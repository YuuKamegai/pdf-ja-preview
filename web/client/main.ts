/**
 * 画面の組み立て。
 *
 * PDF を選んだらローカルのバイト列ですぐ表示し、同じバイト列をサーバーへ送る。
 * 抽出が終わるまで原文は読める。
 */

import type { PdfBlock, PdfDocument, Region } from '../shared/document';
import type { Snapshot } from '../shared/protocol';
import { Api, ApiError, readToken } from './api';
import { candidatesAt, regionsForPage } from './geometry';
import { PdfView } from './pdf-view';
import { applySessionResponse, countStates, reduceEvent } from './state';
import { TranslationView } from './translation-view';

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

interface Elements {
  file: HTMLInputElement;
  model: HTMLInputElement;
  page: HTMLInputElement;
  pageCount: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  rotate: HTMLButtonElement;
  pause: HTMLButtonElement;
  clearCache: HTMLButtonElement;
  close: HTMLButtonElement;
  extraction: HTMLElement;
  progress: HTMLElement;
  banner: HTMLElement;
  pdf: HTMLElement;
  translation: HTMLElement;
}

const EXTRACTION_LABEL: Record<string, string> = {
  queued: '抽出待ち',
  running: '抽出中',
  ready: '抽出済み',
  partial: '一部のみ抽出',
  error: '抽出に失敗',
};

export class App {
  #api: Api;
  #elements: Elements;
  #pdfView: PdfView;
  #translationView: TranslationView;

  #documentId: string | undefined;
  #document: PdfDocument | undefined;
  #snapshot: Snapshot | undefined;
  #stream: AbortController | undefined;
  #extraction: AbortController | undefined;
  #candidates: PdfBlock[] = [];
  #candidateIndex = 0;
  /** 読み込みが重ならないようにする。 */
  #opening: Promise<void> = Promise.resolve();
  #openGeneration = 0;

