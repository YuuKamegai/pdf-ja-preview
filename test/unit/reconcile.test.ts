import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks } from '../../src/markdown/blocks';
import { reconcile } from '../../src/markdown/reconcile';

const OLD = '# Title\n\nAlpha.\n\nBravo.\n';

function translationsFor(text: string): Map<number, string> {
  return new Map(splitBlocks(text).map((b) => [b.index, `JA:${b.source}`]));
}

test('先頭に段落を挿入しても既存訳がすべて持ち越される', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('Intro.\n\n' + OLD),
  );
  assert.deepEqual(pending, [0]);
  assert.equal(carried.get(1), 'JA:# Title');
  assert.equal(carried.get(2), 'JA:Alpha.');
  assert.equal(carried.get(3), 'JA:Bravo.');
});

test('1 段落だけ編集したらその 1 つだけが再翻訳対象になる', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('# Title\n\nAlpha edited.\n\nBravo.\n'),
  );
  assert.deepEqual(pending, [1]);
  assert.equal(carried.get(0), 'JA:# Title');
  assert.equal(carried.get(2), 'JA:Bravo.');
});

test('中間の段落を削除しても残りの訳がずれない', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('# Title\n\nBravo.\n'),
  );
  assert.deepEqual(pending, []);
  assert.equal(carried.get(1), 'JA:Bravo.');
});

test('同一内容のブロックが重複していても取り違えない', () => {
  const text = 'Same.\n\nOther.\n\nSame.\n';
  const translations = new Map([
    [0, 'JA-first'],
    [1, 'JA-other'],
    [2, 'JA-second'],
  ]);
  const { carried, pending } = reconcile(splitBlocks(text), translations, splitBlocks(text));
  assert.deepEqual(pending, []);
  assert.equal(carried.get(0), 'JA-first');
  assert.equal(carried.get(2), 'JA-second');
});

test('訳を持たない旧ブロックは pending に残る', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    new Map([[0, 'JA:# Title']]),
    splitBlocks(OLD),
  );
  assert.deepEqual(pending, [1, 2]);
  assert.equal(carried.get(0), 'JA:# Title');
});

test('全面的に書き換えたら全ブロックが pending になる', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('Completely different.\n\nAnd more.\n'),
  );
  assert.deepEqual(pending, [0, 1]);
  assert.equal(carried.size, 0);
});
