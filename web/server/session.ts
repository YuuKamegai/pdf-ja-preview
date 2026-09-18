/**
 * 閲覧セッション。1 タブ = 1 セッション。
 *
 * どのブロックがどこまで訳せているかを持ち、見ているページから順に翻訳を頼む。
 * 実際の順番待ちは Scheduler がサーバー全体で一つだけ持つ。
 */

import { createHash } from 'node:crypto';

import type { ProviderConfig } from '../../src/translate/provider';
import type { PdfBlock, PdfDocument, TranslationState } from '../shared/document';
import type { ServerEvent, Snapshot } from '../shared/protocol';
import { Scheduler } from './scheduler';
import { Storage, translationCacheKey, translationKey } from './storage';
import {
  PDF_PROMPT_VERSION,
  PDF_VERIFIER_VERSION,
  TranslationError,
  translatePdfBlock,
} from './translation';

/** 見ているページ 0、次のページ 1、残りは文書順。 */
export const PRIORITY_CURRENT = 0;
export const PRIORITY_NEXT = 1;
export const PRIORITY_REST_BASE = 2;
/** 再試行は今いちばん見たいもの。 */
export const PRIORITY_RETRY = -1;

export type SessionListener = (event: ServerEvent) => void;

export type TranslateFn = (
  block: PdfBlock,
  config: ProviderConfig,
  signal: AbortSignal,
) => Promise<string>;

type OmitModel<Config> = Config extends ProviderConfig ? Omit<Config, 'model'> : never;
export type ProviderConnection = OmitModel<ProviderConfig>;

export interface SessionOptions {
  sessionId: string;
  documentId: string;
  documentHash: string;
  document: PdfDocument;
  model: string;
  storage: Storage;
  scheduler: Scheduler;
  /** model はセッションの値で差し替える。 */
  connection: ProviderConnection;
  translate?: TranslateFn;
}

function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** 出典が複数ページにまたがるブロックは、いちばん早く見えるページで決める。 */
function priorityOf(block: PdfBlock, page: number): number {
  const rest = PRIORITY_REST_BASE + block.order;
  if (block.regions.length === 0) return rest;
  let best = rest;
  for (const region of block.regions) {
    const value =
      region.page === page
        ? PRIORITY_CURRENT
        : region.page === page + 1
          ? PRIORITY_NEXT
          : rest;
    if (value < best) best = value;
  }
  return best;
}

export class Session {
  readonly sessionId: string;
  readonly documentId: string;

  #document: PdfDocument;
  #documentHash: string;
  #model: string;
  #storage: Storage;
  #scheduler: Scheduler;
  #provider: ProviderConnection;
  #translate: TranslateFn;

  #generation = 0;
  #page = 1;
  #paused = false;
  #closed = false;
  #error: { code: string; message: string } | undefined;
  #states = new Map<string, TranslationState>();
  #listeners = new Set<SessionListener>();

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId;
    this.documentId = options.documentId;
    this.#document = options.document;
    this.#documentHash = options.documentHash;
    this.#model = options.model;
    this.#storage = options.storage;
    this.#scheduler = options.scheduler;
    this.#provider = options.connection;
    this.#translate = options.translate ?? translatePdfBlock;

