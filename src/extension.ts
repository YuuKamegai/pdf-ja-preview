import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { TranslationCache } from './cache';
import { renderMarkdown } from './markdown/render';
import { PreviewPanel } from './panel/panel';
import { blockIndexAtLine, lineForBlock, SyncGate } from './panel/sync';
import { TranslationSession, type SessionEvent } from './session';
import { SequentialQueue } from './translate/queue';
import { translate } from './translate/provider';

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

  const SECRET_KEY = 'mdJaPreview.apiKey';

  context.subscriptions.push(
    vscode.commands.registerCommand('mdJaPreview.open', () => open(context, events)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) void autoOpen(context, events, editor);
    }),
    vscode.commands.registerCommand('mdJaPreview.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'クラウド provider の API キー',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-...',
      });
      if (value === undefined) return;
      const trimmed = value.trim();
      if (trimmed === '') {
        void vscode.window.showWarningMessage('API キーが空です。登録しませんでした。');
        return;
      }
      await context.secrets.store(SECRET_KEY, trimmed);
      void vscode.window.showInformationMessage('API キーを登録しました。');
    }),
    vscode.commands.registerCommand('mdJaPreview.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      void vscode.window.showInformationMessage('API キーを削除しました。');
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
    model: config.provider.model,
    maxBlockChars: config.maxBlockChars,
    translate: (source, headingContext, signal) =>
      translate({ source, headingContext, config: config.provider, signal }),
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

  const gate = new SyncGate();

  if (config.scrollSync) {
    const scrollListener = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (live !== owned || owned.disposed) return;
      if (event.textEditor.document.uri.toString() !== document.uri.toString()) return;
      // 跳ね返りで来たスクロールなら、送り返さずに窓が閉じるのを待つ。
      if (!gate.shouldAccept()) return;

      const topLine = event.visibleRanges[0]?.start.line;
      if (topLine === undefined) return;
      const index = blockIndexAtLine(session.blocks, topLine);
      if (index < 0) return;

      gate.markSelfInitiated();
      panel.post({ kind: 'scrollTo', index, ratio: 0 });
    });
    context.subscriptions.push(scrollListener);
    panel.onDispose(() => scrollListener.dispose());
  }

  panel.onMessage((message) => {
    if (live !== owned || owned.disposed) return;

    if (message.kind === 'retry' && typeof message.index === 'number') {
      void session.retry(message.index);
      return;
    }

    if (message.kind === 'scrolled' && typeof message.index === 'number') {
      if (!config.scrollSync || !gate.shouldAccept()) return;

      const editorForDocument = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === document.uri.toString(),
      );
      if (!editorForDocument) return;

      const line = lineForBlock(session.blocks, message.index);
      gate.markSelfInitiated();
      editorForDocument.revealRange(
        new vscode.Range(line, 0, line, 0),
        vscode.TextEditorRevealType.AtTop,
      );
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
