import { ModelMissingError, ProviderUnavailableError } from './errors';

// 旧名は同一クラスの別名。src/session.ts と test/unit/ が instanceof で見ている。
export {
  ProviderUnavailableError as OllamaUnavailableError,
  ModelMissingError as OllamaModelMissingError,
};

export interface OllamaConfig {
  endpoint: string;
  model: string;
  think: boolean;
  temperature: number;
  timeoutMs: number;
}

export const SYSTEM_PROMPT = [
  'あなたは技術文書を英語から日本語へ訳す翻訳者です。',
  '入力は Markdown 文書の 1 ブロックです。次の規則を必ず守ってください。',
  '- Markdown 記法（見出し記号、リスト記号、表、強調、リンク記法）をそのまま保つ。',
  '- インラインコード、コードフェンスの中身、URL、数式、識別子は一切訳さず原文のまま残す。',
  '- 訳文だけを出力する。前置き、後書き、注釈、原文の再掲を書かない。',
  '- 入力に無いコードフェンスで訳文を包まない。',
].join('\n');

export function buildRequestBody(
  source: string,
  headingContext: string,
  config: OllamaConfig,
  systemPrompt: string = SYSTEM_PROMPT,
): Record<string, unknown> {
  const context = headingContext === '' ? '' : `直前の見出し: ${headingContext}\n\n`;
  return {
    model: config.model,
    think: config.think,
    stream: true,
    options: { temperature: config.temperature },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${context}次のブロックを日本語へ訳してください。\n\n${source}` },
    ],
  };
}

/** 原文にフェンスが無いのに訳文全体がフェンスで包まれていた場合だけ外す。 */
export function stripOuterFence(source: string, translated: string): string {
  if (/^\s*```/m.test(source)) return translated;
  const match = translated.trim().match(/^```[A-Za-z0-9_-]*\n([\s\S]*?)\n?```$/);
  if (!match) return translated;
  const inner = match[1];
  if (inner === undefined || inner.includes('```')) return translated;
  return inner;
}

interface ChatChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  error?: string;
}

/**
 * 中断に起因するエラーを分類する。中断でなければ undefined。
 * 呼び出し側の中断はそのまま返す（キューはこれを正常なキャンセルとして扱う）。
 * タイムアウトは可用性の問題として OllamaUnavailableError に包む。
 */
function abortFailure(
  cause: unknown,
  signal: AbortSignal,
  timeout: AbortSignal,
  timeoutMs: number,
): unknown | undefined {
  if (signal.aborted) return cause;
  if (timeout.aborted) {
    return new ProviderUnavailableError(`Ollama の応答が ${timeoutMs}ms を超えました`, { cause });
  }
  return undefined;
}

export async function translateBlock(args: {
  source: string;
  headingContext: string;
  config: OllamaConfig;
  signal: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
  onDelta?: (chunk: string) => void;
  /** 既定は Markdown 用。PDF 用など別の指示を使うときだけ渡す。 */
  systemPrompt?: string;
}): Promise<string> {
  const { source, headingContext, config, signal, onDelta } = args;
  const systemPrompt = args.systemPrompt ?? SYSTEM_PROMPT;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const url = `${config.endpoint.replace(/\/+$/, '')}/api/chat`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildRequestBody(source, headingContext, config, systemPrompt)),
      signal: combined,
    });
  } catch (cause) {
    const aborted = abortFailure(cause, signal, timeout, config.timeoutMs);
    if (aborted !== undefined) throw aborted;
    throw new ProviderUnavailableError(`Ollama へ接続できません: ${config.endpoint}`, { cause });
  }

  if (response.status === 404) throw new ModelMissingError(config.model);
  if (!response.ok) {
    throw new ProviderUnavailableError(`Ollama が HTTP ${response.status} を返しました`);
  }
  if (!response.body) throw new ProviderUnavailableError('Ollama の応答本文が空です');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    const parsed = JSON.parse(trimmed) as ChatChunk;
    if (parsed.error) throw new ProviderUnavailableError(`Ollama エラー: ${parsed.error}`);
    const content = parsed.message?.content ?? '';
    if (content !== '') {
      text += content;
      onDelta?.(content);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
    }
    consume(buffer);
  } catch (cause) {
    // 読み取り中の中断も接続時と同じ分類にかける。これを怠ると、モデルが途中で
    // 停止したときのタイムアウトが呼び出し側のキャンセルと見分けられず、
    // バナーを出さないまま静かに翻訳が止まる。
    await reader.cancel(cause).catch(() => undefined);
    const aborted = abortFailure(cause, signal, timeout, config.timeoutMs);
    throw aborted ?? cause;
  } finally {
    reader.releaseLock();
  }

  return stripOuterFence(source, text.trim());
}
