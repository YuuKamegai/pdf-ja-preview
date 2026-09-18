# クラウド LLM 対応（段階 1）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS Code 拡張と PDF Web アプリの両方で、ローカル Ollama に加えて OpenAI 互換のクラウド endpoint を API キーで使えるようにする。

**Architecture:** `src/translate/provider.ts` を両アプリ唯一の翻訳入口にし、`kind` で Ollama と OpenAI 互換へ振り分ける。クラウドは `assertSendable()` の明示許可が無ければ保存も送信も通さない。鍵は拡張が VS Code SecretStorage、Web が Windows DPAPI（`powershell.exe` 経由）へ保存し、UI にも HTTP 応答にも返さない。

**Tech Stack:** TypeScript 5.9 / Node 24 / esbuild / `node:test` + `tsx` / VS Code Extension API / Playwright (msedge)

**Spec:** `docs/superpowers/specs/2026-09-18-cloud-provider-and-split-design.md`

## Global Constraints

- 既存試験の**主張（assert の中身）を弱めないこと**。件数は `npm test` 118 件、`npm run test:web` 238 件、`npm run test:e2e:web` 22 件、`npm run test:integration` 2 件。
- **書き換えてよい既存試験は次の 4 ファイルの「道具立て」だけ**である。主張そのものは変えない。
  - `test/web/session.test.ts:51` — `connection` に `kind: 'ollama'` を足す。
  - `test/web/http.test.ts:95` — 同上。
  - `test/web/translation.test.ts:18-24` — `config` に `kind: 'ollama'` を足す。
  - `test/web/main.test.ts:38-40,60` — `settings.connection.*` を `settings.provider.*` へ読み替える。フィールド名だけの変更で、期待値は変えない。
  - `test/web/preflight.test.ts` — `context()` ヘルパーに `kind: 'ollama'` と `target` を足し、`preflight()` を呼ぶ 2 件へ同じ 2 つを渡す（Task 11）。
- **`test/unit/` 配下は一行も変えない。** `src/session.ts:35` と `test/unit/session.test.ts` が
  `OllamaModelMissingError` / `OllamaUnavailableError` を `instanceof` で見ているため、この 2 つの
  名前は同一クラスを指す別名として残す。これが Task 1 の存在理由である。
- API キーは、ログ・HTTP 応答・エラーメッセージ・`describeTarget()` の戻り値のいずれにも現れてはならない。キーの断片も長さも出さない。
- クラウドの既定モデル名は置かない。`provider === 'openai'` でモデル未指定なら翻訳を開始しない。
- 既定値: `provider = 'ollama'`、`baseUrl = 'https://api.openai.com/v1'`、`cloudAllowed = false`。
- `baseUrl` は `https:` 必須。ただしホストがループバック（`localhost` / `127.0.0.1` / `::1`）のときだけ `http:` を許す。
- DPAPI の保存形式は `dpapi-current-user-v1:<base64>`。Windows 以外では明示的に失敗させ、平文で保存しない。
- コミットメッセージは既存の形式（`feat(scope): 日本語の要約`）に合わせ、末尾に `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` を置く。
- 訳文の扱いと検証（`stripOuterFence`・`verifyTranslation`・プロンプト）は一切変更しない。

## File Structure

| ファイル | 責任 |
|---|---|
| `src/translate/errors.ts` (新) | 例外型 5 種の定義。ここだけが例外クラスを持つ |
| `src/translate/ollama.ts` (改) | Ollama 実装。例外は errors.ts から import し、旧名で re-export |
| `src/translate/openai.ts` (新) | OpenAI 互換の SSE クライアント |
| `src/translate/provider.ts` (新) | 型・検証・振り分け。両アプリの唯一の入口 |
| `src/config.ts` (改) | 拡張の設定解決。`ProviderConfig` を組み立てる |
| `src/extension.ts` (改) | 鍵コマンド、バナー判定、`translate()` への差し替え |
| `src/session.ts` (改) | 新しい例外のバナー文言 |
| `src/panel/html.ts` (改) | 常時表示の `#notice` 要素 |
| `media/preview.js` (改) | `notice` メッセージの描画 |
| `web/server/secret.ts` (新) | DPAPI の protect / unprotect。接点は 2 関数 |
| `web/server/settings-store.ts` (新) | `settings.json` の読み書き。鍵の保存先 |
| `web/server/main.ts` (改) | provider 対応の `readSettings`、`--set-key` / `--clear-key` |
| `web/server/preflight.ts` (改) | クラウド用の判定 3 件 |
| `web/server/session.ts` (改) | `Snapshot` に `target` / `cloud` |
| `web/shared/protocol.ts` (改) | `Snapshot` の型 |
| `web/client/index.html` (改) | `#cloud-notice` 要素 |
| `web/client/main.ts` (改) | `#cloud-notice` の描画 |

---

### Task 1: 例外型を errors.ts へ切り出し、旧名を別名で残す

**Files:**
- Create: `src/translate/errors.ts`
- Modify: `src/translate/ollama.ts:10-24`（クラス定義を import + re-export へ）
- Test: `test/unit/errors.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `ProviderUnavailableError`、`ModelMissingError`（`.model: string`）、`ProviderAuthError`、`ProviderRateLimitError`、`ProviderConfigError`。`src/translate/ollama.ts` は `OllamaUnavailableError` / `OllamaModelMissingError` を同一クラスの別名として re-export する。

- [ ] **Step 1: 失敗する試験を書く**

`test/unit/errors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelMissingError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../../src/translate/errors';
import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from '../../src/translate/ollama';

test('旧名は新しいクラスと同一である', () => {
  assert.equal(OllamaModelMissingError, ModelMissingError);
  assert.equal(OllamaUnavailableError, ProviderUnavailableError);
});

test('旧名で作った例外は新名でも instanceof が通る', () => {
  const error = new OllamaModelMissingError('test-model');
  assert.ok(error instanceof ModelMissingError);
  assert.equal(error.model, 'test-model');
  assert.equal(error.message, 'モデルが見つかりません: test-model');
});

test('例外はそれぞれ固有の name を持つ', () => {
  assert.equal(new ProviderUnavailableError('x').name, 'ProviderUnavailableError');
  assert.equal(new ModelMissingError('m').name, 'ModelMissingError');
  assert.equal(new ProviderAuthError('x').name, 'ProviderAuthError');
  assert.equal(new ProviderRateLimitError('x').name, 'ProviderRateLimitError');
  assert.equal(new ProviderConfigError('x').name, 'ProviderConfigError');
});

test('cause を引き継ぐ', () => {
  const cause = new Error('原因');
  assert.equal(new ProviderUnavailableError('x', { cause }).cause, cause);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/unit/errors.test.ts"`
Expected: FAIL. `Cannot find module '.../src/translate/errors'`

- [ ] **Step 3: errors.ts を書く**

`src/translate/errors.ts`:

```ts
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
```

- [ ] **Step 4: ollama.ts のクラス定義を差し替える**

`src/translate/ollama.ts:10-24` の `class OllamaUnavailableError` と
`class OllamaModelMissingError` の定義 2 つを削除し、先頭の import 群へ次を足す。

```ts
import { ModelMissingError, ProviderUnavailableError } from './errors';

// 旧名は同一クラスの別名。src/session.ts と test/unit/ が instanceof で見ている。
export {
  ProviderUnavailableError as OllamaUnavailableError,
  ModelMissingError as OllamaModelMissingError,
};
```

そのうえで、**このファイル内の `throw` / `new` を新しい名前へ機械的に置換する**。
別名は `export` 文の中だけに存在し、ファイル内の識別子としては使えないため。

置換前に件数を数える（想定 6 箇所）。

```bash
grep -c "OllamaUnavailableError" src/translate/ollama.ts
grep -c "OllamaModelMissingError" src/translate/ollama.ts
```

`new OllamaUnavailableError(` を `new ProviderUnavailableError(` へ、
`new OllamaModelMissingError(` を `new ModelMissingError(` へ置換する。
`export { ... as ... }` の行は置換しないこと。

- [ ] **Step 5: 試験を通す**

Run: `npx tsx --test "test/unit/errors.test.ts"`
Expected: PASS（4 件）

- [ ] **Step 6: 既存試験が壊れていないことを確認する**

Run: `npm test`
Expected: 118 件すべて PASS、型検査もエラーなし

- [ ] **Step 7: コミット**

```bash
git add src/translate/errors.ts src/translate/ollama.ts test/unit/errors.test.ts
git commit -m "$(cat <<'MSG'
refactor(translate): 例外型を errors.ts へ切り出す

provider を増やすので、例外の型を実装ごとではなく意味ごとに持たせる。
Ollama の旧名は同一クラスの別名として残す。src/session.ts と既存試験が
instanceof で見ており、そこを書き換えずに通すため。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: OpenAI 互換の SSE パーサと本文組み立て

**Files:**
- Create: `src/translate/openai.ts`
- Test: `test/unit/openai.test.ts`

**Interfaces:**
- Consumes: Task 1 の `ProviderAuthError`・`ProviderRateLimitError`・`ProviderUnavailableError`・`ModelMissingError`。既存 `src/translate/ollama.ts` の `SYSTEM_PROMPT` と `stripOuterFence`。
- Produces: `OpenAiConfig`（`baseUrl`・`apiKey`・`model`・`temperature`・`timeoutMs`）、`buildOpenAiRequestBody()`、`parseSseData(line): string | 'done' | undefined`、`translateWithOpenAi(args): Promise<string>`。

このタスクでは純粋な部分（本文組み立てと SSE 行の解釈）だけを作る。HTTP は Task 3 で扱う。

- [ ] **Step 1: 失敗する試験を書く**

`test/unit/openai.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAiRequestBody, parseSseData, type OpenAiConfig } from '../../src/translate/openai';
import { SYSTEM_PROMPT } from '../../src/translate/ollama';

const config: OpenAiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  temperature: 0.2,
  timeoutMs: 1000,
};

