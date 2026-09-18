import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeTarget } from '../../src/translate/provider';
import { formatProblems, judgePreflight, preflight } from '../../web/server/preflight';
import { readSettings, seedFromEnv, startServer } from '../../web/server/main';
import { SettingsStore } from '../../web/server/settings-store';

const KEY = 'sk-canary-0123456789abcdef';
const windows = process.platform === 'win32';

test('設定の丸ごとに鍵が現れない', () => {
  const settings = readSettings(
    {
      LOCALAPPDATA: 'C:/tmp/local',
      PDF_JA_PROVIDER: 'openai',
      PDF_JA_MODEL: 'gpt-test',
      PDF_JA_API_KEY: KEY,
      OPENAI_API_KEY: KEY,
    } as NodeJS.ProcessEnv,
    'C:/tmp/dist-web',
  );
  assert.equal(JSON.stringify(settings).includes(KEY), false);
});

test('送信先の表示に鍵が現れない', () => {
  const target = describeTarget({
    kind: 'openai',
    baseUrl: `https://api.openai.com/v1?key=${KEY}`,
    apiKey: KEY,
    model: 'gpt-test',
    temperature: 0.2,
    timeoutMs: 1000,
  });
  assert.equal(target.includes(KEY), false);
  assert.equal(target, 'api.openai.com');
});

test('preflight の問題文に鍵が現れない', () => {
  const problems = judgePreflight(
    {
      missingAssets: [],
      extractor: { kind: 'docker', daemon: true, image: true },
      ollama: { reachable: true, models: [] },
      cloud: { hasKey: true, model: 'gpt-test', reachable: false },
    },
    {
      image: 'x:1',
      python: '',
      endpoint: 'http://127.0.0.1:11434',
      model: 'gpt-test',
      kind: 'openai',
      target: 'api.openai.com',
    },
  );
  for (const problem of problems) {
    assert.equal(problem.title.includes(KEY), false);
    assert.equal(problem.remedy.includes(KEY), false);
  }
});

test('preflight の実経路と整形ログに apiKey を問題文へ混ぜる mutation を検出する', async () => {
  let probedApiKey = '';
  const problems = await preflight(
    {
      staticRoot: 'C:/tmp/dist-web',
      image: 'x:1',
      python: '',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-test',
      kind: 'openai',
      target: 'api.openai.com',
      cloudAllowed: true,
      apiKey: KEY,
    },
    {
      assets: async () => [],
      extractor: async () => ({ kind: 'docker', daemon: true, image: true }),
      ollama: async () => {
        throw new Error('openai 経路では Ollama を探査しない');
      },
      cloud: async (_baseUrl, apiKey) => {
        probedApiKey = apiKey;
        return false;
      },
    },
  );

  assert.equal(probedApiKey, KEY, 'canary が実際の cloud probe 経路を通る');
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'warning');
  assert.equal(JSON.stringify(problems).includes(KEY), false);

  const logLines = formatProblems(problems);
  assert.equal(logLines.length, 2);
  assert.equal(logLines.join('\n').includes(KEY), false);
});

// ---- 実際の保存と HTTP 応答 ------------------------------------------------

/**
 * ここだけは DPAPI と実 HTTP を通す。
 * 「暗号化して保存した鍵が、画面と API のどこにも出てこない」は組み立て全体の
 * 性質なので、部品ごとの試験では守れない。
 */
test('実 SettingsStore に登録した鍵は HTTP 応答のどこにも出ない', { skip: !windows }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdf-ja-leak-'));
  const staticRoot = join(dir, 'static');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(
    join(staticRoot, 'index.html'),
    '<!doctype html><html><head><!--PDF_JA_TOKEN--><!--PDF_JA_MODEL--></head><body>ok</body></html>',
    'utf8',
  );

  const settings = readSettings(
    {
      LOCALAPPDATA: dir,
      PDF_JA_PROVIDER: 'openai',
      PDF_JA_CLOUD_ALLOWED: '1',
      PDF_JA_MODEL: 'gpt-test',
      PDF_JA_PORT: '0',
      PDF_JA_DATA_DIR: dir,
      PDF_JA_STATIC_ROOT: staticRoot,
    } as NodeJS.ProcessEnv,
    staticRoot,
  );

  // 環境変数からの移行で作られる接続へ、実 DPAPI で鍵を入れる。
  const store = new SettingsStore(dir);
  await store.loadOrMigrate(seedFromEnv(settings));
  const migrated = (await store.resolveSelected()).connection;
  await store.update(migrated.name, migrated, KEY);

  const running = await startServer(settings);
  try {
    const page = await (await fetch(running.url)).text();
    assert.equal(page.includes(KEY), false, '起動 HTML に鍵を埋め込まない');

    const token = /name="pdf-ja-token" content="([^"]+)"/.exec(page)?.[1];
    assert.ok(token, 'token を取り出せる');

    const status = await fetch(`${running.url}api/connections`, {
      headers: { 'x-pdf-ja-token': token },
    });
    const body = await status.text();
    assert.equal(status.status, 200);
    assert.equal(body.includes(KEY), false, '一覧は登録の有無だけを返す');
    const list = JSON.parse(body) as {
      selected: string;
      connections: { name: string; target: string; configured: boolean }[];
    };
    assert.equal(list.selected, 'openai');
    assert.equal(list.connections[0]?.target, 'api.openai.com');
    assert.equal(list.connections[0]?.configured, true);

    // 知らない文書のエラー経路にも鍵は混ざらない。
    const missing = await fetch(`${running.url}api/documents/unknown`, {
      headers: { 'x-pdf-ja-token': token },
    });
    assert.equal((await missing.text()).includes(KEY), false);

    const raw = await readFile(join(dir, 'settings.json'), 'utf8');
    assert.equal(raw.includes(KEY), false, 'ディスク上も平文ではない');
  } finally {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  }
});
