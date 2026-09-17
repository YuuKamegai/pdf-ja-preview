import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { DocumentStore, UploadError } from '../../web/server/documents';
import { dockerExtractor, type Extractor } from '../../web/server/extractor';
import { createTemporaryStorage, documentKey, exists, type Storage } from '../../web/server/storage';
import type { PdfDocument } from '../../web/shared/document';

const WORKER = fileURLToPath(new URL('./helpers/fake-worker.mjs', import.meta.url));

function fakeExtractor(mode: string, extra: string[] = []): Extractor {
  return dockerExtractorLike(mode, extra);
}

/** fake worker を `node` で直接動かす抽出器。docker は使わない。 */
function dockerExtractorLike(mode: string, extra: string[]): Extractor {
  return {
    description: `fake:${mode}`,
    async run({ hash, signal, timeoutMs }) {
      const { runExtractorProcess } = await import('../../web/server/extractor');
      return runExtractorProcess({
        command: process.execPath,
        args: [WORKER, '--mode', mode, '--hash', hash, ...extra],
        signal,
        timeoutMs: timeoutMs ?? 10_000,
      });
    },
  };
}

async function* bytesOf(text: string, chunks = 1): AsyncGenerator<Uint8Array> {
  const buffer = Buffer.from(text, 'utf8');
  const size = Math.ceil(buffer.length / chunks);
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}

async function setup(t: { after: (fn: () => unknown) => void }, extractor: Extractor, options: { maxBytes?: number } = {}) {
  const storage: Storage = await createTemporaryStorage();
  const store = new DocumentStore({ storage, extractor, ...options });
  t.after(async () => {
    await store.close();
    await storage.close();
  });
  return { storage, store };
}

test('register はキューに載せた時点で返り、抽出を待たない', async (t) => {
  const { store } = await setup(t, fakeExtractor('slow', ['--delay', '400']));
  const job = await store.register(bytesOf('%PDF-1.7 fake'), 'x.pdf');
  assert.equal(job.state, 'queued');
  assert.equal(job.document, undefined);

  await store.idle();
  assert.equal(store.get(job.id)?.state, 'ready');
});

test('抽出結果は文書ハッシュの下へ保存する', async (t) => {
  const { store, storage } = await setup(t, fakeExtractor('ok'));
  const job = await store.register(bytesOf('%PDF-1.7 fake'), 'x.pdf');
  await store.idle();

  const hash = store.hashOf(job.id);
  assert.ok(hash);
  const saved = (await storage.readJson(documentKey(hash, 'document'))) as PdfDocument;
  assert.equal(saved.schema, 'pdf-document.v1');
});

test('二度目の同じ PDF はキャッシュから即 ready になる', async (t) => {
  let runs = 0;
  const counting: Extractor = {
    description: 'counting',
    run: (args) => {
      runs += 1;
      return fakeExtractor('ok').run(args);
    },
  };
  const { store } = await setup(t, counting);

  const first = await store.register(bytesOf('%PDF-1.7 same'), 'a.pdf');
  await store.idle();
  assert.equal(store.get(first.id)?.state, 'ready');

  const second = await store.register(bytesOf('%PDF-1.7 same'), 'b.pdf');
  assert.equal(second.state, 'ready', 'キャッシュヒットは即 ready');
  assert.equal(runs, 1, '同じ文書を二度抽出しない');
});

test('壊れたキャッシュは捨てて抽出し直す', async (t) => {
  const { store, storage } = await setup(t, fakeExtractor('ok'));
  const first = await store.register(bytesOf('%PDF-1.7 broken-cache'), 'a.pdf');
  await store.idle();
  const hash = store.hashOf(first.id);
  assert.ok(hash);

  await storage.writeJson(documentKey(hash, 'document'), { schema: 'nonsense' });

  const second = await store.register(bytesOf('%PDF-1.7 broken-cache'), 'b.pdf');
  assert.equal(second.state, 'queued');
  await store.idle();
  assert.equal(store.get(second.id)?.state, 'ready');
});

