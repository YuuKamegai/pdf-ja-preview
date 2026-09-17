import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PDF_JA_E2E_PORT ?? 7398);

/**
 * PDF 日本語プレビューのブラウザ試験。
 *
 * 既存の VS Code 拡張の試験（`vscode-test`）とは別に動く。実 HTTP・実 `dist-web`・
 * 実 PDF.js を使い、抽出と翻訳だけ固定する。
 */
export default defineConfig({
  testDir: './test/web-e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // この machine は Smart App Control が Enforce で、Playwright が落としてくる
  // 未署名の chrome-headless-shell.exe を起動できない（spawn UNKNOWN /
  // "An Application Control policy has blocked this file"）。署名済みで既に
  // 入っている Edge を使う。PDF.js の動作確認としては同じ Chromium で足りる。
  projects: [
    {
      name: 'msedge',
      use: { ...devices['Desktop Edge'], channel: process.env.PDF_JA_E2E_CHANNEL ?? 'msedge' },
    },
  ],
  webServer: {
    // 先に `npm run build:web` が要る。dist-web をそのまま配信する。
    command: `node --import tsx test/web-e2e/fixture-server.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
