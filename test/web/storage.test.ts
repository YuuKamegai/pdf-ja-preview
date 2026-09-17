import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Storage,
  StorageKeyError,
  createTemporaryStorage,
  defaultDataDir,
  documentKey,
  exists,
  translationCacheKey,
  translationKey,
} from '../../web/server/storage';

const HASH = 'a'.repeat(64);

function baseKey() {
  return {
    source: 'Control',
    headingContext: 'Methods',
    model: 'm',
    think: false,
    temperature: 0.2,
    promptVersion: 'pdf-1',
    verifierVersion: '1',
  };
}

test('見出し文脈の違う訳を流用しない', () => {
  const base = baseKey();
  assert.notEqual(translationKey(base), translationKey({ ...base, headingContext: 'Results' }));
});

test('原文・モデル・温度・think・各版のどれが違っても別の鍵になる', () => {
  const base = baseKey();
  const variants = [
    { ...base, source: 'Controls' },
    { ...base, model: 'other' },
    { ...base, temperature: 0.3 },
    { ...base, think: true },
    { ...base, promptVersion: 'pdf-2' },
    { ...base, verifierVersion: '2' },
  ];
  const keys = new Set([translationKey(base), ...variants.map(translationKey)]);
  assert.equal(keys.size, variants.length + 1);
});

test('同じ入力からは同じ鍵になる', () => {
  assert.equal(translationKey(baseKey()), translationKey(baseKey()));
});

test('PDF_JA_DATA_DIR が既定を上書きする', () => {
  const dir = defaultDataDir({ PDF_JA_DATA_DIR: 'C:/tmp/here', LOCALAPPDATA: 'C:/other' } as never);
  assert.match(dir, /here$/);
});

test('LOCALAPPDATA の下が既定になる', () => {
  const dir = defaultDataDir({ LOCALAPPDATA: join(tmpdir(), 'local') } as never);
  assert.match(dir, /pdf-ja-preview$/);
});

test('保存キーは相対で、区切りごとに検証する', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());

  for (const bad of ['../escape', 'docs/../x', '/absolute', '', 'docs//x', 'docs/a b']) {
    await assert.rejects(() => storage.writeJson(bad, {}), StorageKeyError, `通してはいけない: ${bad}`);
  }
  await storage.writeJson('docs/ok/name', { a: 1 });
  assert.deepEqual(await storage.readJson('docs/ok/name'), { a: 1 });
});

test('文書キーは 64 桁の 16 進だけを受ける', () => {
  assert.equal(documentKey(HASH, 'meta'), `docs/${HASH}/meta`);
  assert.throws(() => documentKey('short', 'meta'), StorageKeyError);
  assert.throws(() => translationCacheKey('short', 'k'), StorageKeyError);
});

test('無い鍵は undefined を返す', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());
  assert.equal(await storage.readJson('docs/none/none'), undefined);
});

test('壊れた JSON は無効化して読み直させる', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());

  await storage.writeJson('docs/x/meta', { ok: true });
  const path = join(storage.root, 'docs', 'x', 'meta.json');
  await writeFile(path, '{ broken', 'utf8');

  assert.equal(await storage.readJson('docs/x/meta'), undefined);
  assert.equal(await exists(path), false, '壊れたキャッシュは残さない');

  await storage.writeJson('docs/x/meta', { ok: 2 });
  assert.deepEqual(await storage.readJson('docs/x/meta'), { ok: 2 });
});

test('同じ保存先への並行書き込みを直列化する', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());

  await Promise.all(
    Array.from({ length: 20 }, (_, index) => storage.writeJson('docs/y/meta', { index })),
  );
  const value = (await storage.readJson('docs/y/meta')) as { index: number };
  assert.ok(Number.isInteger(value.index));

  const files = await readdir(join(storage.root, 'docs', 'y'));
  assert.deepEqual(files, ['meta.json'], '一時ファイルを残さない');
});

test('書き込みは一時ファイル経由なので半端な JSON を残さない', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());
  await storage.writeJson('docs/z/big', { text: 'x'.repeat(100000) });
  const text = await readFile(join(storage.root, 'docs', 'z', 'big.json'), 'utf8');
  assert.equal(JSON.parse(text).text.length, 100000);
});

test('文書単位で訳文キャッシュごと消せる', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());

  await storage.writeJson(documentKey(HASH, 'document'), { schema: 'x' });
  await storage.writeJson(translationCacheKey(HASH, 'k1'), { ja: '訳' });
  const other = 'b'.repeat(64);
  await storage.writeJson(documentKey(other, 'document'), { schema: 'y' });

  await storage.deleteDocument(HASH);

  assert.equal(await storage.readJson(documentKey(HASH, 'document')), undefined);
  assert.equal(await storage.readJson(translationCacheKey(HASH, 'k1')), undefined);
  assert.notEqual(await storage.readJson(documentKey(other, 'document')), undefined);
});

test('一時 PDF の名前に元のファイル名を使わない', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());
  const path = await storage.createTempFile();
  assert.match(path, /[0-9a-f-]{36}\.pdf$/);
  assert.ok(path.startsWith(storage.tempDir));
});

test('一時領域の外は消さない', async (t) => {
  const storage = await createTemporaryStorage();
  t.after(() => storage.close());
  const outside = join(storage.root, 'docs', 'keep.pdf');
  await mkdir(join(storage.root, 'docs'), { recursive: true });
  await writeFile(outside, 'x', 'utf8');
  await storage.removeTempFile(outside);
  assert.equal(await exists(outside), true);
});

test('死んだサーバーの一時領域だけ回収する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-ja-reap-'));
  try {
    const deadDir = join(root, 'tmp', '999999-dead');
    await mkdir(deadDir, { recursive: true });
    await writeFile(
      join(deadDir, 'owner.json'),
      JSON.stringify({ pid: 999999, startedAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );
    await writeFile(join(deadDir, 'stale.pdf'), 'x', 'utf8');

    const liveDir = join(root, 'tmp', `${process.pid}-live`);
    await mkdir(liveDir, { recursive: true });
    await writeFile(
      join(liveDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );
    await writeFile(join(liveDir, 'inuse.pdf'), 'x', 'utf8');

    const storage = new Storage(root);
    await storage.initialize();

    assert.equal(await exists(deadDir), false, '死んだサーバーの領域は消す');
    assert.equal(await exists(join(liveDir, 'inuse.pdf')), true, '生きている領域は残す');
    await storage.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('close で自分の一時領域を片づける', async () => {
  const storage = await createTemporaryStorage();
  const dir = storage.tempDir;
  await writeFile(join(dir, 'x.pdf'), 'x', 'utf8');
  await storage.close();
  assert.equal(await exists(dir), false);
});

test('initialize 前に一時領域へ触ると落ちる', () => {
  const storage = new Storage(join(tmpdir(), 'pdf-ja-uninit'));
  assert.throws(() => storage.tempDir, /initialize/);
});
