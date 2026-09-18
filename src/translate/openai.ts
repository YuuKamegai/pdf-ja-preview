/**
 * OpenAI 互換の chat completions クライアント。
 *
 * OpenAI 本体・Azure OpenAI・OpenRouter・手元の互換サーバーを 1 つの実装で扱う。
 * 送信先ごとの差は baseUrl とモデル名だけに閉じ込める。
 *
 * API キーはヘッダーにだけ載せる。本文・ログ・例外メッセージには出さない。
 */

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
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
