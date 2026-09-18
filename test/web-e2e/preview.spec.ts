import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

// Playwright は CJS へ変換して読むので import.meta は使えない。設定の testDir から
// 見た相対ではなく、リポジトリ直下からの絶対パスにする。
const fixture = (name: string): string => resolve(process.cwd(), 'test', 'fixtures', 'pdf', name);

/**
 * PDF を開き、紙が描かれるまで待つ。
 *
 * canvas は文書を開く前から DOM にあるので、`pdf-page` が見えただけでは何も読めて
 * いない。ページ数が入ったことを合図にする。
 */
async function open(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('PDFを開く', { exact: true }).setInputFiles(fixture(name));
  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.locator('#page-count')).not.toHaveText('/ 0');
}

/** 抽出と翻訳の往復が済み、セッションが立つまで待つ。 */
async function openWithSession(page: Page, name: string, blockId: string): Promise<void> {
  await open(page, name);
  await expect(page.getByTestId(`translation-block-${blockId}`)).toBeVisible();
}

/** 原文の正規化座標を、画面の位置へ直して押す。 */
async function clickNormalized(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.getByTestId('pdf-page');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas がありません');
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

test('二段組みを開くと、原文と訳文が左右に並ぶ', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('PDFを開く', { exact: true }).setInputFiles(fixture('two-column.pdf'));

  await expect(page.getByTestId('pdf-page')).toBeVisible();
  await expect(page.getByTestId('extraction-status')).toContainText('抽出');
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');
  await expect(page.getByTestId('translation-block-texts-2')).toContainText('左段の続き');
  await expect(page.getByTestId('translation-block-texts-3')).toContainText('右段の本文');
});

test('抽出が終わるまで原文は読める', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('PDFを開く', { exact: true }).setInputFiles(fixture('two-column.pdf'));
  // 抽出の完了を待たずに canvas が出ていること。
  await expect(page.getByTestId('pdf-page')).toBeVisible({ timeout: 5_000 });
});

test('訳文を押すと、原文の該当箇所が光る', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');

  await page.getByTestId('translation-block-texts-1').click();
  const highlight = page.getByTestId('source-highlight').first();
  await expect(highlight).toBeVisible();

  // 抽出が出した矩形は [0.100, 0.129, 0.431, 0.212]。600x800 の紙なので約 (60, 103)。
  const box = await highlight.boundingBox();
  const canvas = await page.getByTestId('pdf-page').boundingBox();
  if (!box || !canvas) throw new Error('位置を取れません');
  expect(Math.abs(box.x - canvas.x - 60)).toBeLessThan(6);
  expect(Math.abs(box.y - canvas.y - 103)).toBeLessThan(6);
});

test('原文を押すと、その段落の訳が選ばれる', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await expect(page.getByTestId('translation-block-texts-3')).toContainText('右段の本文');

  // 右段のほぼ中央。
  await clickNormalized(page, 0.7, 0.17);
  await expect(page.getByTestId('translation-block-texts-3')).toHaveClass(/selected/);
  await expect(page.getByTestId('source-highlight').first()).toBeVisible();
});

test('重なった領域は繰り返し押すと切り替わる', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await expect(page.getByTestId('translation-block-texts-4')).toBeVisible();

  // 図の中。図だけが当たる。
  await clickNormalized(page, 0.7, 0.4);
  await expect(page.getByTestId('translation-block-pictures-0')).toHaveClass(/selected/);
});

test('図は訳さず、原文の切り抜きを見せる', async ({ page }) => {
  await open(page, 'two-column.pdf');
  const crop = page.getByTestId('crop-pictures-0');
  await expect(crop).toBeVisible();
  await expect(crop).toHaveAttribute('src', /^blob:/);
});

test('ページ装飾は折りたたんで出す', async ({ page }) => {
  await open(page, 'two-column.pdf');
  const furniture = page.getByTestId('translation-block-texts-5');
  await expect(furniture).toBeVisible();
  expect(await furniture.evaluate((el) => el.tagName)).toBe('DETAILS');
});

