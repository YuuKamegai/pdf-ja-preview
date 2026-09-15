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
