/**
 * 実文書を実サーバー（実 Docling・実 Ollama）で通すブラウザ試験。
 *
 * 既定では走りません。Docker と Ollama が要るうえ、数分かかります。
 *
 *   npm run build:web
 *   node dist-web/server.cjs                      # 別の端末で
 *   $env:PDF_JA_REAL_PDF = 'C:\path\to\paper.pdf'
 *   $env:PDF_JA_REAL_BASE = 'http://127.0.0.1:7391'
 *   npx playwright test --config playwright.pdf.config.ts -g '実文書'
 *
 * 文書はリポジトリへ入れません。パスは環境変数で渡します。
 */

import { expect, test } from '@playwright/test';

const pdfPath = process.env.PDF_JA_REAL_PDF;
const base = process.env.PDF_JA_REAL_BASE;

test.describe('実文書', () => {
  test.skip(
    !pdfPath || !base,
    'PDF_JA_REAL_PDF と PDF_JA_REAL_BASE を指定したときだけ走ります',
  );
  test.setTimeout(10 * 60_000);

  test('実サーバーで開き、原文と訳が対応する', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(`${base}/`) && !url.startsWith('blob:') && !url.startsWith('data:')) {
        external.push(url);
      }
    });

    await page.goto(`${base}/`);
    await page.getByLabel('PDFを開く', { exact: true }).setInputFiles(pdfPath as string);

    // 抽出を待たずに原文が読めること。
    await expect(page.getByTestId('pdf-page')).toBeVisible();
    await expect(page.locator('#page-count')).not.toHaveText('/ 0', { timeout: 60_000 });

    // 抽出が終わると訳文側にブロックが並ぶ。
    await expect(page.locator('.translation-view .block').first()).toBeVisible({
      timeout: 5 * 60_000,
    });
    await expect(page.getByTestId('extraction-status')).toContainText('抽出');

    // どれか一つが日本語になるまで待つ。
    await expect
      .poll(
        async () =>
          page.locator('.translation-view .block[data-status="translated"]').count(),
        { timeout: 5 * 60_000, message: '訳が出るまで' },
      )
      .toBeGreaterThan(0);

    // 訳文を押すと原文が光る。
    const translated = page.locator('.translation-view .block[data-status="translated"]').first();
    await translated.click();
    await expect(page.getByTestId('source-highlight').first()).toBeVisible();

    await page.screenshot({ path: 'test-results/real-document.png', fullPage: false });
    expect(external, `外部への通信: ${external.join(', ')}`).toEqual([]);
  });
});
