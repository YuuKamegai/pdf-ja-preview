import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  areaOf,
  blocksOnPage,
  blocksWithoutPosition,
  candidatesAt,
  containsPoint,
  normalizedToPdf,
  regionsForPage,
} from '../../web/client/geometry';
import {
  applySessionResponse,
  blockState,
  countStates,
  reduceEvent,
} from '../../web/client/state';
import type { PdfBlock, PdfDocument } from '../../web/shared/document';
import type { Snapshot } from '../../web/shared/protocol';

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    sessionId: 's1',
    documentId: 'd1',
    generation: 2,
    page: 1,
    paused: false,
    model: 'm1',
    blocks: [
      { id: 'b0', sourceHash: 'h0', status: 'queued' },
      { id: 'b1', sourceHash: 'h1', status: 'translated', ja: '訳1' },
    ],
    ...overrides,
  };
}

function block(id: string, order: number, regions: PdfBlock['regions']): PdfBlock {
  return {
    id,
    kind: 'paragraph',
    order,
    source: `Source ${id}`,
    headingContext: '',
    translatable: true,
    regions,
    relatedIds: [],
  };
}

function document(blocks: PdfBlock[]): PdfDocument {
  return {
    schema: 'pdf-document.v1',
    hash: 'a'.repeat(64),
    extractor: { version: 'test', configHash: 'b'.repeat(64) },
    pages: [
      { number: 1, width: 600, height: 800, rotation: 0, status: 'ok' },
      { number: 2, width: 600, height: 800, rotation: 0, status: 'ok' },
    ],
    blocks,
    warnings: [],
  };
}

// ---- イベントの畳み込み ----------------------------------------------------

test('自分の世代の訳だけ取り込む', () => {
  const state = snapshot();
  const next = reduceEvent(state, {
    type: 'block',
    sessionId: 's1',
    generation: 2,
    value: { id: 'b0', sourceHash: 'h0', status: 'translated', ja: '訳0' },
  });
  assert.equal(blockState(next, 'b0')?.ja, '訳0');
});

test('遅れて届いた別世代の訳は表示しない', () => {
  const state = snapshot();
  const next = reduceEvent(state, {
    type: 'block',
    sessionId: 's1',
    generation: 1,
    value: { id: 'b0', sourceHash: 'h0', status: 'translated', ja: '古い訳' },
  });
  assert.equal(next, state, '状態を作り直さない');
  assert.equal(blockState(next, 'b0')?.status, 'queued');
});

test('別セッションのイベントは無視する', () => {
  const state = snapshot();
  const next = reduceEvent(state, {
    type: 'block',
    sessionId: 'other',
    generation: 2,
    value: { id: 'b0', sourceHash: 'h0', status: 'translated', ja: 'よその訳' },
  });
  assert.equal(next, state);
});

test('snapshot は世代が上がっていても丸ごと置き換える', () => {
  const state = snapshot();
  const replacement = snapshot({ generation: 3, page: 4, blocks: [] });
  assert.deepEqual(reduceEvent(state, { type: 'snapshot', value: replacement }), replacement);
});

test('別セッションの snapshot は受け取らない', () => {
  const state = snapshot();
  const other = snapshot({ sessionId: 'other' });
  assert.equal(reduceEvent(state, { type: 'snapshot', value: other }), state);
});

test('知らないブロックの訳は足す', () => {
  const state = snapshot();
  const next = reduceEvent(state, {
    type: 'block',
    sessionId: 's1',
    generation: 2,
    value: { id: 'b9', sourceHash: 'h9', status: 'translated', ja: '新しい' },
  });
  assert.equal(next.blocks.length, 3);
});

test('error イベントは同じ世代のときだけ残す', () => {
  const state = snapshot();
  const kept = reduceEvent(state, {
    type: 'error',
    sessionId: 's1',
    generation: 2,
    code: 'number-missing',
    message: '数値が落ちています',
  });
  assert.equal(kept.error?.code, 'number-missing');

  const ignored = reduceEvent(state, {
    type: 'error',
    sessionId: 's1',
    generation: 1,
    code: 'old',
    message: '古い',
  });
  assert.equal(ignored.error, undefined);
});

test('heartbeat と document は状態を変えない', () => {
  const state = snapshot();
  assert.equal(reduceEvent(state, { type: 'heartbeat' }), state);
  assert.equal(
    reduceEvent(state, { type: 'document', documentId: 'd1', state: 'ready' }),
    state,
  );
});

test('進み具合を数えられる', () => {
  const counts = countStates(
    snapshot({
      blocks: [
        { id: 'a', sourceHash: 'h', status: 'translated', ja: 'x' },
        { id: 'b', sourceHash: 'h', status: 'error', error: { code: 'x', message: 'y' } },
        { id: 'c', sourceHash: 'h', status: 'queued' },
        { id: 'd', sourceHash: 'h', status: 'translating' },
        { id: 'e', sourceHash: 'h', status: 'source' },
      ],
    }),
  );
  assert.deepEqual(counts, { total: 5, translated: 1, failed: 1, pending: 2 });
});

// ---- 位置 -----------------------------------------------------------------

