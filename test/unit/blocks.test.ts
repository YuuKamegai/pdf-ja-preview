import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks, hashSource, TRANSLATABLE_KINDS } from '../../src/markdown/blocks';

test('見出しと段落を別ブロックに分け、行範囲を持つ', () => {
  const blocks = splitBlocks('# Title\n\nHello world.\n');
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.source, b.lineStart, b.lineEnd]),
    [
      ['heading', '# Title', 0, 1],
      ['paragraph', 'Hello world.', 2, 3],
    ],
  );
});

test('コードフェンスは 1 ブロックで、中身は分割されない', () => {
  const blocks = splitBlocks('```js\nconst a = 1;\n\nconst b = 2;\n```\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'fence');
  assert.ok(blocks[0].source.includes('const b = 2;'));
});

test('リストは項目ごとではなく 1 ブロックになる', () => {
  const blocks = splitBlocks('- one\n- two\n- three\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'list');
});

test('引用の中の段落は独立ブロックにならない', () => {
  const blocks = splitBlocks('> quoted one\n>\n> quoted two\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'blockquote');
});

test('表・水平線・生 HTML をそれぞれ 1 ブロックとして認識する', () => {
  const md = '| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n<div>raw</div>\n';
  assert.deepEqual(splitBlocks(md).map((b) => b.kind), ['table', 'hr', 'html']);
});

test('index は 0 始まりの通し番号になる', () => {
  assert.deepEqual(splitBlocks('# A\n\nb\n\n# C\n').map((b) => b.index), [0, 1, 2]);
});

test('hash は原文に依存し、同じ原文なら一致する', () => {
  assert.equal(hashSource('same'), hashSource('same'));
  assert.notEqual(hashSource('a'), hashSource('b'));
  assert.equal(splitBlocks('x\n')[0].hash, hashSource('x'));
});

test('翻訳対象の種別に fence / html / hr を含めない', () => {
  assert.equal(TRANSLATABLE_KINDS.has('paragraph'), true);
  assert.equal(TRANSLATABLE_KINDS.has('fence'), false);
  assert.equal(TRANSLATABLE_KINDS.has('html'), false);
  assert.equal(TRANSLATABLE_KINDS.has('hr'), false);
});

test('CRLF 改行でも行範囲が崩れない', () => {
  const blocks = splitBlocks('# T\r\n\r\nbody\r\n');
  assert.deepEqual(blocks.map((b) => [b.source, b.lineStart]), [['# T', 0], ['body', 2]]);
});

const listItem = (n: number) => `- ${'x'.repeat(40)} ${n}`;

test('maxBlockChars を超えるリストは項目単位でまとめ直される', () => {
  const md = [listItem(1), listItem(2), listItem(3), listItem(4)].join('\n') + '\n';
  const blocks = splitBlocks(md, 100);
  assert.ok(blocks.length > 1, '分割されること');
  assert.ok(blocks.every((b) => b.kind === 'list'));
  assert.equal(blocks.map((b) => b.source).join('\n'), md.trimEnd());
});

test('分割後も行範囲が連続し、index が振り直される', () => {
  const md = [listItem(1), listItem(2), listItem(3)].join('\n') + '\n';
  const blocks = splitBlocks(md, 60);
  assert.deepEqual(blocks.map((b) => b.index), blocks.map((_, i) => i));
  for (let i = 1; i < blocks.length; i++) {
    assert.equal(blocks[i].lineStart, blocks[i - 1].lineEnd);
  }
});

test('1 項目が単独で上限を超えても、その項目は割らない', () => {
  const blocks = splitBlocks(`- ${'y'.repeat(300)}\n`, 50);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, `- ${'y'.repeat(300)}`);
});

test('上限以下のリストと、上限を超えた表は分割されない', () => {
  assert.equal(splitBlocks('- a\n- b\n', 1000).length, 1);
  const table = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n';
  assert.equal(splitBlocks(table, 10).length, 1, '表は上限を超えても割らない');
});

test('リストの後ろに別のブロックが続いても、lineEnd はリスト本体の末尾で止まる', () => {
  const blocks = splitBlocks('- a\n- b\n\n# next\n');
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.source, b.lineStart, b.lineEnd]),
    [
      ['list', '- a\n- b', 0, 2],
      ['heading', '# next', 3, 4],
    ],
  );
});

test('分割されたリストの後ろにブロックが続く場合も、最後の断片が本体の末尾で止まる', () => {
  const blocks = splitBlocks(
    [listItem(1), listItem(2), listItem(3)].join('\n') + '\n\n# next\n',
    60,
  );
  const lists = blocks.filter((b) => b.kind === 'list');
  assert.ok(lists.length > 1, 'リストが分割されること');
  assert.equal(lists[lists.length - 1].lineEnd, 3);
  assert.equal(blocks[blocks.length - 1].kind, 'heading');
  assert.equal(blocks[blocks.length - 1].lineStart, 4);
});
