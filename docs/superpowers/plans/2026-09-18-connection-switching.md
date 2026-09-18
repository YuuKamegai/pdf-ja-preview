# 接続の登録と切り替え Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PDF 日本語プレビューで、登録済みの接続（ローカル Ollama / OpenAI 互換 / Azure OpenAI）を画面から選ぶだけで切り替えられるようにする。

**Architecture:** 純粋な検証層（`connection.ts`）、保存と復号を持つ層（`settings-store.ts`）、HTTP の口（`http.ts`）、生きているセッションへの反映（`session.ts`）に分ける。送信先・モデル・鍵・信頼境界は 1 つの「接続」にまとまり、環境変数は初回移行にだけ使う。

**Tech Stack:** TypeScript, Node.js HTTP, DPAPI（powershell.exe 経由）, node:test, Playwright, esbuild

**Spec:** `docs/superpowers/specs/2026-09-18-connection-switching-design.md`

## Global Constraints

- API キーをレスポンス、ログ、HTML、例外、テストスナップショットへ出さない。断りの文に受け取った値を含めない。
- 鍵は Windows DPAPI CurrentUser で暗号化して保存する。平文の fallback を作らない。
- `provider === 'ollama'` は `trust: 'loopback'` のみ、かつ送信先はループバックの `http`/`https` のみ。
- `provider === 'openai' | 'azure'` は `trust: 'cloud-allowed'` のみ。
- Azure の送信先は `https://<resource>.openai.azure.com/openai/v1` または `https://<resource>.services.ai.azure.com/openai/v1` だけ。`model` は deployment 名。
- 接続名は 1〜40 文字、制御文字なし、大小文字を無視して一意。
- `PDF_JA_PROVIDER` / `PDF_JA_BASE_URL` / `PDF_JA_MODEL` / `PDF_JA_CLOUD_ALLOWED` は初回移行にだけ使い、以後読まない。他の `PDF_JA_*` は従来どおり。
- `.vscode/launch.json` の利用者設定値を上書きしない。

---

### Task 1: 接続の型と検証（純粋関数）

**Files:**
- Create: `web/server/connection.ts`
- Test: `test/web/connection.test.ts`

**Interfaces:**
- Produces: `ProviderKind`, `Trust`, `Connection`, `ConnectionView`, `ConnectionError`, `MAX_CONNECTION_NAME`, `normalizeName()`, `validateConnection()`, `viewOf()`, `sameTarget()`, `toProviderConfig()`。
- Consumes: 既存 `src/translate/provider.ts` の `isLoopbackUrl()`、`normalizeAzureBaseUrl()`、`ProviderConfig`。

- [ ] **Step 1: 失敗する試験を書く。**

`test/web/connection.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectionError,
  normalizeName,
  sameTarget,
  toProviderConfig,
  validateConnection,
  viewOf,
  type Connection,
} from '../../web/server/connection';

const OLLAMA = {
  name: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b-q4_K_M',
  trust: 'loopback',
};

const AZURE = {
  name: 'azure-mini',
  provider: 'azure',
  baseUrl: 'https://example.services.ai.azure.com/openai/',
  model: 'gpt-test-deploy',
  trust: 'cloud-allowed',
};

test('接続名は前後の空白を落として受け取る', () => {
  assert.equal(normalizeName('  local  '), 'local');
});

test('空・長すぎ・制御文字入りの接続名を拒否する', () => {
  assert.throws(() => normalizeName('   '), ConnectionError);
  assert.throws(() => normalizeName('x'.repeat(41)), ConnectionError);
  assert.throws(() => normalizeName('a\nb'), ConnectionError);
  assert.throws(() => normalizeName(42), ConnectionError);
});

test('Ollama の接続は末尾の / を落として受け取る', () => {
  const connection = validateConnection({ ...OLLAMA, baseUrl: 'http://127.0.0.1:11434/' });
  assert.equal(connection.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(connection.trust, 'loopback');
});

// Mutation: Ollama にクラウド許可を認めると失敗する。
test('Ollama では cloud-allowed を指定できない', () => {
  assert.throws(
    () => validateConnection({ ...OLLAMA, trust: 'cloud-allowed' }),
    ConnectionError,
  );
});

// Mutation: Ollama のループバック制限を外すと失敗する。
test('Ollama の送信先はループバックだけ', () => {
  assert.throws(
    () => validateConnection({ ...OLLAMA, baseUrl: 'http://192.168.1.10:11434' }),
    ConnectionError,
  );
  assert.throws(
    () => validateConnection({ ...OLLAMA, baseUrl: 'ftp://127.0.0.1' }),
    ConnectionError,
  );
});

// Mutation: クラウドで許可を省けるようにすると失敗する。
test('クラウドの接続は送信許可が要る', () => {
  assert.throws(() => validateConnection({ ...AZURE, trust: 'loopback' }), ConnectionError);
});

test('Azure の送信先は /openai/v1 へ正規化して保存する', () => {
  const connection = validateConnection(AZURE);
  assert.equal(connection.baseUrl, 'https://example.services.ai.azure.com/openai/v1');
});

test('Azure の非公式ホストを拒否する', () => {
  assert.throws(
    () => validateConnection({ ...AZURE, baseUrl: 'https://api.openai.com/v1' }),
    ConnectionError,
  );
});

test('OpenAI 互換は https、ループバックなら http も許す', () => {
  assert.equal(
    validateConnection({
      name: 'oai',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      trust: 'cloud-allowed',
    }).baseUrl,
    'https://api.openai.com/v1',
  );
  assert.equal(
    validateConnection({
      name: 'localoai',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'gpt-test',
      trust: 'cloud-allowed',
    }).baseUrl,
    'http://127.0.0.1:8080/v1',
  );
  assert.throws(
    () =>
      validateConnection({
        name: 'oai',
        provider: 'openai',
        baseUrl: 'http://example.com/v1',
        model: 'gpt-test',
        trust: 'cloud-allowed',
      }),
    ConnectionError,
  );
});

test('知らない provider を拒否する', () => {
  assert.throws(() => validateConnection({ ...OLLAMA, provider: 'anthropic' }), ConnectionError);
});

test('モデルは空でも受け取る（選んだときに警告する）', () => {
  assert.equal(validateConnection({ ...OLLAMA, model: '' }).model, '');
  assert.equal(validateConnection({ ...OLLAMA, model: '  m1  ' }).model, 'm1');
});

// Mutation: view に鍵を載せると失敗する。
test('画面へ出す形に鍵は入らない', () => {
  const connection: Connection = {
    ...validateConnection(AZURE),
    apiKeyProtected: 'dpapi-current-user-v1:AAAA',
  };
  const view = viewOf(connection);
  assert.deepEqual(view, {
    name: 'azure-mini',
    provider: 'azure',
    target: 'example.services.ai.azure.com',
    model: 'gpt-test-deploy',
    trust: 'cloud-allowed',
    configured: true,
  });
  assert.equal(JSON.stringify(view).includes('dpapi'), false);
});

test('鍵が無ければ configured は false', () => {
  assert.equal(viewOf(validateConnection(AZURE)).configured, false);
});

// Mutation: 送信先が変わっても同じとみなすと失敗する（鍵の破棄規則が効かなくなる）。
test('provider か送信先が変われば別の送信先とみなす', () => {
  const current = validateConnection(AZURE);
  assert.equal(sameTarget(current, { provider: 'azure', baseUrl: current.baseUrl }), true);
  assert.equal(
    sameTarget(current, {
      provider: 'azure',
      baseUrl: 'https://other.services.ai.azure.com/openai/v1',
    }),
    false,
  );
  assert.equal(sameTarget(current, { provider: 'openai', baseUrl: current.baseUrl }), false);
});

test('ProviderConfig へ落とすと provider ごとの形になる', () => {
  const options = { temperature: 0.2, timeoutMs: 1000, think: false };

  const ollama = toProviderConfig(validateConnection(OLLAMA), '', options);
  assert.equal(ollama.kind, 'ollama');
  if (ollama.kind !== 'ollama') throw new Error('unreachable');
  assert.equal(ollama.endpoint, 'http://127.0.0.1:11434');
  assert.equal(ollama.think, false);

  const azure = toProviderConfig(validateConnection(AZURE), 'sk-canary', options);
  assert.equal(azure.kind, 'azure');
  if (azure.kind === 'ollama') throw new Error('unreachable');
  assert.equal(azure.apiKey, 'sk-canary');
  assert.equal(azure.model, 'gpt-test-deploy');
});
```

- [ ] **Step 2: 試験を走らせて、未実装で落ちることを確かめる。**

Run: `npm run test:web -- --test-name-pattern "接続|Ollama|Azure|OpenAI|provider|モデル|鍵|ProviderConfig"`
Expected: FAIL（`web/server/connection.ts` が無い）

- [ ] **Step 3: `web/server/connection.ts` を実装する。**

