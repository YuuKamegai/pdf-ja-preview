import type { PdfBlock, PdfDocument, Region } from '../shared/document';

/**
 * 正規化された `[left, top, right, bottom]` を PDF のユーザー空間へ戻す。
 *
 * `view` は PDF.js の `page.view`（`[x0, y0, x1, y1]`）。CropBox の原点が 0 でない
 * ページでも正しくなるよう、原点を足してから比率を掛ける。PDF は左下原点なので
 * `y` は上下を入れ替える。ここから先の回転・拡大は PDF.js の viewport 変換に任せ、
 * 自前の推測式を重ねない。
 */
export function normalizedToPdf(
  box: Region['box'],
  view: [number, number, number, number],
): [number, number, number, number] {
  const x0 = Math.min(view[0], view[2]);
  const x1 = Math.max(view[0], view[2]);
  const y0 = Math.min(view[1], view[3]);
  const y1 = Math.max(view[1], view[3]);
  const width = x1 - x0;
  const height = y1 - y0;
  const [left, top, right, bottom] = box;
  return [x0 + left * width, y1 - top * height, x0 + right * width, y1 - bottom * height];
}

/** 正規化座標の点。左上原点、0..1。 */
export interface NormalizedPoint {
  x: number;
  y: number;
}

export function areaOf(box: Region['box']): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

export function containsPoint(box: Region['box'], point: NormalizedPoint): boolean {
  return point.x >= box[0] && point.x <= box[2] && point.y >= box[1] && point.y <= box[3];
}

/**
 * その点を含むブロックを、面積の小さい順 → order の順に返す。
 *
 * 図とキャプションのように領域が重なることがある。小さい方（より具体的な方）を
 * 先に出し、同じ面積なら文書順で安定させる。クリックを繰り返すと次の候補へ移れる
 * ように、候補は捨てずに全部返す。
 */
export function candidatesAt(
  document: PdfDocument,
  page: number,
  point: NormalizedPoint,
): PdfBlock[] {
  const hits: Array<{ block: PdfBlock; area: number }> = [];
  for (const block of document.blocks) {
    let best: number | undefined;
    for (const region of block.regions) {
      if (region.page !== page) continue;
      if (!containsPoint(region.box, point)) continue;
      const area = areaOf(region.box);
      if (best === undefined || area < best) best = area;
    }
    if (best !== undefined) hits.push({ block, area: best });
  }
  hits.sort((a, b) => a.area - b.area || a.block.order - b.block.order);
  return hits.map((hit) => hit.block);
}

/** 指定ページに出るブロックを文書順で返す。 */
export function blocksOnPage(document: PdfDocument, page: number): PdfBlock[] {
  return document.blocks
    .filter((block) => block.regions.some((region) => region.page === page))
    .sort((a, b) => a.order - b.order);
}

/** どのページにも出ないブロック。見失わせないために別枠で出す。 */
export function blocksWithoutPosition(document: PdfDocument): PdfBlock[] {
  return document.blocks.filter((block) => block.regions.length === 0);
}

/** 選択中のページにある領域を優先する。無ければ最初の領域。 */
export function regionsForPage(block: PdfBlock, page: number): Region[] {
  const onPage = block.regions.filter((region) => region.page === page);
  return onPage.length > 0 ? onPage : block.regions.slice(0, 1);
}
