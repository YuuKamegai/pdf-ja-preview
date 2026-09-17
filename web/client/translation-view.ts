/**
 * 訳文側の表示。
 *
 * 訳文はすべて `textContent` で書く。原文にどんな文字列が入っていても、ここから
 * HTML として解釈させない。
 */

import type { PdfBlock, PdfDocument, TranslationState } from '../shared/document';
import type { Snapshot } from '../shared/protocol';
import { blocksOnPage, blocksWithoutPosition, regionsForPage } from './geometry';
import { blockState } from './state';

/** 原文の切り抜きを見せる種別。訳さない。 */
const CROPPED_KINDS = new Set(['picture', 'table', 'formula']);
/** 折りたたんで出す種別。 */
const COLLAPSED_KINDS = new Set(['reference', 'furniture']);

const KIND_LABEL: Record<string, string> = {
  heading: '見出し',
  paragraph: '本文',
  list: '箇条書き',
  caption: 'キャプション',
  footnote: '脚注',
  picture: '図',
  table: '表',
  formula: '数式',
  reference: '参考文献',
  furniture: 'ページ装飾',
};

const STATUS_LABEL: Record<TranslationState['status'], string> = {
  source: '原文',
  queued: '待機',
  translating: '翻訳中',
  translated: '訳',
  error: '失敗',
};

export interface TranslationViewHandlers {
  onSelect(blockId: string): void;
  onRetry(blockId: string): void;
  /** 図表・数式の切り抜きを頼む。返らなければ原文のまま出す。 */
  cropOf(block: PdfBlock): Promise<Blob | undefined>;
}

export class TranslationView {
  #host: HTMLElement;
  #handlers: TranslationViewHandlers;
  #selected: string | undefined;
  #document: PdfDocument | undefined;
  #page = 1;
  #cropUrls = new Map<string, string>();
  #insideFigures = new Map<string, PdfBlock[]>();

  constructor(host: HTMLElement, handlers: TranslationViewHandlers) {
    this.#host = host;
    this.#handlers = handlers;
    this.#host.classList.add('translation-view');
  }

  get selected(): string | undefined {
    return this.#selected;
  }

