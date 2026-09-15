import type { Block } from '../markdown/blocks';

/** 指定行を含む（あるいは直前の）ブロックの index。ブロックが無ければ -1。 */
export function blockIndexAtLine(blocks: readonly Block[], line: number): number {
  if (blocks.length === 0) return -1;

  let found = 0;
  for (const block of blocks) {
    if (block.lineStart <= line) found = block.index;
    else break;
  }
  return found;
}

export function lineForBlock(blocks: readonly Block[], index: number): number {
  return blocks[index]?.lineStart ?? 0;
}

/**
 * 双方向スクロール同期のループを止めるゲート。
 * 自分が起こしたスクロールの跳ね返りを、一定時間だけ無視する。
 */
export class SyncGate {
  private suppressUntil = 0;

  constructor(
    private readonly windowMs = 250,
    private readonly now: () => number = Date.now,
  ) {}

  markSelfInitiated(): void {
    this.suppressUntil = this.now() + this.windowMs;
  }

  shouldAccept(): boolean {
    return this.now() >= this.suppressUntil;
  }
}
