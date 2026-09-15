import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateBlock,
  stripOuterFence,
  OllamaUnavailableError,
  OllamaModelMissingError,
  type OllamaConfig,
} from '../../src/translate/ollama';

const CONFIG: OllamaConfig = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'test-model',
  think: false,
  temperature: 0.2,
  timeoutMs: 5000,
};

function ndjsonResponse(objects: unknown[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const object of objects) {
        controller.enqueue(encoder.encode(JSON.stringify(object) + '\n'));
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

function chunk(content: string, done = false): unknown {
  return { message: { role: 'assistant', content }, done };
}

test('ストリームの content を連結して返す', async () => {
  const fetchImpl = async () => ndjsonResponse([chunk('こんに'), chunk('ちは。'), chunk('', true)]);
  const result = await translateBlock({
    source: 'Hello.',
    headingContext: '',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  assert.equal(result, 'こんにちは。');
});

test('リクエスト本文に think:false とモデル名が入る', async () => {
  let captured: Record<string, unknown> = {};
  const fetchImpl = async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return ndjsonResponse([chunk('訳', true)]);
  };
  await translateBlock({
    source: 'Hello.',
    headingContext: '# Intro',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  assert.equal(captured.think, false);
  assert.equal(captured.model, 'test-model');
  assert.equal(captured.stream, true);
  assert.deepEqual(captured.options, { temperature: 0.2 });
});

test('thinking フィールドは訳文に混ぜない', async () => {
  const fetchImpl = async () =>
    ndjsonResponse([
      { message: { role: 'assistant', thinking: '考え中', content: '' }, done: false },
      chunk('本文。', true),
    ]);
  const result = await translateBlock({
    source: 'Body.',
    headingContext: '',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  assert.equal(result, '本文。');
});

test('onDelta が到着順に呼ばれる', async () => {
  const seen: string[] = [];
  const fetchImpl = async () => ndjsonResponse([chunk('あ'), chunk('い'), chunk('', true)]);
  await translateBlock({
    source: 'x',
    headingContext: '',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    onDelta: (c) => seen.push(c),
  });
  assert.deepEqual(seen, ['あ', 'い']);
});

test('404 はモデル未導入として分類する', async () => {
  const fetchImpl = async () => new Response('{"error":"model not found"}', { status: 404 });
  await assert.rejects(
    translateBlock({
      source: 'x',
      headingContext: '',
      config: CONFIG,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    (error: unknown) =>
      error instanceof OllamaModelMissingError && error.model === 'test-model',
  );
});

test('接続できない場合は OllamaUnavailableError になる', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    translateBlock({
      source: 'x',
      headingContext: '',
      config: CONFIG,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    OllamaUnavailableError,
  );
});

test('呼び出し側の abort は AbortError として伝わる', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  const promise = translateBlock({
    source: 'x',
    headingContext: '',
    config: CONFIG,
    signal: controller.signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  controller.abort();
  await assert.rejects(promise, (error: unknown) => (error as Error).name === 'AbortError');
});

test('タイムアウトは OllamaUnavailableError になる', async () => {
  const fetchImpl = async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('timeout', 'TimeoutError')),
      );
    });
  await assert.rejects(
    translateBlock({
      source: 'x',
      headingContext: '',
      config: { ...CONFIG, timeoutMs: 20 },
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    OllamaUnavailableError,
  );
});

test('原文にフェンスが無いのに訳文全体が包まれていたら外す', () => {
  assert.equal(stripOuterFence('Plain.', '```markdown\n訳文。\n```'), '訳文。');
  assert.equal(stripOuterFence('Plain.', '```\n訳文。\n```'), '訳文。');
});

test('原文にフェンスがある場合は訳文をそのまま通す', () => {
  const ja = '```js\nx\n```';
  assert.equal(stripOuterFence('```js\nx\n```', ja), ja);
});

test('包まれていない訳文はそのまま通す', () => {
  assert.equal(stripOuterFence('Plain.', '訳文。'), '訳文。');
});