  render(document: PdfDocument, snapshot: Snapshot): void {
    this.#document = document;
    this.#page = snapshot.page;
    this.#host.innerHTML = '';

    const all = blocksOnPage(document, snapshot.page);
    // 図の中の文字は図へ畳む。実際の論文では 1 ページに何百個も出るので、そのまま
    // 並べると本文が埋もれる。
    const insideFigures = new Map<string, PdfBlock[]>();
    const containers = new Set(
      all.filter((block) => CROPPED_KINDS.has(block.kind)).map((block) => block.id),
    );
    for (const block of all) {
      if (block.translatable || CROPPED_KINDS.has(block.kind) || block.kind === 'furniture') continue;
      const parent = block.relatedIds.find((id) => containers.has(id));
      if (parent === undefined) continue;
      const list = insideFigures.get(parent) ?? [];
      list.push(block);
      insideFigures.set(parent, list);
    }
    const foldedIds = new Set([...insideFigures.values()].flat().map((block) => block.id));
    this.#insideFigures = insideFigures;

    const onPage = all.filter((block) => !foldedIds.has(block.id));
    if (onPage.length === 0) {
      const empty = globalThis.document.createElement('p');
      empty.className = 'empty';
      empty.dataset.testid = 'no-blocks';
      empty.textContent = 'このページからは文章を抽出できません。';
      this.#host.append(empty);
    }

    for (const block of onPage) this.#host.append(this.#renderBlock(block, snapshot));

    const orphans = blocksWithoutPosition(document);
    if (orphans.length > 0) {
      const details = globalThis.document.createElement('details');
      details.dataset.testid = 'blocks-without-position';
      const summary = globalThis.document.createElement('summary');
      summary.textContent = `ページの分からない文章 (${orphans.length})`;
      details.append(summary);
      for (const block of orphans) details.append(this.#renderBlock(block, snapshot));
      this.#host.append(details);
    }

    if (this.#selected) this.select(this.#selected);
  }

  #renderBlock(block: PdfBlock, snapshot: Snapshot): HTMLElement {
    const state = blockState(snapshot, block.id);
    const collapsed = COLLAPSED_KINDS.has(block.kind);

    const container = globalThis.document.createElement(collapsed ? 'details' : 'article');
    container.className = `block kind-${block.kind}`;
    container.dataset.testid = `translation-block-${block.id}`;
    container.dataset.blockId = block.id;
    container.dataset.kind = block.kind;
    container.dataset.status = state?.status ?? 'source';

    const header = globalThis.document.createElement(collapsed ? 'summary' : 'header');
    header.className = 'block-header';
    const kindLabel = globalThis.document.createElement('span');
    kindLabel.className = 'kind';
    kindLabel.textContent = KIND_LABEL[block.kind] ?? block.kind;
    const statusLabel = globalThis.document.createElement('span');
    statusLabel.className = 'status';
    statusLabel.dataset.testid = `status-${block.id}`;
    statusLabel.textContent = STATUS_LABEL[state?.status ?? 'source'];
    header.append(kindLabel, statusLabel);
    container.append(header);

    if (CROPPED_KINDS.has(block.kind)) {
      container.append(this.#renderCrop(block));
      const inside = this.#insideFigures.get(block.id) ?? [];
      if (inside.length > 0) container.append(this.#renderFigureText(inside));
    } else {
      container.append(this.#renderText(block, state));
    }

    if (state?.status === 'error') {
      const reason = globalThis.document.createElement('p');
      reason.className = 'error';
      reason.dataset.testid = `error-${block.id}`;
      reason.textContent = state.error?.message ?? '翻訳に失敗しました';
      const retry = globalThis.document.createElement('button');
      retry.type = 'button';
      retry.dataset.testid = `retry-${block.id}`;
      retry.textContent = '訳し直す';
      retry.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#handlers.onRetry(block.id);
      });
      container.append(reason, retry);
    }

    container.addEventListener('click', () => this.#handlers.onSelect(block.id));
    return container;
  }

  #renderText(block: PdfBlock, state: TranslationState | undefined): HTMLElement {
    const body = globalThis.document.createElement('p');
    body.className = 'body';
    body.dataset.testid = `body-${block.id}`;
    // 訳が無い間は原文を見せる。空白にして待たせない。
    if (state?.status === 'translated' && state.ja) {
      body.textContent = state.ja;
      body.lang = 'ja';
    } else {
      body.textContent = block.source;
      body.lang = 'en';
      body.classList.add('source');
    }
    return body;
  }

  /** 図の中の文字。訳さないが、読めるように畳んで残す。 */
  #renderFigureText(blocks: PdfBlock[]): HTMLElement {
    const details = globalThis.document.createElement('details');
    details.className = 'figure-text';
    details.dataset.testid = 'figure-text';
    const summary = globalThis.document.createElement('summary');
    summary.textContent = `図の中の文字 (${blocks.length}) — 訳しません`;
    const body = globalThis.document.createElement('p');
    body.className = 'body source';
    body.lang = 'en';
    body.textContent = blocks.map((block) => block.source).join(' ');
    details.append(summary, body);
    return details;
  }

  #renderCrop(block: PdfBlock): HTMLElement {
    const figure = globalThis.document.createElement('figure');
    figure.className = 'crop';
    const image = globalThis.document.createElement('img');
    image.alt = `${KIND_LABEL[block.kind] ?? block.kind}の原文`;
    image.dataset.testid = `crop-${block.id}`;
    figure.append(image);

    const region = regionsForPage(block, this.#page)[0];
    if (region) {
      void this.#handlers.cropOf(block).then((blob) => {
        if (!blob) return;
        const previous = this.#cropUrls.get(block.id);
        if (previous) URL.revokeObjectURL(previous);
        const url = URL.createObjectURL(blob);
        this.#cropUrls.set(block.id, url);
        image.src = url;
      });
    }
    return figure;
  }

  select(blockId: string): void {
    this.#selected = blockId;
    for (const element of this.#host.querySelectorAll('[data-block-id]')) {
      element.classList.toggle('selected', (element as HTMLElement).dataset.blockId === blockId);
    }
    const target = this.#host.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
    target?.scrollIntoView({ block: 'nearest' });
  }

  dispose(): void {
    for (const url of this.#cropUrls.values()) URL.revokeObjectURL(url);
    this.#cropUrls.clear();
    this.#host.innerHTML = '';
    this.#document = undefined;
  }
}
