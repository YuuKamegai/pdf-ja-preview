/**
 * 原文の描画。PDF.js の薄い被せもの。
 *
 * 回転・拡大は PDF.js の viewport に任せ、自前の推測式を重ねない。中間形式の
 * 正規化座標は `normalizedToPdf` で PDF のユーザー空間へ戻し、そこから viewport の
 * `convertToViewportRectangle` で画面座標にする。
 */

import * as pdfjs from 'pdfjs-dist';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
} from 'pdfjs-dist';

import type { Region } from '../shared/document';
import { normalizedToPdf } from './geometry';

pdfjs.GlobalWorkerOptions.workerSrc = './pdfjs/pdf.worker.mjs';

/** すべてローカルから読む。実行時に CDN を見に行かせない。 */
const LOCAL_ASSETS = {
  cMapUrl: './pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: './pdfjs/standard_fonts/',
  wasmUrl: './pdfjs/wasm/',
  iccUrl: './pdfjs/iccs/',
} as const;

export interface PageGeometry {
  page: number;
  width: number;
  height: number;
  rotation: number;
}

export class PdfView {
  #canvas: HTMLCanvasElement;
  #overlay: HTMLElement;
  #textLayer: HTMLElement;
  #loadingTask: PDFDocumentLoadingTask | undefined;
  #document: PDFDocumentProxy | undefined;
  #page: PDFPageProxy | undefined;
  #renderTask: RenderTask | undefined;
  #viewport: PageViewport | undefined;
  #pageNumber = 1;
  #scale = 1;
  #rotation = 0;

