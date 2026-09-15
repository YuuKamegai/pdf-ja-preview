import * as vscode from 'vscode';
import { buildWebviewHtml, createNonce } from './html';

export class PreviewPanel {
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
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

    panel.webview.html = buildWebviewHtml({
      nonce,
      cspSource: panel.webview.cspSource,
      scriptUri: asUri('preview.js'),
      styleUri: asUri('preview.css'),
    });

    const preview = new PreviewPanel(panel);
    // ready ハンドラは whenReady() を誰かが待つより前にここで配線する。
    // 後から配線すると、待つ側と受信の間でまた競合が生まれる。
    preview.onMessage((message) => {
      if (message.kind === 'ready') preview.markReady();
    });
    return preview;
  }

  /** Webview の script が message リスナーを登録し終えるまで待つ。 */
  whenReady(): Promise<void> {
    return this.ready;
  }

  post(message: unknown): void {
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
    this.panel.dispose();
  }
}
