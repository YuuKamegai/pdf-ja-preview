import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DocumentStore } from '../../web/server/documents';
import { runExtractorProcess, type Extractor } from '../../web/server/extractor';
import { createApp } from '../../web/server/http';
import { Scheduler } from '../../web/server/scheduler';
import { TOKEN_HEADER, allowedHostsFor, createToken } from '../../web/server/security';
import type { TranslateFn } from '../../web/server/session';
import { createTemporaryStorage } from '../../web/server/storage';
import type { PdfDocument } from '../../web/shared/document';
import type { ServerEvent, Snapshot } from '../../web/shared/protocol';

const WORKER = fileURLToPath(new URL('./helpers/fake-worker.mjs', import.meta.url));
const PDF_BYTES = Buffer.from('%PDF-1.7\n% fake but non-empty\n');

function fakeExtractor(mode = 'ok'): Extractor {
  return {
    description: `fake:${mode}`,
    run: ({ hash, signal, timeoutMs }) =>
      runExtractorProcess({
        command: process.execPath,
        args: [WORKER, '--mode', mode, '--hash', hash],
        signal,
        timeoutMs: timeoutMs ?? 10_000,
      }),
  };
}

const echo: TranslateFn = async (block) => `訳: ${block.source}`;

async function startServer(
  t: { after: (fn: () => unknown) => void },
  options: { extractor?: Extractor; translate?: TranslateFn; graceMs?: number } = {},
) {
  const storage = await createTemporaryStorage();
  const scheduler = new Scheduler();
  const documents = new DocumentStore({
    storage,
    extractor: options.extractor ?? fakeExtractor(),
  });
  const staticRoot = await mkdtemp(join(tmpdir(), 'pdf-ja-static-'));
  await writeFile(
    join(staticRoot, 'index.html'),
    '<!doctype html><html><head><!--PDF_JA_TOKEN--></head><body>ok</body></html>',
    'utf8',
  );
  await writeFile(join(staticRoot, 'app.js'), 'console.log(1);\n', 'utf8');

  const token = createToken();
  // ポートは listen して初めて決まる。同じ Set を渡しておき、後から埋める。
  const allowedHosts = new Set<string>();
  const server = createApp({
    documents,
    storage,
    scheduler,
    connection: { endpoint: 'http://127.0.0.1:11434', think: false, temperature: 0.2, timeoutMs: 1000 },
    defaultModel: 'm1',
    staticRoot,
    security: { token, allowedHosts },
    translate: options.translate ?? echo,
    heartbeatMs: 50,
    graceMs: options.graceMs ?? 60_000,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  for (const host of allowedHostsFor(port)) allowedHosts.add(host);

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    scheduler.close();
    await documents.close();
    await storage.close();
  });

  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(base + path, {
      ...init,
      headers: { [TOKEN_HEADER]: token, ...(init.headers as Record<string, string> | undefined) },
    });

  return { server, base, port, token, call, documents, storage, scheduler, staticRoot };
}

/** 抽出が終わるまで待つ。 */
async function waitForDocument(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  id: string,
  wanted: string[],
): Promise<{ state: string; document?: PdfDocument }> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await call(`/api/documents/${id}`);
    const body = (await response.json()) as { state: string; document?: PdfDocument };
    if (wanted.includes(body.state)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('抽出が終わりませんでした');
}

async function uploadPdf(call: (path: string, init?: RequestInit) => Promise<Response>) {
  const response = await call('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf' },
    body: PDF_BYTES,
  });
  assert.equal(response.status, 202);
  return (await response.json()) as { documentId: string; state: string };
}

// ---- 入口 ----------------------------------------------------------------

test('別 origin からの要求は 403', async (t) => {
  const { base, token } = await startServer(t);
  const response = await fetch(base + '/api/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://example.com',
      [TOKEN_HEADER]: token,
    },
    body: JSON.stringify({ documentId: 'd', model: 'm' }),
  });
  assert.equal(response.status, 403);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'bad-origin');
});

