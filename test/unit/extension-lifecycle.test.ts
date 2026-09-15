import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

interface Harness {
  commands: Map<string, () => unknown>;
  editorListeners: Array<(editor: unknown) => unknown>;
  panels: FakePanel[];
  loads: Array<{ resolve(): void }>;
  sessions: FakeSession[];
  caches: Array<{ flushes: number }>;
  config: Record<string, unknown>;
  activeTextEditor?: { document: { languageId: string; fileName: string; getText(): string } };
}

class FakePanel {
  messages: unknown[] = [];
  disposed = false;
  private messageHandlers: Array<(message: any) => void> = [];
  private disposeHandlers: Array<() => void> = [];
  post(message: unknown): void { this.messages.push(message); }
  onMessage(handler: (message: any) => void): void { this.messageHandlers.push(handler); }
  onDispose(handler: () => void): void { this.disposeHandlers.push(handler); }
  reveal(): void {}
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handler of this.disposeHandlers) handler();
  }
  receive(message: unknown): void { for (const handler of this.messageHandlers) handler(message); }
}

class FakeSession {
  opens: string[] = [];
  constructor(private readonly deps: { emit(event: unknown): void }) {
    harness.sessions.push(this);
  }
  async open(text: string): Promise<void> {
    this.opens.push(text);
    this.deps.emit({ kind: 'init', blocks: [] });
  }
  async retry(): Promise<void> {}
  emit(event: unknown): void { this.deps.emit(event); }
}

let harness: Harness;
let outputDir: string;
let extension: { activate(context: any): { events: unknown[] }; deactivate(): void };

before(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'md-ja-preview-extension-'));
  const outfile = join(outputDir, 'extension.cjs');
  await esbuild.build({
    entryPoints: [new URL('../../src/extension.ts', import.meta.url).pathname.slice(1)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [{
      name: 'lifecycle-fakes',
      setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fake' }));
        build.onResolve({ filter: /\/cache$/ }, () => ({ path: 'cache', namespace: 'fake' }));
        build.onResolve({ filter: /\/panel\/panel$/ }, () => ({ path: 'panel', namespace: 'fake' }));
        build.onResolve({ filter: /\/session$/ }, () => ({ path: 'session', namespace: 'fake' }));
        build.onResolve({ filter: /\/translate\/queue$/ }, () => ({ path: 'queue', namespace: 'fake' }));
        build.onResolve({ filter: /\/translate\/ollama$/ }, () => ({ path: 'ollama', namespace: 'fake' }));
        build.onResolve({ filter: /\/markdown\/render$/ }, () => ({ path: 'render', namespace: 'fake' }));
        build.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({ contents: mocks[args.path] }));
      },
    }],
  });
  extension = createRequire(import.meta.url)(outfile);
});

after(async () => { await rm(outputDir, { recursive: true, force: true }); });

beforeEach(() => {
  extension?.deactivate();
  harness = {
    commands: new Map(), editorListeners: [], panels: [], loads: [], sessions: [], caches: [], config: {},
    activeTextEditor: { document: { languageId: 'markdown', fileName: 'a.md', getText: () => '# A' } },
  };
  (globalThis as any).__mdJaHarness = harness;
});

const mocks: Record<string, string> = {
  vscode: `module.exports = {
    commands: { registerCommand(id, fn) { globalThis.__mdJaHarness.commands.set(id, fn); return {}; } },
    window: {
      get activeTextEditor() { return globalThis.__mdJaHarness.activeTextEditor; },
      onDidChangeActiveTextEditor(fn) { globalThis.__mdJaHarness.editorListeners.push(fn); return {}; },
      showWarningMessage() {},
    },
    workspace: { getConfiguration() { return { get(k) { return globalThis.__mdJaHarness.config[k]; } }; } },
    Uri: { joinPath(base, name) { return { fsPath: base.fsPath + '/' + name }; } },
  };`,
  cache: `exports.TranslationCache = class {
    constructor() { this.flushes = 0; globalThis.__mdJaHarness.caches.push(this); }
    static load() { return new Promise(resolve => globalThis.__mdJaHarness.loads.push({ resolve: () => resolve(new this()) })); }
    get() {} set() {} async flush() { this.flushes++; }
  };`,
  panel: `exports.PreviewPanel = class { static create() { const p = new globalThis.__mdJaFakePanel(); globalThis.__mdJaHarness.panels.push(p); return p; } };`,
  session: `exports.TranslationSession = globalThis.__mdJaFakeSession;`,
  queue: `exports.SequentialQueue = class { cancelAll() { this.cancelled = true; } enqueue(job) { return job(new AbortController().signal); } };`,
  ollama: `exports.translateBlock = async () => '';`,
  render: `exports.renderMarkdown = value => value;`,
};

(globalThis as any).__mdJaFakePanel = FakePanel;
(globalThis as any).__mdJaFakeSession = FakeSession;

function context() { return { subscriptions: [], globalStorageUri: { fsPath: 'storage' }, extensionUri: {} }; }
async function tick(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }

test('ready 前のメッセージはパネル側で保持されるため session は ready を待たず開始できる', async () => {
  extension.activate(context());
  const running = harness.commands.get('mdJaPreview.open')!();
  harness.loads[0].resolve();
  await running;
  assert.deepEqual(harness.sessions[0].opens, ['# A']);
});

test('cache load 中に閉じたパネルは load 完了後も session を開始しない', async () => {
  extension.activate(context());
  const running = harness.commands.get('mdJaPreview.open')!();
  harness.panels[0].dispose();
  harness.loads[0].resolve();
  await running;
  assert.equal(harness.sessions.length, 0);
});

test('連続 open では新しい世代だけが session を開始する', async () => {
  extension.activate(context());
  const command = harness.commands.get('mdJaPreview.open')!;
  const first = command();
  const second = command();
  assert.equal(harness.panels[0].disposed, true);
  harness.loads[0].resolve();
  await Promise.all([first, second]);
  assert.equal(harness.sessions.length, 1);
  assert.deepEqual(harness.sessions[0].opens, ['# A']);
});

test('切替後の stale session event を捨て、共有 cache を dispose 時にも flush する', async () => {
  const api = extension.activate(context());
  const command = harness.commands.get('mdJaPreview.open')!;
  const first = command();
  harness.loads[0].resolve();
  await first;
  const before = api.events.length;
  const second = command();
  await second;
  harness.sessions[0].emit({ kind: 'block', index: 0, markdown: 'stale', state: 'translated' });
  await tick();
  assert.equal(api.events.length, before + 1); // 新 session の init だけ
  assert.equal(harness.caches.length, 1);
  assert.ok(harness.caches[0].flushes >= 3); // 完了2回 + 最初のpanel dispose
});

test('autoOpen=true なら Markdown editor の activation で open する', async () => {
  harness.config.autoOpen = true;
  extension.activate(context());
  assert.equal(harness.editorListeners.length, 1);
  harness.editorListeners[0](harness.activeTextEditor);
  await tick();
  assert.equal(harness.panels.length, 1);
});
