import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IMAGE,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  assertLoopback,
  createExtractor,
  readSettings,
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
  assert.equal(settings.connection.endpoint, 'http://127.0.0.1:11434');
  assert.equal(settings.connection.think, false);
  assert.equal(settings.connection.temperature, 0.2);
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
  assert.equal(settings.connection.endpoint, 'http://localhost:11500');
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