test('本文はモデル・温度・ストリームを含む', () => {
  const body = buildOpenAiRequestBody('Hello.', '', config, SYSTEM_PROMPT);
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, true);
});

test('本文に API キーを含めない', () => {
  const body = buildOpenAiRequestBody('Hello.', '', config, SYSTEM_PROMPT);
  assert.equal(JSON.stringify(body).includes('sk-test'), false);
});

test('見出し文脈は user メッセージの先頭に付く', () => {
  const body = buildOpenAiRequestBody('Hello.', 'Methods', config, SYSTEM_PROMPT);
  const messages = body.messages as { role: string; content: string }[];
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, SYSTEM_PROMPT);
  assert.match(messages[1]?.content ?? '', /^直前の見出し: Methods/);
});

test('見出し文脈が空なら前置きを付けない', () => {
  const body = buildOpenAiRequestBody('Hello.', '', config, SYSTEM_PROMPT);
  const messages = body.messages as { content: string }[];
  assert.equal(messages[1]?.content.startsWith('直前の見出し'), false);
});

test('data 行から delta の中身を取り出す', () => {
  assert.equal(
    parseSseData('data: {"choices":[{"delta":{"content":"こん"}}]}'),
    'こん',
  );
});

test('[DONE] は終端として返す', () => {
  assert.equal(parseSseData('data: [DONE]'), 'done');
});

test('空行・コメント・event 行は無視する', () => {
  assert.equal(parseSseData(''), undefined);
  assert.equal(parseSseData('   '), undefined);
  assert.equal(parseSseData(': keep-alive'), undefined);
  assert.equal(parseSseData('event: message'), undefined);
});

test('delta に content が無ければ無視する', () => {
  assert.equal(parseSseData('data: {"choices":[{"delta":{"role":"assistant"}}]}'), undefined);
  assert.equal(parseSseData('data: {"choices":[]}'), undefined);
});

test('壊れた JSON は例外にせず無視する', () => {
  assert.equal(parseSseData('data: {壊れている'), undefined);
});

