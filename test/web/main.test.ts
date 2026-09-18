import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_IMAGE,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  assertLoopback,
  createExtractor,
  readSettings,
  seedFromEnv,
  startServer,
} from '../../web/server/main';

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { LOCALAPPDATA: 'C:/tmp/local', ...extra } as NodeJS.ProcessEnv;
}

test('ループバックの endpoint だけ受け付ける', () => {
  assert.equal(assertLoopback('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(assertLoopback('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(assertLoopback('http://[::1]:11434'), 'http://[::1]:11434');
});

test('外向きの endpoint を拒否する', () => {
  for (const endpoint of ['http://example.com:11434', 'http://192.168.1.10:11434', 'https://api.example.com']) {
    assert.throws(() => assertLoopback(endpoint), /ループバック/, endpoint);
  }
});

test('URL でない endpoint を拒否する', () => {
  assert.throws(() => assertLoopback('not a url'), /URL/);
  assert.throws(() => assertLoopback('ftp://127.0.0.1'), /scheme/);
});

test('既定値は拡張と揃える', () => {
  const settings = readSettings(env(), 'C:/tmp/dist-web');
  assert.equal(settings.port, DEFAULT_PORT);
  assert.equal(settings.model, DEFAULT_MODEL);
  assert.equal(settings.provider.kind, 'ollama');
  assert.equal(settings.provider.endpoint, 'http://127.0.0.1:11434');
  assert.equal(settings.provider.think, false);
  assert.equal(settings.provider.temperature, 0.2);
  assert.equal(settings.extractorKind, 'docker');
  assert.equal(settings.image, DEFAULT_IMAGE);
});

test('環境変数で設定を差し替えられる', () => {
  const settings = readSettings(
    env({
      PDF_JA_PORT: '8123',
      PDF_JA_MODEL: 'other:9b',
      PDF_JA_DATA_DIR: 'C:/tmp/data',
      PDF_JA_EXTRACTOR_IMAGE: 'custom:2',
      PDF_JA_OLLAMA_ENDPOINT: 'http://localhost:11500',
    }),
    'C:/tmp/dist-web',
  );
  assert.equal(settings.port, 8123);
  assert.equal(settings.model, 'other:9b');
  assert.match(settings.dataDir, /data$/);
  assert.equal(settings.image, 'custom:2');
  assert.equal(settings.provider.kind, 'ollama');
  assert.equal(settings.provider.endpoint, 'http://localhost:11500');
});

test('PDF_JA_PYTHON があればローカル Python の抽出器になる', () => {
  const settings = readSettings(
    env({ PDF_JA_PYTHON: 'C:/py/python.exe', PDF_JA_MODELS_DIR: 'C:/models' }),
    'C:/tmp/dist-web',
  );
  assert.equal(settings.extractorKind, 'python');
  assert.match(createExtractor(settings).description, /^python:/);
});

test('既定は Docker 経由の抽出器', () => {
  const settings = readSettings(env(), 'C:/tmp/dist-web');
  assert.equal(createExtractor(settings).description, `docker:${DEFAULT_IMAGE}`);
});

test('数値でないポートは既定へ落とす', () => {
  assert.equal(readSettings(env({ PDF_JA_PORT: 'abc' }), 'C:/x').port, DEFAULT_PORT);
  assert.equal(readSettings(env({ PDF_JA_PORT: '-5' }), 'C:/x').port, DEFAULT_PORT);
});

// Mutation: provider の既定分岐を openai に変えると失敗する。
test('既定はローカルの Ollama', () => {
  const settings = readSettings(env(), 'C:/tmp/dist-web');
  assert.equal(settings.provider.kind, 'ollama');
  assert.equal(settings.cloudAllowed, false);
});

// Mutation: PDF_JA_PROVIDER またはクラウド許可フラグを無視すると失敗する。
test('PDF_JA_PROVIDER=openai でクラウドを選ぶ', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_CLOUD_ALLOWED: '1', PDF_JA_MODEL: 'gpt-test' }),
    'C:/tmp/dist-web',
  );
  assert.equal(settings.provider.kind, 'openai');
  assert.equal(settings.cloudAllowed, true);
  assert.equal(settings.model, 'gpt-test');
});

test('PDF_JA_PROVIDER=azure は公式 endpoint を正規化する', () => {
  const settings = readSettings(
    env({
      PDF_JA_PROVIDER: 'azure',
      PDF_JA_BASE_URL: 'https://sample.services.ai.azure.com/openai/',
      PDF_JA_CLOUD_ALLOWED: '1',
      PDF_JA_MODEL: 'translation-deployment',
    }),
    'C:/tmp/dist-web',
  );
  assert.equal(settings.provider.kind, 'azure');
  if (settings.provider.kind !== 'azure') throw new Error('unreachable');
  assert.equal(settings.provider.baseUrl, 'https://sample.services.ai.azure.com/openai/v1');
  assert.equal(settings.provider.model, 'translation-deployment');
  assert.equal(settings.cloudAllowed, true);
});

test('PDF_JA_PROVIDER=azure は非公式 endpoint を拒否する', () => {
  assert.throws(
    () =>
      readSettings(
        env({ PDF_JA_PROVIDER: 'azure', PDF_JA_BASE_URL: 'https://api.openai.com/v1' }),
        'C:/tmp/dist-web',
      ),
    /Azure OpenAI/,
  );
});

