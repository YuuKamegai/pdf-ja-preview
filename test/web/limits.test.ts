/**
 * 既定の上限そのものを固定する試験。
 *
 * `documents.test.ts` は上限の**仕組み**（超えた時点で切る）を注入した値で試す。
 * ここで見るのは**既定値の方針**で、実測した基準文書が通ることと、
 * 上限どうしが矛盾しないことを縛る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MAX_PAGES, MAX_UPLOAD_BYTES } from '../../web/shared/protocol';
import { DEFAULT_EXTRACTION_TIMEOUT_MS } from '../../web/server/extractor';

/**
 * 基準文書。実測値なので、上限を下げたらここで落ちる。
 *
 * "Computational Methods and Data Analysis for Metabolomics"（Springer, 2020）
 * 390 ページ・60,902,790 バイト。文字レイヤーあり、CropBox は全ページ 505x720pt。
 * 2026-09-18 に実イメージ `pdf-ja-extractor:1` で全ページ `status: ok` を確認済み。
 */
const REFERENCE_PAGES = 390;
const REFERENCE_BYTES = 60_902_790;

test('既定の上限は基準文書（390 ページ・58.1 MiB）を受け入れる', () => {
  assert.ok(
    MAX_PAGES >= REFERENCE_PAGES,
    `MAX_PAGES=${MAX_PAGES} では基準文書の ${REFERENCE_PAGES} ページを拒否する`,
  );
  assert.ok(
    MAX_UPLOAD_BYTES >= REFERENCE_BYTES,
    `MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES} では基準文書の ${REFERENCE_BYTES} バイトを拒否する`,
  );
});

test('ページ数の上限は抽出ワーカーと共有契約で一致する', () => {
  // 食い違うと、抽出は通ったのに画面からページ番号を送れない、という形で壊れる。
  // 小さいほうが黙って効くので、どちらを直し忘れても気づけるようにする。
  const worker = readFileSync(
    fileURLToPath(new URL('../../python/pdf_ja/worker.py', import.meta.url)),
    'utf-8',
  );
  const found = /^MAX_PAGES\s*=\s*(\d+)$/m.exec(worker);
  assert.ok(found, 'worker.py に MAX_PAGES の定義が見つからない');

  assert.equal(
    Number(found[1]),
    MAX_PAGES,
    `worker.py=${found[1]} と protocol.ts=${MAX_PAGES} が食い違っている`,
  );
});

test('上限いっぱいのページ数でも既定の抽出タイムアウトに収まる', () => {
  // 実測（2026-09-18, pdf-ja-extractor:1, CPU 4 スレッド）:
  //   固定費（モデル読み込み等）約 25 秒 + 約 0.75 秒/ページ。
  // 機械差を見て 1.5 秒/ページまで悪化しても間に合うことを要求する。
  // ここが破れる上限を置くと、利用者は「ページ数超過」ではなく
  // 打ち切りという分かりにくい失敗を受け取る。
  const worstCaseMs = 30_000 + MAX_PAGES * 1_500;

  assert.ok(
    worstCaseMs <= DEFAULT_EXTRACTION_TIMEOUT_MS,
    `MAX_PAGES=${MAX_PAGES} は最悪 ${worstCaseMs}ms かかり、` +
      `既定の打ち切り ${DEFAULT_EXTRACTION_TIMEOUT_MS}ms を超える`,
  );
});
