/**
 * ローカル HTTP。API と SSE と静的配信。
 *
 * ハンドラーから Ollama や Python を直接見ない。必要なものは `createApp` の引数で
 * 受け取る。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  MAX_JSON_BYTES,
  parseCreateSessionRequest,
  parsePatchSessionRequest,
  parseRetryRequest,
  ProtocolContractError,
  type ServerEvent,
} from '../shared/protocol';
import { DocumentStore, UploadError } from './documents';
import { Scheduler } from './scheduler';
import {
  checkApiRequest,
  checkPageRequest,
  SECURITY_HEADERS,
  TOKEN_HEADER,
  type SecurityConfig,
} from './security';
import { Session, type ProviderConnection, type TranslateFn } from './session';
import { Storage } from './storage';

/** SSE の生存確認。 */
export const HEARTBEAT_MS = 15_000;
/** この時間つながらないままならセッションを捨てる。 */
export const SESSION_GRACE_MS = 5 * 60_000;

/**
 * 画面から API キーを登録・削除する口。ローカル provider では渡さない。
 *
 * 鍵そのものは決して外へ返さない。登録されているかどうかだけを答える。
 */
export interface CloudKeyControl {
  /** 送信先のホスト名。表示にだけ使う。鍵もパスもクエリも含めない。 */
  target: string;
  /** 登録されているか。値は返さない。 */
  configured(): Promise<boolean>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface AppDeps {
  documents: DocumentStore;
  storage: Storage;
  scheduler: Scheduler;
  /**
   * セッションを作るたびに呼ぶ。鍵は画面から登録・削除できるので、起動時の値を
   * 使い回さず、そのつど最新の設定から組み直す。model はセッションごとの値で
   * 差し替える。
   */
  resolveConnection(): Promise<ProviderConnection>;
  /** クラウドの鍵を画面から扱う口。ローカルなら undefined。 */
  cloudKey?: CloudKeyControl;
  defaultModel: string;
  /** 静的ファイルの置き場所。ここから外へは出さない。 */
  staticRoot: string;
  security: SecurityConfig;
  translate?: TranslateFn;
  heartbeatMs?: number;
  graceMs?: number;
}

interface SessionEntry {
  session: Session;
  documentId: string;
  /** つながっている SSE の数。 */
  connections: number;
  reaper: NodeJS.Timeout | undefined;
  streams: Set<http.ServerResponse>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function sendError(response: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) {
      throw new ProtocolContractError('body-too-large', 'JSON が大きすぎます');
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolContractError('invalid-json', 'JSON として読めません');
  }
}

/** `/api/sessions/<id>/events` のような道筋を分解する。 */
function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '');
}

export interface AppServer extends http.Server { shutdown(): Promise<void>; }