```ts
/**
 * 接続 1 件の形と、その検証。
 *
 * ここは純粋関数だけにする。ファイルも DPAPI も触らない。「この設定は送ってよいか」
 * の判断を 1 か所へ閉じ込め、保存経路と HTTP の口の両方から同じ規則を通す。
 */

import { isLoopbackUrl, normalizeAzureBaseUrl, type ProviderConfig } from '../../src/translate/provider';

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
  /** ホスト名だけ。パスも query も含めない。 */
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
    throw new ConnectionError('invalid-provider', 'provider は ollama / openai / azure のどれかです');
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
```

- [ ] **Step 4: 試験を走らせて通ることを確かめる。**

Run: `npm run typecheck:web && npm run test:web`
Expected: すべて PASS

- [ ] **Step 5: コミットする。**

```bash
git add web/server/connection.ts test/web/connection.test.ts
git commit -m "feat(pdf-web): 接続 1 件の形と検証を足す"
```

---

### Task 2: 接続の保存・移行・復号

**Files:**
- Modify: `web/server/settings-store.ts`（全面的に作り替える）
- Test: `test/web/settings-store.test.ts`（作り替える）

**Interfaces:**
- Produces: `SETTINGS_VERSION`, `StoredSettings`, `SettingsVersionError`, `SettingsStore` の `loadOrMigrate()` / `list()` / `add()` / `update()` / `remove()` / `select()` / `resolveSelected()`。
- Consumes: Task 1 の `Connection` / `ConnectionView` / `ConnectionError` / `validateConnection()` / `viewOf()` / `sameTarget()`、既存 `web/server/secret.ts` の `protect()` / `unprotect()` / `isProtected()`。

**注意:** 既存の `setApiKey()` / `readApiKey()` / `clearApiKey()` / `load()` は消える。Task 3・5 で呼び出し側も直すので、この Task の途中は `npm run typecheck:web` が赤いままでよい。Step 4 で緑にする。

- [ ] **Step 1: 失敗する試験を書く。**

`test/web/settings-store.test.ts` を次の内容で置き換える:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionError } from '../../web/server/connection';
import {
  SETTINGS_VERSION,
  SettingsStore,
  SettingsVersionError,
} from '../../web/server/settings-store';
import { protect } from '../../web/server/secret';

const windows = process.platform === 'win32';
const KEY = 'sk-canary-0123456789abcdef';

const LOCAL = {
  name: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b-q4_K_M',
  trust: 'loopback',
} as const;

const AZURE = {
  name: 'azure-mini',
  provider: 'azure',
  baseUrl: 'https://example.services.ai.azure.com/openai/v1',
  model: 'gpt-test-deploy',
  trust: 'cloud-allowed',
} as const;

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'connections-'));
  return {
    dir,
    store: new SettingsStore(dir),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** 移行の種。環境変数の解釈は main.ts の仕事なので、試験では直接渡す。 */
const seed = () => ({ connections: [{ ...LOCAL }], selected: 'local' });

test('設定が無ければ種から作って書き出す', async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    const settings = await subject.loadOrMigrate(seed);
    assert.equal(settings.version, SETTINGS_VERSION);
    assert.equal(settings.selected, 'local');
    assert.equal(settings.connections.length, 1);

    const raw = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
      version: number;
    };
    assert.equal(raw.version, SETTINGS_VERSION);
  } finally {
    await cleanup();
  }
});

// Mutation: v1 の鍵を捨てると失敗する。
test('v1 の暗号化鍵をそのまま接続へ引き継ぐ', async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ apiKey: 'dpapi-current-user-v1:AAAA' }),
      'utf8',
    );
    const settings = await subject.loadOrMigrate((legacy) => ({
      connections: [{ ...AZURE, apiKeyProtected: legacy }, { ...LOCAL }],
      selected: 'azure-mini',
    }));
    assert.equal(settings.connections[0]?.apiKeyProtected, 'dpapi-current-user-v1:AAAA');
    assert.equal(settings.selected, 'azure-mini');
  } finally {
    await cleanup();
  }
});

test('移行は一度だけ。二度目は保存済みを読む', async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await subject.add({ ...AZURE });
    const again = await subject.loadOrMigrate(() => {
      throw new Error('二度目に種を使ってはいけない');
    });
    assert.deepEqual(
      again.connections.map((connection) => connection.name),
      ['local', 'azure-mini'],
    );
  } finally {
    await cleanup();
  }
});

// Mutation: 未知の version を読み飛ばすと失敗する。
test('より新しい version は上書きせず起動を止める', async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    const original = JSON.stringify({ version: 3, selected: 'x', connections: [] });
    await writeFile(join(dir, 'settings.json'), original, 'utf8');
    await assert.rejects(subject.loadOrMigrate(seed), SettingsVersionError);
    assert.equal(await readFile(join(dir, 'settings.json'), 'utf8'), original);
  } finally {
    await cleanup();
  }
});

test('壊れた v2 は既定の 1 件で立ち上げる', async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 2, selected: 'x', connections: 'これは配列ではない' }),
      'utf8',
    );
    const settings = await subject.loadOrMigrate(seed);
    assert.equal(settings.connections.length, 1);
    assert.equal(settings.selected, 'local');
  } finally {
    await cleanup();
  }
});

test('選択が存在しない名前なら先頭を選ぶ', async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 2, selected: '居ない', connections: [{ ...LOCAL }] }),
      'utf8',
    );
    assert.equal((await subject.loadOrMigrate(seed)).selected, 'local');
  } finally {
    await cleanup();
  }
});

test('同じ名前は大小文字を無視して拒否する', async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await assert.rejects(subject.add({ ...LOCAL, name: 'LOCAL' }), ConnectionError);
  } finally {
    await cleanup();
  }
});

// Mutation: 最後の 1 件を消せるようにすると失敗する。
test('最後の 1 件は消せない', async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await assert.rejects(subject.remove('local'), ConnectionError);
  } finally {
    await cleanup();
  }
});

test('選択中を消したら残りの先頭を選ぶ', async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await subject.add({ ...AZURE });
    await subject.select('azure-mini');
    await subject.remove('azure-mini');
    assert.equal((await subject.list()).selected, 'local');
  } finally {
    await cleanup();
  }
});

test('知らない名前の選択は断る', async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await assert.rejects(subject.select('居ない'), ConnectionError);
  } finally {
    await cleanup();
  }
});

// Mutation: 送信先を変えても鍵を残すと失敗する。
test('送信先を変えたら、その接続の鍵を破棄する', { skip: !windows }, async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await subject.add({ ...AZURE }, KEY);
    assert.equal((await subject.list()).connections[1]?.configured, true);

    await subject.update('azure-mini', {
      ...AZURE,
      baseUrl: 'https://other.services.ai.azure.com/openai/v1',
    });
    assert.equal((await subject.list()).connections[1]?.configured, false);
  } finally {
    await cleanup();
  }
});

test('送信先が同じなら鍵を保つ', { skip: !windows }, async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await subject.add({ ...AZURE }, KEY);
    await subject.update('azure-mini', { ...AZURE, model: 'other-deploy' });
    assert.equal((await subject.list()).connections[1]?.configured, true);
  } finally {
    await cleanup();
  }
});

test('apiKey に null を渡すと鍵だけ消す', { skip: !windows }, async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await subject.add({ ...AZURE }, KEY);
    await subject.update('azure-mini', { ...AZURE }, null);
    assert.equal((await subject.list()).connections[1]?.configured, false);
  } finally {
    await cleanup();
  }
});

// Mutation: 一覧へ鍵を載せると失敗する。
test('一覧にも設定ファイルにも平文の鍵は出ない', { skip: !windows }, async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await subject.add({ ...AZURE }, KEY);
    assert.equal(JSON.stringify(await subject.list()).includes(KEY), false);
    assert.equal((await readFile(join(dir, 'settings.json'), 'utf8')).includes(KEY), false);
  } finally {
    await cleanup();
  }
});

test('選択中の接続と復号した鍵を返す', { skip: !windows }, async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    await subject.add({ ...AZURE }, KEY);
    await subject.select('azure-mini');
    const resolved = await subject.resolveSelected();
    assert.equal(resolved.connection.name, 'azure-mini');
    assert.equal(resolved.apiKey, KEY);
  } finally {
    await cleanup();
  }
});

test('鍵が無ければ空文字を返す', async () => {
  const { store: subject, cleanup } = await store();
  try {
    await subject.loadOrMigrate(seed);
    const resolved = await subject.resolveSelected();
    assert.equal(resolved.connection.name, 'local');
    assert.equal(resolved.apiKey, '');
  } finally {
    await cleanup();
  }
});

test('復号できない鍵は未登録として扱う', async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 2,
        selected: 'azure-mini',
        connections: [{ ...AZURE, apiKeyProtected: 'dpapi-current-user-v1:!!!not-base64!!!' }],
      }),
      'utf8',
    );
    await subject.loadOrMigrate(seed);
    assert.equal((await subject.resolveSelected()).apiKey, '');
  } finally {
    await cleanup();
  }
});

