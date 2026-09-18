/**
 * 接続 1 件の形と、その検証。
 *
 * ここは純粋関数だけにする。ファイルも DPAPI も触らない。「この設定は送ってよいか」
 * の判断を 1 か所へ閉じ込め、保存経路と HTTP の口の両方から同じ規則を通す。
 */

import {
  isLoopbackUrl,
  normalizeAzureBaseUrl,
  type ProviderConfig,
} from '../../src/translate/provider';

export type ProviderKind = 'ollama' | 'openai' | 'azure';
export type Trust = 'loopback' | 'cloud-allowed';

export const MAX_CONNECTION_NAME = 40;
export const MAX_MODEL_LENGTH = 200;

export interface Connection {
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  trust: Trust;
  /** DPAPI 暗号文。無ければ鍵未登録。 */
  apiKeyProtected?: string;
}

/** 画面と API へ出す形。鍵そのもの・断片・長さを含めない。 */
export interface ConnectionView {
  name: string;
  provider: ProviderKind;
  /** 送信先。編集で入れ直させないため、そのまま返す。鍵は含まない。 */
  baseUrl: string;
  /** 表示用のホスト名だけ。 */
  target: string;
  model: string;
  trust: Trust;
  configured: boolean;
}

export class ConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

/** 制御文字。ヘッダーや道筋へ載る値から締め出す。 */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]');

export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ConnectionError('invalid-name', '接続名が文字列ではありません');
  }
  const name = raw.trim();
  if (name === '') throw new ConnectionError('invalid-name', '接続名が空です');
  if (name.length > MAX_CONNECTION_NAME) {
    throw new ConnectionError('invalid-name', `接続名は ${MAX_CONNECTION_NAME} 文字までです`);
  }
  if (CONTROL.test(name)) {
    throw new ConnectionError('invalid-name', '接続名に制御文字は使えません');
  }
  return name;
}

function urlOf(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ConnectionError('invalid-base-url', '送信先が URL ではありません');
  }
}

export interface ConnectionInput {
  name: unknown;
  provider: unknown;
  baseUrl: unknown;
  model: unknown;
  trust: unknown;
}

/** 受け取った値を検証し、保存できる形にして返す。鍵はここでは扱わない。 */
export function validateConnection(input: ConnectionInput): Omit<Connection, 'apiKeyProtected'> {
  const name = normalizeName(input.name);

  const provider = input.provider;
  if (provider !== 'ollama' && provider !== 'openai' && provider !== 'azure') {
    throw new ConnectionError(
      'invalid-provider',
      'provider は ollama / openai / azure のどれかです',
    );
  }

  const trust = input.trust;
  if (trust !== 'loopback' && trust !== 'cloud-allowed') {
    throw new ConnectionError('invalid-trust', 'trust は loopback / cloud-allowed のどちらかです');
  }

  if (typeof input.model !== 'string') {
    throw new ConnectionError('invalid-model', 'モデル名が文字列ではありません');
  }
  const model = input.model.trim();
  if (model.length > MAX_MODEL_LENGTH) {
    throw new ConnectionError('invalid-model', 'モデル名が長すぎます');
  }
  if (CONTROL.test(model)) {
    throw new ConnectionError('invalid-model', 'モデル名に制御文字は使えません');
  }

  if (typeof input.baseUrl !== 'string') {
    throw new ConnectionError('invalid-base-url', '送信先が文字列ではありません');
  }
  const baseUrl = input.baseUrl.trim();

  if (provider === 'ollama') {
    if (trust !== 'loopback') {
      throw new ConnectionError('invalid-trust', 'Ollama の接続はループバック限定です');
    }
    const url = urlOf(baseUrl);
    if (!isLoopbackUrl(baseUrl) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new ConnectionError('invalid-base-url', 'Ollama の送信先はループバックだけです');
    }
    return { name, provider, baseUrl: baseUrl.replace(/\/+$/, ''), model, trust };
  }

  if (trust !== 'cloud-allowed') {
    throw new ConnectionError(
      'invalid-trust',
      'クラウドの接続には、原文をその送信先へ送る許可が要ります',
    );
  }

  if (provider === 'azure') {
    try {
      return { name, provider, baseUrl: normalizeAzureBaseUrl(baseUrl), model, trust };
    } catch (error) {
      throw new ConnectionError('invalid-base-url', (error as Error).message);
    }
  }

  const url = urlOf(baseUrl);
  const localHttp = url.protocol === 'http:' && isLoopbackUrl(baseUrl);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new ConnectionError(
      'invalid-base-url',
      'クラウドの送信先は https だけです（手元の互換サーバーは除く）',
    );
  }
  return { name, provider, baseUrl: baseUrl.replace(/\/+$/, ''), model, trust };
}

export function viewOf(connection: Connection): ConnectionView {
  let target: string;
  try {
    target = new URL(connection.baseUrl).host;
  } catch {
    target = '(不正な URL)';
  }
  return {
    name: connection.name,
    provider: connection.provider,
    baseUrl: connection.baseUrl,
    target,
    model: connection.model,
    trust: connection.trust,
    configured: typeof connection.apiKeyProtected === 'string' && connection.apiKeyProtected !== '',
  };
}

/** 鍵を持ち越してよいかの判定。provider か送信先が変われば別物とみなす。 */
export function sameTarget(
  current: Pick<Connection, 'provider' | 'baseUrl'>,
  next: Pick<Connection, 'provider' | 'baseUrl'>,
): boolean {
  return current.provider === next.provider && current.baseUrl === next.baseUrl;
}

export interface ProviderOptions {
  temperature: number;
  timeoutMs: number;
  think: boolean;
}

/** 接続と復号済みの鍵から、実際に送るときの設定を組む。 */
export function toProviderConfig(
  connection: Omit<Connection, 'apiKeyProtected'>,
  apiKey: string,
  options: ProviderOptions,
): ProviderConfig {
  const common = {
    model: connection.model,
    temperature: options.temperature,
    timeoutMs: options.timeoutMs,
  };
  if (connection.provider === 'ollama') {
    return { kind: 'ollama', endpoint: connection.baseUrl, think: options.think, ...common };
  }
  return { kind: connection.provider, baseUrl: connection.baseUrl, apiKey, ...common };
}
