/**
 * ローカル HTTP/SSE の共有契約。
 *
 * サーバーとブラウザの両方が読む。ここでは要求の形だけを検証し、文書の中身は
 * `document.ts` の `parseDocument` に任せる。
 */

import type { PdfDocument, TranslationState } from './document';

/** 初期版の既定上限。超過は処理開始前、またはページ数が判明した時点で拒否する。 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 300;
/** JSON API の body 上限。 */
export const MAX_JSON_BYTES = 64 * 1024;
/** モデル名・ID の上限。長さで殴られないようにする。 */
export const MAX_NAME_LENGTH = 200;

export type ExtractionState = 'queued' | 'running' | 'ready' | 'partial' | 'error';

export interface ProtocolError {
  code: string;
  message: string;
}

export interface DocumentAccepted {
  documentId: string;
  state: ExtractionState;
}

export interface DocumentStatus {
  state: ExtractionState;
  document?: PdfDocument;
  error?: ProtocolError;
}

export interface CreateSessionRequest {
  documentId: string;
}

export interface PatchSessionRequest {
  page?: number;
  paused?: boolean;
}

export interface RetryRequest {
  blockId: string;
  bypassCache: boolean;
}

/** 閲覧セッションの全状態。SSE の最初と再接続で丸ごと送る。 */
export interface Snapshot {
  sessionId: string;
  documentId: string;
  /** モデル変更・キャッシュ削除で上がる。古い世代の結果は捨てる。 */
  generation: number;
  page: number;
  paused: boolean;
  /** 選択中の接続名。どこへ送っているかを画面で言うために使う。 */
  connection: string;
  model: string;
  /** 送信先のホスト名。鍵もパスも含めない。 */
  target: string;
  /** クラウドへ送っているか。画面の常時表示に使う。 */
  cloud: boolean;
  blocks: TranslationState[];
  error?: ProtocolError;
}

export type ServerEvent =
  | { type: 'snapshot'; value: Snapshot }
  | { type: 'block'; sessionId: string; generation: number; value: TranslationState }
  | { type: 'error'; sessionId: string; generation: number; code: string; message: string }
  | { type: 'document'; documentId: string; state: ExtractionState }
  | { type: 'heartbeat' };

/** 要求の形が契約に合わない。HTTP では 400 にする。 */
export class ProtocolContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProtocolContractError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProtocolContractError(code, message);
}

function asRecord(input: unknown, where: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('invalid-body', `${where} がオブジェクトではありません`);
  }
  return input as Record<string, unknown>;
}

function asName(value: unknown, where: string): string {
  if (typeof value !== 'string') fail('invalid-body', `${where} が文字列ではありません`);
  if (value === '') fail('invalid-body', `${where} が空文字です`);
  if (value.length > MAX_NAME_LENGTH) fail('invalid-body', `${where} が長すぎます`);
  return value;
}

export function parsePageNumber(value: unknown, where = 'page'): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('invalid-page', `${where} が整数ではありません`);
  }
  if (value < 1 || value > MAX_PAGES) fail('invalid-page', `${where} が 1..${MAX_PAGES} の外です`);
  return value;
}

export function parseCreateSessionRequest(input: unknown): CreateSessionRequest {
  const raw = asRecord(input, 'session 要求');
  // model は受け取らない。どのモデルを使うかは、選択中の接続が決める。
  return { documentId: asName(raw.documentId, 'documentId') };
}

export function parsePatchSessionRequest(input: unknown): PatchSessionRequest {
  const raw = asRecord(input, 'session 更新');
  const patch: PatchSessionRequest = {};
  if (raw.page !== undefined) patch.page = parsePageNumber(raw.page);
  if (raw.paused !== undefined) {
    if (typeof raw.paused !== 'boolean') fail('invalid-body', 'paused が真偽値ではありません');
    patch.paused = raw.paused;
  }
  if (Object.keys(patch).length === 0) fail('invalid-body', '更新する項目がありません');
  return patch;
}

export function parseRetryRequest(input: unknown): RetryRequest {
  const raw = asRecord(input, 'retry 要求');
  const blockId = asName(raw.blockId, 'blockId');
  if (raw.bypassCache !== undefined && typeof raw.bypassCache !== 'boolean') {
    fail('invalid-body', 'bypassCache が真偽値ではありません');
  }
  return { blockId, bypassCache: raw.bypassCache === true };
}

export type { PdfDocument, TranslationState };