test('平文で書かれた鍵は読まない', async () => {
  const { dir, store: subject, cleanup } = await store();
  try {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 2,
        selected: 'azure-mini',
        connections: [{ ...AZURE, apiKeyProtected: KEY }],
      }),
      'utf8',
    );
    await subject.loadOrMigrate(seed);
    assert.equal((await subject.resolveSelected()).apiKey, '');
  } finally {
    await cleanup();
  }
});

test('暗号文は接頭辞つきで保存される', { skip: !windows }, async () => {
  const protectedValue = await protect(KEY);
  assert.match(protectedValue, /^dpapi-current-user-v1:/);
});
```

- [ ] **Step 2: 試験を走らせて落ちることを確かめる。**

Run: `npm run test:web -- --test-name-pattern "接続|鍵|移行|version|選択"`
Expected: FAIL（`loadOrMigrate` などが無い）

- [ ] **Step 3: `web/server/settings-store.ts` を書き換える。**

```ts
/**
 * `settings.json` の読み書き。
 *
 * 持つのは「登録済みの接続一覧」と「いま選んでいる接続」だけ。ポートや抽出器の
 * 設定は環境変数のまま置く。ここが「どの LLM へ送るか」の唯一の真実である。
 *
 * 鍵は暗号化済みの形でしか書かない。平文で置かれていたら読まずに未登録として扱う
 * （利用者が手で書いた場合に、気づかないまま平文が残り続けるのを避ける）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ConnectionError,
  normalizeName,
  validateConnection,
  viewOf,
  type Connection,
  type ConnectionInput,
  type ConnectionView,
} from './connection';
import { isProtected, protect, unprotect } from './secret';

export const SETTINGS_VERSION = 2;

export interface StoredSettings {
  version: number;
  selected: string;
  connections: Connection[];
}

/** より新しい版で作られた設定。上書きせず起動を止める。 */
export class SettingsVersionError extends Error {
  constructor(version: number) {
    super(
      `設定ファイルがより新しい版（version ${version}）で作られています。` +
        'この版では読めません。新しい版を使うか、設定ファイルを退避してください。',
    );
    this.name = 'SettingsVersionError';
  }
}

export type MigrationSeed = (legacyApiKeyProtected: string | undefined) => {
  connections: Connection[];
  selected: string;
};

/** 保存されている 1 件を、信用せずに読み直す。読めなければ undefined。 */
function parseStored(raw: unknown): Connection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  let base: Omit<Connection, 'apiKeyProtected'>;
  try {
    base = validateConnection(record as unknown as ConnectionInput);
  } catch {
    return undefined;
  }
  const stored = record.apiKeyProtected;
  return typeof stored === 'string' && stored !== ''
    ? { ...base, apiKeyProtected: stored }
    : base;
}

export class SettingsStore {
  readonly #path: string;
  #settings: StoredSettings | undefined;

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'settings.json');
  }

  get path(): string {
    return this.#path;
  }

  async #readRaw(): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      // 壊れた設定で起動を止めない。無いのと同じ扱いにする。
      return undefined;
    }
  }

  async #save(settings: StoredSettings): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    this.#settings = settings;
  }

  /**
   * 読み込む。v1 またはファイル無しなら、渡された種で一度だけ移行して書き出す。
   * より新しい version なら投げる（上書きしない）。
   */
  async loadOrMigrate(seed: MigrationSeed): Promise<StoredSettings> {
    if (this.#settings) return this.#settings;

    const raw = await this.#readRaw();
    const version = raw?.version;

    if (typeof version === 'number' && version > SETTINGS_VERSION) {
      throw new SettingsVersionError(version);
    }

    if (typeof version === 'number' && version === SETTINGS_VERSION) {
      const list = Array.isArray(raw?.connections) ? raw.connections : [];
      const connections = list
        .map((entry) => parseStored(entry))
        .filter((entry): entry is Connection => entry !== undefined);
      if (connections.length > 0) {
        const selected =
          typeof raw?.selected === 'string' &&
          connections.some((connection) => connection.name === raw.selected)
            ? raw.selected
            : connections[0].name;
        this.#settings = { version: SETTINGS_VERSION, selected, connections };
        return this.#settings;
      }
      // 中身が壊れている。種で立ち上げ直す。
    }

    const legacy = typeof raw?.apiKey === 'string' && raw.apiKey !== '' ? raw.apiKey : undefined;
    const built = seed(legacy);
    const settings: StoredSettings = {
      version: SETTINGS_VERSION,
      selected: built.selected,
      connections: built.connections,
    };
    await this.#save(settings);
    return settings;
  }

  #current(): StoredSettings {
    if (!this.#settings) throw new Error('loadOrMigrate() を先に呼んでください');
    return this.#settings;
  }

  #find(name: string): number {
    const wanted = name.toLowerCase();
    return this.#current().connections.findIndex(
      (connection) => connection.name.toLowerCase() === wanted,
    );
  }

  async list(): Promise<{ selected: string; connections: ConnectionView[] }> {
    const settings = this.#current();
    return {
      selected: settings.selected,
      connections: settings.connections.map((connection) => viewOf(connection)),
    };
  }

  /** 名前で 1 件引く。鍵の暗号文を含むので、外へは出さないこと。 */
  get(name: string): Connection | undefined {
    const index = this.#find(name);
    return index < 0 ? undefined : this.#current().connections[index];
  }

  async add(input: ConnectionInput, apiKey?: string | null): Promise<void> {
    const next = validateConnection(input);
    if (this.#find(next.name) >= 0) {
      throw new ConnectionError('duplicate-name', `その接続名は既にあります: ${next.name}`);
    }
    const connection: Connection = { ...next };
    if (typeof apiKey === 'string') connection.apiKeyProtected = await protect(apiKey);
    const settings = this.#current();
    await this.#save({ ...settings, connections: [...settings.connections, connection] });
  }

  async update(name: string, input: ConnectionInput, apiKey?: string | null): Promise<void> {
    const index = this.#find(normalizeName(name));
    if (index < 0) throw new ConnectionError('unknown-connection', 'その接続はありません');
    const settings = this.#current();
    const current = settings.connections[index];
    const next = validateConnection(input);

    const renamed = this.#find(next.name);
    if (renamed >= 0 && renamed !== index) {
      throw new ConnectionError('duplicate-name', `その接続名は既にあります: ${next.name}`);
    }

    const connection: Connection = { ...next };
    // 送信先が変わったら古い鍵を持ち越さない。
    if (
      current.provider === next.provider &&
      current.baseUrl === next.baseUrl &&
      apiKey === undefined &&
      current.apiKeyProtected !== undefined
    ) {
      connection.apiKeyProtected = current.apiKeyProtected;
    }
    if (typeof apiKey === 'string') connection.apiKeyProtected = await protect(apiKey);

    const connections = [...settings.connections];
    connections[index] = connection;
    const selected = settings.selected === current.name ? connection.name : settings.selected;
    await this.#save({ ...settings, selected, connections });
  }

  async remove(name: string): Promise<void> {
    const index = this.#find(normalizeName(name));
    if (index < 0) throw new ConnectionError('unknown-connection', 'その接続はありません');
    const settings = this.#current();
    if (settings.connections.length <= 1) {
      throw new ConnectionError('last-connection', '最後の 1 件は削除できません');
    }
    const connections = settings.connections.filter((_, at) => at !== index);
    const selected = connections.some((connection) => connection.name === settings.selected)
      ? settings.selected
      : connections[0].name;
    await this.#save({ ...settings, selected, connections });
  }

  async select(name: string): Promise<void> {
    const index = this.#find(normalizeName(name));
    if (index < 0) throw new ConnectionError('unknown-connection', 'その接続はありません');
    const settings = this.#current();
    await this.#save({ ...settings, selected: settings.connections[index].name });
  }

  /** 選択中の接続と、復号した鍵。読めない鍵は未登録として扱う。 */
  async resolveSelected(): Promise<{ connection: Connection; apiKey: string }> {
    const settings = this.#current();
    const connection =
      settings.connections.find((entry) => entry.name === settings.selected) ??
      settings.connections[0];
    return { connection, apiKey: await this.#decrypt(connection) };
  }

  async #decrypt(connection: Connection): Promise<string> {
    const stored = connection.apiKeyProtected;
    if (stored === undefined || stored === '' || !isProtected(stored)) return '';
    try {
      return await unprotect(stored);
    } catch {
      // 読めない鍵は未登録として扱う。内容は例外にもログにも出さない。
      return '';
    }
  }
}
```

- [ ] **Step 4: 型検査と試験を通す。**

`web/server/main.ts` と `web/server/http.ts` がまだ古い口（`readApiKey` など）を呼んでいるので、この時点では `npm run typecheck:web` が落ちる。Task 3・5 でそれぞれ直す。ここでは対象の試験だけ確かめる。

Run: `npm run test:web -- --test-name-pattern "接続|鍵|移行|version|選択|暗号"`
Expected: すべて PASS

- [ ] **Step 5: コミットする。**

```bash
git add web/server/settings-store.ts test/web/settings-store.test.ts
git commit -m "feat(pdf-web): settings.json を接続一覧へ作り替える"
```

---

### Task 3: 接続 API

**Files:**
- Modify: `web/server/http.ts`
- Test: `test/web/http.test.ts`

**Interfaces:**
- Produces: `ConnectionControl`（`AppDeps.connections`）、`GET/POST/PUT/DELETE /api/connections`、`PUT /api/connections/selected`、`POST /api/connections/<name>/test`。
- Consumes: Task 1 の `ConnectionError` / `ConnectionView`、Task 2 の `SettingsStore`。
- 削除: `CloudKeyControl`、`AppDeps.cloudKey`、`GET/PUT/DELETE /api/settings/api-key`。

- [ ] **Step 1: 失敗する試験を書く。**

`test/web/http.test.ts` の「---- API キー ----」節（`CANARY` の定義から末尾まで）を、次で置き換える:

```ts
// ---- 接続 -----------------------------------------------------------------