test('重なった領域は小さい方を先に出す', () => {
  const picture = block('pic', 0, [{ page: 1, box: [0.1, 0.1, 0.9, 0.9] }]);
  const caption = block('cap', 1, [{ page: 1, box: [0.2, 0.5, 0.6, 0.6] }]);
  const doc = document([picture, caption]);
  assert.deepEqual(
    candidatesAt(doc, 1, { x: 0.3, y: 0.55 }).map((b) => b.id),
    ['cap', 'pic'],
  );
});

test('同じ大きさなら文書順で安定させる', () => {
  const first = block('one', 0, [{ page: 1, box: [0.1, 0.1, 0.5, 0.5] }]);
  const second = block('two', 1, [{ page: 1, box: [0.1, 0.1, 0.5, 0.5] }]);
  assert.deepEqual(
    candidatesAt(document([second, first]), 1, { x: 0.2, y: 0.2 }).map((b) => b.id),
    ['one', 'two'],
  );
});

test('別のページの領域は候補に入らない', () => {
  const doc = document([block('p2', 0, [{ page: 2, box: [0.1, 0.1, 0.9, 0.9] }])]);
  assert.deepEqual(candidatesAt(doc, 1, { x: 0.5, y: 0.5 }), []);
});

test('領域の外は候補が無い', () => {
  const doc = document([block('a', 0, [{ page: 1, box: [0.1, 0.1, 0.2, 0.2] }])]);
  assert.deepEqual(candidatesAt(doc, 1, { x: 0.9, y: 0.9 }), []);
});

test('ページごとの一覧は文書順', () => {
  const doc = document([
    block('c', 2, [{ page: 1, box: [0.1, 0.6, 0.9, 0.7] }]),
    block('a', 0, [{ page: 1, box: [0.1, 0.1, 0.9, 0.2] }]),
    block('other', 1, [{ page: 2, box: [0.1, 0.1, 0.9, 0.2] }]),
  ]);
  assert.deepEqual(
    blocksOnPage(doc, 1).map((b) => b.id),
    ['a', 'c'],
  );
});

test('座標の無いブロックは別枠で拾える', () => {
  const doc = document([block('lost', 0, []), block('placed', 1, [{ page: 1, box: [0, 0, 1, 1] }])]);
  assert.deepEqual(
    blocksWithoutPosition(doc).map((b) => b.id),
    ['lost'],
  );
});

test('複数ページの出典は選択中のページを優先する', () => {
  const spanning = block('span', 0, [
    { page: 1, box: [0.1, 0.8, 0.9, 0.9] },
    { page: 2, box: [0.1, 0.1, 0.9, 0.2] },
  ]);
  assert.deepEqual(
    regionsForPage(spanning, 2).map((r) => r.page),
    [2],
  );
  assert.deepEqual(
    regionsForPage(spanning, 3).map((r) => r.page),
    [1],
    '無ければ最初の領域',
  );
});

test('面積と内包の基本', () => {
  assert.equal(areaOf([0, 0, 0.5, 0.4]), 0.2);
  assert.equal(containsPoint([0.1, 0.1, 0.2, 0.2], { x: 0.15, y: 0.15 }), true);
  assert.equal(containsPoint([0.1, 0.1, 0.2, 0.2], { x: 0.25, y: 0.15 }), false);
});

test('座標変換は geometry の契約のまま', () => {
  assert.deepEqual(normalizedToPdf([0.1, 0.2, 0.4, 0.5], [10, 20, 610, 820]), [70, 660, 250, 420]);
});

// ---- 往復の応答 -----------------------------------------------------------

test('PATCH の応答で、その間に届いた訳を捨てない', () => {
  const current = snapshot({
    blocks: [{ id: 'b0', sourceHash: 'h0', status: 'translated', ja: '届いた訳' }],
  });
  // サーバーが要求を受けた時点の姿。まだ訳が入っていない。
  const stale = snapshot({ page: 3, blocks: [{ id: 'b0', sourceHash: 'h0', status: 'translating' }] });

  const merged = applySessionResponse(current, stale);
  assert.equal(merged.page, 3, 'ページは応答に従う');
  assert.equal(blockState(merged, 'b0')?.status, 'translated', '訳は残す');
});

test('世代が変わった応答には丸ごと従う', () => {
  const current = snapshot({
    blocks: [{ id: 'b0', sourceHash: 'h0', status: 'translated', ja: '古い訳' }],
  });
  const reset = snapshot({ generation: 3, blocks: [{ id: 'b0', sourceHash: 'h0', status: 'queued' }] });
  const merged = applySessionResponse(current, reset);
  assert.equal(merged.generation, 3);
  assert.equal(blockState(merged, 'b0')?.status, 'queued');
});

test('別セッションの応答は取り込まない', () => {
  const current = snapshot();
  assert.equal(applySessionResponse(current, snapshot({ sessionId: 'other' })), current);
});

test('応答で休止とモデルは更新する', () => {
  const current = snapshot();
  const merged = applySessionResponse(current, snapshot({ paused: true, model: 'm2' }));
  assert.equal(merged.paused, true);
  assert.equal(merged.model, 'm2');
});

test('応答にエラーが無ければ手元のエラーも消す', () => {
  const current = snapshot({ error: { code: 'x', message: 'y' } });
  assert.equal(applySessionResponse(current, snapshot()).error, undefined);
});