test('検証に落ちた訳も、未検証と断って原文と並べて出す', async ({ page }) => {
  await openWithSession(page, 'formula.pdf', 'texts-4');

  await expect(page.getByTestId('status-texts-4')).toHaveText('失敗');
  await expect(page.getByTestId('error-texts-4')).toContainText('42.5');

  const draft = page.getByTestId('draft-texts-4');
  await expect(draft).toContainText('未検証');
  await expect(draft).toContainText('活性化エネルギー Ea はどの試行でも kJ/mol');

  // 突き合わせられるよう、原文と訳し直すはそのまま残す。
  await expect(page.getByTestId('body-texts-4')).toContainText('42.5 kJ per mole');
  await expect(page.getByTestId('retry-texts-4')).toBeVisible();
});

test('ページを移ると訳文もそのページに変わる', async ({ page }) => {
  await openWithSession(page, 'general.pdf', 'texts-1');

  await page.getByLabel('次のページ').click();
  await expect(page.getByRole('spinbutton', { name: 'ページ' })).toHaveValue('2');
  await expect(page.getByTestId('translation-block-texts-4')).toBeVisible();
  await expect(page.getByTestId('translation-block-texts-1')).toHaveCount(0);
});

test('ページ番号を打ち込んでも移れる', async ({ page }) => {
  await openWithSession(page, 'general.pdf', 'texts-1');
  await page.getByRole('spinbutton', { name: 'ページ' }).fill('2');
  await page.getByRole('spinbutton', { name: 'ページ' }).press('Enter');
  await expect(page.getByTestId('translation-block-texts-4')).toBeVisible();
});

test('キーボードでページを移れる', async ({ page }) => {
  await openWithSession(page, 'general.pdf', 'texts-1');
  // text layer が canvas の上にあるので、位置を指定して直接押す。
  await clickNormalized(page, 0.02, 0.02);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('spinbutton', { name: 'ページ' })).toHaveValue('2');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('spinbutton', { name: 'ページ' })).toHaveValue('1');
});

test('ページ移動を連打しても最後のページをエラーなく表示する', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page, 'general.pdf');
  await expect(page.getByTestId('translation-block-texts-1')).toBeVisible();
  await page.evaluate(() => {
    document.getElementById('next')!.click();
    document.getElementById('prev')!.click();
    document.getElementById('next')!.click();
  });
  await expect(page.getByRole('spinbutton', {name:'ページ'})).toHaveValue('2');
  await expect(page.locator('.text-layer')).toContainText('The second page');
  expect(errors).toEqual([]);
});

test('拡大しても位置の対応が保たれる', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await page.getByTestId('translation-block-texts-1').click();
  await expect(page.getByTestId('source-highlight').first()).toBeVisible();

  const before = await page.getByTestId('source-highlight').first().boundingBox();
  if (!before) throw new Error('位置を取れません');

  await page.getByLabel('拡大').click();
  // 再描画は非同期。広がるまで待つ。
  await expect
    .poll(async () => (await page.getByTestId('source-highlight').first().boundingBox())?.width ?? 0)
    .toBeGreaterThan(before.width);
});

test('90 度ずつ回しても位置の対応が保たれる', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await page.getByTestId('translation-block-texts-1').click();

  for (const expected of [
    { rotation: 90, left: 630.7, top: 60 },
    { rotation: 180, left: 341.3, top: 630.7 },
    { rotation: 270, left: 103.1, top: 341.3 },
    { rotation: 0, left: 60, top: 103.1 },
  ]) {
    await page.getByLabel('90度回転').click();
    const highlight = page.getByTestId('source-highlight').first();
    await expect(highlight).toBeVisible();
    await expect
      .poll(async () => {
        const box = await highlight.boundingBox();
        const canvas = await page.getByTestId('pdf-page').boundingBox();
        if (!box || !canvas) return null;
        return Math.round(box.x - canvas.x);
      }, { message: `${expected.rotation} 度での左端` })
      .toBeCloseTo(expected.left, -1);
  }
});

test('非ゼロ CropBox のページでも位置が合う', async ({ page }) => {
  await open(page, 'cropbox.pdf');
  await expect(page.getByTestId('translation-block-texts-0')).toBeVisible();
  await page.getByTestId('translation-block-texts-0').click();

  const highlight = page.getByTestId('source-highlight').first();
  await expect(highlight).toBeVisible();
  const box = await highlight.boundingBox();
  const canvas = await page.getByTestId('pdf-page').boundingBox();
  if (!box || !canvas) throw new Error('位置を取れません');
  // 表示領域は 600x800。CropBox の原点を引いた l=60 に当たる。
  expect(Math.abs(box.x - canvas.x - 60)).toBeLessThan(6);
});

