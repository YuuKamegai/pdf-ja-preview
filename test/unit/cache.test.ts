import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, TranslationCache } from '../../src/cache';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'md-ja-cache-'));
  return join(dir, 'translations.json');
}

test('キーはモデル名と原文の両方に依存する', () => {
  assert.equal(cacheKey('m1', 'text'), cacheKey('m1', 'text'));
  assert.notEqual(cacheKey('m1', 'text'), cacheKey('m2', 'text'));
  assert.notEqual(cacheKey('m1', 'text'), cacheKey('m1', 'other'));
});

test('モデル名に区切り文字が入っていても別のキーになる', () => {
  assert.notEqual(cacheKey('m1\nx', 'y'), cacheKey('m1', 'x\ny'));
});

test('保存した訳を再読み込み後も取り出せる', async () => {
  const path = await tempFile();
  const first = await TranslationCache.load(path);
  first.set('m1', 'Hello.', 'こんにちは。');
  await first.flush();

  const second = await TranslationCache.load(path);
  assert.equal(second.get('m1', 'Hello.'), 'こんにちは。');
});

test('モデルが違えば別の訳として扱われる', async () => {
  const cache = await TranslationCache.load(await tempFile());
  cache.set('m1', 'Hello.', 'A');
  assert.equal(cache.get('m2', 'Hello.'), undefined);
});

test('ファイルが無い場合は空のキャッシュとして開く', async () => {
  const cache = await TranslationCache.load(await tempFile());
  assert.equal(cache.size, 0);
  assert.equal(cache.get('m1', 'anything'), undefined);
});

test('壊れた JSON でも例外を投げず空で開く', async () => {
  const path = await tempFile();
  await writeFile(path, '{ not json', 'utf8');
  const cache = await TranslationCache.load(path);
  assert.equal(cache.size, 0);
});

test('期限切れの項目は読み込み時に剪定される', async () => {
  const path = await tempFile();
  const old = await TranslationCache.load(path, { now: () => 0 });
  old.set('m1', 'stale', 'ふるい');
  await old.flush();

  const day = 24 * 60 * 60 * 1000;
  const fresh = await TranslationCache.load(path, { now: () => 91 * day, maxAgeMs: 90 * day });
  assert.equal(fresh.size, 0);
});

test('flush はワークスペースではなく渡されたパスへだけ書く', async () => {
  const path = await tempFile();
  const cache = await TranslationCache.load(path);
  cache.set('m1', 'Hello.', 'こんにちは。');
  await cache.flush();

  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, { ja: string; at: number }>;
  assert.equal(Object.keys(raw).length, 1);
  assert.equal(Object.values(raw)[0].ja, 'こんにちは。');
});

test('flush を重ねて呼んでも最後の状態が壊れずに書かれる', async () => {
  const path = await tempFile();
  const cache = await TranslationCache.load(path);

  cache.set('m1', 'a', 'A');
  const first = cache.flush();
  cache.set('m1', 'b', 'B');
  const second = cache.flush();
  await Promise.all([first, second]);

  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, { ja: string }>;
  assert.equal(Object.keys(raw).length, 2);
});

test('書き込み中の set は dirty のまま残り、後続 flush が最新 snapshot を保存する', async () => {
  const path = await tempFile();
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  const cache = await TranslationCache.load(path, {
    writeFile: async (target, data, encoding) => {
      writes++;
      if (writes === 1) {
        firstStarted();
        await release;
      }
      await writeFile(target, data, encoding);
    },
  });

  cache.set('m1', 'a', 'A');
  const first = cache.flush();
  await started;
  cache.set('m1', 'b', 'B');
  const second = cache.flush();
  releaseFirst();
  await Promise.all([first, second]);

  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, { ja: string }>;
  assert.equal(writes, 2);
  assert.equal(Object.keys(raw).length, 2);
});

test('writeFile が失敗した更新は次の flush で再試行できる', async () => {
  const path = await tempFile();
  let attempts = 0;
  const cache = await TranslationCache.load(path, {
    writeFile: async (target, data, encoding) => {
      attempts++;
      if (attempts === 1) throw new Error('disk unavailable');
      await writeFile(target, data, encoding);
    },
  });

  cache.set('m1', 'a', 'A');
  await assert.rejects(cache.flush(), /disk unavailable/);
  await cache.flush();

  const saved = await TranslationCache.load(path);
  assert.equal(attempts, 2);
  assert.equal(saved.get('m1', 'a'), 'A');
});
