import type { Block } from './blocks';

export interface Reconciled {
  /** キーは新ブロックの index。値は持ち越した訳文 Markdown。 */
  carried: Map<number, string>;
  /** 訳が無く、翻訳が必要な新ブロックの index（昇順）。 */
  pending: number[];
}

/** ハッシュ列の最長共通部分列を (旧index, 新index) の対応として返す。 */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function reconcile(
  oldBlocks: readonly Block[],
  oldTranslations: ReadonlyMap<number, string>,
  newBlocks: readonly Block[],
): Reconciled {
  const pairs = lcsPairs(
    oldBlocks.map((b) => b.hash),
    newBlocks.map((b) => b.hash),
  );

  const carried = new Map<number, string>();
  for (const [oldIndex, newIndex] of pairs) {
    const ja = oldTranslations.get(oldIndex);
    if (ja !== undefined) carried.set(newIndex, ja);
  }

  const pending = newBlocks.filter((b) => !carried.has(b.index)).map((b) => b.index);
  return { carried, pending };
}
