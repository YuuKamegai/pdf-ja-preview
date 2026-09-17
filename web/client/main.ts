/** 画面の入口。Task 7 で組み立てる。 */

export function boot(root: HTMLElement): void {
  root.textContent = 'PDF 日本語プレビュー';
}

const root = document.getElementById('app');
if (root) boot(root);