test('data: の後の空白の有無を問わない', () => {
  assert.equal(parseSseData('data:{"choices":[{"delta":{"content":"a"}}]}'), 'a');
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/unit/openai.test.ts"`
Expected: FAIL. `Cannot find module '.../src/translate/openai'`

- [ ] **Step 3: openai.ts の純粋な部分を書く**

`src/translate/openai.ts`:

```ts
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
```

- [ ] **Step 4: 試験を通す**

Run: `npx tsx --test "test/unit/openai.test.ts"`
Expected: PASS（10 件）

- [ ] **Step 5: コミット**

```bash
git add src/translate/openai.ts test/unit/openai.test.ts
git commit -m "$(cat <<'MSG'
feat(translate): OpenAI 互換の本文組み立てと SSE 行の解釈

壊れた data 行や content の無い delta で翻訳全体を落とさない。次の行へ進む。
API キーは本文に載せない（ヘッダーにだけ載せる）ことを試験で固定した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: OpenAI 互換の HTTP と例外分類

**Files:**
- Modify: `src/translate/openai.ts`（`translateWithOpenAi` を追加）
- Test: `test/unit/openai.test.ts`（追記）

**Interfaces:**
- Consumes: Task 2 の `parseSseData`・`buildOpenAiRequestBody`・`OpenAiConfig`。Task 1 の例外型。既存 `src/translate/ollama.ts` の `stripOuterFence`。
- Produces: `translateWithOpenAi(args: { source; headingContext; config: OpenAiConfig; signal: AbortSignal; fetchImpl?; onDelta?; systemPrompt })` → `Promise<string>`。

- [ ] **Step 1: 失敗する試験を書く**

`test/unit/openai.test.ts` に追記:

```ts
import {
  ModelMissingError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../../src/translate/errors';
import { translateWithOpenAi } from '../../src/translate/openai';

/** SSE の本文を、指定した切れ目で分割して返す fetch を作る。 */
function sseFetch(chunks: string[], init: { status?: number; body?: string } = {}) {
  const captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const impl = (async (url: string | URL, options: RequestInit = {}) => {
    captured.url = String(url);
    captured.headers = options.headers as Record<string, string>;
    captured.body = options.body as string;
    const status = init.status ?? 200;
    if (status !== 200) {
      return new Response(init.body ?? '{}', { status });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { impl, captured };
}

test('SSE を繋いで訳文にする', async () => {
  const { impl } = sseFetch([
    'data: {"choices":[{"delta":{"content":"こん"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const result = await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config,
    signal: new AbortController().signal,
    fetchImpl: impl,
  });
  assert.equal(result, 'こんにちは');
});

test('イベントの途中で分割して届いても繋がる', async () => {
  const { impl } = sseFetch([
    'data: {"choices":[{"delta":{"con',
    'tent":"あ"}}]}\n\ndata: {"choices":[{"delta":{"content":"い"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const result = await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config,
    signal: new AbortController().signal,
    fetchImpl: impl,
  });
  assert.equal(result, 'あい');
});

test('onDelta へ逐次渡す', async () => {
  const seen: string[] = [];
  const { impl } = sseFetch([
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config,
    signal: new AbortController().signal,
    fetchImpl: impl,
    onDelta: (chunk) => seen.push(chunk),
  });
  assert.deepEqual(seen, ['A', 'B']);
});

test('URL とヘッダーを組み立てる', async () => {
  const { impl, captured } = sseFetch(['data: [DONE]\n\n']);
  await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config: { ...config, baseUrl: 'https://api.openai.com/v1/' },
    signal: new AbortController().signal,
    fetchImpl: impl,
  });
  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(captured.headers?.['authorization'], 'Bearer sk-test');
  assert.equal(captured.headers?.['content-type'], 'application/json');
});

test('401 は認証の失敗として投げる', async () => {
  const { impl } = sseFetch([], { status: 401 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderAuthError,
  );
});

test('403 も認証の失敗として投げる', async () => {
  const { impl } = sseFetch([], { status: 403 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderAuthError,
  );
});

test('認証の失敗に API キーを含めない', async () => {
  const { impl } = sseFetch([], { status: 401 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => !(error as Error).message.includes('sk-test'),
  );
});

test('404 はモデル欠落として投げる', async () => {
  const { impl } = sseFetch([], { status: 404 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ModelMissingError && error.model === 'gpt-test',
  );
});

test('本文の model_not_found もモデル欠落として投げる', async () => {
  const { impl } = sseFetch([], {
    status: 400,
    body: '{"error":{"code":"model_not_found"}}',
  });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ModelMissingError,
  );
});

test('429 は流量制限として投げる', async () => {
  const { impl } = sseFetch([], { status: 429 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderRateLimitError,
  );
});

test('500 は可用性の問題として投げる', async () => {
  const { impl } = sseFetch([], { status: 500 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderUnavailableError,
  );
});

test('接続できないときは可用性の問題として投げる', async () => {
  const impl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) =>
      error instanceof ProviderUnavailableError && error.message.includes('api.openai.com'),
  );
});

test('呼び出し側の中断はそのまま伝える', async () => {
  const controller = new AbortController();
  const impl = (async (_url: string, options: RequestInit = {}) => {
    controller.abort();
    (options.signal as AbortSignal).throwIfAborted();
    return new Response('', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: controller.signal,
      fetchImpl: impl,
    }),
    (error: unknown) => (error as Error).name === 'AbortError',
  );
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/unit/openai.test.ts"`
Expected: FAIL. `translateWithOpenAi is not a function`

- [ ] **Step 3: translateWithOpenAi を書く**

`src/translate/openai.ts` に追記:

```ts
import {
  ModelMissingError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './errors';
import { stripOuterFence } from './ollama';

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
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
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
```

`SYSTEM_PROMPT_FALLBACK` は `src/translate/ollama.ts` の `SYSTEM_PROMPT` を import して使う。
`openai.ts` の先頭の import に `SYSTEM_PROMPT as SYSTEM_PROMPT_FALLBACK` を足すこと。
循環 import を避けるため、`ollama.ts` から `openai.ts` を import してはならない。

- [ ] **Step 4: 試験を通す**

Run: `npx tsx --test "test/unit/openai.test.ts"`
Expected: PASS（23 件）

- [ ] **Step 5: 型検査**

Run: `npm run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/translate/openai.ts test/unit/openai.test.ts
git commit -m "$(cat <<'MSG'
feat(translate): OpenAI 互換の HTTP と例外分類

401/403 を認証、404 と model_not_found をモデル欠落、429 を流量制限、他を可用性へ
振り分ける。例外メッセージにはホスト名だけを載せ、API キーを含めない。
イベント境界で分割して届く SSE を行バッファで繋ぐ。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: provider 抽象（型・検証・振り分け）

**Files:**
- Create: `src/translate/provider.ts`
- Test: `test/unit/provider.test.ts`

**Interfaces:**
- Consumes: Task 1 の `ProviderConfigError`、Task 3 の `translateWithOpenAi` と `OpenAiConfig`、既存の `translateBlock` と `OllamaConfig`。
- Produces: `ProviderConfig`、`TranslateArgs`、`assertSendable(config, cloudAllowed)`、`describeTarget(config)`、`translate(args)`、`isLoopbackUrl(raw)`。

- [ ] **Step 1: 失敗する試験を書く**

`test/unit/provider.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderConfigError } from '../../src/translate/errors';
import {
  assertSendable,
  describeTarget,
  isLoopbackUrl,
  translate,
  type ProviderConfig,
} from '../../src/translate/provider';

const ollama: ProviderConfig = {
  kind: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b-q4_K_M',
  think: false,
  temperature: 0.2,
  timeoutMs: 1000,
};

const openai: ProviderConfig = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  temperature: 0.2,
  timeoutMs: 1000,
};

test('ループバックの判定', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLoopbackUrl('http://localhost:1234'), true);
  assert.equal(isLoopbackUrl('http://[::1]:1234'), true);
  assert.equal(isLoopbackUrl('https://api.openai.com/v1'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});

test('ローカルは許可なしでも通る', () => {
  assert.doesNotThrow(() => assertSendable(ollama, false));
});

test('ローカルで非ループバックは拒否する', () => {
  assert.throws(
    () => assertSendable({ ...ollama, endpoint: 'http://192.168.1.10:11434' }, true),
    ProviderConfigError,
  );
});

test('クラウドは許可がなければ拒否する', () => {
  assert.throws(() => assertSendable(openai, false), ProviderConfigError);
});

test('クラウドは許可があれば通る', () => {
  assert.doesNotThrow(() => assertSendable(openai, true));
});

test('クラウドの拒否理由に許可の付け方を書く', () => {
  assert.throws(() => assertSendable(openai, false), /許可/);
});

test('http のクラウドは拒否する', () => {
  assert.throws(
    () => assertSendable({ ...openai, baseUrl: 'http://api.example.com/v1' }, true),
    ProviderConfigError,
  );
});

test('ループバックなら http の互換サーバーを許す', () => {
  assert.doesNotThrow(() =>
    assertSendable({ ...openai, baseUrl: 'http://127.0.0.1:8000/v1' }, true),
  );
});

test('キーが空なら拒否する', () => {
  assert.throws(() => assertSendable({ ...openai, apiKey: '' }, true), ProviderConfigError);
  assert.throws(() => assertSendable({ ...openai, apiKey: '   ' }, true), ProviderConfigError);
});

test('モデル名が空なら拒否する', () => {
  assert.throws(() => assertSendable({ ...openai, model: '' }, true), ProviderConfigError);
});

test('拒否理由に API キーを含めない', () => {
  for (const broken of [{ ...openai, model: '' }, { ...openai, baseUrl: 'http://x.example' }]) {
    assert.throws(
      () => assertSendable(broken, true),
      (error: unknown) => !(error as Error).message.includes('sk-test'),
    );
  }
});

test('送信先の表示はホスト名だけ', () => {
  assert.equal(describeTarget(openai), 'api.openai.com');
  assert.equal(describeTarget(ollama), '127.0.0.1:11434');
});

test('送信先の表示に API キーもパスも含めない', () => {
  const target = describeTarget({ ...openai, baseUrl: 'https://api.openai.com/v1/secret-path' });
  assert.equal(target, 'api.openai.com');
  assert.equal(target.includes('sk-test'), false);
  assert.equal(target.includes('secret-path'), false);
});

test('kind で実装を振り分ける', async () => {
  const calls: string[] = [];
  const result = await translate({
    source: 'Hello.',
    headingContext: '',
    config: openai,
    signal: new AbortController().signal,
    deps: {
      ollama: async () => {
        calls.push('ollama');
        return 'ollama';
      },
      openai: async () => {
        calls.push('openai');
        return 'openai';
      },
    },
  });
  assert.equal(result, 'openai');
  assert.deepEqual(calls, ['openai']);
});

test('ローカルは Ollama 実装へ回る', async () => {
  const result = await translate({
    source: 'Hello.',
    headingContext: '',
    config: ollama,
    signal: new AbortController().signal,
    deps: {
      ollama: async () => 'ollama',
      openai: async () => 'openai',
    },
  });
  assert.equal(result, 'ollama');
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/unit/provider.test.ts"`
Expected: FAIL. `Cannot find module '.../src/translate/provider'`

- [ ] **Step 3: provider.ts を書く**

`src/translate/provider.ts`:

```ts
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
```

- [ ] **Step 4: 試験を通す**

Run: `npx tsx --test "test/unit/provider.test.ts"`
Expected: PASS（15 件）

- [ ] **Step 5: 既存試験と型検査**

Run: `npm test`
Expected: 既存 118 件 + 新規すべて PASS

- [ ] **Step 6: コミット**

```bash
git add src/translate/provider.ts test/unit/provider.test.ts
git commit -m "$(cat <<'MSG'
feat(translate): provider 抽象と送信可否の検証

「どこへ送るか」(kind) と「送ってよいか」(cloudAllowed) を別の関心にする。
設定を 1 つ間違えただけで原文が外へ出ないよう、保存経路と送信経路の両方で
assertSendable() を通す設計にした。

describeTarget() はホスト名だけを返す。パスもクエリも鍵も含めないことを
試験で固定した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: 拡張の設定と鍵コマンド

**Files:**
- Modify: `package.json`（`contributes.configuration` と `contributes.commands`）
- Modify: `src/config.ts`
- Modify: `src/extension.ts`
- Test: `test/unit/config.test.ts`（既存があれば追記、なければ作成）

**Interfaces:**
- Consumes: Task 4 の `ProviderConfig`・`assertSendable`・`describeTarget`。
- Produces: `resolveConfig(read)` が `{ provider: ProviderConfig（apiKey は空文字）, cloudAllowed, maxBlockChars, scrollSync, autoOpen }` を返す。鍵は別経路（SecretStorage）で後から差し込む。

- [ ] **Step 1: 失敗する試験を書く**

`test/unit/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../../src/config';

function reader(values: Record<string, unknown>) {
  return (key: string): unknown => values[key];
}

test('既定はローカルの Ollama', () => {
  const config = resolveConfig(reader({}));
  assert.equal(config.provider.kind, 'ollama');
  assert.equal(config.cloudAllowed, false);
  if (config.provider.kind !== 'ollama') throw new Error('unreachable');
  assert.equal(config.provider.endpoint, 'http://127.0.0.1:11434');
  assert.equal(config.provider.model, 'qwen3.5:9b-q4_K_M');
});

test('provider を openai にすると baseUrl 側を組む', () => {
  const config = resolveConfig(reader({ provider: 'openai', model: 'gpt-test' }));
  assert.equal(config.provider.kind, 'openai');
  if (config.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(config.provider.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.provider.model, 'gpt-test');
});

test('鍵は設定から読まない（常に空）', () => {
  const config = resolveConfig(reader({ provider: 'openai', apiKey: 'sk-leak' }));
  if (config.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(config.provider.apiKey, '');
});

test('知らない provider は ollama へ落とす', () => {
  assert.equal(resolveConfig(reader({ provider: 'gemini' })).provider.kind, 'ollama');
});

test('cloudAllowed を読む', () => {
  assert.equal(resolveConfig(reader({ cloudAllowed: true })).cloudAllowed, true);
});

test('温度とタイムアウトは両 provider で共用する', () => {
  const config = resolveConfig(reader({ provider: 'openai', temperature: 0.5, requestTimeoutMs: 9000 }));
  assert.equal(config.provider.temperature, 0.5);
  assert.equal(config.provider.timeoutMs, 9000);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/unit/config.test.ts"`
Expected: FAIL. `config.provider` が undefined

- [ ] **Step 3: config.ts を書き換える**

`src/config.ts` を全面的に置き換える:

```ts
import type { ProviderConfig } from './translate/provider';

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
  const kind = read('provider') === 'openai' ? 'openai' : 'ollama';
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
```

- [ ] **Step 4: 試験を通す**

Run: `npx tsx --test "test/unit/config.test.ts"`
Expected: PASS（6 件）

- [ ] **Step 5: package.json に設定とコマンドを足す**

`contributes.configuration.properties` に追加:

```json
"mdJaPreview.provider": {
  "type": "string",
  "enum": ["ollama", "openai"],
  "default": "ollama",
  "description": "翻訳に使う provider。openai は OpenAI 互換の endpoint を指します。"
},
"mdJaPreview.baseUrl": {
  "type": "string",
  "default": "https://api.openai.com/v1",
  "description": "provider が openai のときの送信先。API キーはここに書かず、コマンドで登録します。"
},
"mdJaPreview.cloudAllowed": {
  "type": "boolean",
  "default": false,
  "description": "原文を外部へ送ることを許可する。これを有効にしない限りクラウドは使えません。"
}
```

`contributes.commands` に追加:

```json
{ "command": "mdJaPreview.setApiKey", "title": "API キーを登録", "category": "md-ja" },
{ "command": "mdJaPreview.clearApiKey", "title": "API キーを削除", "category": "md-ja" }
```

`activationEvents` に `"onCommand:mdJaPreview.setApiKey"` と
`"onCommand:mdJaPreview.clearApiKey"` を追加。

- [ ] **Step 6: extension.ts にコマンドを登録する**

`src/extension.ts` の `activate()` 内、既存の `registerCommand` の隣へ追加:

```ts
const SECRET_KEY = 'mdJaPreview.apiKey';

context.subscriptions.push(
  vscode.commands.registerCommand('mdJaPreview.setApiKey', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'クラウド provider の API キー',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...',
    });
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed === '') {
      void vscode.window.showWarningMessage('API キーが空です。登録しませんでした。');
      return;
    }
    await context.secrets.store(SECRET_KEY, trimmed);
    void vscode.window.showInformationMessage('API キーを登録しました。');
  }),
  vscode.commands.registerCommand('mdJaPreview.clearApiKey', async () => {
    await context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('API キーを削除しました。');
  }),
);
```

- [ ] **Step 7: 型検査と既存試験**

Run: `npm test`
Expected: すべて PASS。`src/extension.ts` の `config.ollama` 参照が型エラーになるので、
Task 6 で直すまでの暫定として `config.provider` へ読み替える（`translateBlock` 呼び出しは
Task 6 で `translate()` へ替える）。このステップでは型が通ることだけを確認する。

- [ ] **Step 8: コミット**

```bash
git add package.json src/config.ts src/extension.ts test/unit/config.test.ts
git commit -m "$(cat <<'MSG'
feat(extension): provider 設定と API キーの登録コマンド

鍵は設定に置かない。settings.json は同期・共有されうるため、そこへ平文の鍵を
書く経路を作らない。SecretStorage へ入れ、設定から読まないことを試験で固定した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: 拡張をクラウドで動かす（バナーと差し替え）

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/session.ts:32-41`（`fatalBanner`）
- Modify: `src/panel/html.ts:33`
- Modify: `media/preview.js`
- Test: `test/unit/session.test.ts`（追記）

**Interfaces:**
- Consumes: Task 4 の `translate`・`assertSendable`・`describeTarget`、Task 5 の `resolveConfig`。
- Produces: `SessionEvent` に `{ kind: 'notice'; text: string }` を追加。webview は `#notice` に常時表示する。

- [ ] **Step 1: 失敗する試験を書く**

`test/unit/session.test.ts` に追記:

```ts
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
} from '../../src/translate/errors';

test('認証の失敗はバナーになる', async () => {
  const h = harness(async () => {
    throw new ProviderAuthError('api.openai.com が拒否');
  });
  await h.session.open('Alpha.
');
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('API キー'));
});

test('流量制限はバナーになる', async () => {
  const h = harness(async () => {
    throw new ProviderRateLimitError('混雑');
  });
  await h.session.open('Alpha.
');
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('混雑'));
});

test('設定の不備はバナーになる', async () => {
  const h = harness(async () => {
    throw new ProviderConfigError('原文を api.openai.com へ送る許可がありません。');
  });
  await h.session.open('Alpha.
');
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('許可'));
});

test('認証エラーのバナーに例外メッセージを埋め込まない', async () => {
  const h = harness(async () => {
    throw new ProviderAuthError('sk-leak-0123456789 が拒否されました');
  });
  await h.session.open('Alpha.
');
  for (const event of h.events) {
    if (event.kind === 'banner') assert.equal(event.text.includes('sk-leak-0123456789'), false);
  }
});

test('打ち切ったら 2 つ目のブロックは訳さない', async () => {
  const h = harness(async () => {
    throw new ProviderAuthError('拒否');
  });
  await h.session.open('Alpha.

Bravo.
');
  assert.deepEqual(h.calls, ['Alpha.'], '2 つ目は呼ばない');
});
```

`harness()` は `test/unit/session.test.ts:17` に既にある。新しい関数は作らず、既存試験
（`'モデル未導入なら pull コマンドを添えたバナーを出す'`, 169 行目付近）と同じ形で使う。

**重要:** 4 件目の試験は「例外メッセージに鍵が混ざっていてもバナーには出さない」ことを
要求している。`fatalBanner` は `ProviderAuthError` の `message` を埋め込んではならない。

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/unit/session.test.ts"`
Expected: FAIL（4 件）。新しい例外でバナーが出ない

- [ ] **Step 3: fatalBanner を広げる**

`src/session.ts` の import と `fatalBanner` を差し替える:

```ts
import {
  ModelMissingError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './translate/errors';

/** 復帰不能なエラーならバナー文言を返す。ブロック単位の失敗なら undefined。 */
function fatalBanner(error: unknown): string | undefined {
  if (error instanceof ModelMissingError) {
    return `モデル ${error.model} がありません。ローカルなら "ollama pull ${error.model}"、クラウドならモデル名の設定を確かめてください。`;
  }
  if (error instanceof ProviderAuthError) {
    // 例外メッセージを埋め込まない。鍵が混ざりうる。
    return 'API キーが拒否されました。コマンド「md-ja: API キーを登録」で登録し直してください。';
  }
  if (error instanceof ProviderRateLimitError) {
    return '送信先が混雑しています。しばらく待ってから再試行してください。';
  }
  if (error instanceof ProviderConfigError) {
    return `設定を確かめてください: ${error.message}`;
  }
  if (error instanceof ProviderUnavailableError) {
    return `翻訳先へ接続できません。原文のまま表示しています。（${error.message}）`;
  }
  return undefined;
}
```

`ProviderConfigError` のメッセージは `assertSendable()` が組み立てたものだけが来る。
Task 4 の試験で鍵を含まないことを固定済みなので、そのまま出してよい。

- [ ] **Step 4: 試験を通す**

Run: `npx tsx --test "test/unit/session.test.ts"`
Expected: 既存と新規すべて PASS

- [ ] **Step 5: `notice` イベントと webview 要素を足す**

`src/session.ts` の `SessionEvent` に追加:

```ts
export type SessionEvent =
  | { kind: 'init'; blocks: SessionView[] }
  | { kind: 'block'; index: number; markdown: string; state: BlockState }
  | { kind: 'banner'; text: string }
  | { kind: 'notice'; text: string };
```

`src/panel/html.ts:33` の直後へ:

```html
<div id="notice" hidden></div>
```

`media/preview.js` の先頭付近、`const banner = ...` の隣へ:

```js
const notice = document.getElementById('notice');
```

`if (message.kind === 'banner') { ... }` ブロックの直後へ:

```js
    if (message.kind === 'notice') {
      notice.textContent = message.text;
      notice.hidden = message.text === '';
      return;
    }
```

`media/preview.css` へ、`#banner` の規則の隣に追加:

```css
#notice {
  padding: 6px 12px;
  background: var(--vscode-inputValidation-warningBackground);
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder);
  font-size: 0.9em;
}
```

`src/extension.ts` の `toWebviewMessage` に分岐を追加:

```ts
  if (event.kind === 'notice') return { kind: 'notice', text: event.text };
```

- [ ] **Step 6: extension.ts を translate() へ差し替える**

`src/extension.ts` の import から `translateBlock` を外し、次を足す:

```ts
import { assertSendable, describeTarget, translate, type ProviderConfig } from './translate/provider';
```

セッション生成の直前へ、鍵の差し込みと事前検証を入れる:

```ts
  // 鍵は設定ではなく SecretStorage から。config には空で入っている。
  const secret = (await context.secrets.get('mdJaPreview.apiKey')) ?? '';
  const provider: ProviderConfig =
    config.provider.kind === 'openai'
      ? { ...config.provider, apiKey: secret }
      : config.provider;

  try {
    assertSendable(provider, config.cloudAllowed);
  } catch (error) {
    const text =
      error instanceof Error ? `設定を確かめてください: ${error.message}` : '設定が不正です。';
    events.push({ kind: 'banner', text });
    panel.post({ kind: 'banner', text });
    return;
  }

  if (provider.kind === 'openai') {
    const text = `原文を ${describeTarget(provider)} へ送信しています。`;
    events.push({ kind: 'notice', text });
    panel.post({ kind: 'notice', text });
  }
```

`TranslationSession` の生成を次へ変える:

```ts
  const session = new TranslationSession({
    model: provider.model,
    maxBlockChars: config.maxBlockChars,
    translate: (source, headingContext, signal) =>
      translate({ source, headingContext, config: provider, signal }),
    ...
  });
```

`return` で抜ける位置は、`panel` を作った後・`session` を作る前であること。パネルは開いた
まま、バナーだけ出して翻訳を始めない挙動にする。

- [ ] **Step 7: 全試験と型検査**

Run: `npm test && npm run build`
Expected: すべて PASS、ビルド成功

- [ ] **Step 8: 統合試験**

Run: `npm run test:integration`
Expected: 2 件 PASS（既定は ollama のままなので挙動は変わらない）

- [ ] **Step 9: コミット**

```bash
git add src/extension.ts src/session.ts src/panel/html.ts media/preview.js media/preview.css test/unit/session.test.ts
git commit -m "$(cat <<'MSG'
feat(extension): クラウドでの翻訳と常時表示の送信先バナー

許可が無い・鍵が無い・モデル名が無いときは、パネルを開いたままバナーだけ出して
翻訳を始めない。クラウドで動いている間は送信先ホストを常時表示する。

認証エラーのバナーに例外メッセージを埋め込まない。送信先が鍵をエコーする
可能性があり、そのまま画面へ出すと鍵が露出する。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: DPAPI による鍵の暗号化

**Files:**
- Create: `web/server/secret.ts`
- Test: `test/web/secret.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `PROTECTED_PREFIX = 'dpapi-current-user-v1:'`、`protect(value): Promise<string>`、`unprotect(value): Promise<string>`、`isProtected(value): boolean`。

- [ ] **Step 1: 失敗する試験を書く**

`test/web/secret.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROTECTED_PREFIX, isProtected, protect, unprotect } from '../../web/server/secret';

const windows = process.platform === 'win32';

test('暗号化した値は接頭辞と base64 になる', { skip: !windows }, async () => {
  const protectedValue = await protect('sk-test-1234567890');
  assert.ok(protectedValue.startsWith(PROTECTED_PREFIX));
  const encoded = protectedValue.slice(PROTECTED_PREFIX.length);
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
});

test('暗号文に平文が現れない', { skip: !windows }, async () => {
  const protectedValue = await protect('sk-test-1234567890');
  assert.equal(protectedValue.includes('sk-test-1234567890'), false);
});

test('暗号化して復号すると元へ戻る', { skip: !windows }, async () => {
  const original = 'sk-test-1234567890';
  assert.equal(await unprotect(await protect(original)), original);
});

test('日本語と記号も往復できる', { skip: !windows }, async () => {
  const original = 'キー:日本語/+=あ';
  assert.equal(await unprotect(await protect(original)), original);
});

test('空の値は暗号化しない', async () => {
  await assert.rejects(protect(''), /空/);
});

test('接頭辞の無い値は復号しない', async () => {
  await assert.rejects(unprotect('sk-plain-text'), /形式/);
});

test('壊れた base64 は復号しない', async () => {
  await assert.rejects(unprotect(`${PROTECTED_PREFIX}!!!not-base64!!!`), /不正|復号/);
});

test('保護済みかどうかを見分ける', () => {
  assert.equal(isProtected(`${PROTECTED_PREFIX}abc`), true);
  assert.equal(isProtected('sk-plain'), false);
  assert.equal(isProtected(''), false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/web/secret.test.ts"`
Expected: FAIL. `Cannot find module '.../web/server/secret'`

- [ ] **Step 3: secret.ts を書く**

`web/server/secret.ts`:

```ts
/**
 * API キーの保存用の暗号化。
 *
 * Windows の DPAPI（CurrentUser スコープ）を使う。同じ Windows ユーザー・同じ PC
 * でだけ復号できる。
 *
 * Node に DPAPI は無い。ネイティブモジュールはこの machine の Smart App Control が
 * 弾くため使えない。署名済みの powershell.exe を経由して呼ぶ。
 *
 * Windows 以外では明示的に失敗させる。黙って平文で保存しない。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROTECTED_PREFIX = 'dpapi-current-user-v1:';

export function isProtected(value: string): boolean {
  return value.startsWith(PROTECTED_PREFIX);
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('API キーの保存には Windows の DPAPI が必要です。');
  }
}

/**
 * PowerShell を走らせる。値は標準入力で渡す。
 * コマンドライン引数に載せると、他のプロセスから見える（Win32_Process の CommandLine）。
 */
async function runPowerShell(script: string, input: string): Promise<string> {
  const child = execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  child.child.stdin?.end(input, 'utf8');
  const { stdout } = await child;
  return stdout.trim();
}

const PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$plain = [Console]::In.ReadToEnd();',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($plain);',
  '$out = [Security.Cryptography.ProtectedData]::Protect(',
  '  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Convert]::ToBase64String($out)',
].join(' ');

const UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '$b64 = [Console]::In.ReadToEnd().Trim();',
  '$bytes = [Convert]::FromBase64String($b64);',
  '$out = [Security.Cryptography.ProtectedData]::Unprotect(',
  '  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))',
].join(' ');

export async function protect(value: string): Promise<string> {
  if (value === '') throw new Error('空の値は暗号化できません。');
  assertWindows();
  let encoded: string;
  try {
    encoded = await runPowerShell(PROTECT_SCRIPT, value);
  } catch (cause) {
    throw new Error('API キーの暗号化に失敗しました。', { cause });
  }
  if (encoded === '') throw new Error('API キーの暗号化に失敗しました。');
  return PROTECTED_PREFIX + encoded;
}

export async function unprotect(value: string): Promise<string> {
  if (!isProtected(value)) {
    throw new Error('保存された API キーの形式が不明です。登録し直してください。');
  }
  assertWindows();
  const encoded = value.slice(PROTECTED_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
    throw new Error('保存された API キーの暗号データが不正です。');
  }
  try {
    return await runPowerShell(UNPROTECT_SCRIPT, encoded);
  } catch (cause) {
    throw new Error('API キーを復号できません。登録し直してください。', { cause });
  }
}
```

**注意:** `protect()` は末尾を `trim()` するが、`unprotect()` は
`[Console]::Out.Write` で改行を付けずに書く。鍵の末尾に空白がある場合に壊さないため。
`runPowerShell` の `trim()` は `protect` の base64 にだけ効けばよいので、
`unprotect` 用に `trim` しない経路を用意すること。実装では `runPowerShell` に
`{ trim: boolean }` を渡すか、`unprotect` 側で `stdout` をそのまま返す別関数にする。

- [ ] **Step 4: 試験を通す**

Run: `npx tsx --test "test/web/secret.test.ts"`
Expected: PASS（8 件）

- [ ] **Step 5: コミット**

```bash
git add web/server/secret.ts test/web/secret.test.ts
git commit -m "$(cat <<'MSG'
feat(pdf-web): API キーを DPAPI で暗号化して保存する

Node に DPAPI は無く、ネイティブモジュールは Smart App Control が弾く。署名済みの
powershell.exe 経由で ProtectedData を呼ぶ。

値は標準入力で渡す。コマンドライン引数に載せると Win32_Process の CommandLine から
他のプロセスに見える。

Windows 以外では明示的に失敗させる。黙って平文で保存しない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: 設定ファイルと鍵の CLI

**Files:**
- Create: `web/server/settings-store.ts`
- Modify: `web/server/main.ts`（`--set-key` / `--clear-key`）
- Test: `test/web/settings-store.test.ts`

**Interfaces:**
- Consumes: Task 7 の `protect`・`unprotect`・`isProtected`。既存 `web/server/storage.ts` の `defaultDataDir`。
- Produces: `SettingsStore` クラス。`load(): Promise<StoredSettings>`、`setApiKey(raw): Promise<void>`、`clearApiKey(): Promise<void>`、`readApiKey(): Promise<string>`。`StoredSettings = { apiKey?: string }`。

- [ ] **Step 1: 失敗する試験を書く**

`test/web/settings-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsStore } from '../../web/server/settings-store';

const windows = process.platform === 'win32';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'settings-'));
  return { dir, store: new SettingsStore(dir) };
}

test('鍵が無ければ空文字を返す', async () => {
  const { dir, store: subject } = await store();
  try {
    assert.equal(await subject.readApiKey(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存した鍵を読み戻せる', { skip: !windows }, async () => {
  const { dir, store: subject } = await store();
  try {
    await subject.setApiKey('sk-test-1234567890');
    assert.equal(await subject.readApiKey(), 'sk-test-1234567890');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('設定ファイルに平文の鍵を書かない', { skip: !windows }, async () => {
  const { dir, store: subject } = await store();
  try {
    await subject.setApiKey('sk-test-1234567890');
    const raw = await readFile(join(dir, 'settings.json'), 'utf8');
    assert.equal(raw.includes('sk-test-1234567890'), false);
    assert.ok(raw.includes('dpapi-current-user-v1:'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('鍵を消せる', { skip: !windows }, async () => {
  const { dir, store: subject } = await store();
  try {
    await subject.setApiKey('sk-test-1234567890');
    await subject.clearApiKey();
    assert.equal(await subject.readApiKey(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空の鍵は保存しない', async () => {
  const { dir, store: subject } = await store();
  try {
    await assert.rejects(subject.setApiKey('  '), /空/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('平文で置かれた鍵は読まずに拒否する', async () => {
  const { dir, store: subject } = await store();
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ apiKey: 'sk-plain' }), 'utf8');
    await assert.rejects(subject.readApiKey(), /形式/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('壊れた JSON は空として扱う', async () => {
  const { dir, store: subject } = await store();
  try {
    await writeFile(join(dir, 'settings.json'), '{壊れている', 'utf8');
    assert.equal(await subject.readApiKey(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/web/settings-store.test.ts"`
Expected: FAIL. `Cannot find module '.../web/server/settings-store'`

- [ ] **Step 3: settings-store.ts を書く**

`web/server/settings-store.ts`:

```ts
/**
 * `settings.json` の読み書き。
 *
 * ここに入るのは API キーだけ。他の設定は環境変数で渡す。設定の保存先を増やさず、
 * 「鍵はここ、それ以外は環境変数」という一行の規則で済ませるため。
 *
 * 鍵は暗号化済みの形でしか書かない。平文で置かれていたら読まずに拒否する
 * （利用者が手で書いた場合に、気づかないまま平文が残り続けるのを避ける）。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isProtected, protect, unprotect } from './secret';

export interface StoredSettings {
  apiKey?: string;
}

export class SettingsStore {
  readonly #path: string;

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'settings.json');
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<StoredSettings> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as StoredSettings;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      // 壊れた設定で起動を止めない。鍵が無いのと同じ扱いにする。
      return {};
    }
  }

  async #save(settings: StoredSettings): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  async setApiKey(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === '') throw new Error('空の API キーは保存できません。');
    const settings = await this.load();
    settings.apiKey = await protect(trimmed);
    await this.#save(settings);
  }

  async clearApiKey(): Promise<void> {
    const settings = await this.load();
    if (settings.apiKey === undefined) return;
    delete settings.apiKey;
    if (Object.keys(settings).length === 0) {
      await rm(this.#path, { force: true });
      return;
    }
    await this.#save(settings);
  }

  async readApiKey(): Promise<string> {
    const settings = await this.load();
    const stored = settings.apiKey;
    if (stored === undefined || stored === '') return '';
    if (!isProtected(stored)) {
      throw new Error(
        '保存された API キーの形式が不明です。--set-key で登録し直してください。',
      );
    }
    return unprotect(stored);
  }
}
```

- [ ] **Step 4: 試験を通す**

Run: `npx tsx --test "test/web/settings-store.test.ts"`
Expected: PASS（7 件）

- [ ] **Step 5: CLI を足す**

`web/server/main.ts` の `main()` の先頭、`readSettings()` より前へ:

```ts
import { createInterface } from 'node:readline';
import { SettingsStore } from './settings-store';

/** 画面に出さずに 1 行読む。TTY でなければ拒否する。 */
async function readSecretLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('API キーは対話的にのみ入力できます（履歴やログへ残さないため）。');
  }
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // 入力をエコーしない。
  const output = rl as unknown as { _writeToOutput?: (text: string) => void };
  output._writeToOutput = () => undefined;
  try {
    const value = await new Promise<string>((resolve) => rl.question('', resolve));
    process.stdout.write('\n');
    return value;
  } finally {
    rl.close();
  }
}

async function manageKey(argv: string[], dataDir: string): Promise<number> {
  const store = new SettingsStore(dataDir);
  if (argv.includes('--clear-key')) {
    await store.clearApiKey();
    console.log('API キーを削除しました。');
    return 0;
  }
  const value = await readSecretLine('API キー（入力は表示されません）: ');
  await store.setApiKey(value);
  console.log(`API キーを暗号化して保存しました: ${store.path}`);
  return 0;
}
```

`main()` の中、`readSettings()` の直後へ:

```ts
  if (argv.includes('--set-key') || argv.includes('--clear-key')) {
    try {
      return await manageKey(argv, settings.dataDir);
    } catch (error) {
      console.error((error as Error).message);
      if (launcher) await holdWindow();
      return 1;
    }
  }
```

- [ ] **Step 6: 手で確かめる**

Run:
```bash
npm run build:web
node dist-web/server.cjs --set-key < /dev/null
```
Expected: `API キーは対話的にのみ入力できます` と出て終了コード 1

- [ ] **Step 7: 全試験**

Run: `npm run test:web && npm run typecheck:web`
Expected: すべて PASS

- [ ] **Step 8: コミット**

```bash
git add web/server/settings-store.ts web/server/main.ts test/web/settings-store.test.ts
git commit -m "$(cat <<'MSG'
feat(pdf-web): API キーの保存と --set-key / --clear-key

鍵を受け取る HTTP API は作らない。この app は API に起動時 token を要求し token を
ログに出さない posture で作ってあり、平文の鍵を受ける口を新設するとそれを下げる。

--set-key は TTY からのみ受け付け、入力をエコーしない。パイプ経由だと鍵が
シェル履歴やログへ残る。

平文で書かれた鍵は読まずに拒否する。気づかないまま平文が残り続けるのを避ける。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: Web サーバーを provider 対応にする

**Files:**
- Modify: `web/server/main.ts`（`ServerSettings`・`readSettings`・`startServer`）
- Modify: `web/server/session.ts`・`web/server/http.ts`（`OllamaConfig` → `ProviderConfig`）
- Modify: `web/server/translation.ts:313-331`
- Test: `test/web/main.test.ts`（追記）

**Interfaces:**
- Consumes: Task 4 の `ProviderConfig`・`assertSendable`・`describeTarget`、Task 8 の `SettingsStore`。
- Produces: `ServerSettings` に `provider: Omit<ProviderConfig, 'model'>` 相当と `cloudAllowed: boolean` を持たせる。`readSettings(env, defaultStaticRoot)` の戻り値の形が変わる。

- [ ] **Step 1: 失敗する試験を書く**

`test/web/main.test.ts` に追記:

```ts
test('既定はローカルの Ollama', () => {
  const settings = readSettings(env(), 'C:/tmp/dist-web');
  assert.equal(settings.provider.kind, 'ollama');
  assert.equal(settings.cloudAllowed, false);
});

test('PDF_JA_PROVIDER=openai でクラウドを選ぶ', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_CLOUD_ALLOWED: '1', PDF_JA_MODEL: 'gpt-test' }),
    'C:/tmp/dist-web',
  );
  assert.equal(settings.provider.kind, 'openai');
  assert.equal(settings.cloudAllowed, true);
  assert.equal(settings.model, 'gpt-test');
});

test('クラウドでも既定の送信先は OpenAI', () => {
  const settings = readSettings(env({ PDF_JA_PROVIDER: 'openai' }), 'C:/tmp/dist-web');
  if (settings.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(settings.provider.baseUrl, 'https://api.openai.com/v1');
});

test('PDF_JA_BASE_URL で送信先を差し替えられる', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_BASE_URL: 'https://example.openai.azure.com/openai/v1' }),
    'C:/tmp/dist-web',
  );
  if (settings.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(settings.provider.baseUrl, 'https://example.openai.azure.com/openai/v1');
});

test('クラウドを選んでも ollama の endpoint 検査で落ちない', () => {
  assert.doesNotThrow(() =>
    readSettings(
      env({ PDF_JA_PROVIDER: 'openai', PDF_JA_OLLAMA_ENDPOINT: 'http://127.0.0.1:11434' }),
      'C:/tmp/dist-web',
    ),
  );
});

test('ローカルのままなら従来どおり非ループバックを拒否する', () => {
  assert.throws(
    () => readSettings(env({ PDF_JA_OLLAMA_ENDPOINT: 'http://192.168.1.10:11434' }), 'C:/x'),
    /ループバック/,
  );
});

test('鍵は設定に持たせない（環境変数からも読まない）', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_API_KEY: 'sk-leak' }),
    'C:/tmp/dist-web',
  );
  assert.equal(JSON.stringify(settings).includes('sk-leak'), false);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/web/main.test.ts"`
Expected: FAIL。`settings.provider` が undefined

- [ ] **Step 3: readSettings を書き換える**

`web/server/main.ts`。`ServerSettings` を次へ変える:

```ts
export interface ServerSettings {
  port: number;
  dataDir: string;
  staticRoot: string;
  model: string;
  /** apiKey は空。起動時に SettingsStore から差し込む。 */
  provider: ProviderConfig;
  cloudAllowed: boolean;
  extractorKind: 'docker' | 'python';
  image: string;
  python: string;
  modelsDir: string;
  extractionTimeoutMs: number;
}
```

`readSettings` の該当部分:

```ts
export function readSettings(
  env: NodeJS.ProcessEnv = process.env,
  defaultStaticRoot = join(process.cwd(), 'dist-web'),
): ServerSettings {
  const python = env.PDF_JA_PYTHON ?? '';
  const kind = env.PDF_JA_PROVIDER === 'openai' ? 'openai' : 'ollama';
  const model = env.PDF_JA_MODEL ?? DEFAULT_MODEL;
  const temperature = number(env.PDF_JA_TEMPERATURE, 0.2);
  const timeoutMs = number(env.PDF_JA_REQUEST_TIMEOUT_MS, 120_000);

  const provider: ProviderConfig =
    kind === 'openai'
      ? {
          kind: 'openai',
          baseUrl: env.PDF_JA_BASE_URL ?? DEFAULT_BASE_URL,
          // 鍵は環境変数から読まない。SettingsStore からだけ入る。
          apiKey: '',
          model,
          temperature,
          timeoutMs,
        }
      : {
          kind: 'ollama',
          // ローカルのときだけ、従来どおりループバックを強制する。
          endpoint: assertLoopback(env.PDF_JA_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434'),
          model,
          think: env.PDF_JA_THINK === '1',
          temperature,
          timeoutMs,
        };

  return {
    port: number(env.PDF_JA_PORT, DEFAULT_PORT),
    dataDir: defaultDataDir(env),
    staticRoot: resolve(env.PDF_JA_STATIC_ROOT ?? defaultStaticRoot),
    model,
    provider,
    cloudAllowed: env.PDF_JA_CLOUD_ALLOWED === '1',
    extractorKind: python === '' ? 'docker' : 'python',
    image: env.PDF_JA_EXTRACTOR_IMAGE ?? DEFAULT_IMAGE,
    python,
    modelsDir: env.PDF_JA_MODELS_DIR ?? (python === '' ? '/models' : ''),
    extractionTimeoutMs: number(env.PDF_JA_EXTRACTION_TIMEOUT_MS, DEFAULT_EXTRACTION_TIMEOUT_MS),
  };
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
```

`assertLoopback` の export と実装はそのまま残す。既存試験がこれを直接呼んでいる。

- [ ] **Step 4: startServer で鍵を差し込み、検証する**

`startServer(settings)` の先頭へ:

```ts
  let provider = settings.provider;
  if (provider.kind === 'openai') {
    const apiKey = await new SettingsStore(settings.dataDir).readApiKey();
    provider = { ...provider, apiKey };
  }
  assertSendable(provider, settings.cloudAllowed);
```

以降、`createApp` へ渡す `connection: settings.connection` を `provider` へ置き換える。
`web/server/http.ts`・`web/server/session.ts`・`web/server/translation.ts` の
`Omit<OllamaConfig, 'model'>` と `OllamaConfig` を `ProviderConfig` へ読み替え、
`translateBlock` の呼び出しを `translate` へ替える。

`web/server/session.ts` の `#connection` はモデル名を差し替えて使っているため、
`{ ...this.#provider, model }` の形で組み直すこと。`kind` が保たれることを確認する。

**既存試験の道具立てを 4 箇所そろえる**（主張は変えない）。

| ファイル | 変更 |
|---|---|
| `test/web/session.test.ts:51` | `connection` に `kind: 'ollama'` を足す |
| `test/web/http.test.ts:95` | 同上 |
| `test/web/translation.test.ts:18-24` | `config` に `kind: 'ollama'` を足す |
| `test/web/main.test.ts:38-40,60` | `settings.connection.*` を `settings.provider.*` へ。期待値は変えない |

`test/web/translation.test.ts` の `deps.translate` に渡す偽実装は、引数の `config` の型が
`ProviderConfig` へ変わるだけで、構造は同じなのでそのまま通る。

- [ ] **Step 5: 試験を通す**

Run: `npm run test:web && npm run typecheck:web`
Expected: 既存 238 件 + 新規すべて PASS

- [ ] **Step 6: コミット**

```bash
git add web/server/ test/web/main.test.ts
git commit -m "$(cat <<'MSG'
feat(pdf-web): サーバーを provider 対応にする

assertLoopback は provider が ollama のときだけ適用する。openai では
assertSendable の検査（https 必須・許可必須・鍵必須・モデル必須）へ差し替える。

鍵は環境変数から読まない。SettingsStore からだけ入る。環境変数は ps や
プロセス一覧から見えることがある。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: 画面に送信先を常時表示する

**Files:**
- Modify: `web/shared/protocol.ts`（`Snapshot`）
- Modify: `web/server/session.ts`（`snapshot()`）
- Modify: `web/client/index.html:48` の隣
- Modify: `web/client/main.ts`
- Modify: `web/client/style.css`
- Test: `test/web/session.test.ts`（追記）

**Interfaces:**
- Consumes: Task 4 の `describeTarget`、Task 9 の `ProviderConfig`。
- Produces: `Snapshot` に `target: string`（ホスト名）と `cloud: boolean` を追加。

- [ ] **Step 1: 失敗する試験を書く**

`test/web/session.test.ts` に追記:

```ts
test('snapshot は送信先のホスト名を持つ', async (t) => {
  const { session } = await setup(t, [block('b0', 0, 1)], async () => 'ja', 'gpt-test', {
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    temperature: 0.2,
    timeoutMs: 1000,
  });
  const snapshot = session.snapshot();
  assert.equal(snapshot.target, 'api.openai.com');
  assert.equal(snapshot.cloud, true);
});

test('ローカルなら cloud は false', async (t) => {
  const { session } = await setup(t, [block('b0', 0, 1)], async () => 'ja', 'm1', {
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    think: false,
    temperature: 0.2,
    timeoutMs: 1000,
  });
  assert.equal(session.snapshot().cloud, false);
  assert.equal(session.snapshot().target, '127.0.0.1:11434');
});

test('snapshot に API キーが現れない', async (t) => {
  const { session } = await setup(t, [block('b0', 0, 1)], async () => 'ja', 'gpt-test', {
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-secret-value',
    model: 'gpt-test',
    temperature: 0.2,
    timeoutMs: 1000,
  });
  assert.equal(JSON.stringify(session.snapshot()).includes('sk-secret-value'), false);
});
```

既存 `test/web/session.test.ts:84` の `setup(t, blocks, translate, model?)` に**第 5 引数
`provider` を足して**使う（既定は同ファイル 51 行目の `connection`）。`setup` の中の
`new Session({ ... connection ... })` を `connection: provider ?? connection` へ変える。
既存の呼び出し側は引数を増やさないのでそのまま通る。

上の 3 件は `setup(t, [block('b0', 0, 1)], async () => 'ja', 'm1', <provider>)` の形で書き、
戻り値の `session.snapshot()` を見ること。

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/web/session.test.ts"`
Expected: FAIL。`snapshot.target` が undefined

- [ ] **Step 3: Snapshot を広げる**

`web/shared/protocol.ts` の `Snapshot` へ追加:

```ts
  /** 送信先のホスト名。鍵もパスも含めない。 */
  target: string;
  /** クラウドへ送っているか。画面の常時表示に使う。 */
  cloud: boolean;
```

`web/server/session.ts` の `snapshot()` の戻り値へ追加:

```ts
      target: describeTarget(this.#provider),
      cloud: this.#provider.kind === 'openai',
```

- [ ] **Step 4: 画面に出す**

`web/client/index.html` の `<p id="banner" ...>` の直前へ:

```html
<p id="cloud-notice" class="cloud-notice" data-testid="cloud-notice" hidden></p>
```

`web/client/main.ts` の snapshot 適用箇所へ:

```ts
  const cloudNotice = document.getElementById('cloud-notice') as HTMLElement;
  cloudNotice.textContent = snapshot.cloud
    ? `原文を ${snapshot.target} へ送信しています。`
    : '';
  cloudNotice.hidden = !snapshot.cloud;
```

`web/client/style.css` へ:

```css
.cloud-notice {
  margin: 0;
  padding: 6px 12px;
  background: #7c2d12;
  color: #fff7ed;
  font-size: 0.9em;
}
```

- [ ] **Step 5: 試験を通す**

Run: `npm run test:web && npm run typecheck:web && npm run build:web`
Expected: すべて PASS

- [ ] **Step 6: e2e が壊れていないことを確認する**

Run: `npm run test:e2e:web`
Expected: 22 件 PASS、1 件 skip（既定は ollama なので `cloud-notice` は hidden のまま）

- [ ] **Step 7: コミット**

```bash
git add web/shared/protocol.ts web/server/session.ts web/client/ test/web/session.test.ts
git commit -m "$(cat <<'MSG'
feat(pdf-web): クラウド動作中は送信先を常時表示する

Snapshot にホスト名と真偽値だけを載せる。鍵も、鍵の断片も、長さも返さない。
それを試験で固定した。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 11: preflight にクラウドの確認を足す

**Files:**
- Modify: `web/server/preflight.ts`
- Modify: `web/server/main.ts`（preflight 呼び出しの引数）
- Test: `test/web/preflight.test.ts`（追記）

**Interfaces:**
- Consumes: Task 4 の `ProviderConfig`、Task 8 の `SettingsStore`。既存 `judgePreflight`・`preflight`・`PreflightFacts`・`PreflightContext`。
- Produces: `PreflightFacts` に `cloud?: { allowed: boolean; hasKey: boolean; model: string; reachable: boolean }`、`PreflightContext` に `kind: 'ollama' | 'openai'` と `target: string` を追加。

- [ ] **Step 1: 失敗する試験を書く**

`test/web/preflight.test.ts` に追記:

```ts
function cloudContext(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return { ...context(), kind: 'openai', target: 'api.openai.com', ...overrides };
}

function cloudFacts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    ...facts(),
    cloud: { allowed: true, hasKey: true, model: 'gpt-test', reachable: true },
    ...overrides,
  };
}

test('クラウドで許可が無ければ致命', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: false, hasKey: true, model: 'gpt-test', reachable: true } }),
    cloudContext(),
  );
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.remedy ?? '', /PDF_JA_CLOUD_ALLOWED/);
});

test('クラウドで鍵が無ければ致命', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: true, hasKey: false, model: 'gpt-test', reachable: true } }),
    cloudContext(),
  );
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.remedy ?? '', /--set-key/);
});

test('クラウドでモデル名が無ければ致命', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: true, hasKey: true, model: '', reachable: true } }),
    cloudContext(),
  );
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.remedy ?? '', /PDF_JA_MODEL/);
});

test('クラウドへ届かないのは警告に留める', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: true, hasKey: true, model: 'gpt-test', reachable: false } }),
    cloudContext(),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'warning');
  assert.match(problems[0]?.title ?? '', /api\.openai\.com/);
});

