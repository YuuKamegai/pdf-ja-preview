import { randomBytes } from 'node:crypto';

export type BlockState = 'source' | 'translating' | 'translated' | 'error';

export function createNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function buildWebviewHtml(options: {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}): string {
  const { nonce, cspSource, scriptUri, styleUri } = options;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>日本語プレビュー</title>
</head>
<body>
<div id="banner" hidden></div>
<div id="notice" hidden></div>
<main id="blocks"></main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
