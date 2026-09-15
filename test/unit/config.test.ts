import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/config';

const empty = () => undefined;

test('未設定なら仕様どおりの既定値になる', () => {
  assert.deepEqual(resolveConfig(empty), {
    ollama: {
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b-q4_K_M',
      think: false,
      temperature: 0.2,
      timeoutMs: 120000,
    },
    maxBlockChars: 1500,
    scrollSync: true,
    autoOpen: false,
  });
});

test('設定値を読み取る', () => {
  const values: Record<string, unknown> = {
    endpoint: 'http://192.168.0.2:11434/',
    model: 'ornith:35b',
    think: true,
    temperature: 0.7,
    requestTimeoutMs: 30000,
    maxBlockChars: 800,
    scrollSync: false,
    autoOpen: true,
  };
  const config = resolveConfig((key) => values[key]);

  assert.equal(config.ollama.endpoint, 'http://192.168.0.2:11434/');
  assert.equal(config.ollama.model, 'ornith:35b');
  assert.equal(config.ollama.think, true);
  assert.equal(config.ollama.temperature, 0.7);
  assert.equal(config.ollama.timeoutMs, 30000);
  assert.equal(config.maxBlockChars, 800);
  assert.equal(config.scrollSync, false);
  assert.equal(config.autoOpen, true);
});

test('型が違う値は既定値へ落とす', () => {
  const config = resolveConfig((key) => (key === 'temperature' ? 'hot' : undefined));
  assert.equal(config.ollama.temperature, 0.2);
});

test('package.json が設定項目をすべて宣言している', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { contributes: { configuration: { properties: Record<string, unknown> } } };

  const declared = Object.keys(pkg.contributes.configuration.properties).sort();
  assert.deepEqual(declared, [
    'mdJaPreview.autoOpen',
    'mdJaPreview.endpoint',
    'mdJaPreview.maxBlockChars',
    'mdJaPreview.model',
    'mdJaPreview.requestTimeoutMs',
    'mdJaPreview.scrollSync',
    'mdJaPreview.temperature',
    'mdJaPreview.think',
  ]);
});
