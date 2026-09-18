/**
 * サーバーとの通信。
 *
 * token は起動 HTML の meta から取り、専用ヘッダーで送る。SSE も `EventSource` では
 * なく fetch streaming で読む。`EventSource` はヘッダーを付けられないので、token を
 * URL へ載せることになり、履歴やログへ残ってしまう。
 */

import { parseDocument, type PdfDocument } from '../shared/document';
import type { ConnectionList } from './state';
import type {
  DocumentAccepted,
  DocumentStatus,
  ExtractionState,
  PatchSessionRequest,
  ServerEvent,
  Snapshot,
} from '../shared/protocol';

const TOKEN_HEADER = 'x-pdf-ja-token';

/** 接続の登録内容。`apiKey` は省略で据え置き、null で削除、文字列で登録。 */
export interface ConnectionInput {
  name: string;
  provider: 'ollama' | 'openai' | 'azure';
  baseUrl: string;
  model: string;
  trust: 'loopback' | 'cloud-allowed';
  apiKey?: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function readToken(doc: Document = document): string {
  const meta = doc.querySelector('meta[name="pdf-ja-token"]');
  const token = meta?.getAttribute('content') ?? '';
  if (token === '') throw new Error('token がありません。サーバーから開き直してください。');
  return token;
}

export class Api {
  #token: string;
  #base: string;

  constructor(token: string, base = '') {
    this.#token = token;
    this.#base = base.replace(/\/+$/, '');
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { [TOKEN_HEADER]: this.#token, ...extra };
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(this.#base + path, {
      ...init,
      headers: this.#headers((init.headers as Record<string, string>) ?? {}),
    });
    if (!response.ok) {
      let code = 'http-error';
      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        if (body.error?.code) code = body.error.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        /* JSON でない応答もある */
      }
      throw new ApiError(response.status, code, message);
    }
    return response;
  }

  // ---- 接続 ---------------------------------------------------------------

  async listConnections(): Promise<ConnectionList> {
    return (await (await this.#call('/api/connections')).json()) as ConnectionList;
  }

  /** 追加する。鍵は送るだけで、返ってはこない。 */
  async addConnection(input: ConnectionInput): Promise<ConnectionList> {
    const response = await this.#call('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return (await response.json()) as ConnectionList;
  }

  async updateConnection(name: string, input: ConnectionInput): Promise<ConnectionList> {
    const response = await this.#call(`/api/connections/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return (await response.json()) as ConnectionList;
  }

  async removeConnection(name: string): Promise<ConnectionList> {
    const response = await this.#call(`/api/connections/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    return (await response.json()) as ConnectionList;
  }

  async selectConnection(name: string): Promise<ConnectionList> {
    const response = await this.#call('/api/connections/selected', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return (await response.json()) as ConnectionList;
  }

  async testConnection(name: string): Promise<{ ok: boolean; detail: string }> {
    const response = await this.#call(`/api/connections/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    });
    return (await response.json()) as { ok: boolean; detail: string };
  }

  async uploadDocument(bytes: BlobPart, signal?: AbortSignal): Promise<DocumentAccepted> {
    const response = await this.#call('/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: bytes as BodyInit,
      signal,
    });
    return (await response.json()) as DocumentAccepted;
  }

  async getDocument(id: string, signal?: AbortSignal): Promise<DocumentStatus> {
    const response = await this.#call(`/api/documents/${encodeURIComponent(id)}`, {signal});
    const body = (await response.json()) as { state: ExtractionState; document?: unknown; error?: never };
    const status: DocumentStatus = { state: body.state };
    if (body.document !== undefined) status.document = parseDocument(body.document);
    if (body.error !== undefined) status.error = body.error;
    return status;
  }

  /** 抽出が終わる（または失敗する）まで待つ。 */
  async waitForDocument(
    id: string,
    onState: (state: ExtractionState) => void,
    signal: AbortSignal,
    intervalMs = 600,
  ): Promise<DocumentStatus> {
    for (;;) {
      if (signal.aborted) throw new ApiError(0, 'cancelled', '取り消されました');
      const status = await this.getDocument(id, signal);
      if (signal.aborted) throw new ApiError(0, 'cancelled', '取り消されました');
      onState(status.state);
      if (status.state === 'ready' || status.state === 'partial' || status.state === 'error') {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  pdfUrl(id: string): string {
    return `${this.#base}/api/documents/${encodeURIComponent(id)}/pdf`;
  }

  /** モデルは選択中の接続が決める。ここでは指定しない。 */
  async createSession(documentId: string): Promise<Snapshot> {
    const response = await this.#call('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId }),
    });
    return (await response.json()) as Snapshot;
  }

  async patchSession(sessionId: string, patch: PatchSessionRequest): Promise<Snapshot> {
    const response = await this.#call(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return (await response.json()) as Snapshot;
  }

  async retry(sessionId: string, blockId: string): Promise<void> {
    await this.#call(`/api/sessions/${encodeURIComponent(sessionId)}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockId, bypassCache: true }),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#call(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.#call(`/api/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
  }

  async deleteCache(documentId: string): Promise<void> {
    await this.#call(`/api/documents/${encodeURIComponent(documentId)}/cache`, {
      method: 'DELETE',
    });
  }

  /** SSE を読み続ける。切れたら呼び出し側がつなぎ直す。 */
  async streamEvents(
    sessionId: string,
    onEvent: (event: ServerEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.#call(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      signal,
    });
    if (!response.body) throw new ApiError(0, 'no-body', 'イベントを読めません');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = frame.split('\n').find((part) => part.startsWith('data: '));
          if (line) {
            try {
              onEvent(JSON.parse(line.slice(6)) as ServerEvent);
            } catch {
              /* 読めない枠は飛ばす */
            }
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

export type { ConnectionList, PdfDocument, Snapshot, ServerEvent };