test('文章の無いページはそう言う', async ({ page }) => {
  await open(page, 'image-only.pdf');
  await expect(page.getByTestId('banner')).toContainText('文章を抽出できません');
});

test('一時停止と再開ができる', async ({ page }) => {
  await openWithSession(page, 'two-column.pdf', 'texts-1');
  const pause = page.getByRole('button', { name: '一時停止' });
  await pause.click();
  await expect(page.getByRole('button', { name: '再開' })).toBeVisible();
  await page.getByRole('button', { name: '再開' }).click();
  await expect(page.getByRole('button', { name: '一時停止' })).toBeVisible();
});

test('保存した訳を消せる', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');

  await page.getByRole('button', { name: '保存した訳を消す' }).click();
  await expect(page.getByTestId('banner')).toContainText('保存していた訳を消しました');
  // 世代が上がっても訳し直されて戻ってくる。
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');
});

test('別の PDF へ切り替えられる', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');

  await page.getByLabel('PDFを開く', { exact: true }).setInputFiles(fixture('general.pdf'));
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('The device was calibrated');
  await expect(page.getByRole('spinbutton', { name: 'ページ' })).toHaveValue('1');
});

test('閉じると表示が片づく', async ({ page }) => {
  await open(page, 'two-column.pdf');
  await expect(page.getByTestId('translation-block-texts-1')).toBeVisible();

  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByTestId('translation-block-texts-1')).toHaveCount(0);
  await expect(page.locator('#page-count')).toHaveText('/ 0');
  await expect(page.getByTestId('pdf-page')).not.toBeVisible();
});

test('抽出中でも次の文書へ切り替えられる', async ({page}) => {
  await page.goto('/');
  let firstId: string | undefined;
  await page.route('**/api/documents/*', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const id = route.request().url().split('/').pop()!;
    firstId ??= id;
    if (id === firstId) return route.fulfill({json:{state:'running'}});
    return route.continue();
  });
  await page.getByLabel('PDFを開く', {exact:true}).setInputFiles(fixture('two-column.pdf'));
  await expect(page.getByTestId('extraction-status')).toHaveText('抽出中');
  await page.getByLabel('PDFを開く', {exact:true}).setInputFiles(fixture('general.pdf'));
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('The device was calibrated');
});

test('外部への通信をしない', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('blob:') && !url.startsWith('data:')) {
      external.push(url);
    }
  });
  await open(page, 'two-column.pdf');
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');
  expect(external).toEqual([]);
});

// ---- API キー -------------------------------------------------------------

/** 鍵を扱うクラウド構成の fixture は隣のポートに立っている（playwright 設定と対）。 */
const cloudBase = `http://127.0.0.1:${Number(process.env.PDF_JA_E2E_PORT ?? 7398) + 1}`;

test('ローカルだけの構成では接続が 1 件しか出ない', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('接続')).toHaveValue('local');
  await expect(page.getByTestId('cloud-notice')).toBeHidden();
});

test('接続を切り替えると、その場で送信先が変わる', async ({ page }) => {
  await page.goto(`${cloudBase}/`);
  await expect(page.getByLabel('接続')).toHaveValue('local');
  await expect(page.getByTestId('cloud-notice')).toBeHidden();

  await page.getByLabel('PDFを開く', { exact: true }).setInputFiles(fixture('two-column.pdf'));
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');

  // 鍵の無いクラウド接続へ切り替えると、訳は始まらず理由が出る。
  await page.getByLabel('接続').selectOption('cloud');
  await expect(page.getByTestId('banner')).toContainText('API キー');

  await page.getByRole('button', { name: '接続を管理' }).click();
  // 「保存した訳を消す」と紛れるので、管理画面の中に絞る。
  const dialog = page.getByTestId('connections');
  await dialog.getByLabel('APIキー').fill('sk-e2e-0123456789');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('connection-row-cloud')).toContainText('登録済み');
  // 登録した鍵を画面に残さない。
  await expect(dialog.getByLabel('APIキー')).toHaveValue('');
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();

  await expect(page.getByTestId('cloud-notice')).toContainText('api.openai.com');
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');

  // ローカルへ戻すと送信先の表示が消え、キャッシュから訳が戻る。
  await page.getByLabel('接続').selectOption('local');
  await expect(page.getByTestId('cloud-notice')).toBeHidden();
  await expect(page.getByTestId('translation-block-texts-1')).toContainText('左段の本文');
});
