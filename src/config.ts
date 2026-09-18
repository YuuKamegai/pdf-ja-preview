import { normalizeAzureBaseUrl, type ProviderConfig } from './translate/provider';

export interface ResolvedConfig {
  /** apiKey は常に空。SecretStorage から後で差し込む。 */
  provider: ProviderConfig;
  cloudAllowed: boolean;
  maxBlockChars: number;
  scrollSync: boolean;
  autoOpen: boolean;
}

function pick<T>(value: unknown, fallback: T, type: 'string' | 'number' | 'boolean'): T {
  return typeof value === type ? (value as T) : fallback;
}

export function resolveConfig(read: (key: string) => unknown): ResolvedConfig {
  const requestedKind = read('provider');
  const kind = requestedKind === 'openai' || requestedKind === 'azure' ? requestedKind : 'ollama';
  const model = pick(read('model'), 'qwen3.5:9b-q4_K_M', 'string');
  const temperature = pick(read('temperature'), 0.2, 'number');
  const timeoutMs = pick(read('requestTimeoutMs'), 120000, 'number');

  const provider: ProviderConfig =
    kind === 'openai'
      ? {
          kind: 'openai',
          baseUrl: pick(read('baseUrl'), 'https://api.openai.com/v1', 'string'),
          // 鍵は設定から読まない。settings.json は同期・共有されうる。
          apiKey: '',
          model,
          temperature,
          timeoutMs,
        }
      : kind === 'azure'
        ? {
            kind: 'azure',
            baseUrl: normalizeAzureBaseUrl(pick(read('baseUrl'), '', 'string')),
            // 鍵は設定から読まず、SecretStorage から後で差し込む。
            apiKey: '',
            model,
            temperature,
            timeoutMs,
          }
      : {
          kind: 'ollama',
          endpoint: pick(read('endpoint'), 'http://127.0.0.1:11434', 'string'),
          model,
          // thinking 対応モデルで true にすると推論文が訳文へ混入する。既定は false。
          think: pick(read('think'), false, 'boolean'),
          temperature,
          timeoutMs,
        };

  return {
    provider,
    cloudAllowed: pick(read('cloudAllowed'), false, 'boolean'),
    maxBlockChars: pick(read('maxBlockChars'), 1500, 'number'),
    scrollSync: pick(read('scrollSync'), true, 'boolean'),
    autoOpen: pick(read('autoOpen'), false, 'boolean'),
  };
}
