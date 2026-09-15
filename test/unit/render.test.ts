import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/markdown/render';

test('見出しとリストを HTML へ変換する', () => {
  const html = renderMarkdown('# 題\n\n- 一\n- 二\n');
  assert.match(html, /<h1>題<\/h1>/);
  assert.match(html, /<li>一<\/li>/);
});

test('コードフェンスは pre/code になる', () => {
  assert.match(renderMarkdown('```js\nconst a = 1;\n```'), /<pre><code/);
});

test('生 HTML は実行可能な形で出力されない', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n');
  assert.ok(!html.includes('<script>'), '生の script タグを通さないこと');
});

test('javascript: スキームのリンクは href にならない', () => {
  const html = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!/href="javascript:/i.test(html));
});

test('表を table 要素へ変換する', () => {
  assert.match(renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n'), /<table>/);
});
