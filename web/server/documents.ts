/**
 * 文書の登録と抽出の面倒を見る。
 *
 * `register` はアップロードを受け取ってキューに載せた時点で返る。全文抽出は待たない。
 * 原文はすぐ読めるべきで、抽出はその後ろで進む。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { parseDocument, type PdfDocument } from '../shared/document';
import { MAX_UPLOAD_BYTES } from '../shared/protocol';
import { ExtractorError, type Extractor } from './extractor';
import { Storage, documentKey } from './storage';

export type ExtractionState = 'queued' | 'running' | 'ready' | 'partial' | 'error';

export interface ExtractionJob {
  id: string;
  state: ExtractionState;
  document?: PdfDocument;
  error?: { code: string; message: string };
}

export class UploadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

interface Entry {
  id: string;
  hash: string;
  name: string;
  file: string;
  state: ExtractionState;
  document?: PdfDocument;
  error?: { code: string; message: string };
  refs: number;
  controller: AbortController;
  closed: boolean;
}

export interface DocumentStoreOptions {
  storage: Storage;
  extractor: Extractor;
  maxBytes?: number;
  timeoutMs?: number;
}

type Listener = (job: ExtractionJob) => void;

export class DocumentStore {
  #storage: Storage;
  #extractor: Extractor;
  #maxBytes: number;
  #timeoutMs: number | undefined;

  #entries = new Map<string, Entry>();
  #listeners = new Set<Listener>();
  /** 抽出は並列度 1。待ち行列は FIFO。 */
  #queue: Entry[] = [];
  #running: Entry | undefined;
  /** 同じ PDF を同時に登録しても抽出は一度だけ。 */
  #inFlight = new Map<string, Promise<PdfDocument>>();
  #idleResolve: (() => void) | undefined;

  constructor(options: DocumentStoreOptions) {
    this.#storage = options.storage;
    this.#extractor = options.extractor;
    this.#maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    this.#timeoutMs = options.timeoutMs;
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(entry: Entry): void {
    const job = toJob(entry);
    for (const listener of this.#listeners) {
      try {
        listener(job);
      } catch {
        /* 購読側の失敗で抽出を巻き込まない */
      }
    }
  }

  get(id: string): ExtractionJob | undefined {
    const entry = this.#entries.get(id);
    return entry ? toJob(entry) : undefined;
  }

  /** 文書の PDF の置き場所。参照が生きている間だけ有効。 */
  pdfPath(id: string): string | undefined {
    return this.#entries.get(id)?.file;
  }

  hashOf(id: string): string | undefined {
    return this.#entries.get(id)?.hash;
  }

  retain(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry || entry.closed) return false;
    entry.refs += 1;
    return true;
  }

  isInUse(id: string): boolean {
    const entry = this.#entries.get(id);
    return entry !== undefined && entry.refs > 0;
  }

  /** 参照が 0 になったら抽出を止めて一時 PDF を消す。 */
  async release(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) await this.#close(entry);
  }

  /** 使用中でなければ閉じる。使用中なら false。 */
  async closeIfUnused(id: string): Promise<boolean> {
    const entry = this.#entries.get(id);
    if (!entry) return true;
    if (entry.refs > 0) return false;
    await this.#close(entry);
    return true;
  }

  async #close(entry: Entry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    entry.controller.abort();
    this.#queue = this.#queue.filter((queued) => queued !== entry);
    this.#entries.delete(entry.id);
    await this.#storage.removeTempFile(entry.file);
  }

  /**
   * PDF を受け取り、抽出キューへ載せる。
   *
   * 上限を超えた時点で読むのをやめ、書きかけの一時ファイルは消す。元の名前は
   * パスに使わない。
   */
  async register(bytes: AsyncIterable<Uint8Array>, name: string): Promise<ExtractionJob> {
    const file = await this.#storage.createTempFile();
    const hasher = createHash('sha256');
    const maxBytes = this.#maxBytes;
    let size = 0;

    /** 上限を超えた時点で読むのをやめる。全部受け取ってから測らない。 */
    async function* limited(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
      for await (const chunk of input) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          throw new UploadError(
            'too-large',
            `PDF が上限 ${Math.round(maxBytes / 1024 / 1024)} MiB を超えています`,
          );
        }
        hasher.update(chunk);
        yield chunk;
      }
    }

    try {
      await pipeline(Readable.from(limited(bytes)), createWriteStream(file));
    } catch (error) {
      // 途中超過でも接続断でも、書きかけの一時ファイルは残さない。
      await this.#storage.removeTempFile(file);
      if (error instanceof UploadError) throw error;
      throw new UploadError('upload-failed', `受け取りに失敗しました: ${(error as Error).message}`);
    }

    if (size === 0) {
      await this.#storage.removeTempFile(file);
      throw new UploadError('empty-upload', '中身がありません');
    }

    const entry: Entry = {
      id: randomUUID(),
      hash: hasher.digest('hex'),
      name,
      file,
      state: 'queued',
      refs: 1,
      controller: new AbortController(),
      closed: false,
    };
    this.#entries.set(entry.id, entry);

    const cached = await this.#readCache(entry.hash);
    if (cached) {
      this.#settle(entry, cached);
      return toJob(entry);
    }

    this.#queue.push(entry);
    // 抽出は register が返ってから始める。呼び出し側は queued を見て、その後の
    // 変化は購読で受け取る。
    queueMicrotask(() => this.#pump());
    return toJob(entry);
  }

  async #readCache(hash: string): Promise<PdfDocument | undefined> {
    const raw = await this.#storage.readJson(documentKey(hash, 'document'));
    if (raw === undefined) return undefined;
    try {
      return parseDocument(raw);
    } catch {
      // 壊れたキャッシュは捨てて取り直す。
      await this.#storage.deleteDocument(hash);
      return undefined;
    }
  }

  #settle(entry: Entry, document: PdfDocument): void {
    entry.document = document;
    entry.state = document.pages.every((page) => page.status === 'ok') ? 'ready' : 'partial';
    this.#emit(entry);
  }

  #pump(): void {
    if (this.#running !== undefined) return;
    const next = this.#queue.shift();
    if (next === undefined) {
      this.#idleResolve?.();
      this.#idleResolve = undefined;
      return;
    }
    if (next.closed) {
      this.#pump();
      return;
    }
    this.#running = next;
    void this.#extract(next).finally(() => {
      this.#running = undefined;
      this.#pump();
    });
  }

  async #extract(entry: Entry): Promise<void> {
    entry.state = 'running';
    this.#emit(entry);

    try {
      let pending = this.#inFlight.get(entry.hash);
      if (pending === undefined) {
        pending = this.#extractor.run({
          file: entry.file,
          hash: entry.hash,
          signal: entry.controller.signal,
          timeoutMs: this.#timeoutMs,
        });
        this.#inFlight.set(entry.hash, pending);
        pending.finally(() => this.#inFlight.delete(entry.hash)).catch(() => undefined);
      }
      const document = await pending;

      if (entry.closed || entry.controller.signal.aborted) return;
      // 取り消された結果は保存しない。
      await this.#storage.writeJson(documentKey(entry.hash, 'document'), document);
      this.#settle(entry, document);
    } catch (error) {
      if (entry.closed) return;
      const code = error instanceof ExtractorError ? error.code : 'extraction-failed';
      entry.state = 'error';
      entry.error = { code, message: (error as Error).message };
      this.#emit(entry);
    }
  }

  /** 待ち行列が空になるまで待つ。 */
  async idle(): Promise<void> {
    while (this.#running !== undefined || this.#queue.length > 0) {
      await new Promise<void>((resolve) => {
        this.#idleResolve = resolve;
      });
    }
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  get runningId(): string | undefined {
    return this.#running?.id;
  }

  async close(): Promise<void> {
    for (const entry of [...this.#entries.values()]) {
      entry.refs = 0;
      await this.#close(entry);
    }
    this.#listeners.clear();
  }
}

function toJob(entry: Entry): ExtractionJob {
  const job: ExtractionJob = { id: entry.id, state: entry.state };
  if (entry.document) job.document = entry.document;
  if (entry.error) job.error = entry.error;
  return job;
}
