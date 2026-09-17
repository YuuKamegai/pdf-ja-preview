/**
 * PDF 中間形式 `pdf-document.v1` の型とランタイム検証。
 *
 * 抽出器（Python/Docling）とブラウザの共有契約。ここには抽出器固有の型も
 * VS Code の型も持ち込まない。
 */

export const DOCUMENT_SCHEMA = 'pdf-document.v1';

export type Kind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'caption'
  | 'footnote'
  | 'picture'
  | 'table'
  | 'formula'
  | 'reference'
  | 'furniture';

export const KINDS: readonly Kind[] = [
  'heading',
  'paragraph',
  'list',
  'caption',
  'footnote',
  'picture',
  'table',
  'formula',
  'reference',
  'furniture',
];

/** ページ内の矩形。`box` は `[left, top, right, bottom]` の 0..1、回転適用前。 */
export interface Region {
  page: number;
  box: [number, number, number, number];
  /** 原文の文字範囲。終端排他。 */
  charRange?: [number, number];
}

export interface PdfBlock {
  id: string;
  kind: Kind;
  order: number;
  source: string;
  headingContext: string;
  translatable: boolean;
  regions: Region[];
  relatedIds: string[];
}

export type PageStatus = 'ok' | 'no-text' | 'failed';

export interface PdfPage {
  number: number;
  width: number;
  height: number;
  rotation: number;
  status: PageStatus;
}

export interface PdfDocument {
  schema: typeof DOCUMENT_SCHEMA;
  hash: string;
  extractor: { version: string; configHash: string };
  pages: PdfPage[];
  blocks: PdfBlock[];
  warnings: string[];
}

export type BlockStatus = 'source' | 'queued' | 'translating' | 'translated' | 'error';

export interface TranslationState {
  id: string;
  sourceHash: string;
  status: BlockStatus;
  ja?: string;
  error?: { code: string; message: string };
}

/** 契約違反。座標だけは例外にせず領域を落として warning にする。 */
export class DocumentContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentContractError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new DocumentContractError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, code: string, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code, `${where} がオブジェクトではありません`);
  return value;
}

function requireString(value: unknown, code: string, where: string): string {
  if (typeof value !== 'string') fail(code, `${where} が文字列ではありません`);
  return value;
}

function requireBoolean(value: unknown, code: string, where: string): boolean {
  if (typeof value !== 'boolean') fail(code, `${where} が真偽値ではありません`);
  return value;
}

function requireFiniteNumber(value: unknown, code: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(code, `${where} が有限の数値ではありません`);
  }
  return value;
}

function requireInteger(value: unknown, code: string, where: string): number {
  const n = requireFiniteNumber(value, code, where);
  if (!Number.isInteger(n)) fail(code, `${where} が整数ではありません`);
  return n;
}

function requireArray(value: unknown, code: string, where: string): unknown[] {
  if (!Array.isArray(value)) fail(code, `${where} が配列ではありません`);
  return value;
}

const HASH_RE = /^[0-9a-f]{64}$/;

function requireHash(value: unknown, where: string): string {
  const s = requireString(value, 'invalid-hash', where);
  if (!HASH_RE.test(s)) fail('invalid-hash', `${where} が 64 桁の 16 進ではありません: ${s}`);
  return s;
}

function parsePage(input: unknown, seen: Set<number>): PdfPage {
  const raw = requireRecord(input, 'invalid-page', 'pages[]');
  const number = requireInteger(raw.number, 'invalid-page', 'pages[].number');
  if (number < 1) fail('invalid-page', `ページ番号は 1 始まりです: ${number}`);
  if (seen.has(number)) fail('duplicate-page', `ページ番号が重複しています: ${number}`);
  seen.add(number);

  const width = requireFiniteNumber(raw.width, 'invalid-page', `pages[${number}].width`);
  const height = requireFiniteNumber(raw.height, 'invalid-page', `pages[${number}].height`);
  if (width <= 0 || height <= 0) {
    fail('invalid-page', `ページ ${number} の寸法が正ではありません`);
  }

  const rotation = requireInteger(raw.rotation, 'invalid-page', `pages[${number}].rotation`);
  if (![0, 90, 180, 270].includes(rotation)) {
    fail('invalid-page', `ページ ${number} の rotation が 0/90/180/270 ではありません: ${rotation}`);
  }

  const status = requireString(raw.status, 'invalid-page', `pages[${number}].status`);
  if (status !== 'ok' && status !== 'no-text' && status !== 'failed') {
    fail('invalid-page', `ページ ${number} の status が未知です: ${status}`);
  }

  return { number, width, height, rotation, status };
}