test('token が無い API 要求は 403', async (t) => {
  const { base } = await startServer(t);
  const response = await fetch(base + '/api/documents/x');
  assert.equal(response.status, 403);
});

test('許可されていない Host は 403', async (t) => {
  const { port, token } = await startServer(t);
  // fetch は Host ヘッダーを書き換えさせない。生の HTTP で送る。
  const status = await rawStatus(port, '/api/documents/x', {
    host: 'evil.example',
    [TOKEN_HEADER]: token,
  });
  assert.equal(status, 403);
});

test('正しい Host なら生の HTTP でも通る', async (t) => {
  const { port, token } = await startServer(t);
  const status = await rawStatus(port, '/api/documents/x', {
    host: `127.0.0.1:${port}`,
    [TOKEN_HEADER]: token,
  });
  assert.equal(status, 404, 'Host は通り、文書が無いだけ');
});

test('JSON の body 上限を超えると 400', async (t) => {
  const { call } = await startServer(t);
  const response = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: 'd', model: 'x'.repeat(200_000) }),
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'body-too-large');
});

test('壊れた JSON は 400', async (t) => {
  const { call } = await startServer(t);
  const response = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ nope',
  });
  assert.equal(response.status, 400);
});

test('応答には CSP と nosniff が付く', async (t) => {
  const { call } = await startServer(t);
  const response = await call('/api/documents/none');
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

// ---- 静的配信 -------------------------------------------------------------

test('起動 HTML に token を埋め込む', async (t) => {
  const { base, token } = await startServer(t);
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(`content="${token}"`));
});

test('配信対象の外は取り出せない', async (t) => {
  const { base } = await startServer(t);
  for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json']) {
    const response = await fetch(base + path);
    assert.ok([403, 404].includes(response.status), `${path} -> ${response.status}`);
  }
});

test('静的ファイルは content-type つきで返る', async (t) => {
  const { base } = await startServer(t);
  const response = await fetch(base + '/app.js');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/javascript/);
});

// ---- 文書 -----------------------------------------------------------------

test('PDF 以外の content-type は 415', async (t) => {
  const { call } = await startServer(t);
  const response = await call('/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(response.status, 415);
});

test('登録は 202 で返り、抽出は後から終わる', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  assert.equal(job.state, 'queued');

  const ready = await waitForDocument(call, job.documentId, ['ready', 'partial', 'error']);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.document?.schema, 'pdf-document.v1');
});

test('知らない文書 ID は 404', async (t) => {
  const { call } = await startServer(t);
  assert.equal((await call('/api/documents/nope')).status, 404);
  assert.equal((await call('/api/documents/nope/pdf')).status, 404);
});

test('PDF は Range 付きで取り出せる', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);

  const whole = await call(`/api/documents/${job.documentId}/pdf`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal((await whole.arrayBuffer()).byteLength, PDF_BYTES.length);

  const partial = await call(`/api/documents/${job.documentId}/pdf`, {
    headers: { range: 'bytes=0-3' },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-3/${PDF_BYTES.length}`);
  assert.equal(await partial.text(), '%PDF');
});

test('壊れた Range は 416', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  for (const range of ['bytes=-', 'bytes=9999-', 'items=0-1']) {
    const response = await call(`/api/documents/${job.documentId}/pdf`, { headers: { range } });
    assert.equal(response.status, 416, range);
  }
});

test('使用中の文書は 409、未使用なら 204', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);

  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  assert.equal(created.status, 201);
  const snapshot = (await created.json()) as Snapshot;

  assert.equal((await call(`/api/documents/${job.documentId}`, { method: 'DELETE' })).status, 409);

  assert.equal((await call(`/api/sessions/${snapshot.sessionId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/documents/${job.documentId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/documents/${job.documentId}`)).status, 404);
});

// ---- セッション -----------------------------------------------------------

test('抽出前のセッション作成は 409', async (t) => {
  const { call } = await startServer(t, { extractor: fakeExtractor('spin') });
  const job = await uploadPdf(call);
  const response = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  assert.equal(response.status, 409);
});

test('セッションを作ると翻訳が始まり、PATCH で状態が変わる', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);

  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  const snapshot = (await created.json()) as Snapshot;
  assert.equal(snapshot.page, 1);
  assert.equal(snapshot.model, 'm1');
  assert.equal(snapshot.blocks.length, 1);

  const patched = await call(`/api/sessions/${snapshot.sessionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: true, model: 'm2' }),
  });
  const after = (await patched.json()) as Snapshot;
  assert.equal(after.paused, true);
  assert.equal(after.model, 'm2');
  assert.ok(after.generation > snapshot.generation);
});

