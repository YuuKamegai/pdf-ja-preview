import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mdJaPreview.open', () => {
      void vscode.window.showInformationMessage('md-ja Preview');
    }),
  );
}

export function deactivate(): void {}
