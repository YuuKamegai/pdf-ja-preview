import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveConfig } from '../../src/config';

function reader(values: Record<string, unknown>) {
  return (key: string): unknown => values[key];
}

/**
 * resolveConfig が実際に read() したキーを集める。
 * provider の両分岐（ollama / openai）を通さないと baseUrl 側が漏れるので、
 * 両方回して和集合を取る。
 */
function keysReadByResolveConfig(): Set<string> {
  const seen = new Set<string>();
  for (const provider of ['ollama', 'openai']) {
    resolveConfig((key) => {
      seen.add(key);
      return key === 'provider' ? provider : undefined;
    });
  }
  return seen;
}

test('既定はローカルの Ollama', () => {
  const config = resolveConfig(reader({}));
  assert.equal(config.provider.kind, 'ollama');
  assert.equal(config.cloudAllowed, false);
  if (config.provider.kind !== 'ollama') throw new Error('unreachable');
  assert.equal(config.provider.endpoint, 'http://127.0.0.1:11434');
  assert.equal(config.provider.model, 'qwen3.5:9b-q4_K_M');
});

test('provider を openai にすると baseUrl 側を組む', () => {
  const config = resolveConfig(reader({ provider: 'openai', model: 'gpt-test' }));
  assert.equal(config.provider.kind, 'openai');
  if (config.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(config.provider.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.provider.model, 'gpt-test');
});

test('鍵は設定から読まない（常に空）', () => {
  const config = resolveConfig(reader({ provider: 'openai', apiKey: 'sk-leak' }));
  if (config.provider.kind !== 'openai') throw new Error('unreachable');
  assert.equal(config.provider.apiKey, '');
});

test('知らない provider は ollama へ落とす', () => {
  assert.equal(resolveConfig(reader({ provider: 'gemini' })).provider.kind, 'ollama');
});

test('cloudAllowed を読む', () => {
  assert.equal(resolveConfig(reader({ cloudAllowed: true })).cloudAllowed, true);
});

test('温度とタイムアウトは両 provider で共用する', () => {
  const config = resolveConfig(reader({ provider: 'openai', temperature: 0.5, requestTimeoutMs: 9000 }));
  assert.equal(config.provider.temperature, 0.5);
  assert.equal(config.provider.timeoutMs, 9000);
});

test('resolveConfig が read() するキーと package.json の宣言が完全に一致する', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { contributes: { configuration: { properties: Record<string, unknown> } } };

  const declared = Object.keys(pkg.contributes.configuration.properties)
    .map((key) => key.replace(/^mdJaPreview\./, ''))
    .sort();

  const actuallyRead = Array.from(keysReadByResolveConfig()).sort();

  assert.deepEqual(
    actuallyRead,
    declared,
    'resolveConfig() が read() するキーと package.json の設定宣言は一致するはず',
  );
});
