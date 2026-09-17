/**
 * ブラウザ試験用のサーバー。
 *
 * 実 HTTP・実 `dist-web`・実 PDF.js を使い、抽出と翻訳だけ固定する。抽出結果は
 * Task 2 で実 Docling が出した JSON をそのまま返すので、契約はごまかしていない。
 *
 *   node --import tsx test/web-e2e/fixture-server.ts <port>
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DocumentStore } from '../../web/server/documents';
import type { Extractor } from '../../web/server/extractor';
import { createApp } from '../../web/server/http';
import { Scheduler } from '../../web/server/scheduler';
import { allowedHostsFor, createToken } from '../../web/server/security';
import type { TranslateFn } from '../../web/server/session';
import { Storage } from '../../web/server/storage';
import { parseDocument, type PdfDocument } from '../../web/shared/document';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtures = join(root, 'test', 'fixtures', 'pdf');

/** PDF の sha256 ごとに、実 Docling の出力から作った中間形式を返す。 */
async function documentFor(hash: string): Promise<PdfDocument> {
  const { createHash } = await import('node:crypto');
  const { readdir } = await import('node:fs/promises');

  for (const name of await readdir(fixtures)) {
    if (!name.endsWith('.pdf')) continue;
    const bytes = await readFile(join(fixtures, name));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) continue;

    const raw = JSON.parse(
      await readFile(join(fixtures, `extracted-${name.replace(/\.pdf$/, '')}.json`), 'utf8'),
    ) as unknown;
    return parseDocument(raw);
  }
  throw new Error(`fixture がありません: ${hash}`);
}

const fixedExtractor: Extractor = {
  description: 'fixture',
  async run({ hash, signal }) {
    // 実際の抽出と同じくらいの間は「抽出中」を見せる。
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (signal.aborted) throw new Error('cancelled');
    return documentFor(hash);
  },
};

/** 決まった訳を返す。原文の数値はそのまま残す（検査に通す）。 */
const fixedTranslate: TranslateFn = async (block) => {
  if (block.source.startsWith('Left first.')) return '左段の本文。校正は 12 走査の前に行った。';
  if (block.source.startsWith('Left second.')) return '左段の続き。25 C で 10 分保持した。';
  if (block.source.startsWith('Right first.')) return '右段の本文。一致度は 98.2 パーセント。';
  if (block.source.startsWith('Figure caption.')) return '図の説明。3 回の試行の中央値。';
  if (block.source.startsWith('Title:')) return '表題: 低温保存後の代謝物シグナルの回復';
  if (block.source.startsWith('FAIL')) throw new Error('わざと失敗させた訳');
  return `訳: ${block.source}`;
};

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? '7398');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const storage = new Storage(await mkdtemp(join(tmpdir(), 'pdf-ja-e2e-')));
  await storage.initialize();

  const scheduler = new Scheduler();
  const documents = new DocumentStore({ storage, extractor: fixedExtractor });
  const allowedHosts = new Set<string>();

  const server = createApp({
    documents,
    storage,
    scheduler,
    connection: { endpoint: 'http://127.0.0.1:11434', think: false, temperature: 0.2, timeoutMs: 5000 },
    defaultModel: 'fixture-model',
    staticRoot: join(root, 'dist-web'),
    security: { token: createToken(), allowedHosts },
    translate: fixedTranslate,
    heartbeatMs: 2000,
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  for (const host of allowedHostsFor(port)) allowedHosts.add(host);
  console.log(`fixture server on http://127.0.0.1:${port}/`);

  const stop = (): void => {
    server.close(() => {
      scheduler.close();
      void documents.close().then(() => storage.close()).then(() => process.exit(0));
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
