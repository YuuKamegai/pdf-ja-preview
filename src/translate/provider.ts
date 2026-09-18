/**
 * 翻訳 provider の入口。
 *
 * 拡張も Web アプリもここだけを呼ぶ。実装（Ollama / OpenAI 互換）の違いは
 * ここから先へ漏らさない。
 *
 * 「どこへ送るか」と「送ってよいか」を別の関心として持つ。前者は kind、
 * 後者は cloudAllowed。設定を 1 つ間違えただけで原文が外へ出ることがないよう、
 * 保存経路と送信経路の両方で assertSendable() を通す。
 */

import { ProviderConfigError } from './errors';
import { translateBlock, type OllamaConfig } from './ollama';
import { translateWithOpenAi, type OpenAiConfig } from './openai';

export type ProviderConfig =
  | ({ kind: 'ollama' } & OllamaConfig)
  | ({ kind: 'openai' } & OpenAiConfig);

export interface TranslateArgs {
  source: string;
  headingContext: string;
  config: ProviderConfig;
  signal: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
  onDelta?: (chunk: string) => void;
  systemPrompt?: string;
  /** 試験で実装を差し替えるためだけの口。 */
  deps?: {
    ollama?: typeof translateBlock;
    openai?: typeof translateWithOpenAi;
  };
}

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * 送ってよい設定かを確かめる。反していれば投げる。
 * 例外メッセージに API キーを含めないこと。
 */
export function assertSendable(config: ProviderConfig, cloudAllowed: boolean): void {
  if (config.kind === 'ollama') {
    if (!isLoopbackUrl(config.endpoint)) {
      throw new ProviderConfigError(
        `Ollama の endpoint はループバックだけです: ${config.endpoint}`,
      );
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new ProviderConfigError(`送信先が URL ではありません: ${config.baseUrl}`);
  }
  if (url.protocol !== 'https:' && !isLoopbackUrl(config.baseUrl)) {
    throw new ProviderConfigError(
      `クラウドの送信先は https だけです（手元の互換サーバーは除く）: ${url.host}`,
    );
  }
  if (!cloudAllowed) {
    throw new ProviderConfigError(
      `原文を ${url.host} へ送る許可がありません。クラウドを使うには送信の許可を有効にしてください。`,
    );
  }
  if (config.apiKey.trim() === '') {
    throw new ProviderConfigError('API キーが登録されていません。');
  }
  if (config.model.trim() === '') {
    throw new ProviderConfigError('クラウドで使うモデル名を設定してください。');
  }
}

/** 画面に出す送信先。ホスト名だけ。鍵もパスもクエリも含めない。 */
export function describeTarget(config: ProviderConfig): string {
  const raw = config.kind === 'ollama' ? config.endpoint : config.baseUrl;
  try {
    return new URL(raw).host;
  } catch {
    return '(不正な URL)';
  }
}

export async function translate(args: TranslateArgs): Promise<string> {
  const { config, deps } = args;
  const common = {
    source: args.source,
    headingContext: args.headingContext,
    signal: args.signal,
    fetchImpl: args.fetchImpl,
    onDelta: args.onDelta,
    systemPrompt: args.systemPrompt,
  };
  if (config.kind === 'openai') {
    const impl = deps?.openai ?? translateWithOpenAi;
    return impl({ ...common, config });
  }
  const impl = deps?.ollama ?? translateBlock;
  return impl({ ...common, config });
}