const CANARY = 'sk-canary-0123456789abcdef';

const LOCAL_VIEW = {
  name: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'm1',
  trust: 'loopback',
};

const CLOUD_VIEW = {
  name: 'cloud',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-test',
  trust: 'cloud-allowed',
};

/** 覚えているだけの接続置き場。DPAPI を使わずに API の契約だけを見る。 */
function fakeConnections() {
  const keys = new Map<string, string>();
  let entries = [{ ...LOCAL_VIEW }];
  let selected = 'local';
  const viewOf = (entry: (typeof entries)[number]) => ({
    name: entry.name,
    provider: entry.provider,
    target: new URL(entry.baseUrl).host,
    model: entry.model,
    trust: entry.trust,
    configured: (keys.get(entry.name) ?? '') !== '',
  });
  const control: ConnectionControl = {
    list: () => Promise.resolve({ selected, connections: entries.map(viewOf) }),
    add: (input, apiKey) => {
      entries = [...entries, { ...(input as (typeof entries)[number]) }];
      if (typeof apiKey === 'string') keys.set(String(input.name), apiKey);
      return Promise.resolve();
    },
    update: (name, input, apiKey) => {
      entries = entries.map((entry) =>
        entry.name === name ? { ...(input as (typeof entries)[number]) } : entry,
      );
      if (apiKey === null) keys.delete(name);
      if (typeof apiKey === 'string') keys.set(name, apiKey);
      return Promise.resolve();
    },
    remove: (name) => {
      entries = entries.filter((entry) => entry.name !== name);
      keys.delete(name);
      if (!entries.some((entry) => entry.name === selected)) selected = entries[0].name;
      return Promise.resolve();
    },
    select: (name) => {
      selected = name;
      return Promise.resolve();
    },
    test: (name) => Promise.resolve({ ok: keys.has(name), detail: `${name} を試しました` }),
    resolveSelected: () => {
      const entry = entries.find((candidate) => candidate.name === selected) ?? entries[0];
      const apiKey = keys.get(entry.name) ?? '';
      return Promise.resolve({
        name: entry.name,
        model: entry.model,
        connection:
          entry.provider === 'ollama'
            ? {
                kind: 'ollama' as const,
                endpoint: entry.baseUrl,
                think: false,
                temperature: 0.2,
                timeoutMs: 1000,
              }
            : {
                kind: 'openai' as const,
                baseUrl: entry.baseUrl,
                apiKey,
                temperature: 0.2,
                timeoutMs: 1000,
              },
      });
    },
  };
  return { control, keys, select: (name: string) => void (selected = name) };
}

test('接続の一覧は鍵を載せず、選択中を返す', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });

  const response = await call('/api/connections');
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    selected: string;
    connections: { name: string; target: string; configured: boolean }[];
  };
  assert.equal(body.selected, 'local');
  assert.deepEqual(body.connections[0], {
    name: 'local',
    provider: 'ollama',
    target: '127.0.0.1:11434',
    model: 'm1',
    trust: 'loopback',
    configured: false,
  });
});

test('接続を追加すると鍵は保存されるが応答に出ない', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });

  const response = await call('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...CLOUD_VIEW, apiKey: CANARY }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes(CANARY), false);
  assert.equal(connections.keys.get('cloud'), CANARY);
});

test('制御文字を含む鍵は 400', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  const response = await call('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...CLOUD_VIEW, apiKey: 'sk-a\nb' }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.equal(body.error.message.includes('sk-a'), false);
});

test('選択を切り替えられ、知らない名前は 404', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  await call('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...CLOUD_VIEW, apiKey: CANARY }),
  });

  const ok = await call('/api/connections/selected', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cloud' }),
  });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { selected: string }).selected, 'cloud');

  const missing = await call('/api/connections/selected', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '居ない' }),
  });
  assert.equal(missing.status, 404);
});

test('接続テストは保存済みの名前に対してだけ動く', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  const response = await call('/api/connections/local/test', { method: 'POST' });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; detail: string };
  assert.equal(body.ok, false);
  assert.equal(body.detail.includes(CANARY), false);
});

test('名前は URL へ符号化して渡せる', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  await call('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...CLOUD_VIEW, name: '社内 / 検証' }),
  });
  const response = await call(
    `/api/connections/${encodeURIComponent('社内 / 検証')}`,
    { method: 'DELETE' },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { connections: { name: string }[] };
  assert.deepEqual(
    body.connections.map((connection) => connection.name),
    ['local'],
  );
});

test('鍵 API は無くなっている', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  assert.equal((await call('/api/settings/api-key')).status, 404);
});

test('鍵が未登録ならセッションを作れない', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  await call('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...CLOUD_VIEW }),
  });
  await call('/api/connections/selected', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cloud' }),
  });

  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const response = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId }),
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'no-api-key');
});
```

`startServer` の options に `connections?: ConnectionControl` を足し、`resolveConnection` / `cloudKey` の受け渡しを次へ差し替える:

```ts
    connections: options.connections ?? fakeConnections().control,
```

併せて `import type { CloudKeyControl }` を `import type { ConnectionControl }` に変える。

- [ ] **Step 2: 試験を走らせて落ちることを確かめる。**

Run: `npm run test:web -- --test-name-pattern "接続|鍵 API|セッションを作れない"`
Expected: FAIL（`/api/connections` が 404）

- [ ] **Step 3: `web/server/http.ts` を直す。**

`CloudKeyControl` と `apiKeyStatus` / `getApiKey` / `putApiKey` / `deleteApiKey` と `/api/settings/api-key` の route を削除し、次を足す。

```ts
import type { ConnectionInput, ConnectionView } from './connection';
import { ConnectionError } from './connection';

/** 接続の登録・選択・試験。鍵そのものは決して外へ返さない。 */
export interface ConnectionControl {
  list(): Promise<{ selected: string; connections: ConnectionView[] }>;
  add(input: ConnectionInput, apiKey?: string | null): Promise<void>;
  update(name: string, input: ConnectionInput, apiKey?: string | null): Promise<void>;
  remove(name: string): Promise<void>;
  select(name: string): Promise<void>;
  test(name: string): Promise<{ ok: boolean; detail: string }>;
  /** 選択中の接続から、いま送るときの設定とモデルを組む。 */
  resolveSelected(): Promise<{ name: string; model: string; connection: ProviderConnection }>;
}
```

`AppDeps` の `resolveConnection` と `cloudKey` を `connections: ConnectionControl;` 1 本へ置き換える。

route（`sessions` の前）:

```ts
    if (parts[0] === 'connections') {
      if (parts.length === 1 && method === 'GET') {
        request.resume();
        return listConnections(response);
      }
      if (parts.length === 1 && method === 'POST') return addConnection(request, response);
      if (parts.length === 2 && parts[1] === 'selected' && method === 'PUT') {
        return selectConnection(request, response);
      }
      const name = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);
      if (name !== undefined) {
        if (parts.length === 2 && method === 'PUT') return updateConnection(request, response, name);
        if (parts.length === 2 && method === 'DELETE') {
          request.resume();
          return removeConnection(response, name);
        }
        if (parts.length === 3 && parts[2] === 'test' && method === 'POST') {
          request.resume();
          return testConnection(response, name);
        }
      }
    }