export function createApp(deps: AppDeps): AppServer {
  const sessions = new Map<string, SessionEntry>();
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const graceMs = deps.graceMs ?? SESSION_GRACE_MS;
  const staticRoot = resolve(deps.staticRoot);

  const dropSession = async (sessionId: string): Promise<void> => {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    for (const stream of entry.streams) stream.end();
    if (entry.reaper) clearTimeout(entry.reaper);
    await entry.session.close();
    await deps.documents.release(entry.documentId);
  };

  const armReaper = (entry: SessionEntry): void => {
    if (entry.reaper) clearTimeout(entry.reaper);
    entry.reaper = setTimeout(() => {
      void dropSession(entry.session.sessionId);
    }, graceMs);
    entry.reaper.unref?.();
  };

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendError(response, 500, 'internal', `想定外の失敗: ${(error as Error).message}`);
      } else {
        response.destroy();
      }
    });
  }) as AppServer;
  let shuttingDown: Promise<void> | undefined;
  server.shutdown = () => shuttingDown ??= (async () => {
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([...sessions.keys()].map(dropSession));
    server.closeAllConnections();
    await stopped;
  })();

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://placeholder');
    const parts = segmentsOf(url.pathname);
    const isApi = parts[0] === 'api';

    const decision = isApi
      ? checkApiRequest(request, deps.security)
      : checkPageRequest(request, deps.security);
    if (!decision.ok) {
      request.resume();
      sendError(response, decision.status, decision.code, decision.message);
      return;
    }

    if (!isApi) {
      await serveStatic(request, response, url.pathname);
      return;
    }

    try {
      await route(request, response, parts.slice(1));
    } catch (error) {
      if (error instanceof ProtocolContractError) {
        sendError(response, 400, error.code, error.message);
        return;
      }
      throw error;
    }
  }

  async function route(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    parts: string[],
  ): Promise<void> {
    const method = request.method ?? 'GET';

    if (parts[0] === 'documents') {
      if (parts.length === 1 && method === 'POST') return postDocument(request, response);
      const id = parts[1];
      if (id === undefined) return sendError(response, 404, 'not-found', '見つかりません');

      if (parts.length === 2 && method === 'GET') return getDocument(response, id);
      if (parts.length === 2 && method === 'DELETE') return deleteDocument(response, id);
      if (parts.length === 3 && parts[2] === 'pdf' && method === 'GET') {
        return getPdf(request, response, id);
      }
      if (parts.length === 3 && parts[2] === 'cache' && method === 'DELETE') {
        return deleteCache(response, id);
      }
    }

    if (parts[0] === 'settings' && parts[1] === 'api-key' && parts.length === 2) {
      if (method === 'GET') {
        request.resume();
        return getApiKey(response);
      }
      if (method === 'PUT') return putApiKey(request, response);
      if (method === 'DELETE') {
        request.resume();
        return deleteApiKey(response);
      }
    }

    if (parts[0] === 'sessions') {
      if (parts.length === 1 && method === 'POST') return postSession(request, response);
      const id = parts[1];
      if (id === undefined) return sendError(response, 404, 'not-found', '見つかりません');

      if (parts.length === 2 && method === 'PATCH') return patchSession(request, response, id);
      if (parts.length === 2 && method === 'DELETE') return deleteSession(response, id);
      if (parts.length === 3 && parts[2] === 'events' && method === 'GET') {
        return sessionEvents(request, response, id);
      }
      if (parts.length === 3 && parts[2] === 'retry' && method === 'POST') {
        return retryBlock(request, response, id);
      }
    }

    request.resume();
    sendError(response, 404, 'not-found', '見つかりません');
  }

  // ---- 文書 ---------------------------------------------------------------

  async function postDocument(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const type = (request.headers['content-type'] ?? '').split(';')[0].trim();
    if (type !== 'application/pdf') {
      request.resume();
      sendError(response, 415, 'unsupported-type', 'application/pdf を送ってください');
      return;
    }
    try {
      const job = await deps.documents.register(request, 'upload.pdf');
      sendJson(response, 202, { documentId: job.id, state: job.state });
    } catch (error) {
      if (error instanceof UploadError) {
        sendError(response, error.code === 'too-large' ? 413 : 400, error.code, error.message);
        return;
      }
      throw error;
    }
  }

  function getDocument(response: http.ServerResponse, id: string): void {
    const job = deps.documents.get(id);
    if (!job) return sendError(response, 404, 'unknown-document', '文書がありません');
    const body: Record<string, unknown> = { state: job.state };
    if (job.document) body.document = job.document;
    if (job.error) body.error = job.error;
    sendJson(response, 200, body);
  }

  async function deleteDocument(response: http.ServerResponse, id: string): Promise<void> {
    if (!deps.documents.get(id)) {
      sendJson(response, 204, null);
      return;
    }
    const closed = await deps.documents.closeIfUnused(id);
    if (!closed) {
      sendError(response, 409, 'in-use', 'その文書は使用中です');
      return;
    }
    response.writeHead(204, SECURITY_HEADERS);
    response.end();
  }

  async function deleteCache(response: http.ServerResponse, id: string): Promise<void> {
    const hash = deps.documents.hashOf(id);
    if (hash === undefined) return sendError(response, 404, 'unknown-document', '文書がありません');

    // 実行中の結果でキャッシュを蘇らせない。先に世代を上げてから消す。
    const affected = [...sessions.values()].filter(entry => deps.documents.hashOf(entry.documentId) === hash);
    for (const entry of affected) entry.session.invalidate(false);
    await deps.storage.deleteDocument(hash);
    for (const entry of affected) entry.session.start();
    response.writeHead(204, SECURITY_HEADERS);
    response.end();
  }

  async function getPdf(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const path = deps.documents.pdfPath(id);
    if (path === undefined) return sendError(response, 404, 'unknown-document', '文書がありません');

    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return sendError(response, 404, 'unknown-document', '文書がありません');
    }

    const range = request.headers.range;
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'content-type': 'application/pdf',
      'accept-ranges': 'bytes',
    };

    if (range === undefined) {
      response.writeHead(200, { ...headers, 'content-length': String(size) });
      createReadStream(path).pipe(response);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (match[1] === '' && match[2] === '')) {
      response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
      response.end();
      return;
    }
    let start: number;
    let end: number;
    if (match[1] === '') {
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
      response.end();
      return;
    }

    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    });
    createReadStream(path, { start, end }).pipe(response);
  }

  // ---- API キー -----------------------------------------------------------

  /**
   * 受け取った鍵を確かめる。
   *
   * ヘッダーに載せる値なので、制御文字（改行を含む）が混ざったものは受け取らない。
   * 拒否の理由は書くが、受け取った値そのものは決して返さない。
   */
  function cleanApiKey(body: unknown): string {
    const value = (body as { apiKey?: unknown } | null)?.apiKey;
    if (typeof value !== 'string') {
      throw new ProtocolContractError('invalid-api-key', 'apiKey を文字列で送ってください');
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new ProtocolContractError('invalid-api-key', 'API キーが空です');
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new ProtocolContractError(
        'invalid-api-key',
        'API キーに改行や制御文字は使えません',
      );
    }
    return trimmed;
  }

  /** 登録の有無だけを返す。鍵は載せない。 */
  async function apiKeyStatus(): Promise<{
    configured: boolean;
    cloud: boolean;
    target: string;
  }> {
    const control = deps.cloudKey;
    if (!control) return { configured: false, cloud: false, target: '' };
    return { configured: await control.configured(), cloud: true, target: control.target };
  }

  async function getApiKey(response: http.ServerResponse): Promise<void> {
    sendJson(response, 200, await apiKeyStatus());
  }

  async function putApiKey(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const control = deps.cloudKey;
    if (!control) {
      return sendError(
        response,
        409,
        'local-provider',
        '手元の Ollama を使っています。API キーは要りません。',
      );
    }
    await control.set(cleanApiKey(body));
    sendJson(response, 200, await apiKeyStatus());
  }

  async function deleteApiKey(response: http.ServerResponse): Promise<void> {
    const control = deps.cloudKey;
    if (!control) {
      return sendError(
        response,
        409,
        'local-provider',
        '手元の Ollama を使っています。API キーは要りません。',
      );
    }
    await control.clear();
    sendJson(response, 200, await apiKeyStatus());
  }

  // ---- セッション ---------------------------------------------------------

  async function postSession(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const body = parseCreateSessionRequest(await readJsonBody(request));
    const job = deps.documents.get(body.documentId);
    if (!job) return sendError(response, 404, 'unknown-document', '文書がありません');
    if (!job.document) {
      return sendError(response, 409, 'not-ready', 'まだ抽出が終わっていません');
    }
    const hash = deps.documents.hashOf(body.documentId);
    if (hash === undefined) return sendError(response, 404, 'unknown-document', '文書がありません');

    // 鍵は画面から登録・削除できる。起動時の値ではなく、今の設定で組み直す。
    // 文書を掴む前に確かめる。断るときに掴んだままにしない。
    let connection: ProviderConnection;
    try {
      connection = await deps.resolveConnection();
    } catch (error) {
      return sendError(response, 409, 'not-sendable', (error as Error).message);
    }
    if (connection.kind !== 'ollama' && connection.apiKey.trim() === '') {
      return sendError(
        response,
        409,
        'no-api-key',
        'API キーが登録されていません。画面の「APIキー」から登録してください。',
      );
    }

    if (!deps.documents.retain(body.documentId)) {
      return sendError(response, 409, 'unknown-document', '文書は閉じられています');
    }

    const session = new Session({
      sessionId: randomUUID(),
      documentId: body.documentId,
      documentHash: hash,
      document: job.document,
      model: body.model,
      storage: deps.storage,
      scheduler: deps.scheduler,
      connection,
      translate: deps.translate,
    });
    const entry: SessionEntry = {
      session,
      documentId: body.documentId,
      connections: 0,
      reaper: undefined,
      streams: new Set(),
    };
    sessions.set(session.sessionId, entry);
    armReaper(entry);
    session.start();
    sendJson(response, 201, session.snapshot());
  }

  async function patchSession(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const entry = sessions.get(id);
    if (!entry) {
      request.resume();
      return sendError(response, 404, 'unknown-session', 'セッションがありません');
    }
    const patch = parsePatchSessionRequest(await readJsonBody(request));
    const pageCount = deps.documents.get(entry.documentId)?.document?.pages.length ?? 1;
    if (patch.page !== undefined) {
      if (patch.page > pageCount) {
        return sendError(response, 400, 'invalid-page', `ページは 1..${pageCount} です`);
      }
      entry.session.setPage(patch.page);
    }
    if (patch.paused !== undefined) {
      if (patch.paused) entry.session.pause();
      else entry.session.resume();
    }
    if (patch.model !== undefined) entry.session.setModel(patch.model);
    sendJson(response, 200, entry.session.snapshot());
  }

  async function retryBlock(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    id: string,
  ): Promise<void> {
    const entry = sessions.get(id);
    if (!entry) {
      request.resume();
      return sendError(response, 404, 'unknown-session', 'セッションがありません');
    }
    const body = parseRetryRequest(await readJsonBody(request));
    if (!entry.session.retry(body.blockId, body.bypassCache)) {
      return sendError(response, 404, 'unknown-block', 'そのブロックは訳せません');
    }
    sendJson(response, 202, { accepted: true });
  }

  async function deleteSession(response: http.ServerResponse, id: string): Promise<void> {
    await dropSession(id);
    response.writeHead(204, SECURITY_HEADERS);
    response.end();
  }

  function sessionEvents(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    id: string,
  ): void {
    const entry = sessions.get(id);
    if (!entry) {
      request.resume();
      return sendError(response, 404, 'unknown-session', 'セッションがありません');
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const write = (event: ServerEvent): void => {
      if (response.writableEnded) return;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    entry.connections += 1;
    entry.streams.add(response);
    if (entry.reaper) {
      clearTimeout(entry.reaper);
      entry.reaper = undefined;
    }

    // つなぎ直しでも最初に全状態を送る。取りこぼしから復帰できる。
    write({ type: 'snapshot', value: entry.session.snapshot() });

    const unsubscribeSession = entry.session.subscribe(write);
    const unsubscribeDocuments = deps.documents.onChange((job) => {
      if (job.id === entry.documentId) write({ type: 'document', documentId: job.id, state: job.state });
    });
    const heartbeat = setInterval(() => write({ type: 'heartbeat' }), heartbeatMs);
    heartbeat.unref?.();

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      entry.streams.delete(response);
      clearInterval(heartbeat);
      unsubscribeSession();
      unsubscribeDocuments();
      entry.connections = Math.max(0, entry.connections - 1);
      // つなぎ直す猶予を置く。閉じるときは DELETE を使う。
      if (entry.connections === 0 && sessions.has(entry.session.sessionId)) armReaper(entry);
    };
    response.on('close', cleanup);
    response.on('error', cleanup);
  }

  // ---- 静的配信 -----------------------------------------------------------

  async function serveStatic(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    request.resume();
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    const target = resolve(join(staticRoot, normalize(relative)));
    if (target !== staticRoot && !target.startsWith(staticRoot + sep)) {
      sendError(response, 403, 'outside-root', '配信対象の外です');
      return;
    }

    let size: number;
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      size = info.size;
    } catch {
      sendError(response, 404, 'not-found', '見つかりません');
      return;
    }

    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';

    if (relative === 'index.html') {
      // token は起動 HTML にだけ埋め込む。ログには出さない。
      const { readFile } = await import('node:fs/promises');
      const html = (await readFile(target, 'utf8')).replace(
        '<!--PDF_JA_TOKEN-->',
        `<meta name="pdf-ja-token" content="${deps.security.token}">`,
      ).replace('<!--PDF_JA_MODEL-->',
        `<meta name="pdf-ja-model" content="${encodeURIComponent(deps.defaultModel)}">`);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': type,
        'content-length': Buffer.byteLength(html),
      });
      response.end(html);
      return;
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': type,
      'content-length': String(size),
    });
    createReadStream(target).pipe(response);
  }

  server.on('close', () => {
    for (const id of [...sessions.keys()]) void dropSession(id);
  });

  return server;
}

export { TOKEN_HEADER };
export type { Readable };
