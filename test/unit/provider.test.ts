import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderConfigError } from '../../src/translate/errors';
import {
  assertSendable,
  describeTarget,
  isLoopbackUrl,
  normalizeAzureBaseUrl,
  translate,
  type ProviderConfig,
} from '../../src/translate/provider';

const ollama: ProviderConfig = {
  kind: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b-q4_K_M',
  think: false,
  temperature: 0.2,
  timeoutMs: 1000,
};

const openai: ProviderConfig = {
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  temperature: 0.2,
  timeoutMs: 1000,
};

const azure: ProviderConfig = {
  kind: 'azure',
  baseUrl: 'https://sample.openai.azure.com/openai/v1',
  apiKey: 'azure-key',
  model: 'translation-deployment',
  temperature: 0.2,
  timeoutMs: 1000,
};

test('Azure の公式 endpoint を v1 URL に正規化する', () => {
  assert.equal(
    normalizeAzureBaseUrl('https://sample.openai.azure.com'),
    'https://sample.openai.azure.com/openai/v1',
  );
  assert.equal(
    normalizeAzureBaseUrl('https://sample.services.ai.azure.com/openai/'),
    'https://sample.services.ai.azure.com/openai/v1',
  );
  assert.equal(
    normalizeAzureBaseUrl('https://sample.openai.azure.com/openai/v1/'),
    'https://sample.openai.azure.com/openai/v1',
  );
});

test('Azure は公式ホストと既知の v1 path 以外を拒否する', () => {
  for (const baseUrl of [
    'http://sample.openai.azure.com/openai/v1',
    'https://openai.azure.com/openai/v1',
    'https://sample.openai.azure.com.evil.example/openai/v1',
    'https://sample.openai.azure.com/openai/deployments/x',
    'https://sample.openai.azure.com/openai/v1?api-version=1',
  ]) {
    assert.throws(() => normalizeAzureBaseUrl(baseUrl), ProviderConfigError, baseUrl);
  }
});

test('ループバックの判定', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434'), true);
  assert.equal(isLoopbackUrl('http://localhost:1234'), true);
  assert.equal(isLoopbackUrl('http://[::1]:1234'), true);
  assert.equal(isLoopbackUrl('https://api.openai.com/v1'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
});

test('ローカルは許可なしでも通る', () => {
  assert.doesNotThrow(() => assertSendable(ollama, false));
});

test('ローカルで非ループバックは拒否する', () => {
  assert.throws(
    () => assertSendable({ ...ollama, endpoint: 'http://192.168.1.10:11434' }, true),
    ProviderConfigError,
  );
});

test('クラウドは許可がなければ拒否する', () => {
  assert.throws(() => assertSendable(openai, false), ProviderConfigError);
});

test('クラウドは許可があれば通る', () => {
  assert.doesNotThrow(() => assertSendable(openai, true));
  assert.doesNotThrow(() => assertSendable(azure, true));
});

test('Azure の非公式送信先は許可済みでも拒否する', () => {
  assert.throws(
    () => assertSendable({ ...azure, baseUrl: 'https://api.openai.com/v1' }, true),
    ProviderConfigError,
  );
});

test('真偽値でない truthy な許可を受け付けない', () => {
  for (const bogus of ['false', 'true', 1, {}, []] as unknown[]) {
    assert.throws(
      () => assertSendable(openai, bogus as boolean),
      ProviderConfigError,
      `許可として受け付けてはいけない値: ${JSON.stringify(bogus)}`,
    );
  }
});

test('クラウドの拒否理由に許可の付け方を書く', () => {
  assert.throws(() => assertSendable(openai, false), /許可/);
});

test('http のクラウドは拒否する', () => {
  assert.throws(
    () => assertSendable({ ...openai, baseUrl: 'http://api.example.com/v1' }, true),
    ProviderConfigError,
  );
});

test('ループバックなら http の互換サーバーを許す', () => {
  assert.doesNotThrow(() =>
    assertSendable({ ...openai, baseUrl: 'http://127.0.0.1:8000/v1' }, true),
  );
});

// Mutation: loopback なら scheme を問わず許す実装へ戻すと失敗する。
test('ループバックでも http/https 以外は拒否する', () => {
  assert.throws(
    () => assertSendable({ ...openai, baseUrl: 'ftp://127.0.0.1/v1' }, true),
    ProviderConfigError,
  );
  assert.throws(
    () => assertSendable({ ...ollama, endpoint: 'ftp://127.0.0.1/model' }, false),
    ProviderConfigError,
  );
});

test('キーが空なら拒否する', () => {
  assert.throws(() => assertSendable({ ...openai, apiKey: '' }, true), ProviderConfigError);
  assert.throws(() => assertSendable({ ...openai, apiKey: '   ' }, true), ProviderConfigError);
});

test('モデル名が空なら拒否する', () => {
  assert.throws(() => assertSendable({ ...openai, model: '' }, true), ProviderConfigError);
});

test('拒否理由に API キーを含めない', () => {
  for (const broken of [{ ...openai, model: '' }, { ...openai, baseUrl: 'http://x.example' }]) {
    assert.throws(
      () => assertSendable(broken, true),
      (error: unknown) => !(error as Error).message.includes('sk-test'),
    );
  }
});

test('送信先の表示はホスト名だけ', () => {
  assert.equal(describeTarget(openai), 'api.openai.com');
  assert.equal(describeTarget(ollama), '127.0.0.1:11434');
});

test('送信先の表示に API キーもパスも含めない', () => {
  const target = describeTarget({ ...openai, baseUrl: 'https://api.openai.com/v1/secret-path' });
  assert.equal(target, 'api.openai.com');
  assert.equal(target.includes('sk-test'), false);
  assert.equal(target.includes('secret-path'), false);
});

test('kind で実装を振り分ける', async () => {
  const calls: string[] = [];
  const result = await translate({
    source: 'Hello.',
    headingContext: '',
    config: openai,
    signal: new AbortController().signal,
    deps: {
      ollama: async () => {
        calls.push('ollama');
        return 'ollama';
      },
      openai: async () => {
        calls.push('openai');
        return 'openai';
      },
    },
  });
  assert.equal(result, 'openai');
  assert.deepEqual(calls, ['openai']);
});

test('Azure は正規化した URL と api-key 認証で OpenAI 実装へ回る', async () => {
  let received: Record<string, unknown> | undefined;
  const result = await translate({
    source: 'Hello.',
    headingContext: '',
    config: { ...azure, baseUrl: 'https://sample.openai.azure.com/openai/' },
    signal: new AbortController().signal,
    deps: {
      openai: async (args) => {
        received = args.config as unknown as Record<string, unknown>;
        return 'azure';
      },
    },
  });
  assert.equal(result, 'azure');
  assert.equal(received?.baseUrl, 'https://sample.openai.azure.com/openai/v1');
  assert.equal(received?.authMode, 'api-key');
});

test('ローカルは Ollama 実装へ回る', async () => {
  const result = await translate({
    source: 'Hello.',
    headingContext: '',
    config: ollama,
    signal: new AbortController().signal,
    deps: {
      ollama: async () => 'ollama',
      openai: async () => 'openai',
    },
  });
  assert.equal(result, 'ollama');
});
