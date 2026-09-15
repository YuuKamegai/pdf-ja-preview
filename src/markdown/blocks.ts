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
  /** 原文の終端行（終端排他） */
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
  const blocks: Block[] = [];

  for (const token of md.parse(text, {})) {
    // ネスト深度 0 の開始トークンと自己完結トークンだけを拾う。
    // 閉じトークン (nesting < 0) と、引用やリストの内側 (level > 0) は無視する。
    if (token.level !== 0 || token.nesting < 0 || !token.map) continue;
    const kind = KIND_BY_TOKEN[token.type];
    if (!kind) continue;

    const [lineStart, lineEnd] = token.map;
    const source = lines.slice(lineStart, lineEnd).join('\n').replace(/\s+$/, '');
    if (source === '') continue;

    blocks.push(makeBlock(blocks.length, kind, source, lineStart, lineEnd));
  }

  return blocks;
}