    for (const block of this.#document.blocks) {
      this.#states.set(block.id, {
        id: block.id,
        sourceHash: hashSource(block.source),
        status: 'source',
      });
    }
  }

  subscribe(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: ServerEvent): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* 購読側の失敗で翻訳を止めない */
      }
    }
  }

  snapshot(): Snapshot {
    const snapshot: Snapshot = {
      sessionId: this.sessionId,
      documentId: this.documentId,
      generation: this.#generation,
      page: this.#page,
      paused: this.#paused,
      model: this.#model,
      blocks: [...this.#states.values()],
    };
    if (this.#error) snapshot.error = this.#error;
    return snapshot;
  }

  get model(): string {
    return this.#model;
  }

  get page(): number {
    return this.#page;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get generation(): number {
    return this.#generation;
  }

  /** 翻訳対象のブロックをすべて積む。すでに訳が確定しているものは積み直さない。 */
  start(): void {
    if (this.#closed) return;
    for (const block of this.#document.blocks) {
      if (!block.translatable) continue;
      const state = this.#states.get(block.id);
      if (state?.status === 'translated') continue;
      this.#enqueue(block, priorityOf(block, this.#page), false);
    }
    this.#emit({ type: 'snapshot', value: this.snapshot() });
  }

  setPage(page: number): void {
    if (this.#closed || page === this.#page) return;
    this.#page = page;
    const priorities = new Map<string, number>();
    for (const block of this.#document.blocks) {
      if (!block.translatable) continue;
      priorities.set(block.id, priorityOf(block, page));
    }
    this.#scheduler.reprioritize(this.sessionId, priorities);
  }

  pause(): void {
    if (this.#closed || this.#paused) return;
    this.#paused = true;
    this.#scheduler.pause(this.sessionId);
  }

  resume(): void {
    if (this.#closed || !this.#paused) return;
    this.#paused = false;
    this.#scheduler.resume(this.sessionId);
  }

  /** モデルを変えると訳し直す。キャッシュ検索も鍵が変わるのでやり直しになる。 */
  setModel(model: string): void {
    if (this.#closed || model === this.#model) return;
    this.#model = model;
    this.#invalidate();
  }

  /** キャッシュを消したときなど、これまでの結果を捨ててやり直す。 */
  invalidate(restart = true): void {
    if (this.#closed) return;
    this.#invalidate(restart);
  }

  #invalidate(restart = true): void {
    this.#generation += 1;
    this.#scheduler.cancel(this.sessionId);
    this.#error = undefined;
    for (const [id, state] of this.#states) {
      this.#states.set(id, { id, sourceHash: state.sourceHash, status: 'source' });
    }
    if (restart) this.start();
    else this.#emit({type:'snapshot', value:this.snapshot()});
  }

  retry(blockId: string, bypassCache: boolean): boolean {
    if (this.#closed) return false;
    const block = this.#document.blocks.find((candidate) => candidate.id === blockId);
    if (!block || !block.translatable) return false;
    this.#enqueue(block, PRIORITY_RETRY, bypassCache);
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#scheduler.cancel(this.sessionId);
    this.#listeners.clear();
  }

  get closed(): boolean {
    return this.#closed;
  }

  #setState(next: TranslationState): void {
    if (this.#closed) return;
    this.#states.set(next.id, next);
    this.#emit({
      type: 'block',
      sessionId: this.sessionId,
      generation: this.#generation,
      value: next,
    });
  }

  #cacheKeyFor(block: PdfBlock): string {
    return translationKey({
      source: block.source,
      headingContext: block.headingContext,
      model: this.#model,
      think: this.#provider.kind === 'ollama' && this.#provider.think,
      temperature: this.#provider.temperature,
      promptVersion: PDF_PROMPT_VERSION,
      verifierVersion: PDF_VERIFIER_VERSION,
    });
  }

  #enqueue(block: PdfBlock, priority: number, bypassCache: boolean): void {
    const generation = this.#generation;
    const sourceHash = hashSource(block.source);
    this.#states.set(block.id, { id: block.id, sourceHash, status: 'queued' });

    this.#scheduler.enqueue(this.sessionId, block.id, priority, async (signal) => {
      if (this.#closed || generation !== this.#generation || signal.aborted) return;

      const key = this.#cacheKeyFor(block);
      if (!bypassCache) {
        const cached = (await this.#storage.readJson(
          translationCacheKey(this.#documentHash, key),
        )) as { ja?: unknown } | undefined;
        if (typeof cached?.ja === 'string' && cached.ja !== '') {
          if (this.#closed || generation !== this.#generation) return;
          this.#setState({ id: block.id, sourceHash, status: 'translated', ja: cached.ja });
          return;
        }
      }

      // キャッシュを読んでいる間に取り消されていることがある。中断済みの signal に
      // あとから listener を付けても発火しないので、ここで抜ける。
      if (this.#closed || generation !== this.#generation) return;
      if (signal.aborted) {
        this.#setState({ id: block.id, sourceHash, status: 'source' });
        return;
      }

      this.#setState({ id: block.id, sourceHash, status: 'translating' });

      try {
        const ja = await this.#translate(
          block,
          { ...this.#provider, model: this.#model },
          signal,
        );
        // 世代が変わった後に返ってきた結果は、表示にもキャッシュにも入れない。
        if (this.#closed || generation !== this.#generation) return;
        await this.#storage.writeJson(translationCacheKey(this.#documentHash, key), { ja });
        if (this.#closed || generation !== this.#generation || signal.aborted) return;
        this.#setState({ id: block.id, sourceHash, status: 'translated', ja });
      } catch (error) {
        if (this.#closed || generation !== this.#generation) return;
        if (signal.aborted) {
          // 取り消しは失敗ではない。原文表示のまま待機に戻す。
          this.#setState({ id: block.id, sourceHash, status: 'source' });
          return;
        }
        const code = error instanceof TranslationError ? error.code : 'translation-failed';
        const message = (error as Error).message;
        this.#setState({
          id: block.id,
          sourceHash,
          status: 'error',
          error: { code, message },
        });
        this.#emit({
          type: 'error',
          sessionId: this.sessionId,
          generation,
          code,
          message,
        });
      }
    });
  }
}