test('クラウドでは Ollama の確認をしない', () => {
  const problems = judgePreflight(
    cloudFacts({ ollama: { reachable: false, models: [] } }),
    cloudContext(),
  );
  assert.deepEqual(problems, []);
});

test('ローカルではクラウドの確認をしない', () => {
  const problems = judgePreflight(
    facts({ cloud: { allowed: false, hasKey: false, model: '', reachable: false } }),
    context(),
  );
  assert.deepEqual(problems, []);
});

test('クラウドの問題に API キーを含めない', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: false, hasKey: true, model: 'gpt-test', reachable: true } }),
    cloudContext(),
  );
  for (const problem of problems) {
    assert.equal(problem.title.includes('sk-'), false);
    assert.equal(problem.remedy.includes('sk-'), false);
  }
});
```

既存 `context()` ヘルパー（`test/web/preflight.test.ts:21`）に
`kind: 'ollama'` と `target: '127.0.0.1:11434'` を足すこと。これで既存 21 件はそのまま通る。

既存の `'設定から探査先を決める（Docker）'` と `'PDF_JA_PYTHON があれば Python を探査する'`
の 2 件は `preflight()` を直接呼んでおり、`PreflightSettings` に項目が増えるため
引数を補う必要がある。それぞれの第 1 引数へ
`kind: 'ollama', target: '127.0.0.1:1', cloudAllowed: false, apiKey: ''` を足し、
第 2 引数の `probes` へ `cloud: async () => false` を足す。**主張は変えない。**

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/web/preflight.test.ts"`
Expected: FAIL（新規 7 件）