/** 座標が壊れている領域は `undefined` を返し、呼び出し側が warning を積む。 */
function parseRegion(
  input: unknown,
  pageNumbers: Set<number>,
  blockId: string,
  sourceLength: number,
  warnings: string[],
): Region | undefined {
  const raw = requireRecord(input, 'invalid-region', `blocks[${blockId}].regions[]`);
  const page = requireInteger(raw.page, 'invalid-region', `blocks[${blockId}].regions[].page`);
  if (!pageNumbers.has(page)) {
    fail('unknown-page', `ブロック ${blockId} が存在しないページ ${page} を指しています`);
  }

  let charRange: [number, number] | undefined;
  if (raw.charRange !== undefined) {
    const values = requireArray(
      raw.charRange,
      'invalid-char-range',
      `blocks[${blockId}].regions[].charRange`,
    );
    if (values.length !== 2) {
      fail('invalid-char-range', `ブロック ${blockId} の charRange が 2 要素ではありません`);
    }
    const start = requireInteger(values[0], 'invalid-char-range', `blocks[${blockId}].charRange[0]`);
    const end = requireInteger(values[1], 'invalid-char-range', `blocks[${blockId}].charRange[1]`);
    if (start < 0 || end <= start) {
      fail(
        'invalid-char-range',
        `ブロック ${blockId} の charRange は終端排他で start<end が必要です`,
      );
    }
    if (end > sourceLength) {
      fail('invalid-char-range', `ブロック ${blockId} の charRange が原文の長さを超えています`);
    }
    charRange = [start, end];
  }

  const boxValues = requireArray(raw.box, 'invalid-region', `blocks[${blockId}].regions[].box`);
  const numeric =
    boxValues.length === 4 && boxValues.every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!numeric) {
    warnings.push(
      `ブロック ${blockId} の領域(ページ ${page})の座標が数値ではないため位置を捨てました`,
    );
    return undefined;
  }
  const [left, top, right, bottom] = boxValues as [number, number, number, number];
  const inRange = [left, top, right, bottom].every((v) => v >= 0 && v <= 1);
  if (!inRange || left >= right || top >= bottom) {
    warnings.push(`ブロック ${blockId} の領域(ページ ${page})の座標が不正なため位置を捨てました`);
    return undefined;
  }

  return charRange === undefined
    ? { page, box: [left, top, right, bottom] }
    : { page, box: [left, top, right, bottom], charRange };
}

function parseBlock(
  input: unknown,
  pageNumbers: Set<number>,
  seenIds: Set<string>,
  seenOrders: Set<number>,
  warnings: string[],
): PdfBlock {
  const raw = requireRecord(input, 'invalid-block', 'blocks[]');
  const id = requireString(raw.id, 'invalid-block', 'blocks[].id');
  if (id === '') fail('invalid-block', 'blocks[].id が空文字です');
  if (seenIds.has(id)) fail('duplicate-block-id', `ブロック ID が重複しています: ${id}`);
  seenIds.add(id);

  const kind = requireString(raw.kind, 'unknown-kind', `blocks[${id}].kind`);
  if (!(KINDS as readonly string[]).includes(kind)) {
    fail('unknown-kind', `未知の kind です: ${kind}`);
  }

  const order = requireInteger(raw.order, 'invalid-block', `blocks[${id}].order`);
  if (order < 0) fail('invalid-block', `order は 0 始まりです: ${order}`);
  if (seenOrders.has(order)) fail('duplicate-order', `order が重複しています: ${order}`);
  seenOrders.add(order);

  const source = requireString(raw.source, 'invalid-block', `blocks[${id}].source`);
  const headingContext = requireString(
    raw.headingContext,
    'invalid-block',
    `blocks[${id}].headingContext`,
  );
  const translatable = requireBoolean(raw.translatable, 'invalid-block', `blocks[${id}].translatable`);

  const regions: Region[] = [];
  for (const entry of requireArray(raw.regions, 'invalid-block', `blocks[${id}].regions`)) {
    const region = parseRegion(entry, pageNumbers, id, source.length, warnings);
    if (region !== undefined) regions.push(region);
  }

  const relatedIds = requireArray(raw.relatedIds, 'invalid-block', `blocks[${id}].relatedIds`).map(
    (entry) => requireString(entry, 'invalid-block', `blocks[${id}].relatedIds[]`),
  );

  return {
    id,
    kind: kind as Kind,
    order,
    source,
    headingContext,
    translatable,
    regions,
    relatedIds,
  };
}

export function parseDocument(input: unknown): PdfDocument {
  const raw = requireRecord(input, 'invalid-document', 'document');

  const schema = requireString(raw.schema, 'unknown-schema', 'document.schema');
  if (schema !== DOCUMENT_SCHEMA) fail('unknown-schema', `未知の schema です: ${schema}`);

  const hash = requireHash(raw.hash, 'document.hash');

  const extractorRaw = requireRecord(raw.extractor, 'invalid-document', 'document.extractor');
  const extractor = {
    version: requireString(extractorRaw.version, 'invalid-document', 'document.extractor.version'),
    configHash: requireHash(extractorRaw.configHash, 'document.extractor.configHash'),
  };

  const pageInputs = requireArray(raw.pages, 'invalid-document', 'document.pages');
  if (pageInputs.length === 0) fail('invalid-document', 'ページがありません');
  const seenPages = new Set<number>();
  const pages = pageInputs.map((entry) => parsePage(entry, seenPages));

  const warnings = requireArray(raw.warnings, 'invalid-document', 'document.warnings').map((entry) =>
    requireString(entry, 'invalid-document', 'document.warnings[]'),
  );

  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  const blocks = requireArray(raw.blocks, 'invalid-document', 'document.blocks').map((entry) =>
    parseBlock(entry, seenPages, seenIds, seenOrders, warnings),
  );

  for (const block of blocks) {
    for (const related of block.relatedIds) {
      if (!seenIds.has(related)) {
        fail('unknown-related-id', `ブロック ${block.id} が存在しない ${related} を参照しています`);
      }
    }
  }

  return { schema: DOCUMENT_SCHEMA, hash, extractor, pages, blocks, warnings };
}
