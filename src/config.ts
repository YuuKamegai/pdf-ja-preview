import type { OllamaConfig } from './translate/ollama';

export interface ResolvedConfig {
  ollama: OllamaConfig;
  maxBlockChars: number;
  scrollSync: boolean;
  autoOpen: boolean;
}

function pick<T>(value: unknown, fallback: T, type: 'string' | 'number' | 'boolean'): T {
  return typeof value === type ? (value as T) : fallback;
}

export function resolveConfig(read: (key: string) => unknown): ResolvedConfig {
  return {
    ollama: {
      endpoint: pick(read('endpoint'), 'http://127.0.0.1:11434', 'string'),
      model: pick(read('model'), 'qwen3.5:9b-q4_K_M', 'string'),
      // thinking 対応モデルで true にすると推論文が訳文へ混入する。既定は false。
      think: pick(read('think'), false, 'boolean'),
      temperature: pick(read('temperature'), 0.2, 'number'),
      timeoutMs: pick(read('requestTimeoutMs'), 120000, 'number'),
    },
    maxBlockChars: pick(read('maxBlockChars'), 1500, 'number'),
    scrollSync: pick(read('scrollSync'), true, 'boolean'),
    autoOpen: pick(read('autoOpen'), false, 'boolean'),
  };
}