- [ ] **Step 3: judgePreflight を広げる**

`web/server/preflight.ts` の型を広げる:

```ts
export interface PreflightContext {
  image: string;
  python: string;
  endpoint: string;
  model: string;
  kind: 'ollama' | 'openai';
  /** 送信先のホスト名。表示にだけ使う。 */
  target: string;
}

export interface PreflightFacts {
  missingAssets: string[];
  extractor: ExtractorFacts;
  ollama: { reachable: boolean; models: string[] };
  cloud?: { allowed: boolean; hasKey: boolean; model: string; reachable: boolean };
}
```

`judgePreflight` の翻訳先の判定部分を、`context.kind` で分ける:

```ts
  if (context.kind === 'openai') {
    const cloud = facts.cloud;
    if (cloud === undefined) {
      fatal.push({
        level: 'fatal',
        title: 'クラウドの状態を確認できませんでした。',
        remedy: 'PDF_JA_PROVIDER の設定を確かめてください。',
      });
    } else if (!cloud.allowed) {
      fatal.push({
        level: 'fatal',
        title: `原文を ${context.target} へ送る許可がありません。`,
        remedy: 'PDF_JA_CLOUD_ALLOWED=1 を設定してください。原文が外部へ送られます。',
      });
    } else if (!cloud.hasKey) {
      fatal.push({
        level: 'fatal',
        title: 'API キーが登録されていません。',
        remedy: 'node dist-web/server.cjs --set-key で登録してください。',
      });
    } else if (cloud.model.trim() === '') {
      fatal.push({
        level: 'fatal',
        title: 'クラウドで使うモデル名が未設定です。',
        remedy: 'PDF_JA_MODEL にモデル名を設定してください。既定値はありません。',
      });
    } else if (!cloud.reachable) {
      warnings.push({
        level: 'warning',
        title: `${context.target} へ届きません（訳は出ません）`,
        remedy: '通信とモデル名、API キーを確かめてください。',
      });
    }
  } else if (!facts.ollama.reachable) {
    ...既存のまま...
  } else if (...モデル欠落...) {
    ...既存のまま...
  }
```