```

ハンドラー:

```ts
  // ---- 接続 ---------------------------------------------------------------

  /**
   * 受け取った鍵を確かめる。
   *
   * ヘッダーに載せる値なので、制御文字（改行を含む）が混ざったものは受け取らない。
   * 拒否の理由は書くが、受け取った値そのものは決して返さない。
   */
  function cleanApiKey(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string') {
      throw new ProtocolContractError('invalid-api-key', 'apiKey を文字列で送ってください');
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new ProtocolContractError('invalid-api-key', 'API キーが空です');
    }
    if (new RegExp('[\\u0000-\\u001f\\u007f]').test(trimmed)) {
      throw new ProtocolContractError('invalid-api-key', 'API キーに改行や制御文字は使えません');
    }
    return trimmed;
  }

  function connectionInput(body: unknown): ConnectionInput {
    const raw = (body ?? {}) as Record<string, unknown>;
    return {
      name: raw.name,
      provider: raw.provider,
      baseUrl: raw.baseUrl,
      model: raw.model,
      trust: raw.trust,
    };
  }

  async function sendConnections(response: http.ServerResponse): Promise<void> {
    sendJson(response, 200, await deps.connections.list());
  }

  function connectionFailure(response: http.ServerResponse, error: unknown): boolean {
    if (!(error instanceof ConnectionError)) return false;
    const status = error.code === 'unknown-connection' ? 404 : 400;
    sendError(response, status, error.code, error.message);
    return true;
  }

  async function listConnections(response: http.ServerResponse): Promise<void> {
    await sendConnections(response);
  }

  async function addConnection(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const apiKey = cleanApiKey(body.apiKey);
    try {
      await deps.connections.add(connectionInput(body), apiKey);
    } catch (error) {
      if (connectionFailure(response, error)) return;
      throw error;
    }
    await sendConnections(response);
  }

  async function updateConnection(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    name: string,
  ): Promise<void> {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const apiKey = cleanApiKey(body.apiKey);
    try {
      await deps.connections.update(name, connectionInput(body), apiKey);
    } catch (error) {
      if (connectionFailure(response, error)) return;
      throw error;
    }
    await applySelectedConnection();
    await sendConnections(response);
  }

  async function removeConnection(
    response: http.ServerResponse,
    name: string,
  ): Promise<void> {
    try {
      await deps.connections.remove(name);
    } catch (error) {
      if (connectionFailure(response, error)) return;
      throw error;
    }
    await applySelectedConnection();
    await sendConnections(response);
  }

  async function selectConnection(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    if (typeof body.name !== 'string') {
      throw new ProtocolContractError('invalid-body', 'name を文字列で送ってください');
    }
    try {
      await deps.connections.select(body.name);
    } catch (error) {
      if (connectionFailure(response, error)) return;
      throw error;
    }
    await applySelectedConnection();
    await sendConnections(response);
  }

  async function testConnection(response: http.ServerResponse, name: string): Promise<void> {
    try {
      sendJson(response, 200, await deps.connections.test(name));
    } catch (error) {
      if (connectionFailure(response, error)) return;
      throw error;
    }
  }
```

`applySelectedConnection()` は Task 4 で実装する。この Task では次の仮置きを入れ、Task 4 で中身を入れる。

```ts
  /** 選択中の接続を、開いているセッションへ配る。中身は Task 4 で入れる。 */
  async function applySelectedConnection(): Promise<void> {
    await deps.connections.resolveSelected();
  }
```

`postSession` の接続解決を差し替える:

```ts
    let resolved: { name: string; model: string; connection: ProviderConnection };
    try {
      resolved = await deps.connections.resolveSelected();
    } catch (error) {
      return sendError(response, 409, 'not-sendable', (error as Error).message);
    }
    if (resolved.connection.kind !== 'ollama' && resolved.connection.apiKey.trim() === '') {
      return sendError(
        response,
        409,
        'no-api-key',
        'API キーが登録されていません。画面の「接続を管理」から登録してください。',
      );
    }
```

`new Session({...})` へ渡す値を `connection: resolved.connection, model: resolved.model` にする。`body.model` は使わない（Task 4 で protocol からも消す）。

- [ ] **Step 4: 対象の試験を通す。**

Run: `npm run test:web -- --test-name-pattern "接続|鍵 API|セッションを作れない"`
Expected: すべて PASS（`main.ts` 由来の型エラーは Task 5 まで残る）

- [ ] **Step 5: コミットする。**

```bash
git add web/server/http.ts test/web/http.test.ts
git commit -m "feat(pdf-web): 接続の登録・選択・試験を API にする"
```

---

### Task 4: 切り替えを、開いているセッションへ配る

**Files:**
- Modify: `web/server/session.ts`
- Modify: `web/server/http.ts`
- Modify: `web/shared/protocol.ts`
- Test: `test/web/session.test.ts`
- Test: `test/web/http.test.ts`
- Test: `test/web/client-state.test.ts`

**Interfaces:**
- Produces: `Session.setConnection(connection: ProviderConnection, model: string): void`、`Snapshot.connection: string`。
- 削除: `Session.setModel()`、`CreateSessionRequest.model`、`PatchSessionRequest.model`。
- Consumes: Task 3 の `ConnectionControl.resolveSelected()`。

- [ ] **Step 1: 失敗する試験を書く。**

`test/web/session.test.ts` の末尾へ足す（既存の `session()` ヘルパーの形に合わせ、`setModel` を使っている既存試験は `setConnection` へ書き換える）:

```ts
const CLOUD: ProviderConnection = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-canary-0123456789abcdef',
  temperature: 0.2,
  timeoutMs: 1000,
};

// Mutation: 切り替えで世代を上げないと失敗する。
test('接続を切り替えると世代が上がり、新しい送信先で訳す', async () => {
  const seen: ProviderConfig[] = [];
  const subject = session({
    translate: async (_block, config) => {
      seen.push(config);
      return '訳';
    },
  });
  subject.start();
  await settle();
  const before = subject.generation;

  subject.setConnection(CLOUD, 'gpt-test');
  await settle();

  assert.ok(subject.generation > before);
  assert.equal(subject.snapshot().cloud, true);
  assert.equal(subject.snapshot().target, 'api.openai.com');
  assert.equal(subject.snapshot().model, 'gpt-test');
  assert.ok(seen.some((config) => config.kind === 'openai'));
});

// Mutation: 古い接続への送信を止めないと失敗する。
test('切り替えると、古い接続への実行中の翻訳は打ち切られる', async () => {
  const aborted: boolean[] = [];
  const subject = session({
    translate: (_block, _config, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(true);
          reject(new Error('中断'));
        });
      }),
  });
  subject.start();
  await settle();

  subject.setConnection(CLOUD, 'gpt-test');
  await settle();

  assert.ok(aborted.length > 0, '古い送信先への要求が打ち切られる');
});

