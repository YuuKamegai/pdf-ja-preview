/**
 * Web 版のビルド。出力は `dist-web/`。
 *
 * 既存の VS Code 拡張のビルド（`esbuild.mjs` → `dist/`）には触らない。
 *
 * 原文を扱う実行時に外へ出ないので、PDF.js の worker・CMap・標準フォント・wasm を
 * すべてローカルへ複製する。CDN は使わない。
 */

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist-web');
const pdfjs = join(root, 'node_modules', 'pdfjs-dist');

const watch = process.argv.includes('--watch');

/** ブラウザへ届ける資産。どれか欠けると実行時に外を見に行こうとする。 */
const assets = [
  { from: join(pdfjs, 'build', 'pdf.worker.mjs'), to: join(out, 'pdfjs', 'pdf.worker.mjs') },
  { from: join(pdfjs, 'cmaps'), to: join(out, 'pdfjs', 'cmaps') },
  { from: join(pdfjs, 'standard_fonts'), to: join(out, 'pdfjs', 'standard_fonts') },
  { from: join(pdfjs, 'wasm'), to: join(out, 'pdfjs', 'wasm') },
  { from: join(pdfjs, 'iccs'), to: join(out, 'pdfjs', 'iccs') },
  { from: join(root, 'web', 'client', 'index.html'), to: join(out, 'index.html') },
  { from: join(root, 'web', 'client', 'style.css'), to: join(out, 'style.css') },
];

async function copyAssets() {
  for (const asset of assets) {
    await mkdir(dirname(asset.to), { recursive: true });
    await cp(asset.from, asset.to, { recursive: true });
  }
}

const client = {
  entryPoints: [join(root, 'web', 'client', 'main.ts')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

const server = {
  entryPoints: [join(root, 'web', 'server', 'cli.ts')],
  outfile: join(out, 'server.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await copyAssets();
  for (const options of [client, server]) {
    const ctx = await context(options);
    await ctx.watch();
  }
} else {
  await rm(out, { recursive: true, force: true });
  await copyAssets();
  await Promise.all([build(client), build(server)]);
  console.log(`built -> ${out}`);
}