// Mutation: OpenAI の既定送信先を誤った URL に変えると失敗する。
test('クラウドでも既定の送信先は OpenAI', () => {
  const settings = readSettings(env({ PDF_JA_PROVIDER: 'openai' }), 'C:/tmp/dist-web');
  if (settings.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(settings.provider.baseUrl, 'https://api.openai.com/v1');
});

// Mutation: OpenAI でも DEFAULT_MODEL を流用すると失敗する。
test('クラウドのモデルは未指定なら空文字', () => {
  const settings = readSettings(env({ PDF_JA_PROVIDER: 'openai' }), 'C:/tmp/dist-web');
  assert.equal(settings.model, '');
  assert.equal(settings.provider.model, '');
});

// Mutation: PDF_JA_BASE_URL を無視すると失敗する。
test('PDF_JA_BASE_URL で送信先を差し替えられる', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_BASE_URL: 'https://example.openai.azure.com/openai/v1' }),
    'C:/tmp/dist-web',
  );
  if (settings.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(settings.provider.baseUrl, 'https://example.openai.azure.com/openai/v1');
});

// Mutation: OpenAI 分岐にも Ollama のループバック検査を適用すると失敗する。
test('クラウドを選んでも ollama の endpoint 検査で落ちない', () => {
  assert.doesNotThrow(() =>
    readSettings(
      env({ PDF_JA_PROVIDER: 'openai', PDF_JA_OLLAMA_ENDPOINT: 'http://127.0.0.1:11434' }),
      'C:/tmp/dist-web',
    ),
  );
});

// Mutation: Ollama 分岐からループバック制約を外すと失敗する。
test('ローカルのままなら従来どおり非ループバックを拒否する', () => {
  assert.throws(
    () => readSettings(env({ PDF_JA_OLLAMA_ENDPOINT: 'http://192.168.1.10:11434' }), 'C:/x'),
    /ループバック/,
  );
});

// Mutation: API キーを環境変数から provider へ取り込むと失敗する。
test('鍵は設定に持たせない（環境変数からも読まない）', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_API_KEY: 'sk-leak' }),
    'C:/tmp/dist-web',
  );
  assert.equal(JSON.stringify(settings).includes('sk-leak'), false);
});

// ---- 起動 -----------------------------------------------------------------

/** 起動に要る最小限の配信物を置いた一時ディレクトリ。 */
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'pdf-ja-main-'));
  const staticRoot = join(dir, 'static');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(
    join(staticRoot, 'index.html'),
    '<!doctype html><html><head><!--PDF_JA_TOKEN--><!--PDF_JA_MODEL--></head><body>ok</body></html>',
    'utf8',
  );
  return { dir, staticRoot, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Mutation: 起動時に鍵を必須にすると失敗する。
test('鍵が未登録でもクラウド設定でサーバーは起動し、画面を配信する', async () => {
  const { dir, staticRoot, cleanup } = await scratch();
  const settings = readSettings(
    env({
      PDF_JA_PROVIDER: 'openai',
      PDF_JA_CLOUD_ALLOWED: '1',
      PDF_JA_MODEL: 'gpt-test',
      PDF_JA_PORT: '0',
      PDF_JA_DATA_DIR: dir,
      PDF_JA_STATIC_ROOT: staticRoot,
    }),
    staticRoot,
  );
  const running = await startServer(settings);
  try {
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally {
    await running.close();
    await cleanup();
  }
});

// Mutation: 許可の無いクラウド設定を素通しすると失敗する。
test('許可の無いクラウドの環境変数は移行できない', () => {
  const settings = readSettings(
    env({ PDF_JA_PROVIDER: 'openai', PDF_JA_MODEL: 'gpt-test' }),
    'C:/tmp/dist-web',
  );
  assert.throws(() => seedFromEnv(settings)(undefined), /許可/);
});

// ---- 環境変数からの移行 ---------------------------------------------------

// Mutation: 移行でローカル接続を作らないと失敗する。
test('クラウドの環境変数から移行すると、ローカル接続も一緒に作る', () => {
  const settings = readSettings(
    env({
      PDF_JA_PROVIDER: 'azure',
      PDF_JA_BASE_URL: 'https://example.services.ai.azure.com/openai/v1',
      PDF_JA_CLOUD_ALLOWED: '1',
      PDF_JA_MODEL: 'gpt-test-deploy',
    }),
    'C:/tmp/dist-web',
  );
  const built = seedFromEnv(settings)('dpapi-current-user-v1:AAAA');
  assert.deepEqual(
    built.connections.map((connection) => connection.name),
    ['azure', 'local'],
  );
  assert.equal(built.selected, 'azure');
  assert.equal(built.connections[0]?.apiKeyProtected, 'dpapi-current-user-v1:AAAA');
  assert.equal(built.connections[0]?.trust, 'cloud-allowed');
  assert.equal(built.connections[1]?.trust, 'loopback');
});

test('ローカルの環境変数から移行すると 1 件だけ作る', () => {
  const built = seedFromEnv(readSettings(env(), 'C:/tmp/dist-web'))(undefined);
  assert.deepEqual(
    built.connections.map((connection) => connection.name),
    ['ollama'],
  );
  assert.equal(built.connections[0]?.model, DEFAULT_MODEL);
  assert.equal(built.connections[0]?.apiKeyProtected, undefined);
});