test('一部のページが失敗した文書は partial になる', async (t) => {
  const partial: Extractor = {
    description: 'partial',
    async run({ hash }) {
      return {
        schema: 'pdf-document.v1',
        hash,
        extractor: { version: 'fake', configHash: 'b'.repeat(64) },
        pages: [
          { number: 1, width: 600, height: 800, rotation: 0, status: 'ok' },
          { number: 2, width: 600, height: 800, rotation: 0, status: 'no-text' },
        ],
        blocks: [],
        warnings: ['ページ 2 からは文章を抽出できません'],
      } satisfies PdfDocument;
    },
  };
  const { store } = await setup(t, partial);
  const job = await store.register(bytesOf('%PDF-1.7 partial'), 'x.pdf');
  await store.idle();
  assert.equal(store.get(job.id)?.state, 'partial');
});

test('抽出の失敗は error として残り、結果は保存しない', async (t) => {
  const { store, storage } = await setup(t, fakeExtractor('error'));
  const job = await store.register(bytesOf('%PDF-1.7 bad'), 'x.pdf');
  await store.idle();

  const after = store.get(job.id);
  assert.equal(after?.state, 'error');
  assert.equal(after?.error?.code, 'encrypted-pdf');
  const hash = store.hashOf(job.id);
  assert.ok(hash);
  assert.equal(await storage.readJson(documentKey(hash, 'document')), undefined);
});

test('失敗しても次のジョブは実行される', async (t) => {
  let call = 0;
  const flaky: Extractor = {
    description: 'flaky',
    run: (args) => fakeExtractor(call++ === 0 ? 'error' : 'ok').run(args),
  };
  const { store } = await setup(t, flaky);

  const first = await store.register(bytesOf('%PDF-1.7 one'), 'a.pdf');
  const second = await store.register(bytesOf('%PDF-1.7 two'), 'b.pdf');
  await store.idle();

  assert.equal(store.get(first.id)?.state, 'error');
  assert.equal(store.get(second.id)?.state, 'ready');
});

test('抽出は並列度 1。同時に走るのは一つだけ', async (t) => {
  let active = 0;
  let peak = 0;
  const watched: Extractor = {
    description: 'watched',
    async run(args) {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await fakeExtractor('slow', ['--delay', '120']).run(args);
      } finally {
        active -= 1;
      }
    },
  };
  const { store } = await setup(t, watched);

  await store.register(bytesOf('%PDF-1.7 a'), 'a.pdf');
  await store.register(bytesOf('%PDF-1.7 b'), 'b.pdf');
  await store.register(bytesOf('%PDF-1.7 c'), 'c.pdf');
  await store.idle();

  assert.equal(peak, 1);
});

test('上限を超えた入力は途中で止め、一時ファイルを残さない', async (t) => {
  const { store, storage } = await setup(t, fakeExtractor('ok'), { maxBytes: 64 });
  await assert.rejects(
    () => store.register(bytesOf('x'.repeat(500), 10), 'big.pdf'),
    (error: unknown) => error instanceof UploadError && error.code === 'too-large',
  );
  assert.deepEqual(
    (await readdir(storage.tempDir)).filter((name) => name.endsWith('.pdf')),
    [],
  );
});

test('受け取りが途中で切れたら一時ファイルを回収する', async (t) => {
  const { store, storage } = await setup(t, fakeExtractor('ok'));
  async function* broken(): AsyncGenerator<Uint8Array> {
    yield Buffer.from('%PDF-1.7 ');
    throw new Error('connection reset');
  }
  await assert.rejects(
    () => store.register(broken(), 'x.pdf'),
    (error: unknown) => error instanceof UploadError && error.code === 'upload-failed',
  );
  assert.deepEqual(
    (await readdir(storage.tempDir)).filter((name) => name.endsWith('.pdf')),
    [],
  );
});

test('空の入力は拒否する', async (t) => {
  const { store } = await setup(t, fakeExtractor('ok'));
  await assert.rejects(
    () => store.register(bytesOf(''), 'x.pdf'),
    (error: unknown) => error instanceof UploadError && error.code === 'empty-upload',
  );
});

