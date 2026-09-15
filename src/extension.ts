import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { TranslationCache } from './cache';
import { renderMarkdown } from './markdown/render';
import { PreviewPanel } from './panel/panel';
import { TranslationSession, type SessionEvent } from './session';
import { SequentialQueue } from './translate/queue';
import { translateBlock } from './translate/ollama';

interface Live {
  document: vscode.TextDocument;
  panel: PreviewPanel;
  queue: SequentialQueue;
  session?: TranslationSession;
  disposed: boolean;
}

let live: Live | undefined;
let cachePromise: Promise<TranslationCache> | undefined;

export function activate(context: vscode.ExtensionContext): { events: SessionEvent[] } {
  // 統合テストから翻訳の進行を観測するための記録。
  const events: SessionEvent[] = [];
  cachePromise = undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('mdJaPreview.open', () => open(context, events)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) void autoOpen(context, events, editor);
    }),
  );

  const editor = vscode.window.activeTextEditor;
  if (editor) void autoOpen(context, events, editor);

  return { events };
}

export function deactivate(): void {
  close(live);
  live = undefined;
  cachePromise = undefined;
}

function close(target: Live | undefined): void {
  if (!target || target.disposed) return;
  target.disposed = true;
  target.queue.cancelAll();
  target.panel.dispose();
}

async function autoOpen(
  context: vscode.ExtensionContext,
  events: SessionEvent[],
  editor: vscode.TextEditor,
): Promise<void> {
  if (editor.document.languageId !== 'markdown') return;
  const enabled = resolveConfig((key) =>
    vscode.workspace.getConfiguration('mdJaPreview').get(key),
  ).autoOpen;
  if (!enabled) return;
  if (live?.document === editor.document && !live.disposed) {
    live.panel.reveal();
    return;
  }
  await open(context, events);
}

async function open(context: vscode.ExtensionContext, events: SessionEvent[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    void vscode.window.showWarningMessage('Markdown ファイルを開いてから実行してください。');
    return;
  }

  // 別のファイルへ切り替えたときは、前のパネルと進行中の翻訳を畳む。
  close(live);
  live = undefined;

  const config = resolveConfig((key) =>
    vscode.workspace.getConfiguration('mdJaPreview').get(key),
  );

  const document = editor.document;
  const queue = new SequentialQueue();
  const panel = PreviewPanel.create(context, document.fileName.split(/[\\/]/).pop() ?? 'markdown');
  const owned: Live = { document, panel, queue, disposed: false };
  live = owned;

  panel.onDispose(() => {
    owned.disposed = true;
    owned.session?.dispose();
    queue.cancelAll();
    void cachePromise?.then((cache) => cache.flush()).catch(() => undefined);
    if (live === owned) live = undefined;
  });

  const cachePath = vscode.Uri.joinPath(context.globalStorageUri, 'translations.json').fsPath;
  // 同じ activation 中は単一インスタンスを共有し、旧パネルの遅い flush が
  // 新パネルのキャッシュを古い内容で上書きするのを防ぐ。
  const cache = await (cachePromise ??= TranslationCache.load(cachePath));
  if (live !== owned || owned.disposed) return;

  const session = new TranslationSession({
    model: config.ollama.model,
    maxBlockChars: config.maxBlockChars,
    translate: (source, headingContext, signal) =>
      translateBlock({ source, headingContext, config: config.ollama, signal }),
    enqueue: (job) => queue.enqueue(job),
    cacheGet: (model, source) => cache.get(model, source),
    cacheSet: (model, source, ja) => cache.set(model, source, ja),
    emit: (event) => {
      if (live !== owned || owned.disposed) return;
      events.push(event);
      panel.post(toWebviewMessage(event));
    },
  });

  owned.session = session;

  panel.onMessage((message) => {
    if (live === owned && !owned.disposed && message.kind === 'retry' && typeof message.index === 'number') {
      void session.retry(message.index);
    }
  });

  const saveListener = vscode.workspace.onDidSaveTextDocument((saved) => {
    if (
      live !== owned ||
      owned.disposed ||
      saved.uri.toString() !== document.uri.toString()
    ) return;

    queue.cancelAll();
    void session
      .update(saved.getText())
      .then(() => cache.flush())
      .catch((error: unknown) => {
        if (live !== owned || owned.disposed) return;
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`保存後の再翻訳に失敗しました: ${detail}`);
      });
  });
  context.subscriptions.push(saveListener);
  panel.onDispose(() => saveListener.dispose());

  await session.open(document.getText());
  if (live !== owned || owned.disposed) return;
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
