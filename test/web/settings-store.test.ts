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
