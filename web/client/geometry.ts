import type { Region } from '../shared/document';

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