  constructor(host: HTMLElement) {
    host.innerHTML = '';
    // 器は内側に作る。余白のある枠へ直接重ねると、絶対配置の基準が padding box に
    // なり、ハイライトが余白のぶんだけずれる。
    const stage = document.createElement('div');
    stage.className = 'pdf-view';
    host.append(stage);

    this.#canvas = document.createElement('canvas');
    this.#canvas.dataset.testid = 'pdf-page';
    this.#textLayer = document.createElement('div');
    this.#textLayer.className = 'text-layer';
    this.#overlay = document.createElement('div');
    this.#overlay.className = 'highlight-layer';
    this.#overlay.dataset.testid = 'highlight-layer';

    stage.append(this.#canvas, this.#textLayer, this.#overlay);
  }

  get pageCount(): number {
    return this.#document?.numPages ?? 0;
  }

  get pageNumber(): number {
    return this.#pageNumber;
  }

  get scale(): number {
    return this.#scale;
  }

  get rotation(): number {
    return this.#rotation;
  }

  async open(bytes: Uint8Array): Promise<void> {
    await this.#closeDocument();
    // PDF.js は渡した ArrayBuffer を手放さない。呼び出し側と共有しないよう複製する。
    const task = pdfjs.getDocument({ data: bytes.slice(), ...LOCAL_ASSETS });
    this.#loadingTask = task;
    this.#document = await task.promise;
  }

  async showPage(page: number, scale = this.#scale, rotation = this.#rotation): Promise<void> {
    const pdf = this.#document;
    if (!pdf) throw new Error('PDF が開かれていません');

    const clamped = Math.min(Math.max(1, Math.round(page)), pdf.numPages);
    this.#pageNumber = clamped;
    this.#scale = scale;
    this.#rotation = ((rotation % 360) + 360) % 360;

    // 描画中にページを変えると canvas の取り合いになる。前の描画を必ず止める。
    if (this.#renderTask) {
      this.#renderTask.cancel();
      this.#renderTask = undefined;
    }

    const pdfPage = await pdf.getPage(clamped);
    this.#page = pdfPage;

    const viewport = pdfPage.getViewport({ scale, rotation: this.#rotation });
    this.#viewport = viewport;

    const ratio = globalThis.devicePixelRatio || 1;
    this.#canvas.width = Math.floor(viewport.width * ratio);
    this.#canvas.height = Math.floor(viewport.height * ratio);
    this.#canvas.style.width = `${Math.floor(viewport.width)}px`;
    this.#canvas.style.height = `${Math.floor(viewport.height)}px`;
    for (const layer of [this.#textLayer, this.#overlay]) {
      layer.style.width = `${Math.floor(viewport.width)}px`;
      layer.style.height = `${Math.floor(viewport.height)}px`;
    }

    const context = this.#canvas.getContext('2d');
    if (!context) throw new Error('canvas を使えません');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, viewport.width, viewport.height);

    const task = pdfPage.render({ canvasContext: context, viewport, canvas: this.#canvas });
    this.#renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      // cancel は正常な流れ。次の描画が始まっている。
      if ((error as { name?: string }).name !== 'RenderingCancelledException') throw error;
      return;
    } finally {
      if (this.#renderTask === task) this.#renderTask = undefined;
    }

    await this.#renderText(pdfPage, viewport);
    this.highlight([]);
  }

  async #renderText(page: PDFPageProxy, viewport: unknown): Promise<void> {
    this.#textLayer.innerHTML = '';
    const content = await page.getTextContent();
    const layer = new pdfjs.TextLayer({
      textContentSource: content,
      container: this.#textLayer,
      viewport: viewport as never,
    });
    await layer.render();
  }

  geometry(): PageGeometry | undefined {
    if (!this.#page || !this.#viewport) return undefined;
    return {
      page: this.#pageNumber,
      width: this.#viewport.width,
      height: this.#viewport.height,
      rotation: this.#rotation,
    };
  }

  /** 正規化座標の矩形を、いまの表示での画面座標へ直す。 */
  toScreenRect(box: Region['box']): { left: number; top: number; width: number; height: number } | undefined {
    const page = this.#page;
    const viewport = this.#viewport;
    if (!page || !viewport) return undefined;
    const view = page.view as [number, number, number, number];
    return rectOf(viewport, normalizedToPdf(box, view));
  }

  /** 画面上の位置を正規化座標へ戻す。クリック位置の判定に使う。 */
  fromClientPoint(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const page = this.#page;
    const viewport = this.#viewport;
    if (!page || !viewport) return undefined;
    const rect = this.#canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;

    // 画面 → 表示領域の比率。中間形式は回転前なので、回転分を戻す。
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
    switch (this.#rotation) {
      case 90:
        return { x: v, y: 1 - u };
      case 180:
        return { x: 1 - u, y: 1 - v };
      case 270:
        return { x: 1 - v, y: u };
      default:
        return { x: u, y: v };
    }
  }

  highlight(regions: Region[]): void {
    this.#overlay.innerHTML = '';
    for (const region of regions) {
      if (region.page !== this.#pageNumber) continue;
      const rect = this.toScreenRect(region.box);
      if (!rect) continue;
      const element = document.createElement('div');
      element.className = 'highlight';
      element.dataset.testid = 'source-highlight';
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      this.#overlay.append(element);
    }
  }

  /** 図表・数式は訳さず、原文の切り抜きを見せる。 */
  async crop(region: Region, scale = 2): Promise<Blob | undefined> {
    const pdf = this.#document;
    if (!pdf) return undefined;
    const page = await pdf.getPage(region.page);
    const viewport = page.getViewport({ scale, rotation: 0 });
    const view = page.view as [number, number, number, number];
    const box = rectOf(viewport, normalizedToPdf(region.box, view));
    const left = box.left;
    const top = box.top;
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.translate(-left, -top);
    await page.render({ canvasContext: context, viewport, canvas }).promise;

    return new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/png');
    });
  }

  async #closeDocument(): Promise<void> {
    if (this.#renderTask) {
      this.#renderTask.cancel();
      this.#renderTask = undefined;
    }
    this.#page = undefined;
    this.#viewport = undefined;
    if (this.#loadingTask) {
      // 文書ではなく読み込みタスクを捨てる。worker もここで止まる。
      await this.#loadingTask.destroy();
      this.#loadingTask = undefined;
    }
    this.#document = undefined;
  }

  dispose(): void {
    void this.#closeDocument();
    this.#textLayer.innerHTML = '';
    this.#overlay.innerHTML = '';
  }
}

/**
 * PDF のユーザー空間の矩形を、viewport の画面座標の矩形へ直す。
 *
 * PDF.js 6 には `convertToViewportRectangle` が無いので、対角の 2 点を変換して
 * 外接矩形を取る。回転が入ると対角の向きが変わるので min/max で正規化する。
 */
function rectOf(
  viewport: PageViewport,
  pdfRect: [number, number, number, number],
): { left: number; top: number; width: number; height: number } {
  const [ax, ay] = viewport.convertToViewportPoint(pdfRect[0], pdfRect[1]) as [number, number];
  const [bx, by] = viewport.convertToViewportPoint(pdfRect[2], pdfRect[3]) as [number, number];
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}
