import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PDF_JA_E2E_PORT ?? 7398);
/**
 * 鍵の登録は「クラウド構成のサーバー」でしか起きない。既定のローカル構成と
 * 同居できないので、隣のポートにもう 1 台だけ立てる。翻訳は両方とも固定なので、
 * どちらからも外へは出ない。
 */
const CLOUD_PORT = PORT + 1;

/**
 * PDF 日本語プレビューのブラウザ試験。
 *
 * 実 HTTP・実 `dist-web`・実 PDF.js を使い、抽出と翻訳だけ固定する。
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
  webServer: [
    {
      // 先に `npm run build:web` が要る。dist-web をそのまま配信する。
      command: `node --import tsx test/web-e2e/fixture-server.ts ${PORT}`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `node --import tsx test/web-e2e/fixture-server.ts ${CLOUD_PORT}`,
      env: { PDF_JA_E2E_CLOUD: '1' },
      url: `http://127.0.0.1:${CLOUD_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