test('参照が 0 になったら抽出を止めて一時 PDF を消す', async (t) => {
  const { store } = await setup(t, fakeExtractor('spin'));
  const job = await store.register(bytesOf('%PDF-1.7 spin'), 'x.pdf');
  store.retain(job.id);
  const path = store.pdfPath(job.id);
  assert.ok(path);
  assert.equal(await exists(path), true);

  await store.release(job.id);

  assert.equal(store.get(job.id), undefined);
  assert.equal(await exists(path), false);
});

test('登録直後は誰も開いていない', async (t) => {
  const { store } = await setup(t, fakeExtractor('ok'));
  const job = await store.register(bytesOf('%PDF-1.7 fresh'), 'x.pdf');
  assert.equal(store.isInUse(job.id), false);
  assert.notEqual(store.get(job.id), undefined, 'まだ閉じない');
});

test('retain した分だけ release しないと閉じない', async (t) => {
  const { store } = await setup(t, fakeExtractor('ok'));
  const job = await store.register(bytesOf('%PDF-1.7 refs'), 'x.pdf');
  assert.equal(store.retain(job.id), true);
  assert.equal(store.retain(job.id), true);

  await store.release(job.id);
  assert.notEqual(store.get(job.id), undefined, 'まだ使っている');

  await store.release(job.id);
  assert.equal(store.get(job.id), undefined);
});

test('使用中の文書は閉じられない', async (t) => {
  const { store } = await setup(t, fakeExtractor('ok'));
  const job = await store.register(bytesOf('%PDF-1.7 busy'), 'x.pdf');
  assert.equal(store.retain(job.id), true);
  assert.equal(await store.closeIfUnused(job.id), false);

  await store.release(job.id);
  assert.equal(await store.closeIfUnused(job.id), true);
});

test('待ち行列に残ったまま閉じられたジョブは実行しない', async (t) => {
  let started = 0;
  const counting: Extractor = {
    description: 'counting',
    run: (args) => {
      started += 1;
      return fakeExtractor('slow', ['--delay', '150']).run(args);
    },
  };
  const { store } = await setup(t, counting);

  const first = await store.register(bytesOf('%PDF-1.7 first'), 'a.pdf');
  const second = await store.register(bytesOf('%PDF-1.7 second'), 'b.pdf');
  assert.equal(await store.closeIfUnused(second.id), true);
  await store.idle();

  assert.equal(started, 1);
  assert.equal(store.get(first.id)?.state, 'ready');
});

test('状態の変化を購読できる', async (t) => {
  const { store } = await setup(t, fakeExtractor('ok'));
  const states: string[] = [];
  const off = store.onChange((job) => states.push(job.state));
  t.after(off);

  await store.register(bytesOf('%PDF-1.7 watch'), 'x.pdf');
  await store.idle();

  assert.deepEqual(states, ['running', 'ready']);
});

test('購読側が落ちても抽出は続く', async (t) => {
  const { store } = await setup(t, fakeExtractor('ok'));
  const off = store.onChange(() => {
    throw new Error('listener blew up');
  });
  t.after(off);

  const job = await store.register(bytesOf('%PDF-1.7 safe'), 'x.pdf');
  await store.idle();
  assert.equal(store.get(job.id)?.state, 'ready');
});

test('close で残った一時 PDF をすべて回収する', async () => {
  const storage = await createTemporaryStorage();
  const store = new DocumentStore({ storage, extractor: fakeExtractor('spin') });
  const job = await store.register(bytesOf('%PDF-1.7 leftover'), 'x.pdf');
  const path = store.pdfPath(job.id);
  assert.ok(path);

  await store.close();
  assert.equal(await exists(path), false);
  await storage.close();
});

test('docker 抽出器は既定で docker を呼ぶ', () => {
  assert.equal(dockerExtractor({ image: 'i' }).description, 'docker:i');
});
