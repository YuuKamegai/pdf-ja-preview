import * as assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionEvent } from '../../src/session';

let server: Server;
let requests: string[] = [];

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
        requests.push(parsed.messages[1]!.content);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: '訳文。' }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('条件が満たされないままタイムアウトしました');
}

suite('md-ja-preview 統合', () => {
  let events: SessionEvent[];

  suiteSetup(async () => {
    const endpoint = await startStub();
    const settings = vscode.workspace.getConfiguration('mdJaPreview');
    await settings.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
    // globalStorage のキャッシュは実行をまたいで残る。モデル名を実行ごとに変えて
    // キャッシュキーを分け、2 回目以降も LLM 呼び出しが観測できるようにする。
    await settings.update('model', `stub-model-${Date.now()}`, vscode.ConfigurationTarget.Global);

    const extension = vscode.extensions.getExtension('local.md-ja-preview');
    assert.ok(extension, '拡張が見つかること');
    events = ((await extension.activate()) as { events: SessionEvent[] }).events;
  });

  suiteTeardown(() => {
    server.close();
  });

  setup(() => {
    events.length = 0;
    requests = [];
  });

  test('パネルを開くと翻訳対象ブロックだけが逐次翻訳される', async () => {
    const fixture = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'sample.md');
    const document = await vscode.workspace.openTextDocument(fixture);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('mdJaPreview.open');

    await waitFor(() => events.filter((e) => e.kind === 'block' && e.state === 'translated').length === 4);

    // 見出し・段落 2 つの計 3 ブロックを翻訳し、コードフェンスは呼ばない。
    assert.equal(requests.length, 3);
    assert.ok(!requests.some((content) => content.includes('npm install sample')));

    const init = events.find((e) => e.kind === 'init');
    assert.ok(init && init.kind === 'init');
    assert.ok(init.blocks.every((block) => block.state === 'source'));
  });

  test('保存すると変更したブロックだけ再翻訳する', async () => {
    const document = vscode.window.activeTextEditor!.document;
    const editor = vscode.window.activeTextEditor!;
    requests = [];

    await editor.edit((builder) => {
      builder.replace(new vscode.Range(2, 0, 2, document.lineAt(2).text.length), 'Install it now.');
    });
    await document.save();

    await waitFor(() => requests.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(requests.map((c) => c.includes('Install it now.')), [true]);
  });
});
