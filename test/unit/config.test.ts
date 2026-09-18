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
  for (const provider of ['ollama', 'openai', 'azure']) {
    resolveConfig((key) => {
      seen.add(key);
      if (key === 'provider') return provider;
      if (provider === 'azure' && key === 'baseUrl') {
        return 'https://sample.openai.azure.com/openai/v1';
      }
      return undefined;
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

test('provider を azure にすると公式 endpoint を正規化して deployment 名を使う', () => {
  const config = resolveConfig(
    reader({
      provider: 'azure',
      baseUrl: 'https://sample.services.ai.azure.com/openai/',
      model: 'translation-deployment',
    }),
  );
  assert.equal(config.provider.kind, 'azure');
  if (config.provider.kind !== 'azure') throw new Error('unreachable');
  assert.equal(config.provider.baseUrl, 'https://sample.services.ai.azure.com/openai/v1');
  assert.equal(config.provider.model, 'translation-deployment');
  assert.equal(config.provider.apiKey, '');
});

test('cloud provider はモデル未指定でも Ollama の既定モデルを継承しない', () => {
  const openai = resolveConfig(reader({ provider: 'openai' }));
  assert.equal(openai.provider.model, '');

  const azure = resolveConfig(
    reader({ provider: 'azure', baseUrl: 'https://sample.openai.azure.com/openai/v1' }),
  );
  assert.equal(azure.provider.model, '');
});

test('Ollama はモデルが空または未指定なら既定モデルへ補完する', () => {
  assert.equal(resolveConfig(reader({})).provider.model, 'qwen3.5:9b-q4_K_M');
  assert.equal(resolveConfig(reader({ model: '' })).provider.model, 'qwen3.5:9b-q4_K_M');
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
