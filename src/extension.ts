import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { TranslationCache } from './cache';
import { renderMarkdown } from './markdown/render';
import { PreviewPanel } from './panel/panel';
import { TranslationSession, type SessionEvent } from './session';
import { SequentialQueue } from './translate/queue';
import { translateBlock } from './translate/ollama';

/** Webview の script 起動が想定外に遅い／メッセージが届かない場合の待ち上限。 */
const PANEL_READY_TIMEOUT_MS = 3000;

interface Live {
  document: vscode.TextDocument;
  panel: PreviewPanel;
  session: TranslationSession;
  queue: SequentialQueue;
}

let live: Live | undefined;

export function activate(context: vscode.ExtensionContext): { events: SessionEvent[] } {
  // 統合テストから翻訳の進行を観測するための記録。
  const events: SessionEvent[] = [];

  context.subscriptions.push(
    vscode.commands.registerCommand('mdJaPreview.open', () => open(context, events)),
  );

  return { events };
}

export function deactivate(): void {
  live?.queue.cancelAll();
  live?.panel.dispose();
  live = undefined;
}

/**
 * Webview の 'ready' 通知を待つ。preview.js は message リスナー登録の最後に
 * { kind: 'ready' } を送るが、それより前に init を投げると黙って捨てられ
 * パネルが永久に空白のままになる。届かない場合に永久に固まらないよう、
 * 数秒のタイムアウトで諦めて先へ進む（遅れて描画される方が、拡張が
 * 返ってこないより良い）。
 */
async function waitForPanelReady(panel: PreviewPanel): Promise<void> {
  await Promise.race([
    panel.whenReady(),
    new Promise<void>((resolve) => setTimeout(resolve, PANEL_READY_TIMEOUT_MS)),
  ]);
}

async function open(context: vscode.ExtensionContext, events: SessionEvent[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    void vscode.window.showWarningMessage('Markdown ファイルを開いてから実行してください。');
    return;
  }

  // 別のファイルへ切り替えたときは、前のパネルと進行中の翻訳を畳む。
  live?.queue.cancelAll();
  live?.panel.dispose();
  live = undefined;

  const config = resolveConfig((key) =>
    vscode.workspace.getConfiguration('mdJaPreview').get(key),
  );

  const document = editor.document;
  const queue = new SequentialQueue();
  const panel = PreviewPanel.create(context, document.fileName.split(/[\\/]/).pop() ?? 'markdown');

  const cachePath = vscode.Uri.joinPath(context.globalStorageUri, 'translations.json').fsPath;
  const cache = await TranslationCache.load(cachePath);

  const session = new TranslationSession({
    model: config.ollama.model,
    maxBlockChars: config.maxBlockChars,
    translate: (source, headingContext, signal) =>
      translateBlock({ source, headingContext, config: config.ollama, signal }),
    enqueue: (job) => queue.enqueue(job),
    cacheGet: (model, source) => cache.get(model, source),
    cacheSet: (model, source, ja) => cache.set(model, source, ja),
    emit: (event) => {
      events.push(event);
      panel.post(toWebviewMessage(event));
    },
  });

  live = { document, panel, session, queue };

  panel.onMessage((message) => {
    if (message.kind === 'retry' && typeof message.index === 'number') {
      void session.retry(message.index);
    }
  });

  panel.onDispose(() => {
    queue.cancelAll();
    void cache.flush();
    live = undefined;
  });

  await waitForPanelReady(panel);
  await session.open(document.getText());
  await cache.flush();
}

/** SessionEvent の Markdown を HTML へ変換して Webview のメッセージ契約へ写す。 */
function toWebviewMessage(event: SessionEvent): unknown {
  if (event.kind === 'init') {
    return {
      kind: 'init',
      blocks: event.blocks.map((view) => ({
        index: view.index,
        html: renderMarkdown(view.markdown),
        state: view.state,
        lineStart: view.lineStart,
        lineEnd: view.lineEnd,
      })),
    };
  }
  if (event.kind === 'block') {
    return {
      kind: 'block',
      index: event.index,
      html: renderMarkdown(event.markdown),
      state: event.state,
    };
  }
  return { kind: 'banner', text: event.text };
}
