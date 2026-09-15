import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structureOf, matchesStructure } from '../../src/markdown/verify';

test('フェンス・インラインコード・リンクを数える', () => {
  const md = 'See `foo` and [site](https://example.com).\n\n```js\nx\n```\n';
  assert.deepEqual(structureOf(md), {
    fences: 1,
    inlineCodes: 1,
    links: ['https://example.com'],
  });
});

test('リンク URL は昇順に並べ替えられる', () => {
  const md = '[b](https://b.example) と [a](https://a.example)';
  assert.deepEqual(structureOf(md).links, ['https://a.example', 'https://b.example']);
});

test('構造が保たれた訳文を受け入れる', () => {
  const src = 'Run `npm test` and read [docs](https://example.com/docs).';
  const ja = '`npm test` を実行し、[ドキュメント](https://example.com/docs) を読む。';
  assert.equal(matchesStructure(src, ja), true);
});

test('インラインコードが訳されてしまった訳文を弾く', () => {
  assert.equal(matchesStructure('Run `npm test` now.', '今すぐ npm テスト を実行する。'), false);
});

test('URL が書き換えられた訳文を弾く', () => {
  const src = 'See [docs](https://example.com/en).';
  const ja = '[ドキュメント](https://example.com/ja) を参照。';
  assert.equal(matchesStructure(src, ja), false);
});

test('コードフェンスが増えた訳文を弾く', () => {
  assert.equal(matchesStructure('Plain sentence.', '```\n包んでしまった\n```'), false);
});

test('リンクもコードも無い散文はそのまま受け入れる', () => {
  assert.equal(matchesStructure('Hello world.', 'こんにちは世界。'), true);
});
