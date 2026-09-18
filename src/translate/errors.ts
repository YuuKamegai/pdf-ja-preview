/**
 * 翻訳まわりの例外。
 *
 * provider（Ollama / OpenAI 互換）が違っても、呼び出し側が見る型は同じにする。
 * バナー文言の分岐がここ一箇所で済むようにするため。
 */

export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderUnavailableError';
  }
}

export class ModelMissingError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`モデルが見つかりません: ${model}`);
    this.name = 'ModelMissingError';
    this.model = model;
  }
}

/** 401 / 403。鍵そのものはメッセージに含めない。 */
export class ProviderAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderAuthError';
  }
}

/** 429。待てば直る種類の失敗。 */
export class ProviderRateLimitError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderRateLimitError';
  }
}

/** 設定が不正で、送信すべきでない状態。送る前に投げる。 */
export class ProviderConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderConfigError';
  }
}
