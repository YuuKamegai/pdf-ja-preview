/**
 * OpenAI 互換の chat completions クライアント。
 *
 * OpenAI 本体・Azure OpenAI・OpenRouter・手元の互換サーバーを 1 つの実装で扱う。
 * 送信先ごとの差は baseUrl、モデル名、認証ヘッダーだけに閉じ込める。
 *
 * API キーはヘッダーにだけ載せる。本文・ログ・例外メッセージには出さない。
 */

import {
  ModelMissingError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './errors';
import { SYSTEM_PROMPT as SYSTEM_PROMPT_FALLBACK, stripOuterFence } from './ollama';

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** OpenAI 本体は Bearer、Azure OpenAI v1 は api-key を使う。 */
  authMode?: 'bearer' | 'api-key';
}

export function buildOpenAiRequestBody(
  source: string,
  headingContext: string,
  config: OpenAiConfig,
  systemPrompt: string,
): Record<string, unknown> {
  const context = headingContext === '' ? '' : `直前の見出し: ${headingContext}\n\n`;
  return {
    model: config.model,
    stream: true,
    temperature: config.temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${context}次のブロックを日本語へ訳してください。\n\n${source}` },
    ],
  };
}

/**
 * SSE の 1 行を解釈する。
 * 文字が取れたらその文字列、終端なら 'done'、無視してよい行なら undefined。
 */
export function parseSseData(line: string): string | 'done' | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '') return undefined;
  if (payload === '[DONE]') return 'done';

  let parsed: { choices?: { delta?: { content?: unknown } }[] };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch {
    // 壊れた行で翻訳全体を落とさない。次の行へ進む。
    return undefined;
  }
  const content = parsed.choices?.[0]?.delta?.content;
  return typeof content === 'string' && content !== '' ? content : undefined;
}

/** 送信先のホスト名。例外メッセージと表示に使う。鍵もパスも含めない。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '(不正な URL)';
  }
}

/** 中断に起因するエラーを分類する。中断でなければ undefined。 */
function abortFailure(
  cause: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
  timeoutMs: number,
  host: string,
): unknown | undefined {
  if (signal.aborted) return cause;
  if (timeout.aborted) {
    return new ProviderUnavailableError(`${host} の応答が ${timeoutMs}ms を超えました`, { cause });
  }
  return undefined;
}

/** HTTP の失敗を意味ごとの例外へ振り分ける。本文は分類にだけ使い、外へ出さない。 */
async function failureFor(
  response: Response,
  config: OpenAiConfig,
  host: string,
): Promise<Error> {
  if (response.status === 401 || response.status === 403) {
    return new ProviderAuthError(`${host} が API キーを受け付けませんでした`);
  }
  if (response.status === 429) {
    return new ProviderRateLimitError(`${host} が混雑しています`);
  }
  if (response.status === 404) return new ModelMissingError(config.model);

  let code = '';
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    code = typeof body.error?.code === 'string' ? body.error.code : '';
  } catch {
    code = '';
  }
  if (code === 'model_not_found') return new ModelMissingError(config.model);
  return new ProviderUnavailableError(`${host} が HTTP ${response.status} を返しました`);
}

export async function translateWithOpenAi(args: {
  source: string;
  headingContext: string;
  config: OpenAiConfig;
  signal: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
  onDelta?: (chunk: string) => void;
  systemPrompt?: string;
}): Promise<string> {
  const { source, headingContext, config, signal, onDelta } = args;
  const systemPrompt = args.systemPrompt ?? SYSTEM_PROMPT_FALLBACK;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const host = hostOf(config.baseUrl);
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let response: Response;
  try {
    const authHeaders: Record<string, string> =
      config.authMode === 'api-key'
        ? { 'api-key': config.apiKey }
        : { authorization: `Bearer ${config.apiKey}` };
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(buildOpenAiRequestBody(source, headingContext, config, systemPrompt)),
      signal: combined,
    });
  } catch (cause) {
    const aborted = abortFailure(cause, signal, timeout, config.timeoutMs, host);
    if (aborted !== undefined) throw aborted;
    throw new ProviderUnavailableError(`${host} へ接続できません`, { cause });
  }

  if (!response.ok) throw await failureFor(response, config, host);
  if (!response.body) throw new ProviderUnavailableError(`${host} の応答本文が空です`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finished = false;

  const consume = (line: string): void => {
    const parsed = parseSseData(line);
    if (parsed === undefined) return;
    if (parsed === 'done') {
      finished = true;
      return;
    }
    text += parsed;
    onDelta?.(parsed);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        consume(line);
        if (finished) break;
      }
      if (finished) break;
    }
    if (!finished) consume(buffer);
  } catch (cause) {
    // 読み取り中の中断も接続時と同じ分類にかける。Ollama 実装と同じ理由。
    await reader.cancel(cause).catch(() => undefined);
    const aborted = abortFailure(cause, signal, timeout, config.timeoutMs, host);
    throw aborted ?? cause;
  } finally {
    reader.releaseLock();
  }

  return stripOuterFence(source, text.trim());
}