**注意:** 既存の Ollama 判定は `if (!facts.ollama.reachable)` から始まっている。これを
`else if` の枝へ丸ごと移すこと。既存 21 件の試験は `context()` が `kind: 'ollama'` を
返すので、そのまま通る。

- [ ] **Step 4: 探査を足す**

```ts
export async function probeCloud(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 5000,
): Promise<boolean> {
  if (apiKey === '') return false;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 応答本文は読まない。鍵やアカウント情報が混ざりうる。
    return response.ok;
  } catch {
    return false;
  }
}
```

`Probes` に `cloud(baseUrl: string, apiKey: string): Promise<boolean>` を足し、
`preflight()` の `PreflightSettings` に `kind`・`target`・`cloudAllowed`・`apiKey` を足して
`kind === 'openai'` のときだけ `probes.cloud()` を呼ぶ。`kind === 'ollama'` のときは
`probes.ollama()` だけを呼ぶ（クラウドへ無駄な通信をしない）。

- [ ] **Step 5: main.ts の呼び出しを合わせる**

`web/server/main.ts` の `preflight({...})` 呼び出しへ `kind`・`target`・`cloudAllowed`・
`apiKey` を渡す。`apiKey` は `SettingsStore.readApiKey()` の戻り値。読めなければ空文字を
渡す（`hasKey: false` として致命になる）。

