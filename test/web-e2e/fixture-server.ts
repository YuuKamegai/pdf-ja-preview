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
import { createApp, type ConnectionControl } from '../../web/server/http';
import { Scheduler } from '../../web/server/scheduler';
import { allowedHostsFor, createToken } from '../../web/server/security';
import type { ProviderConnection, TranslateFn } from '../../web/server/session';
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

/**
 * `PDF_JA_E2E_CLOUD=1` ならクラウドの接続も登録した状態で立ち上げる。
 *
 * 鍵は覚えておくだけで、翻訳は `fixedTranslate` が返す。外へは 1 バイトも出ない。
 * 画面から接続を切り替えられることを、実 HTTP と実画面で確かめるための口。
 */
const cloud = process.env.PDF_JA_E2E_CLOUD === '1';

interface FixtureConnection {
  name: string;
  provider: 'ollama' | 'openai';
  baseUrl: string;
  model: string;
  trust: 'loopback' | 'cloud-allowed';
}

const LOCAL: FixtureConnection = {
  name: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'fixture-model',
  trust: 'loopback',
};

const CLOUD: FixtureConnection = {
  name: 'cloud',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'fixture-cloud-model',
  trust: 'cloud-allowed',
};

let entries: FixtureConnection[] = cloud ? [LOCAL, CLOUD] : [LOCAL];
let selected = 'local';
const keys = new Map<string, string>();

const view = (entry: FixtureConnection) => ({
  name: entry.name,
  provider: entry.provider,
  target: new URL(entry.baseUrl).host,
  model: entry.model,
  trust: entry.trust,
  configured: (keys.get(entry.name) ?? '') !== '',
});

const connections: ConnectionControl = {
  list: () => Promise.resolve({ selected, connections: entries.map(view) }),
  add: (input, apiKey) => {
    entries = [...entries, input as unknown as FixtureConnection];
    if (typeof apiKey === 'string') keys.set(String(input.name), apiKey);
    return Promise.resolve();
  },
  update: (name, input, apiKey) => {
    entries = entries.map((entry) =>
      entry.name === name ? (input as unknown as FixtureConnection) : entry,
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
          ? ({
              kind: 'ollama',
              endpoint: entry.baseUrl,
              think: false,
              temperature: 0.2,
              timeoutMs: 5000,
            } as ProviderConnection)
          : ({
              kind: 'openai',
              baseUrl: entry.baseUrl,
              apiKey,
              temperature: 0.2,
              timeoutMs: 5000,
            } as ProviderConnection),
    });
  },
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
    connections,
    defaultModel: 'fixture-model',
    staticRoot: join(root, 'dist-web'),
    security: { token: createToken(), allowedHosts },
    translate: fixedTranslate,
    heartbeatMs: 2000,
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  for (const host of allowedHostsFor(port)) allowedHosts.add(host);
  console.log(`fixture server on http://127.0.0.1:${port}/${cloud ? ' (cloud)' : ''}`);

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
