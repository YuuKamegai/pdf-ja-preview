import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebviewHtml, createNonce } from '../../src/panel/html';

const OPTIONS = {
  nonce: 'NONCE123',
  cspSource: 'vscode-webview://abc',
  scriptUri: 'vscode-webview://abc/media/preview.js',
  styleUri: 'vscode-webview://abc/media/preview.css',
};

test('CSP を default-src none で固定し、cspSource を埋め込む', () => {
  const html = buildWebviewHtml(OPTIONS);
  assert.match(html, /default-src 'none'/);
  assert.ok(html.includes(OPTIONS.cspSource));
});

test('script は nonce 付きの外部ファイル参照だけになる', () => {
  const html = buildWebviewHtml(OPTIONS);
  assert.match(html, /<script nonce="NONCE123" src="vscode-webview:\/\/abc\/media\/preview\.js">/);
  assert.equal(html.match(/<script/g)?.length, 1, 'script タグは 1 つだけ');
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'インライン script を置かないこと');
});

test('ブロックの受け皿とバナーの要素を持つ', () => {
  const html = buildWebviewHtml(OPTIONS);
  assert.ok(html.includes('id="banner"'));
  assert.ok(html.includes('id="blocks"'));
});

test('nonce は毎回異なる', () => {
  assert.notEqual(createNonce(), createNonce());
  assert.equal(createNonce().length >= 16, true);
});