- [ ] **Step 6: 試験を通す**

Run: `npm run test:web && npm run typecheck:web`
Expected: すべて PASS

- [ ] **Step 7: コミット**

```bash
git add web/server/preflight.ts web/server/main.ts test/web/preflight.test.ts
git commit -m "$(cat <<'MSG'
feat(pdf-web): preflight にクラウドの確認を足す

許可なし・鍵なし・モデル名なしは致命。疎通しないのは警告に留める（訳が出ない
だけでサーバーは立つ）。

疎通確認の応答本文は読まない。鍵やアカウント情報が混ざりうる。
ローカルのときはクラウドへ通信しない。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

### Task 12: 鍵が漏れないことの通し試験と docs

**Files:**
- Create: `test/web/no-key-leak.test.ts`
- Modify: `README.md`
- Modify: `docs/pdf-web.md`
- Modify: `docs/superpowers/specs/2026-09-18-cloud-provider-and-split-design.md`（状態を更新）

**Interfaces:**
- Consumes: 全タスクの成果。
- Produces: なし（検証と文書）。

- [ ] **Step 1: 失敗する試験を書く**

`test/web/no-key-leak.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeTarget } from '../../src/translate/provider';
import { judgePreflight } from '../../web/server/preflight';
import { readSettings } from '../../web/server/main';

