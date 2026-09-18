import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectionError,
  normalizeName,
  sameTarget,
  toProviderConfig,
  validateConnection,
  viewOf,
  type Connection,
} from '../../web/server/connection';

const OLLAMA = {
  name: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b-q4_K_M',
  trust: 'loopback',
};

const AZURE = {
  name: 'azure-mini',
  provider: 'azure',
  baseUrl: 'https://example.services.ai.azure.com/openai/',
  model: 'gpt-test-deploy',
  trust: 'cloud-allowed',
};

test('接続名は前後の空白を落として受け取る', () => {
  assert.equal(normalizeName('  local  '), 'local');
});

test('空・長すぎ・制御文字入りの接続名を拒否する', () => {
  assert.throws(() => normalizeName('   '), ConnectionError);
  assert.throws(() => normalizeName('x'.repeat(41)), ConnectionError);
  assert.throws(() => normalizeName('a\nb'), ConnectionError);
  assert.throws(() => normalizeName(42), ConnectionError);
});

test('Ollama の接続は末尾の / を落として受け取る', () => {
  const connection = validateConnection({ ...OLLAMA, baseUrl: 'http://127.0.0.1:11434/' });
  assert.equal(connection.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(connection.trust, 'loopback');
});

// Mutation: Ollama にクラウド許可を認めると失敗する。
test('Ollama では cloud-allowed を指定できない', () => {
  assert.throws(() => validateConnection({ ...OLLAMA, trust: 'cloud-allowed' }), ConnectionError);
});

// Mutation: Ollama のループバック制限を外すと失敗する。
test('Ollama の送信先はループバックだけ', () => {
  assert.throws(
    () => validateConnection({ ...OLLAMA, baseUrl: 'http://192.168.1.10:11434' }),
    ConnectionError,
  );
  assert.throws(() => validateConnection({ ...OLLAMA, baseUrl: 'ftp://127.0.0.1' }), ConnectionError);
});

// Mutation: クラウドで許可を省けるようにすると失敗する。
test('クラウドの接続は送信許可が要る', () => {
  assert.throws(() => validateConnection({ ...AZURE, trust: 'loopback' }), ConnectionError);
});

test('Azure の送信先は /openai/v1 へ正規化して保存する', () => {
  const connection = validateConnection(AZURE);
  assert.equal(connection.baseUrl, 'https://example.services.ai.azure.com/openai/v1');
});

test('Azure の非公式ホストを拒否する', () => {
  assert.throws(
    () => validateConnection({ ...AZURE, baseUrl: 'https://api.openai.com/v1' }),
    ConnectionError,
  );
});

test('OpenAI 互換は https、ループバックなら http も許す', () => {
  assert.equal(
    validateConnection({
      name: 'oai',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      trust: 'cloud-allowed',
    }).baseUrl,
    'https://api.openai.com/v1',
  );
  assert.equal(
    validateConnection({
      name: 'localoai',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'gpt-test',
      trust: 'cloud-allowed',
    }).baseUrl,
    'http://127.0.0.1:8080/v1',
  );
  assert.throws(
    () =>
      validateConnection({
        name: 'oai',
        provider: 'openai',
        baseUrl: 'http://example.com/v1',
        model: 'gpt-test',
        trust: 'cloud-allowed',
      }),
    ConnectionError,
  );
});

test('知らない provider を拒否する', () => {
  assert.throws(() => validateConnection({ ...OLLAMA, provider: 'anthropic' }), ConnectionError);
});

test('モデルは空でも受け取る（選んだときに警告する）', () => {
  assert.equal(validateConnection({ ...OLLAMA, model: '' }).model, '');
  assert.equal(validateConnection({ ...OLLAMA, model: '  m1  ' }).model, 'm1');
});

// Mutation: view に鍵を載せると失敗する。
test('画面へ出す形に鍵は入らない', () => {
  const connection: Connection = {
    ...validateConnection(AZURE),
    apiKeyProtected: 'dpapi-current-user-v1:AAAA',
  };
  const view = viewOf(connection);
  assert.deepEqual(view, {
    name: 'azure-mini',
    provider: 'azure',
    target: 'example.services.ai.azure.com',
    model: 'gpt-test-deploy',
    trust: 'cloud-allowed',
    configured: true,
  });
  assert.equal(JSON.stringify(view).includes('dpapi'), false);
});

test('鍵が無ければ configured は false', () => {
  assert.equal(viewOf(validateConnection(AZURE)).configured, false);
});

// Mutation: 送信先が変わっても同じとみなすと失敗する（鍵の破棄規則が効かなくなる）。
test('provider か送信先が変われば別の送信先とみなす', () => {
  const current = validateConnection(AZURE);
  assert.equal(sameTarget(current, { provider: 'azure', baseUrl: current.baseUrl }), true);
  assert.equal(
    sameTarget(current, {
      provider: 'azure',
      baseUrl: 'https://other.services.ai.azure.com/openai/v1',
    }),
    false,
  );
  assert.equal(sameTarget(current, { provider: 'openai', baseUrl: current.baseUrl }), false);
});

test('ProviderConfig へ落とすと provider ごとの形になる', () => {
  const options = { temperature: 0.2, timeoutMs: 1000, think: false };

  const ollama = toProviderConfig(validateConnection(OLLAMA), '', options);
  if (ollama.kind !== 'ollama') throw new Error('ollama にならなかった');
  assert.equal(ollama.endpoint, 'http://127.0.0.1:11434');
  assert.equal(ollama.think, false);

  const azure = toProviderConfig(validateConnection(AZURE), 'sk-canary', options);
  if (azure.kind !== 'azure') throw new Error('azure にならなかった');
  assert.equal(azure.apiKey, 'sk-canary');
  assert.equal(azure.model, 'gpt-test-deploy');
});