test('同じ接続と同じモデルなら何もしない', async () => {
  const subject = session({});
  subject.start();
  await settle();
  const before = subject.generation;
  subject.setConnection(subject.snapshotConnectionForTest(), subject.model);
  assert.equal(subject.generation, before);
});
```

`test/web/http.test.ts` へ足す:

```ts
// Mutation: 選択の切り替えを開いているセッションへ配らないと失敗する。
test('接続を切り替えると、開いているセッションがその場で訳し直す', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  await call('/api/connections', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...CLOUD_VIEW, apiKey: CANARY }),
  });

  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId }),
  });
  const before = (await created.json()) as Snapshot;
  assert.equal(before.cloud, false);
  assert.equal(before.connection, 'local');

  await call('/api/connections/selected', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cloud' }),
  });

  const patched = await call(`/api/sessions/${before.sessionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 1 }),
  });
  const after = (await patched.json()) as Snapshot;
  assert.equal(after.connection, 'cloud');
  assert.equal(after.cloud, true);
  assert.equal(after.model, 'gpt-test');
  assert.ok(after.generation > before.generation);
  assert.equal(JSON.stringify(after).includes(CANARY), false);
});

test('セッション作成と更新で model は受け付けない', async (t) => {
  const connections = fakeConnections();
  const { call } = await startServer(t, { connections: connections.control });
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'ignored' }),
  });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as Snapshot).model, 'm1');
});
```

`test/web/client-state.test.ts` の `snapshot()` ヘルパーへ `connection: 'local',` を足す。

- [ ] **Step 2: 試験を走らせて落ちることを確かめる。**

Run: `npm run test:web -- --test-name-pattern "接続を切り替え|古い接続|model は受け付けない"`
Expected: FAIL（`setConnection` が無い / `Snapshot.connection` が無い）

- [ ] **Step 3: 実装する。**

`web/shared/protocol.ts`:

```ts
export interface CreateSessionRequest {
  documentId: string;
}

export interface PatchSessionRequest {
  page?: number;
  paused?: boolean;
}
```

`Snapshot` へ足す:

```ts
  /** 選択中の接続名。どこへ送っているかを画面で言うために使う。 */
  connection: string;
```

`parseCreateSessionRequest` から `model` を落とし、`parsePatchSessionRequest` から `model` の枝を落とす。

`web/server/session.ts`:

```ts
export interface SessionOptions {
  sessionId: string;
  documentId: string;
  documentHash: string;
  document: PdfDocument;
  /** 接続名。表示にだけ使う。 */
  connectionName: string;
  model: string;
  storage: Storage;
  scheduler: Scheduler;
  connection: ProviderConnection;
  translate?: TranslateFn;
}
```

`#connectionName` を持ち、`snapshot()` へ `connection: this.#connectionName` を足す。`setModel()` を次で置き換える:

```ts
  /**
   * 送信先かモデルを変えると訳し直す。キャッシュ検索も鍵が変わるのでやり直しになる。
   * 実行中の翻訳は打ち切る。切り替えたのに古い送信先へ送り続けない。
   */
  setConnection(connection: ProviderConnection, model: string, name = this.#connectionName): void {
    if (this.#closed) return;
    const same =
      model === this.#model &&
      name === this.#connectionName &&
      JSON.stringify(connection) === JSON.stringify(this.#provider);
    if (same) return;
    this.#provider = connection;
    this.#model = model;
    this.#connectionName = name;
    this.#invalidate();
  }
```

`web/server/http.ts` の仮置きを本物にする:

```ts
  /** 選択中の接続を、開いているセッション全部へ配る。古い送信先への送信を止める。 */
  async function applySelectedConnection(): Promise<void> {
    const resolved = await deps.connections.resolveSelected();
    for (const entry of sessions.values()) {
      entry.session.setConnection(resolved.connection, resolved.model, resolved.name);
    }
  }
```

`postSession` の `new Session({...})` へ `connectionName: resolved.name` を足す。`patchSession` から `patch.model` の枝を消す。

`test/web-e2e/fixture-server.ts` と `test/web/http.test.ts` の `startServer` は Task 3 で `connections` へ移っているので、`connectionName` の追加だけ追従する。

- [ ] **Step 4: 試験を通す。**

Run: `npm run test:web`
Expected: すべて PASS（`main.ts` 由来の型エラーは Task 5 まで残る）

- [ ] **Step 5: コミットする。**

```bash
git add web/server/session.ts web/server/http.ts web/shared/protocol.ts test/web
git commit -m "feat(pdf-web): 接続の切り替えを開いているセッションへ即時反映する"
```

---

### Task 5: 起動・移行・preflight

**Files:**
- Modify: `web/server/main.ts`
- Modify: `web/server/preflight.ts`
- Test: `test/web/main.test.ts`
- Test: `test/web/preflight.test.ts`
- Test: `test/web/no-key-leak.test.ts`

**Interfaces:**
- Produces: `seedFromEnv(settings: ServerSettings): MigrationSeed`、`connectionControlFor(store, settings): ConnectionControl`。
- Consumes: Task 2 の `SettingsStore`、Task 3 の `ConnectionControl`、Task 1 の `toProviderConfig()`。

- [ ] **Step 1: 失敗する試験を書く。**

`test/web/main.test.ts` へ足す:

```ts
// Mutation: 移行でローカル接続を作らないと失敗する。
test('クラウドの環境変数から移行すると、ローカル接続も一緒に作る', () => {
  const settings = readSettings(
    env({
      PDF_JA_PROVIDER: 'azure',
      PDF_JA_BASE_URL: 'https://example.services.ai.azure.com/openai/v1',
      PDF_JA_CLOUD_ALLOWED: '1',
      PDF_JA_MODEL: 'gpt-test-deploy',
    }),
    'C:/tmp/dist-web',
  );
  const built = seedFromEnv(settings)('dpapi-current-user-v1:AAAA');
  assert.deepEqual(
    built.connections.map((connection) => connection.name),
    ['azure', 'local'],
  );
  assert.equal(built.selected, 'azure');
  assert.equal(built.connections[0]?.apiKeyProtected, 'dpapi-current-user-v1:AAAA');
  assert.equal(built.connections[0]?.trust, 'cloud-allowed');
  assert.equal(built.connections[1]?.trust, 'loopback');
});

test('ローカルの環境変数から移行すると 1 件だけ作る', () => {
  const built = seedFromEnv(readSettings(env(), 'C:/tmp/dist-web'))(undefined);
  assert.deepEqual(
    built.connections.map((connection) => connection.name),
    ['ollama'],
  );
  assert.equal(built.connections[0]?.model, DEFAULT_MODEL);
  assert.equal(built.connections[0]?.apiKeyProtected, undefined);
});

// Mutation: 移行後も環境変数を読むと失敗する。
test('鍵が未登録でもクラウド設定でサーバーは起動し、画面を配信する', async () => {
  const { dir, staticRoot, cleanup } = await scratch();
  const settings = readSettings(
    env({
      PDF_JA_PROVIDER: 'openai',
      PDF_JA_CLOUD_ALLOWED: '1',
      PDF_JA_MODEL: 'gpt-test',
      PDF_JA_PORT: '0',
      PDF_JA_DATA_DIR: dir,
      PDF_JA_STATIC_ROOT: staticRoot,
    }),
    staticRoot,
  );
  const running = await startServer(settings);
  try {
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    await running.close();
    await cleanup();
  }
});

// Mutation: 許可の無いクラウド設定を素通しすると失敗する。
test('許可の無いクラウドの環境変数は移行できない', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_MODEL: 'gpt-test' }),
    'C:/tmp/dist-web',
  );
  assert.throws(() => seedFromEnv(settings)(undefined), /許可/);
});
```

既存の「クラウドの許可が無ければ鍵の有無にかかわらず起動しない」試験は、上の「許可の無いクラウドの環境変数は移行できない」に置き換える（起動を止めるのは移行時の検証になるため）。

`test/web/preflight.test.ts` の `cloudFacts` を使う試験のうち、「クラウドで許可が無ければ致命」を削除する（許可は接続の保存時に強制され、preflight まで届かない）。

`test/web/no-key-leak.test.ts` の実 HTTP 試験は、`/api/settings/api-key` の代わりに `/api/connections` を叩くよう書き換え、`SettingsStore` への登録も `add()` を使う形にする。

- [ ] **Step 2: 試験を走らせて落ちることを確かめる。**

Run: `npm run test:web -- --test-name-pattern "移行|起動|許可"`
Expected: FAIL（`seedFromEnv` が無い）

- [ ] **Step 3: `web/server/main.ts` を直す。**

```ts
/**
 * 環境変数から、初回移行に使う接続の種を組む。
 *
 * 移行のときだけ呼ぶ。以後「どの LLM へ送るか」は settings.json の接続一覧が唯一の
 * 真実であり、ここの環境変数は読まない。
 */
export function seedFromEnv(settings: ServerSettings): MigrationSeed {
  return (legacyApiKeyProtected) => {
    const provider = settings.provider;
    const local: Connection = {
      name: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: DEFAULT_MODEL,
      trust: 'loopback',
    };

    if (provider.kind === 'ollama') {
      const only = validateConnection({
        name: 'ollama',
        provider: 'ollama',
        baseUrl: provider.endpoint,
        model: settings.model,
        trust: 'loopback',
      });
      return { connections: [only], selected: only.name };
    }

    if (!settings.cloudAllowed) {
      throw new Error(
        `原文を ${describeTarget(provider)} へ送る許可がありません。` +
          'PDF_JA_CLOUD_ALLOWED=1 を付けて一度起動するか、起動後に画面から接続を登録してください。',
      );
    }

    const cloud: Connection = {
      ...validateConnection({
        name: provider.kind,
        provider: provider.kind,
        baseUrl: provider.baseUrl,
        model: settings.model,
        trust: 'cloud-allowed',
      }),
    };
    if (legacyApiKeyProtected !== undefined) cloud.apiKeyProtected = legacyApiKeyProtected;
    return { connections: [cloud, local], selected: cloud.name };
  };
}

/** 接続の口。HTTP の層は SettingsStore を直接触らない。 */
export function connectionControlFor(
  store: SettingsStore,
  settings: ServerSettings,
): ConnectionControl {
  const options = {
    temperature: 0.2,
    timeoutMs: 120_000,
    think: settings.provider.kind === 'ollama' ? settings.provider.think : false,
  };
  const configFor = async (connection: Connection) => {
    const apiKey = await store.resolveSelected().then((resolved) =>
      resolved.connection.name === connection.name ? resolved.apiKey : '',
    );
    return toProviderConfig(connection, apiKey, options);
  };
  return {
    list: () => store.list(),
    add: (input, apiKey) => store.add(input, apiKey),
    update: (name, input, apiKey) => store.update(name, input, apiKey),
    remove: (name) => store.remove(name),
    select: (name) => store.select(name),
    async test(name) {
      const connection = store.get(name);
      if (!connection) throw new ConnectionError('unknown-connection', 'その接続はありません');
      if (connection.model === '') {
        return { ok: false, detail: 'モデル名が未設定です。' };
      }
      if (connection.provider === 'ollama') {
        const found = await probeOllama(connection.baseUrl);
        if (!found.reachable) {
          return { ok: false, detail: `${viewOf(connection).target} へ届きません。` };
        }
        const has = found.models.includes(connection.model);
        return {
          ok: has,
          detail: has ? '届きました。' : `モデルがありません: ${connection.model}`,
        };
      }
      const config = await configFor(connection);
      if (config.kind === 'ollama' || config.apiKey === '') {
        return { ok: false, detail: 'API キーが登録されていません。' };
      }
      const ok = await probeCloud(
        config.baseUrl,
        config.apiKey,
        5000,
        connection.provider === 'azure' ? 'api-key' : 'bearer',
      );
      return {
        ok,
        detail: ok ? '届きました。' : `${viewOf(connection).target} へ届きません。`,
      };
    },
    async resolveSelected() {
      const resolved = await store.resolveSelected();
      return {
        name: resolved.connection.name,
        model: resolved.connection.model,
        connection: toProviderConfig(resolved.connection, resolved.apiKey, options),
      };
    },
  };
}
```

`startServer()` を次の形にする:

```ts
export async function startServer(settings: ServerSettings): Promise<RunningServer> {
  const store = new SettingsStore(settings.dataDir);
  await store.loadOrMigrate(seedFromEnv(settings));
  const connections = connectionControlFor(store, settings);
  // 以下、createApp へ `connections` を渡す。resolveConnection / cloudKey は渡さない。
```

`main()` の preflight 呼び出しを、選択中の接続から組み立てる形にする:

```ts
  const store = new SettingsStore(settings.dataDir);
  let selected;
  try {
    await store.loadOrMigrate(seedFromEnv(settings));
    selected = await store.resolveSelected();
  } catch (error) {
    console.error(`設定を読めません: ${(error as Error).message}`);
    if (launcher) await holdWindow();
    return 1;
  }

  const problems = await preflight({
    staticRoot: settings.staticRoot,
    image: settings.image,
    python: settings.python,
    endpoint: selected.connection.baseUrl,
    model: selected.connection.model,
    kind: selected.connection.provider,
    target: viewOf(selected.connection).target,
    cloudAllowed: selected.connection.trust === 'cloud-allowed',
    apiKey: selected.apiKey,
  });
```

起動ログの「翻訳先」を接続名つきにする:

```ts
  console.log(
    `  翻訳先  : ${viewOf(selected.connection).target} ` +
      `(${selected.connection.name} / ${selected.connection.model || 'モデル未設定'})`,
  );
```

環境変数が残っていたら 1 行出す:

```ts
  const legacy = ['PDF_JA_PROVIDER', 'PDF_JA_BASE_URL', 'PDF_JA_MODEL', 'PDF_JA_CLOUD_ALLOWED'];
  if (legacy.some((key) => process.env[key] !== undefined)) {
    console.log('注意: PDF_JA_PROVIDER などは使われません。送信先は画面の接続一覧で選びます。');
  }
```

`--set-key` / `--clear-key` は残し、**選択中の接続**へ効くようにする:

```ts
async function manageKey(argv: string[], dataDir: string, seed: MigrationSeed): Promise<number> {
  const store = new SettingsStore(dataDir);
  await store.loadOrMigrate(seed);
  const { connection } = await store.resolveSelected();
  if (argv.includes('--clear-key')) {
    await store.update(connection.name, connection, null);
    console.log(`API キーを削除しました: ${connection.name}`);
    return 0;
  }
  const value = await readSecretLine('API キー（入力は表示されません）: ');
  await store.update(connection.name, connection, value);
  console.log(`API キーを暗号化して保存しました: ${connection.name}`);
  return 0;
}
```

`web/server/preflight.ts` の `judgePreflight()` から、クラウドの許可に関する致命を削除する（`cloud.allowed` の枝ごと）。`PreflightFacts['cloud']` からも `allowed` を落とす。モデル未設定は致命から**警告**へ落とす。

- [ ] **Step 4: 全部通す。**

Run: `npm run typecheck:web && npm run test:web && npm run build:web`
Expected: すべて PASS

- [ ] **Step 5: コミットする。**

```bash
git add web/server/main.ts web/server/preflight.ts test/web
git commit -m "feat(pdf-web): 環境変数から接続一覧へ移行し、選択中の接続で起動する"
```

---

### Task 6: 画面

**Files:**
- Modify: `web/client/api.ts`
- Modify: `web/client/state.ts`
- Modify: `web/client/main.ts`
- Modify: `web/client/index.html`
- Modify: `web/client/style.css`
- Test: `test/web/client-state.test.ts`
- Test: `test/web-e2e/preview.spec.ts`
- Test: `test/web-e2e/fixture-server.ts`

**Interfaces:**
- Produces: `Api.listConnections()` / `addConnection()` / `updateConnection()` / `removeConnection()` / `selectConnection()` / `testConnection()`、`describeConnection()`。
- 削除: `Api.getApiKeyStatus()` / `setApiKey()` / `clearApiKey()`、`describeApiKey()`。

- [ ] **Step 1: 失敗する試験を書く。**

`test/web/client-state.test.ts` の「---- API キーの欄 ----」節を置き換える:

```ts
// ---- 接続の欄 -------------------------------------------------------------

import { describeConnection } from '../../web/client/state';

const LOCAL = {
  name: 'local',
  provider: 'ollama' as const,
  target: '127.0.0.1:11434',
  model: 'qwen3.5:9b-q4_K_M',
  trust: 'loopback' as const,
  configured: false,
};

const CLOUD = {
  name: 'azure-mini',
  provider: 'azure' as const,
  target: 'example.services.ai.azure.com',
  model: 'gpt-test-deploy',
  trust: 'cloud-allowed' as const,
  configured: true,
};

// Mutation: ローカルでも鍵を要求すると失敗する。
test('ローカルの接続は鍵が無くても使える', () => {
  const view = describeConnection(LOCAL);
  assert.equal(view.usable, true);
  assert.equal(view.needsKey, false);
  assert.match(view.label, /local/);
  assert.match(view.label, /127\.0\.0\.1:11434/);
});

test('鍵のあるクラウドの接続は使える', () => {
  const view = describeConnection(CLOUD);
  assert.equal(view.usable, true);
  assert.equal(view.needsKey, false);
});

// Mutation: 鍵の無いクラウド接続を使えると言うと失敗する。
test('鍵の無いクラウドの接続は使えないと言う', () => {
  const view = describeConnection({ ...CLOUD, configured: false });
  assert.equal(view.usable, false);
  assert.equal(view.needsKey, true);
  assert.match(view.reason, /API キー/);
});

// Mutation: モデル未設定を見落とすと失敗する。
test('モデル未設定の接続は使えないと言う', () => {
  const view = describeConnection({ ...LOCAL, model: '' });
  assert.equal(view.usable, false);
  assert.match(view.reason, /モデル/);
});

test('表示に鍵は現れない', () => {
  assert.equal(JSON.stringify(describeConnection(CLOUD)).includes('sk-'), false);
});
```

`test/web-e2e/preview.spec.ts` の「クラウドでは画面から API キーを登録して訳し始められる」を置き換える:

```ts
test('接続を切り替えると、その場で送信先が変わる', async ({ page }) => {
  await page.goto(`${cloudBase}/`);
  await expect(page.getByLabel('接続')).toHaveValue('local');
  await expect(page.getByTestId('cloud-notice')).toBeHidden();

  await page.getByLabel('PDFを開く', { exact: true }).setInputFiles(fixture('two-column.pdf'));
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');

  await page.getByRole('button', { name: '接続を管理' }).click();
  await page.getByLabel('APIキー').fill('sk-e2e-0123456789');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('connection-row-cloud')).toContainText('登録済み');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();

  await page.getByLabel('接続').selectOption('cloud');
  await expect(page.getByTestId('cloud-notice')).toContainText('api.openai.com');
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');

  await page.getByLabel('接続').selectOption('local');
  await expect(page.getByTestId('cloud-notice')).toBeHidden();
});
```

`test/web-e2e/fixture-server.ts` は、`cloudKey` / `resolveConnection` を `ConnectionControl` の覚えているだけの実装へ置き換える。`PDF_JA_E2E_CLOUD=1` のときは `local`（ollama）と `cloud`（openai）の 2 件を持ち、既定の選択は `local`。

- [ ] **Step 2: 試験を走らせて落ちることを確かめる。**

Run: `npm run test:web -- --test-name-pattern "接続"`
Expected: FAIL（`describeConnection` が無い）

- [ ] **Step 3: 実装する。**

`web/client/state.ts` の `ApiKeyStatus` / `ApiKeyView` / `describeApiKey()` を次で置き換える:

```ts
// ---- 接続 -----------------------------------------------------------------

export interface ConnectionView {
  name: string;
  provider: 'ollama' | 'openai' | 'azure';
  target: string;
  model: string;
  trust: 'loopback' | 'cloud-allowed';
  configured: boolean;
}

export interface ConnectionList {
  selected: string;
  connections: ConnectionView[];
}

export interface ConnectionDisplay {
  label: string;
  /** そのまま訳せるか。 */
  usable: boolean;
  /** 鍵を入れれば使えるか。 */
  needsKey: boolean;
  /** 使えない理由。使えるなら空。 */
  reason: string;
}

/** 接続 1 件の見せ方。鍵そのものは受け取らないので、決して表示できない。 */
export function describeConnection(connection: ConnectionView): ConnectionDisplay {
  const label = `${connection.name}（${connection.target}${
    connection.model === '' ? '' : ` / ${connection.model}`
  }）`;
  if (connection.model === '') {
    return { label, usable: false, needsKey: false, reason: 'モデルが未設定です。' };
  }
  if (connection.provider !== 'ollama' && !connection.configured) {
    return { label, usable: false, needsKey: true, reason: 'API キーが登録されていません。' };
  }
  return { label, usable: true, needsKey: false, reason: '' };
}
```

`web/client/api.ts` の鍵 3 メソッドを次で置き換える:

```ts
  // ---- 接続 ---------------------------------------------------------------

  async listConnections(): Promise<ConnectionList> {
    return (await (await this.#call('/api/connections')).json()) as ConnectionList;
  }

  async addConnection(input: ConnectionInput): Promise<ConnectionList> {
    const response = await this.#call('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return (await response.json()) as ConnectionList;
  }

  async updateConnection(name: string, input: ConnectionInput): Promise<ConnectionList> {
    const response = await this.#call(`/api/connections/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return (await response.json()) as ConnectionList;
  }

  async removeConnection(name: string): Promise<ConnectionList> {
    const response = await this.#call(`/api/connections/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    return (await response.json()) as ConnectionList;
  }

  async selectConnection(name: string): Promise<ConnectionList> {
    const response = await this.#call('/api/connections/selected', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return (await response.json()) as ConnectionList;
  }

  async testConnection(name: string): Promise<{ ok: boolean; detail: string }> {
    const response = await this.#call(`/api/connections/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    });
    return (await response.json()) as { ok: boolean; detail: string };
  }