const KEY = 'sk-canary-0123456789abcdef';

test('設定の丸ごとに鍵が現れない', () => {
  const settings = readSettings(
    {
      LOCALAPPDATA: 'C:/tmp/local',
      PDF_JA_PROVIDER: 'openai',
      PDF_JA_MODEL: 'gpt-test',
      PDF_JA_API_KEY: KEY,
      OPENAI_API_KEY: KEY,
    } as NodeJS.ProcessEnv,
    'C:/tmp/dist-web',
  );
  assert.equal(JSON.stringify(settings).includes(KEY), false);
});

test('送信先の表示に鍵が現れない', () => {
  const target = describeTarget({
    kind: 'openai',
    baseUrl: `https://api.openai.com/v1?key=${KEY}`,
    apiKey: KEY,
    model: 'gpt-test',
    temperature: 0.2,
    timeoutMs: 1000,
  });
  assert.equal(target.includes(KEY), false);
  assert.equal(target, 'api.openai.com');
});

test('preflight の問題文に鍵が現れない', () => {
  const problems = judgePreflight(
    {
      missingAssets: [],
      extractor: { kind: 'docker', daemon: true, image: true },
      ollama: { reachable: true, models: [] },
      cloud: { allowed: false, hasKey: true, model: 'gpt-test', reachable: false },
    },
    {
      image: 'x:1',
      python: '',
      endpoint: 'http://127.0.0.1:11434',
      model: 'gpt-test',
      kind: 'openai',
      target: 'api.openai.com',
    },
  );
  for (const problem of problems) {
    assert.equal(problem.title.includes(KEY), false);
    assert.equal(problem.remedy.includes(KEY), false);
  }
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npx tsx --test "test/web/no-key-leak.test.ts"`
Expected: 実装が正しければこの時点で PASS する。**PASS したら、わざと
`describeTarget` が `baseUrl` 全体を返すよう一時的に壊し、試験が FAIL することを
確認してから元へ戻すこと。** 失敗を見ていない試験は、何も守っていない。

- [ ] **Step 3: 起動ログに鍵が出ないことを手で確かめる**

```bash
npm run build:web
node dist-web/server.cjs --set-key      # sk-canary-0123456789abcdef を入力
PDF_JA_PROVIDER=openai PDF_JA_CLOUD_ALLOWED=1 PDF_JA_MODEL=gpt-test \
  node dist-web/server.cjs 2>&1 | tee /tmp/startup.log
grep -c 'sk-canary' /tmp/startup.log
```
Expected: `0`。確認後 `node dist-web/server.cjs --clear-key` で消す。

- [ ] **Step 4: 実キーで実翻訳を 1 回通す**

利用者に本物の API キーを `--set-key` で登録してもらい、小さな PDF を 1 本開いて
訳が出ることを確認する。**このキーはリポジトリにもログにも残さない。**
確認後、テスト用に登録したキーを残すかは利用者の判断に委ねる。

- [ ] **Step 5: docs を書き換える**

`README.md` と `docs/pdf-web.md` の「文書はこの machine から出ません」を
すべて次の表現へ揃える。

> 既定ではこの machine から出ません。クラウドを明示的に許可したときだけ、
> 原文が指定した送信先へ出ます。

`README.md` の VS Code 拡張の設定表へ `provider`・`baseUrl`・`cloudAllowed` を追加し、
「API キーはコマンド `md-ja: API キーを登録` で登録します。設定ファイルには書きません」
を明記する。

`docs/pdf-web.md` に「クラウドの LLM を使う」節を新設し、次を書く。

- `--set-key` / `--clear-key` の使い方と、TTY からのみ受け付けること
- `PDF_JA_PROVIDER` / `PDF_JA_BASE_URL` / `PDF_JA_CLOUD_ALLOWED` / `PDF_JA_MODEL`
- **クラウドの既定モデル名は無いこと**
- 鍵は DPAPI で暗号化され、同じ Windows ユーザー・同じ PC でだけ復号できること
- クラウドを使うと原文が送信先へ出ること。画面上部に常時表示されること

- [ ] **Step 6: 仕様の状態を更新する**

`docs/superpowers/specs/2026-09-18-cloud-provider-and-split-design.md` の 3 行目を
`- 状態: 段階 1 実装済み（2026-09-18）。段階 2・3 は未着手。` へ変える。

- [ ] **Step 7: 全部通す**

```bash
npm test && npm run typecheck:web && npm run test:web && npm run build && npm run build:web && npm run test:e2e:web && npm run test:integration
```
Expected: すべて PASS。件数を記録して報告する。

- [ ] **Step 8: コミット**

```bash
git add test/web/no-key-leak.test.ts README.md docs/
git commit -m "$(cat <<'MSG'
test(pdf-web): 鍵が外へ出ないことの通し試験と docs 更新

設定・送信先表示・preflight の問題文のいずれにも鍵が現れないことを固定する。
起動ログに出ないことは手で確認した（canary キーで grep）。

「文書はこの machine から出ません」を「既定では出ません。明示的に許可した
ときだけ出ます」へ書き換えた。

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## 完了条件

- `npm test`（118 + 新規）、`npm run test:web`（238 + 新規）、`npm run test:e2e:web`（22）、`npm run test:integration`（2）がすべて緑。
- 既定設定のままなら、挙動が従来と一切変わらない。
- クラウドは、許可・鍵・モデル名の 3 つが揃わない限り 1 バイトも送らない。
- 鍵が設定ファイル・HTTP 応答・ログ・例外メッセージ・画面表示のいずれにも現れない。
- 実キーでの実翻訳を 1 回通した。

## この計画が崩れたときの扱い

実装中に、この計画が前提にしている既存コードの形が違っていた場合（関数名・行番号・
ヘルパーの有無など）、**推測で進めずに止めて報告すること。** 行番号は 2026-09-18 時点の
ものであり、先行タスクのコミットでずれる。ずれ自体は問題ないが、*構造*が想定と違う
なら、それは計画の誤りであって実装の裁量で埋めてよいものではない。
