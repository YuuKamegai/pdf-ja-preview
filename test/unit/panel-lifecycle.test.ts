import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

let outputDir: string;
let PreviewPanel: any;

before(async () => {
  (globalThis as any).__panelVscode = {
    window: { createWebviewPanel: (...args: unknown[]) => (globalThis as any).__createPanel(...args) },
    ViewColumn: { Beside: 2 }, Uri: { joinPath: () => ({}) },
  };
  outputDir = await mkdtemp(join(tmpdir(), 'md-ja-preview-panel-'));
  const outfile = join(outputDir, 'panel.cjs');
  await esbuild.build({
    entryPoints: [new URL('../../src/panel/panel.ts', import.meta.url).pathname.slice(1)],
    outfile, bundle: true, platform: 'node', format: 'cjs',
    plugins: [{
      name: 'vscode-fake',
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
        build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'module.exports = globalThis.__panelVscode;' }));
      },
    }],
  });
  PreviewPanel = createRequire(import.meta.url)(outfile).PreviewPanel;
});

after(async () => { await rm(outputDir, { recursive: true, force: true }); });

test('ready listener を HTML 設定より先に登録し、ready 前の送信を順番どおり flush する', async () => {
  const order: string[] = [];
  const delivered: unknown[] = [];
  let receive: (message: any) => void = () => undefined;
  const webview: any = {
    cspSource: 'test',
    asWebviewUri: () => ({ toString: () => 'asset' }),
    onDidReceiveMessage(handler: (message: any) => void) { order.push('listener'); receive = handler; },
    postMessage(message: unknown) { delivered.push(message); return Promise.resolve(true); },
  };
  Object.defineProperty(webview, 'html', { set() { order.push('html'); } });
  (globalThis as any).__createPanel = () => ({ webview, onDidDispose() {}, reveal() {}, dispose() {} });
  const panel = PreviewPanel.create({ extensionUri: {} }, 'a.md');
  panel.post({ kind: 'init' });
  panel.post({ kind: 'block', index: 0 });
  assert.deepEqual(order.slice(0, 2), ['listener', 'html']);
  assert.deepEqual(delivered, []);
  receive({ kind: 'ready' });
  await Promise.resolve();
  assert.deepEqual(delivered, [{ kind: 'init' }, { kind: 'block', index: 0 }]);
});

test('ネイティブに閉じたパネルは pending message を ready 後にも送らない', async () => {
  const delivered: unknown[] = [];
  let receive: (message: any) => void = () => undefined;
  let dispose: () => void = () => undefined;
  const webview: any = {
    cspSource: 'test', asWebviewUri: () => ({ toString: () => 'asset' }),
    onDidReceiveMessage(handler: (message: any) => void) { receive = handler; },
    postMessage(message: unknown) { delivered.push(message); return Promise.resolve(true); },
  };
  Object.defineProperty(webview, 'html', { set() {} });
  (globalThis as any).__createPanel = () => ({
    webview, onDidDispose(handler: () => void) { dispose = handler; }, reveal() {}, dispose() { dispose(); },
  });
  const panel = PreviewPanel.create({ extensionUri: {} }, 'a.md');
  panel.post({ kind: 'init' });
  dispose();
  receive({ kind: 'ready' });
  assert.deepEqual(delivered, []);
});