```

`ConnectionInput` は `{ name; provider; baseUrl; model; trust; apiKey?: string | null }`。

`web/client/index.html` の「モデル」欄と「APIキー」欄（`api-key-group` ごと）を次で置き換える:

```html
      <span class="group">
        <label for="connection" class="muted">接続</label>
        <select id="connection" aria-label="接続"></select>
        <button id="manage-connections" type="button">接続を管理</button>
        <button id="pause" type="button">一時停止</button>
      </span>
```

`</main>` の後ろへ管理画面を足す:

```html
    <dialog id="connections" class="connections" data-testid="connections">
      <h2>接続</h2>
      <ul id="connection-list" class="connection-list"></ul>
      <form id="connection-form" class="connection-form">
        <label>名前 <input id="c-name" type="text" required /></label>
        <label>種類
          <select id="c-provider">
            <option value="ollama">ローカル Ollama</option>
            <option value="openai">OpenAI 互換</option>
            <option value="azure">Azure OpenAI</option>
          </select>
        </label>
        <label>送信先 <input id="c-base-url" type="url" required /></label>
        <label>モデル / deployment 名 <input id="c-model" type="text" /></label>
        <label>APIキー
          <input id="c-api-key" type="password" autocomplete="off" aria-label="APIキー" />
        </label>
        <label id="c-trust-row" class="trust">
          <input id="c-trust" type="checkbox" />
          原文をこの送信先へ送ることを許可する（原文が外部のサーバーへ出ます）
        </label>
        <p id="c-error" class="banner" data-testid="connection-error" hidden></p>
        <menu>
          <button id="c-save" type="button">保存</button>
          <button id="c-test" type="button">接続テスト</button>
          <button id="c-close" type="button">閉じる</button>
        </menu>
      </form>
    </dialog>
