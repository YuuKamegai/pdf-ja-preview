import * as vscode from 'vscode';
import { buildWebviewHtml, createNonce } from './html';

export class PreviewPanel {
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  private isReady = false;
  private disposed = false;
  private readonly pending: unknown[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel) {
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
    // Webview の HTML を設定する前に受信口を用意する。同期的に script が起動しても
    // ready を取りこぼさない。
    this.panel.webview.onDidReceiveMessage((message: { kind?: string }) => {
      if (message.kind !== 'ready' || this.isReady || this.disposed) return;
      this.isReady = true;
      this.markReady();
      for (const pending of this.pending.splice(0)) {
        void this.panel.webview.postMessage(pending);
      }
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.pending.length = 0;
    });
  }

  static create(context: vscode.ExtensionContext, title: string): PreviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'mdJaPreview',
      `日本語: ${title}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    const nonce = createNonce();
    const asUri = (name: string) =>
      panel.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name))
        .toString();

    const preview = new PreviewPanel(panel);

    panel.webview.html = buildWebviewHtml({
      nonce,
      cspSource: panel.webview.cspSource,
      scriptUri: asUri('preview.js'),
      styleUri: asUri('preview.css'),
    });

    return preview;
  }

  /** Webview の script が message リスナーを登録し終えるまで待つ。 */
  whenReady(): Promise<void> {
    return this.ready;
  }

  post(message: unknown): void {
    if (this.disposed) return;
    if (!this.isReady) {
      this.pending.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  onMessage(handler: (message: { kind: string; [key: string]: unknown }) => void): void {
    this.panel.webview.onDidReceiveMessage(handler);
  }

  onDispose(handler: () => void): void {
    this.panel.onDidDispose(handler);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.length = 0;
    this.panel.dispose();
  }
}
