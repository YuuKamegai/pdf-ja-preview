/**
 * 抽出ワーカーの出力を共有契約で検証し、人が読める形で表示する。
 *
 *   node --import tsx scripts/inspect-document.ts <worker-output.json> [--json <out>]
 *
 * 入力はワーカーの stdout そのもの（`{"ok":true,"document":{...}}`）。
 * 契約に通らなければ 0 以外で終わる。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from '../web/shared/document';

function main(argv: string[]): number {
  const path = argv[2];
  if (!path) {
    console.error('usage: inspect-document.ts <worker-output.json> [--json <out>]');
    return 2;
  }

  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const payload = JSON.parse(text) as { ok?: boolean; document?: unknown; error?: unknown };
  if (payload.ok !== true) {
    console.error('worker failed:', JSON.stringify(payload.error));
    return 1;
  }

  const doc = parseDocument(payload.document);
  const jsonIndex = argv.indexOf('--json');
  if (jsonIndex > 0 && argv[jsonIndex + 1]) {
    writeFileSync(argv[jsonIndex + 1], JSON.stringify(doc, null, 1) + '\n', 'utf8');
  }

  const translatable = doc.blocks.filter((block) => block.translatable);
  const positioned = doc.blocks.filter((block) => block.regions.length > 0);
  console.log('schema     :', doc.schema);
  console.log('hash       :', doc.hash);
  console.log('extractor  :', doc.extractor.version, doc.extractor.configHash.slice(0, 12));
  console.log('pages      :', doc.pages.length, 'ok/no-text/failed =',
    ['ok', 'no-text', 'failed'].map((s) => doc.pages.filter((p) => p.status === s).length).join('/'));
  console.log('blocks     :', doc.blocks.length, `(translatable ${translatable.length}, positioned ${positioned.length})`);
  console.log('chars      :', translatable.reduce((sum, block) => sum + block.source.length, 0));
  console.log('warnings   :', doc.warnings.length);
  for (const warning of doc.warnings.slice(0, 20)) console.log('  -', warning);

  const limit = Number(process.env.INSPECT_LIMIT ?? '40');
  for (const block of doc.blocks.slice(0, limit)) {
    const box = block.regions[0]?.box.map((v) => v.toFixed(3)).join(',') ?? '-';
    const page = block.regions[0]?.page ?? '-';
    console.log(
      `  ${String(block.order).padStart(3)} p${page} ${block.kind.padEnd(9)}` +
        ` ${block.translatable ? 'T' : ' '} [${box}]` +
        ` rel=${block.relatedIds.join('|') || '-'}` +
        ` ctx=${JSON.stringify(block.headingContext.slice(0, 24))}` +
        ` :: ${JSON.stringify(block.source.slice(0, 56))}`,
    );
  }
  if (doc.blocks.length > limit) console.log(`  ... ${doc.blocks.length - limit} more`);
  return 0;
}

process.exit(main(process.argv));
