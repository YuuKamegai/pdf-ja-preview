import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export interface StructureSignature {
  fences: number;
  inlineCodes: number;
  /** 昇順に並べたリンク URL */
  links: string[];
}

const md = new MarkdownIt({ html: false });

function walkInline(children: readonly Token[], signature: StructureSignature): void {
  for (const child of children) {
    if (child.type === 'code_inline') signature.inlineCodes++;
    if (child.type === 'link_open') {
      const href = child.attrGet('href');
      if (href !== null) signature.links.push(href);
    }
    if (child.children) walkInline(child.children, signature);
  }
}

export function structureOf(markdown: string): StructureSignature {
  const signature: StructureSignature = { fences: 0, inlineCodes: 0, links: [] };

  for (const token of md.parse(markdown, {})) {
    if (token.type === 'fence' || token.type === 'code_block') signature.fences++;
    if (token.type === 'inline' && token.children) walkInline(token.children, signature);
  }

  signature.links.sort();
  return signature;
}

/** 訳文が原文の構造を保っているか。プロンプト遵守を信用せず機械的に確かめる。 */
export function matchesStructure(source: string, translated: string): boolean {
  const a = structureOf(source);
  const b = structureOf(translated);
  return (
    a.fences === b.fences &&
    a.inlineCodes === b.inlineCodes &&
    a.links.length === b.links.length &&
    a.links.every((href, i) => href === b.links[i])
  );
}
