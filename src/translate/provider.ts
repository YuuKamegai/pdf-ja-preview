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
  | ({ kind: 'openai' } & OpenAiConfig)
  | ({ kind: 'azure' } & OpenAiConfig);

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

/** Azure OpenAI v1 の公式 endpoint だけを受け付け、末尾を /openai/v1 に揃える。 */
export function normalizeAzureBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderConfigError('Azure OpenAI の送信先が URL ではありません。');
  }
  const officialHost =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/i;
  if (
    url.protocol !== 'https:' ||
    !officialHost.test(url.hostname) ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ProviderConfigError(
      'Azure OpenAI の送信先は公式 https endpoint だけを指定してください。',
    );
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/openai' && path !== '/openai/v1') {
    throw new ProviderConfigError('Azure OpenAI の path は /openai/v1 だけを使用できます。');
  }
  return `${url.origin}/openai/v1`;
}

/**
 * 送ってよい設定かを確かめる。反していれば投げる。
 * 例外メッセージに API キーを含めないこと。
 */
export function assertSendable(config: ProviderConfig, cloudAllowed: boolean): void {
  if (config.kind === 'ollama') {
    if (
      !isLoopbackUrl(config.endpoint) ||
      !['http:', 'https:'].includes(new URL(config.endpoint).protocol)
    ) {
      throw new ProviderConfigError(
        `Ollama の endpoint はループバックだけです: ${config.endpoint}`,
      );
    }
    return;
  }

  let url: URL;
  if (config.kind === 'azure') normalizeAzureBaseUrl(config.baseUrl);
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new ProviderConfigError(`送信先が URL ではありません: ${config.baseUrl}`);
  }
  const localHttp = url.protocol === 'http:' && isLoopbackUrl(config.baseUrl);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new ProviderConfigError(
      `クラウドの送信先は https だけです（手元の互換サーバーは除く）: ${url.host}`,
    );
  }
  if (cloudAllowed !== true) {
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
  if (config.kind === 'openai' || config.kind === 'azure') {
    const impl = deps?.openai ?? translateWithOpenAi;
    const cloudConfig =
      config.kind === 'azure'
        ? {
            ...config,
            baseUrl: normalizeAzureBaseUrl(config.baseUrl),
            authMode: 'api-key' as const,
          }
        : config;
    return impl({ ...common, config: cloudConfig });
  }
  const impl = deps?.ollama ?? translateBlock;
  return impl({ ...common, config });
}
