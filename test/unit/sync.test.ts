import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks } from '../../src/markdown/blocks';
import { blockIndexAtLine, lineForBlock, SyncGate } from '../../src/panel/sync';

const DOC = '# Title\n\nAlpha.\n\nBravo.\n\nCharlie.\n';
// 行: 0=# Title, 2=Alpha., 4=Bravo., 6=Charlie.

test('行番号から、その行を含むブロックを引ける', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(blockIndexAtLine(blocks, 0), 0);
  assert.equal(blockIndexAtLine(blocks, 2), 1);
  assert.equal(blockIndexAtLine(blocks, 4), 2);
  assert.equal(blockIndexAtLine(blocks, 6), 3);
});

test('ブロック間の空行は直前のブロックに寄せる', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(blockIndexAtLine(blocks, 3), 1);
  assert.equal(blockIndexAtLine(blocks, 5), 2);
});

test('文書末尾より後ろの行は最後のブロックになる', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(blockIndexAtLine(blocks, 999), 3);
});

test('ブロックが無ければ -1 を返す', () => {
  assert.equal(blockIndexAtLine([], 0), -1);
});

test('ブロック index から開始行を引ける', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(lineForBlock(blocks, 2), 4);
  assert.equal(lineForBlock(blocks, 99), 0);
});

test('自分が起こした同期は抑制窓の間だけ拒否される', () => {
  let now = 1000;
  const gate = new SyncGate(250, () => now);

  assert.equal(gate.shouldAccept(), true);
  gate.markSelfInitiated();
  assert.equal(gate.shouldAccept(), false);

  now = 1249;
  assert.equal(gate.shouldAccept(), false);

  now = 1250;
  assert.equal(gate.shouldAccept(), true);
});

test('抑制はマークのたびに延長される', () => {
  let now = 0;
  const gate = new SyncGate(100, () => now);
  gate.markSelfInitiated();
  now = 90;
  gate.markSelfInitiated();
  now = 150;
  assert.equal(gate.shouldAccept(), false);
  now = 190;
  assert.equal(gate.shouldAccept(), true);
});