test('文書の範囲を超えるページ指定は 400', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  const snapshot = (await created.json()) as Snapshot;

  const response = await call(`/api/sessions/${snapshot.sessionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 99 }),
  });
  assert.equal(response.status, 400);
});

test('知らないセッションは 404', async (t) => {
  const { call } = await startServer(t);
  assert.equal((await call('/api/sessions/none/events')).status, 404);
  assert.equal(
    (
      await call('/api/sessions/none', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: 1 }),
      })
    ).status,
    404,
  );
});

test('SSE は最初に snapshot を送り、訳が届く', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  const snapshot = (await created.json()) as Snapshot;

  const events = await readEvents(call, snapshot.sessionId, (event) =>
    event.type === 'block' && event.value.status === 'translated',
  );
  assert.equal(events[0].type, 'snapshot');
  const translated = events.find(
    (event) => event.type === 'block' && event.value.status === 'translated',
  );
  assert.ok(translated && translated.type === 'block');
  assert.match(translated.value.ja ?? '', /訳: /);
});

test('つなぎ直すたびに snapshot から始まる', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  const snapshot = (await created.json()) as Snapshot;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const events = await readEvents(call, snapshot.sessionId, () => true);
    assert.equal(events[0].type, 'snapshot');
  }
});

test('再試行は 202、知らないブロックは 404', async (t) => {
  const { call } = await startServer(t);
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  const snapshot = (await created.json()) as Snapshot;

  const ok = await call(`/api/sessions/${snapshot.sessionId}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blockId: 'b0', bypassCache: true }),
  });
  assert.equal(ok.status, 202);

  const missing = await call(`/api/sessions/${snapshot.sessionId}/retry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blockId: 'nope', bypassCache: true }),
  });
  assert.equal(missing.status, 404);
});

test('キャッシュ削除は世代を上げ、実行中の結果で復活させない', async (t) => {
  const { call, storage } = await startServer(t);
  const job = await uploadPdf(call);
  await waitForDocument(call, job.documentId, ['ready']);
  const created = await call('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: job.documentId, model: 'm1' }),
  });
  const snapshot = (await created.json()) as Snapshot;

  await readEvents(call, snapshot.sessionId, (event) =>
    event.type === 'block' && event.value.status === 'translated',
  );

  const deleted = await call(`/api/documents/${job.documentId}/cache`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);

  const events = await readEvents(call, snapshot.sessionId, () => true);
  const first = events[0];
  assert.ok(first.type === 'snapshot');
  assert.ok(first.value.generation > snapshot.generation, '世代が上がっている');
  void storage;
});

test('存在しない道筋は 404', async (t) => {
  const { call } = await startServer(t);
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/documents')).status, 404);
});

/** SSE を読み、条件に合うイベントが来たら閉じる。 */
async function readEvents(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
  until: (event: ServerEvent) => boolean,
): Promise<ServerEvent[]> {
  const controller = new AbortController();
  const response = await call(`/api/sessions/${sessionId}/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: ServerEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + 10_000;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 2);
        if (frame.startsWith('data: ')) {
          const event = JSON.parse(frame.slice(6)) as ServerEvent;
          events.push(event);
          if (until(event)) return events;
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return events;
}

/** Host を指定して送る。fetch は禁止ヘッダーとして落とす。 */
function rawStatus(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    call.on('error', reject);
    call.end();
  });
}
