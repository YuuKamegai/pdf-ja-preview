/**
 * 実文書を実 Docling・実 Ollama で通し、結果を記録する。
 *
 *   node --import tsx scripts/validate-pdf.ts --pdf <path> --model <name> --out <dir> [--max-blocks N]
 *
 * 文書も訳文もリポジトリへは書かない。`--out` は必ずリポジトリの外を指す。
 *
 * 保存領域は**実行のたびに使い捨て**（`mkdtemp`）。前回の訳を引き継がないので、
 * 所要時間は常にキャッシュ無しの値になり、繰り返しても揃う。裏を返すと、
 * キャッシュの再利用はこの道具では確かめられない。それは実サーバー
 * （`PDF_JA_DATA_DIR` の永続領域）で確かめること。
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { validationResult } from './validation-result';

import { DocumentStore } from '../web/server/documents';
import { dockerExtractor } from '../web/server/extractor';
import { Scheduler } from '../web/server/scheduler';
import { Session } from '../web/server/session';
import { Storage } from '../web/server/storage';
import { translatePdfBlock } from '../web/server/translation';
import type { PdfDocument, TranslationState } from '../web/shared/document';

function flag(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

async function* bytesOf(path: string): AsyncGenerator<Uint8Array> {
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(path)) yield chunk as Uint8Array;
}

function summarize(document: PdfDocument) {
  const pages = { ok: 0, 'no-text': 0, failed: 0 };
  for (const page of document.pages) pages[page.status] += 1;
  const kinds: Record<string, number> = {};
  for (const block of document.blocks) kinds[block.kind] = (kinds[block.kind] ?? 0) + 1;
  const translatable = document.blocks.filter((block) => block.translatable);
  return {
    pages: document.pages.length,
    pageStatus: pages,
    blocks: document.blocks.length,
    translatable: translatable.length,
    chars: translatable.reduce((sum, block) => sum + block.source.length, 0),
    kinds,
    warnings: document.warnings,
  };
}

async function main(): Promise<number> {
  const pdfPath = resolve(flag('pdf'));
  const model = flag('model', 'qwen3.5:9b-q4_K_M');
  const outDir = resolve(flag('out', join(tmpdir(), 'pdf-ja-validation')));
  const maxBlocks = Number(flag('max-blocks', '40'));
  const image = flag('image', 'pdf-ja-extractor:1');
  const endpoint = flag('endpoint', 'http://127.0.0.1:11434');
  if (!flag('pdf') || !Number.isInteger(maxBlocks) || maxBlocks < 1) {
    console.error('--pdf と正の整数の --max-blocks が必要です');
    return 2;
  }

  const repoRoot = resolve(join(import.meta.dirname ?? '.', '..'));
  const outRelative = relative(repoRoot, outDir);
  if (outRelative === '' || (!outRelative.startsWith('..') && !isAbsolute(outRelative))) {
    console.error(`--out はリポジトリの外を指してください: ${outDir}`);
    return 2;
  }
  await mkdir(outDir, { recursive: true });

  const bytes = await readFile(pdfPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  console.log(`文書   : ${basename(pdfPath)} (${(bytes.length / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`sha256 : ${hash}`);
  console.log(`モデル : ${model}`);
  console.log(`出力先 : ${outDir}`);

  const storage = new Storage(await mkdtemp(join(tmpdir(), 'pdf-ja-validate-')));
  await storage.initialize();
  const scheduler = new Scheduler();
  const documents = new DocumentStore({ storage, extractor: dockerExtractor({ image }) });
  let session: Session | undefined;
  try {

  // 抽出はコンテナへ PDF を渡す必要がある。一時領域へ置いてから登録する。
  const staged = join(storage.tempDir, 'input.pdf');
  await copyFile(pdfPath, staged);

  const extractStarted = Date.now();
  const job = await documents.register(bytesOf(staged), 'input.pdf');
  documents.retain(job.id);
  await documents.idle();
  const extractMs = Date.now() - extractStarted;

  const finished = documents.get(job.id);
  if (!finished?.document) {
    console.error(`抽出に失敗: ${JSON.stringify(finished?.error)}`);
    return 1;
  }
  const document = finished.document;
  await writeFile(join(outDir, 'document.json'), JSON.stringify(document, null, 1), 'utf8');
  const extraction = summarize(document);
  console.log(
    `抽出   : ${extractMs} ms / ${extraction.pages} ページ / ${extraction.blocks} ブロック` +
      ` (訳す対象 ${extraction.translatable}, ${extraction.chars} 文字)`,
  );
  for (const warning of document.warnings) console.log(`  warning: ${warning}`);

  session = new Session({
    sessionId: 'validate',
    documentId: job.id,
    documentHash: hash,
    connectionName: 'local',
    document,
    model,
    storage,
    scheduler,
    connection: { kind: 'ollama', endpoint, think: false, temperature: 0.2, timeoutMs: 180_000 },
    translate: translatePdfBlock,
  });

  const wanted = document.blocks.filter((block) => block.translatable).slice(0, maxBlocks);
  const wantedIds = new Set(wanted.map((block) => block.id));
  const results = new Map<string, TranslationState>();
  session.subscribe((event) => {
    if (event.type !== 'block' || !wantedIds.has(event.value.id)) return;
    if (event.value.status === 'translated' || event.value.status === 'error') {
      results.set(event.value.id, event.value);
      const done = results.size;
      if (done % 5 === 0 || done === wantedIds.size) {
        console.log(`翻訳   : ${done} / ${wantedIds.size}`);
      }
    }
  });

  const translateStarted = Date.now();
  // 先頭から順に積む。retry は優先度を上げるだけで、キャッシュも使う。
  for (const block of wanted) session.retry(block.id, false);
  while (results.size < wantedIds.size) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([scheduler.idle(), new Promise(resolve => {
        timer = setTimeout(resolve, Math.max(1, 60 * 60_000 - (Date.now() - translateStarted)));
      })]);
    } finally {clearTimeout(timer);}
    if (results.size < wantedIds.size) await new Promise((r) => setTimeout(r, 200));
    if (Date.now() - translateStarted > 60 * 60_000) break;
  }
  const translateMs = Date.now() - translateStarted;

  const ok = [...results.values()].filter((state) => state.status === 'translated');
  const failed = [...results.values()].filter((state) => state.status === 'error');
  const completion = validationResult(wantedIds.size, [...results.values()]);
  console.log(`翻訳   : ${translateMs} ms / 成功 ${ok.length} / 失敗 ${failed.length}`);

  const sourceOf = new Map(document.blocks.map((block) => [block.id, block]));
  const report = {
    document: { name: basename(pdfPath), bytes: bytes.length, hash },
    model,
    extractor: { image, version: document.extractor.version, ms: extractMs },
    extraction,
    translation: {
      ms: translateMs,
      ...completion,
      failures: failed.map((state) => ({
        id: state.id,
        code: state.error?.code,
        message: state.error?.message,
        source: sourceOf.get(state.id)?.source.slice(0, 200),
      })),
    },
    samples: [...results.values()].slice(0, 30).map((state) => ({
      id: state.id,
      kind: sourceOf.get(state.id)?.kind,
      status: state.status,
      source: sourceOf.get(state.id)?.source,
      ja: state.ja,
    })),
  };

  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 1), 'utf8');
  await writeFile(join(outDir, 'document.json'), JSON.stringify(document, null, 1), 'utf8');
  console.log(`記録   : ${join(outDir, 'report.json')}`);

  return completion.exitCode;
  } finally {
    await session?.close();
    scheduler.close();
    await documents.close();
    await storage.close();
  }
}

void main().then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch(error => {
  console.error(`検証に失敗: ${(error as Error).message}`);
  process.exitCode = 1;
});