```

`web/client/main.ts`:

- `Elements` から `model` / `apiKeyGroup` / `apiKey` / `saveApiKey` / `clearApiKey` / `apiKeyStatus` を外し、`connection: HTMLSelectElement` と管理画面の要素を足す。
- `refreshApiKey()` / `saveApiKey()` / `clearApiKey()` / `#showApiKey()` を、`refreshConnections()` / `saveConnection()` / `removeConnection()` / `testConnection()` / `selectConnection()` / `#renderConnections()` へ置き換える。
- `changeModel()` を削除し、`#renderTranslations()` の `this.#elements.model.value = snapshot.model;` を消す。
- `createSession()` から model を渡さない。
- 接続を選んだら `api.selectConnection(name)` を呼び、成功したら `#resumeAfterKey()` と同じ要領で、セッションが無ければ `#startSession()` をやり直す。
- 種類が `ollama` のときは「APIキー」と許可チェックを隠す。

`web/client/style.css` へ `.connections` / `.connection-list` / `.connection-form` / `.trust` の体裁を足し、`.toolbar .api-key` の規則を消す。

- [ ] **Step 4: 全部通す。**

Run: `npm run typecheck:web && npm run test:web && npm run build:web && npm run test:e2e:web`
Expected: すべて PASS（E2E は 1 skip）

- [ ] **Step 5: コミットする。**

```bash
git add web/client test/web/client-state.test.ts test/web-e2e
git commit -m "feat(pdf-web): 画面から接続を登録・切り替えできるようにする"
```

---

### Task 7: 文書と総合検証

**Files:**
- Modify: `docs/pdf-web.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-18-cloud-provider-and-split-design.md`
- Create: `docs/validation/connection-switching.md`

**Interfaces:**
- Consumes: Task 1〜6 の成果。

- [ ] **Step 1: `docs/pdf-web.md` を書き換える。**

「クラウドの LLM を使う」節を「接続を登録して切り替える」へ書き換え、次を含める。

- 画面上部の「接続」で選ぶ。「接続を管理」で追加・編集・削除・接続テスト・鍵の登録。
- provider ごとの入力（Ollama は endpoint とモデル、OpenAI 互換は https の送信先とモデル、Azure は公式 endpoint と deployment 名）。
- クラウドの接続は「原文をこの送信先へ送ることを許可する」を明示チェックしないと保存できない。
- 送信先を変えると、その接続の鍵は破棄され再入力が要る。
- 切り替えは開いている文書へ即時反映され、同じモデルへ戻せばキャッシュから戻る。
- `PDF_JA_PROVIDER` / `PDF_JA_BASE_URL` / `PDF_JA_MODEL` / `PDF_JA_CLOUD_ALLOWED` は**初回の移行にだけ使われ、以後は読まれない**こと。設定（環境変数）の表からこの 4 つを外し、移行の節へ移す。
- `--set-key` / `--clear-key` は**選択中の接続**に効くこと。

- [ ] **Step 2: `README.md` の PDF 節から、クラウド設定を環境変数で行う旨の記述を外し、`docs/pdf-web.md` を指す。**

- [ ] **Step 3: 設計書 `2026-09-18-cloud-provider-and-split-design.md` を更新する。**

- §7.3 の環境変数の表から provider 系 4 つを外し、「接続一覧へ移行済み。`2026-09-18-connection-switching-design.md` を見ること」と記す。
- §11 の「キーの複数登録と切り替え。1 アプリ 1 キーとする」を取り消し線にし、撤回先を指す。
- §13.2 と §13.5 に、`/api/settings/api-key` が `/api/connections` へ置き換わったこと、§13.5 の「鍵を削除しても送信が止まらない」が解消したことを追記する。

- [ ] **Step 4: 総合検証を走らせる。**

```bash
npm run typecheck && npm run test:unit && npm run typecheck:web && npm run test:web \
  && npm run build && npm run build:web && npm run test:e2e:web && npm run test:integration
```
Expected: すべて PASS（E2E は 1 skip）

- [ ] **Step 5: 検証記録を書いてコミットする。**

`docs/validation/connection-switching.md` に、上の各コマンドの結果、実 API キーを使っていないこと、利用者の手が要る確認（実キーでローカル↔Azure を往復して両方訳せること）を書く。

```bash
git add docs README.md
git commit -m "docs: 接続の登録と切り替えを書き、環境変数からの移行を記す"
```

---

## 自己点検の結果

- **仕様の被覆:** §4 保存形式 → Task 1・2。§4.2 検証 → Task 1。§4.3 鍵の破棄 → Task 2。§4.4 version → Task 2。§5 API → Task 3。§5.1 削除と選択 → Task 2・3。§5.2 接続テスト → Task 3・5。§5.3 鍵 API の削除 → Task 3。§6 移行 → Task 5。§7 画面 → Task 6。§8 セッションへの反映 → Task 4。§9 preflight → Task 5。§10 試験 → 各 Task。§11 触る範囲 → Task 1〜7。
- **型の突き合わせ:** `ConnectionView` は Task 1（サーバー）と Task 6（クライアント）で同じ形。`ConnectionControl.resolveSelected()` は `{ name, model, connection }` で Task 3・4・5 で一致。`Session.setConnection(connection, model, name)` は Task 4 の定義と Task 4 の `applySelectedConnection()` の呼び出しで一致。
- **積み残しの明示:** Task 2 と Task 3 の途中は `npm run typecheck:web` が赤いままになる（呼び出し側が Task 5 まで直らないため）。各 Task の Step 4 にその旨を書いてある。