  constructor(api: Api, elements: Elements) {
    this.#api = api;
    this.#elements = elements;
    this.#pdfView = new PdfView(elements.pdf);
    this.#translationView = new TranslationView(elements.translation, {
      onSelect: (blockId) => this.selectBlock(blockId),
      onRetry: (blockId) => void this.retry(blockId),
      cropOf: (block) => this.#cropOf(block),
    });
    this.#wire();
  }

  #wire(): void {
    const e = this.#elements;
    e.file.addEventListener('change', () => {
      const file = e.file.files?.[0];
      if (file) void this.openFile(file);
    });
    e.prev.addEventListener('click', () => void this.goToPage(this.#pdfView.pageNumber - 1));
    e.next.addEventListener('click', () => void this.goToPage(this.#pdfView.pageNumber + 1));
    e.page.addEventListener('change', () => void this.goToPage(Number(e.page.value)));
    // 数値入力では Enter だけでは change が出ないブラウザがある。取りこぼさない。
    e.page.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      event.preventDefault();
      void this.goToPage(Number(e.page.value));
    });
    e.zoomIn.addEventListener('click', () => void this.zoom(1));
    e.zoomOut.addEventListener('click', () => void this.zoom(-1));
    e.rotate.addEventListener('click', () => void this.rotate());
    e.pause.addEventListener('click', () => void this.togglePause());
    e.clearCache.addEventListener('click', () => void this.clearCache());
    e.close.addEventListener('click', () => void this.closeDocument());
    e.model.addEventListener('change', () => void this.changeModel(e.model.value.trim()));

    this.#elements.pdf.addEventListener('click', (event) => this.#onPdfClick(event as MouseEvent));

    globalThis.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        void this.goToPage(this.#pdfView.pageNumber + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        void this.goToPage(this.#pdfView.pageNumber - 1);
      }
    });

    globalThis.addEventListener('beforeunload', () => {
      // 見ていない文書をサーバーに残さない。
      this.#stream?.abort();
    });
  }

  // ---- 文書 ---------------------------------------------------------------

  async openFile(file: File): Promise<void> {
    const generation = ++this.#openGeneration;
    this.#extraction?.abort();
    this.#stream?.abort();
    // 続けて選ばれたら、前の読み込みが終わってから始める。描画の途中で文書を
    // 差し替えると canvas と worker の取り合いになり、黙って古い表示が残る。
    const previous = this.#opening;
    let done!: () => void;
    this.#opening = new Promise<void>((resolve) => {
      done = resolve;
    });
    await previous;

    try {
      if (generation !== this.#openGeneration) return;
      await this.#openFile(file, generation);
    } catch (error) {
      if (generation !== this.#openGeneration) return;
      this.#banner(`PDF を開けません: ${this.#describe(error)}`);
      this.#setExtraction('error');
    } finally {
      done();
    }
  }

  async #openFile(file: File, generation: number): Promise<void> {
    await this.#clearDocument();
    const controller = new AbortController();
    this.#extraction = controller;
    this.#banner('');

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (generation !== this.#openGeneration) return;
    // 先にローカルのバイト列で表示する。アップロードと抽出は後ろで進む。
    await this.#pdfView.open(bytes);
    await this.#pdfView.showPage(1, 1, 0);
    if (generation !== this.#openGeneration) return;
    this.#elements.pageCount.textContent = `/ ${this.#pdfView.pageCount}`;
    this.#elements.page.value = '1';
    this.#setExtraction('queued');

    try {
      const accepted = await this.#api.uploadDocument(bytes);
      if (generation !== this.#openGeneration) {
        await this.#api.deleteDocument(accepted.documentId).catch(() => undefined);
        return;
      }
      this.#documentId = accepted.documentId;
    } catch (error) {
      this.#banner(this.#describe(error));
      this.#setExtraction('error');
      return;
    }

    try {
      const status = await this.#api.waitForDocument(
        this.#documentId,
        (state) => this.#setExtraction(state),
        controller.signal,
      );
      if (generation !== this.#openGeneration) return;
      if (status.state === 'error' || !status.document) {
        this.#banner(status.error?.message ?? '抽出に失敗しました');
        return;
      }
      this.#document = status.document;
      for (const warning of status.document.warnings.slice(0, 3)) this.#banner(warning);
      await this.#startSession(generation);
    } catch (error) {
      if ((error as ApiError).code !== 'cancelled') this.#banner(this.#describe(error));
    }
  }

  async #startSession(generation: number): Promise<void> {
    if (!this.#documentId || !this.#document) return;
    const model = this.#elements.model.value.trim();
    try {
      const snapshot = await this.#api.createSession(this.#documentId, model);
      if (generation !== this.#openGeneration) {
        await this.#api.deleteSession(snapshot.sessionId).catch(() => undefined);
        return;
      }
      this.#snapshot = snapshot;
    } catch (error) {
      this.#banner(this.#describe(error));
      return;
    }
    this.#renderTranslations();
    void this.#listen();
    await this.#syncPage();
  }

  async #listen(): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    this.#stream?.abort();
    const controller = new AbortController();
    this.#stream = controller;

    while (!controller.signal.aborted) {
      try {
        await this.#api.streamEvents(
          snapshot.sessionId,
          (event) => {
            if (!this.#snapshot) return;
            const next = reduceEvent(this.#snapshot, event);
            if (next !== this.#snapshot) {
              this.#snapshot = next;
              this.#renderTranslations();
            }
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        this.#banner(`接続が切れました。つなぎ直します: ${this.#describe(error)}`);
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async closeDocument(): Promise<void> {
    this.#openGeneration++;
    this.#extraction?.abort();
    this.#stream?.abort();
    await this.#opening;
    await this.#clearDocument();
  }

  async #clearDocument(): Promise<void> {
    this.#extraction?.abort();
    this.#extraction = undefined;
    this.#stream?.abort();
    this.#stream = undefined;

    const sessionId = this.#snapshot?.sessionId;
    const documentId = this.#documentId;
    this.#snapshot = undefined;
    this.#document = undefined;
    this.#documentId = undefined;
    this.#candidates = [];

    this.#translationView.dispose();
    await this.#pdfView.dispose();
    this.#elements.pageCount.textContent = '/ 0';
    this.#elements.page.value = '1';
    if (sessionId) await this.#api.deleteSession(sessionId).catch(() => undefined);
    // 取り消したときもサーバー側の文書を解除する。
    if (documentId) await this.#api.deleteDocument(documentId).catch(() => undefined);
    this.#setExtraction('');
    this.#elements.progress.textContent = '';
    this.#banner('');
  }

  // ---- 表示 ---------------------------------------------------------------

  async goToPage(page: number): Promise<void> {
    if (this.#pdfView.pageCount === 0) return;
    if (!Number.isFinite(page)) return;
    const clamped = Math.min(Math.max(1, Math.round(page)), this.#pdfView.pageCount);
    await this.#pdfView.showPage(clamped);
    if (clamped !== this.#pdfView.pageNumber) return;
    this.#elements.page.value = String(clamped);
    this.#renderTranslations();
    await this.#syncPage();
    this.#reapplyHighlight();
  }

  async zoom(direction: number): Promise<void> {
    const current = ZOOM_STEPS.indexOf(this.#pdfView.scale);
    const index = Math.min(
      ZOOM_STEPS.length - 1,
      Math.max(0, (current < 0 ? 2 : current) + direction),
    );
    await this.#pdfView.showPage(this.#pdfView.pageNumber, ZOOM_STEPS[index]);
    this.#reapplyHighlight();
  }

  async rotate(): Promise<void> {
    await this.#pdfView.showPage(
      this.#pdfView.pageNumber,
      this.#pdfView.scale,
      this.#pdfView.rotation + 90,
    );
    this.#reapplyHighlight();
  }

  async #syncPage(): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    try {
      const response = await this.#api.patchSession(snapshot.sessionId, {
        page: this.#pdfView.pageNumber,
      });
      this.#apply(response);
    } catch (error) {
      this.#banner(this.#describe(error));
    }
  }

  // ---- 操作 ---------------------------------------------------------------

  async togglePause(): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    try {
      this.#apply(await this.#api.patchSession(snapshot.sessionId, { paused: !snapshot.paused }));
    } catch (error) {
      this.#banner(this.#describe(error));
    }
  }

  async changeModel(model: string): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot || model === '' || model === snapshot.model) return;
    try {
      this.#apply(await this.#api.patchSession(snapshot.sessionId, { model }));
    } catch (error) {
      this.#banner(this.#describe(error));
    }
  }

  async retry(blockId: string): Promise<void> {
    const snapshot = this.#snapshot;
    if (!snapshot) return;
    try {
      await this.#api.retry(snapshot.sessionId, blockId);
    } catch (error) {
      this.#banner(this.#describe(error));
    }
  }

  async clearCache(): Promise<void> {
    if (!this.#documentId) return;
    try {
      await this.#api.deleteCache(this.#documentId);
      this.#banner('保存していた訳を消しました。訳し直します。');
    } catch (error) {
      this.#banner(this.#describe(error));
    }
  }

  // ---- 位置対応 -----------------------------------------------------------

  #onPdfClick(event: MouseEvent): void {
    const document = this.#document;
    if (!document) return;
    const point = this.#pdfView.fromClientPoint(event.clientX, event.clientY);
    if (!point) return;

    const found = candidatesAt(document, this.#pdfView.pageNumber, point);
    if (found.length === 0) return;

    const same =
      found.length === this.#candidates.length &&
      found.every((block, index) => block.id === this.#candidates[index]?.id);
    // 同じ場所を続けて押したら次の候補へ。重なった図とキャプションを切り替えられる。
    this.#candidateIndex = same ? (this.#candidateIndex + 1) % found.length : 0;
    this.#candidates = found;
    this.selectBlock(found[this.#candidateIndex].id);
  }

  selectBlock(blockId: string): void {
    this.#translationView.select(blockId);
    this.#reapplyHighlight();
  }

  #reapplyHighlight(): void {
    const document = this.#document;
    const selected = this.#translationView.selected;
    if (!document || !selected) {
      this.#pdfView.highlight([]);
      return;
    }
    const block = document.blocks.find((candidate) => candidate.id === selected);
    if (!block) {
      this.#pdfView.highlight([]);
      return;
    }
    const regions: Region[] = regionsForPage(block, this.#pdfView.pageNumber);
    this.#pdfView.highlight(regions);
  }

  #cropOf(block: PdfBlock): Promise<Blob | undefined> {
    const region = regionsForPage(block, this.#pdfView.pageNumber)[0];
    if (!region) return Promise.resolve(undefined);
    return this.#pdfView.crop(region);
  }

  // ---- 表示の小物 ---------------------------------------------------------

  /** 往復の応答を取り込む。手元の方が新しいブロックは残す。 */
  #apply(response: Snapshot): void {
    if (!this.#snapshot) return;
    this.#snapshot = applySessionResponse(this.#snapshot, response);
    this.#renderTranslations();
  }

  #renderTranslations(): void {
    const document = this.#document;
    const snapshot = this.#snapshot;
    if (!document || !snapshot) return;

    this.#translationView.render(document, { ...snapshot, page: this.#pdfView.pageNumber });

    const counts = countStates(snapshot, document);
    this.#elements.progress.textContent =
      `訳済み ${counts.translated} / ${counts.total}` +
      (counts.failed > 0 ? `（失敗 ${counts.failed}）` : '');
    this.#elements.pause.textContent = snapshot.paused ? '再開' : '一時停止';
    this.#elements.model.value = snapshot.model;
    if (snapshot.error) this.#banner(snapshot.error.message);
  }

  #setExtraction(state: string): void {
    this.#elements.extraction.textContent = EXTRACTION_LABEL[state] ?? '';
  }

  #banner(message: string): void {
    this.#elements.banner.textContent = message;
    this.#elements.banner.hidden = message === '';
  }

  #describe(error: unknown): string {
    if (error instanceof ApiError) return error.message;
    return (error as Error).message ?? String(error);
  }
}

function must<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`要素がありません: ${id}`);
  return element as unknown as T;
}

export function boot(): App {
  const elements: Elements = {
    file: must('file'),
    model: must('model'),
    page: must('page'),
    pageCount: must('page-count'),
    prev: must('prev'),
    next: must('next'),
    zoomIn: must('zoom-in'),
    zoomOut: must('zoom-out'),
    rotate: must('rotate'),
    pause: must('pause'),
    clearCache: must('clear-cache'),
    close: must('close'),
    extraction: must('extraction-status'),
    progress: must('progress'),
    banner: must('banner'),
    pdf: must('pdf'),
    translation: must('translation'),
  };
  const defaultModel = document.querySelector('meta[name="pdf-ja-model"]')?.getAttribute('content');
  if (defaultModel) elements.model.value = decodeURIComponent(defaultModel);
  return new App(new Api(readToken()), elements);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot());
} else {
  boot();
}
