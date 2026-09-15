import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'blockquote'
  | 'fence'
  | 'html'
  | 'hr';

export interface Block {
  index: number;
  kind: BlockKind;
  source: string;
  hash: string;
  /** 原文の開始行（0 始まり） */
  lineStart: number;
  /**
   * 原文の終端行（終端排他）。ブロック本体の末尾であり、リストの直後の空行は含まない。
   * markdown-it の list トークンの map は後続の空行を 1 行飲み込むが、ここでは採用しない。
   */
  lineEnd: number;
}

const KIND_BY_TOKEN: Readonly<Record<string, BlockKind>> = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  table_open: 'table',
  blockquote_open: 'blockquote',
  fence: 'fence',
  code_block: 'fence',
  html_block: 'html',
  hr: 'hr',
};

export const TRANSLATABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  'heading',
  'paragraph',
  'list',
  'table',
  'blockquote',
]);

// 分割専用のパーサ。html:false にすると生 HTML が html_block ではなく paragraph になり、
// 翻訳対象へ紛れ込む。ここでは構造を見るだけで、描画には render.ts の html:false を使う。
const md = new MarkdownIt({ html: true });

export function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function makeBlock(
  index: number,
  kind: BlockKind,
  source: string,
  lineStart: number,
  lineEnd: number,
): Block {
  return { index, kind, source, hash: hashSource(source), lineStart, lineEnd };
}

export function splitBlocks(
  text: string,
  maxBlockChars = Number.POSITIVE_INFINITY,
): Block[] {
  const lines = text.split(/\r?\n/);
  const raw: Array<{ kind: BlockKind; source: string; lineStart: number }> = [];

  for (const token of md.parse(text, {})) {
    if (token.level !== 0 || token.nesting < 0 || !token.map) continue;
    const kind = KIND_BY_TOKEN[token.type];
    if (!kind) continue;
    const [lineStart, lineEnd] = token.map;
    const source = lines.slice(lineStart, lineEnd).join('\n').replace(/\s+$/, '');
    if (source === '') continue;
    raw.push({ kind, source, lineStart });
  }

  const blocks: Block[] = [];
  for (const entry of raw) {
    const pieces =
      entry.kind === 'list' && entry.source.length > maxBlockChars
        ? chunkListItems(entry.source, maxBlockChars)
        : [entry.source];

    let line = entry.lineStart;
    for (const piece of pieces) {
      // token.map ではなく本体の行数から求める。list トークンの map は後続の空行を
      // 含むため、そのまま使うとブロックの行範囲が実体より 1 行長くなる。
      const lineEnd = line + piece.split('\n').length;
      blocks.push(makeBlock(blocks.length, entry.kind, piece, line, lineEnd));
      line = lineEnd;
    }
  }

  return blocks;
}

const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s/;

/** リスト原文をトップレベル項目単位へ切る。継続行は直前の項目へ付ける。 */
function splitListItems(source: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  for (const line of source.split('\n')) {
    if (LIST_MARKER.test(line) && current.length > 0) {
      items.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) items.push(current.join('\n'));
  return items;
}

/** 項目を上限まで詰め合わせる。単独で上限を超える項目はそれ自体を 1 塊にする。 */
function chunkListItems(source: string, maxBlockChars: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const item of splitListItems(source)) {
    if (current.length > 0 && length + 1 + item.length > maxBlockChars) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    length = current.length === 0 ? item.length : length + 1 + item.length;
    current.push(item);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}
