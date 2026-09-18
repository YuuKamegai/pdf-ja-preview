import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAiRequestBody, parseSseData, type OpenAiConfig } from '../../src/translate/openai';
import { SYSTEM_PROMPT } from '../../src/translate/ollama';
import {
  ModelMissingError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../../src/translate/errors';
import { translateWithOpenAi } from '../../src/translate/openai';

const config: OpenAiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
  temperature: 0.2,
  timeoutMs: 1000,
};

test('本文はモデル・温度・ストリームを含む', () => {
  const body = buildOpenAiRequestBody('Hello.', '', config, SYSTEM_PROMPT);
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, true);
});

test('本文に API キーを含めない', () => {
  const body = buildOpenAiRequestBody('Hello.', '', config, SYSTEM_PROMPT);
  assert.equal(JSON.stringify(body).includes('sk-test'), false);
});

test('見出し文脈は user メッセージの先頭に付く', () => {
  const body = buildOpenAiRequestBody('Hello.', 'Methods', config, SYSTEM_PROMPT);
  const messages = body.messages as { role: string; content: string }[];
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, SYSTEM_PROMPT);
  assert.match(messages[1]?.content ?? '', /^直前の見出し: Methods/);
});

test('見出し文脈が空なら前置きを付けない', () => {
  const body = buildOpenAiRequestBody('Hello.', '', config, SYSTEM_PROMPT);
  const messages = body.messages as { content: string }[];
  assert.equal(messages[1]?.content.startsWith('直前の見出し'), false);
});

test('data 行から delta の中身を取り出す', () => {
  assert.equal(
    parseSseData('data: {"choices":[{"delta":{"content":"こん"}}]}'),
    'こん',
  );
});

test('[DONE] は終端として返す', () => {
  assert.equal(parseSseData('data: [DONE]'), 'done');
});

test('空行・コメント・event 行は無視する', () => {
  assert.equal(parseSseData(''), undefined);
  assert.equal(parseSseData('   '), undefined);
  assert.equal(parseSseData(': keep-alive'), undefined);
  assert.equal(parseSseData('event: message'), undefined);
});

test('delta に content が無ければ無視する', () => {
  assert.equal(parseSseData('data: {"choices":[{"delta":{"role":"assistant"}}]}'), undefined);
  assert.equal(parseSseData('data: {"choices":[]}'), undefined);
});

test('壊れた JSON は例外にせず無視する', () => {
  assert.equal(parseSseData('data: {壊れている'), undefined);
});

test('data: の後の空白の有無を問わない', () => {
  assert.equal(parseSseData('data:{"choices":[{"delta":{"content":"a"}}]}'), 'a');
});

/** SSE の本文を、指定した切れ目で分割して返す fetch を作る。 */
function sseFetch(chunks: string[], init: { status?: number; body?: string } = {}) {
  const captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const impl = (async (url: string | URL, options: RequestInit = {}) => {
    captured.url = String(url);
    captured.headers = options.headers as Record<string, string>;
    captured.body = options.body as string;
    const status = init.status ?? 200;
    if (status !== 200) {
      return new Response(init.body ?? '{}', { status });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { impl, captured };
}

test('SSE を繋いで訳文にする', async () => {
  const { impl } = sseFetch([
    'data: {"choices":[{"delta":{"content":"こん"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"にちは"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const result = await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config,
    signal: new AbortController().signal,
    fetchImpl: impl,
  });
  assert.equal(result, 'こんにちは');
});

test('イベントの途中で分割して届いても繋がる', async () => {
  const { impl } = sseFetch([
    'data: {"choices":[{"delta":{"con',
    'tent":"あ"}}]}\n\ndata: {"choices":[{"delta":{"content":"い"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const result = await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config,
    signal: new AbortController().signal,
    fetchImpl: impl,
  });
  assert.equal(result, 'あい');
});

test('onDelta へ逐次渡す', async () => {
  const seen: string[] = [];
  const { impl } = sseFetch([
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config,
    signal: new AbortController().signal,
    fetchImpl: impl,
    onDelta: (chunk) => seen.push(chunk),
  });
  assert.deepEqual(seen, ['A', 'B']);
});

test('URL とヘッダーを組み立てる', async () => {
  const { impl, captured } = sseFetch(['data: [DONE]\n\n']);
  await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config: { ...config, baseUrl: 'https://api.openai.com/v1/' },
    signal: new AbortController().signal,
    fetchImpl: impl,
  });
  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(captured.headers?.['authorization'], 'Bearer sk-test');
  assert.equal(captured.headers?.['content-type'], 'application/json');
});

test('Azure 認証は api-key ヘッダーだけを使う', async () => {
  const { impl, captured } = sseFetch(['data: [DONE]\n\n']);
  await translateWithOpenAi({
    source: 'Hello.',
    headingContext: '',
    config: {
      ...config,
      baseUrl: 'https://sample.openai.azure.com/openai/v1',
      authMode: 'api-key',
    },
    signal: new AbortController().signal,
    fetchImpl: impl,
  });
  assert.equal(captured.headers?.['api-key'], 'sk-test');
  assert.equal(captured.headers?.['authorization'], undefined);
});

test('401 は認証の失敗として投げる', async () => {
  const { impl } = sseFetch([], { status: 401 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderAuthError,
  );
});

test('403 も認証の失敗として投げる', async () => {
  const { impl } = sseFetch([], { status: 403 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderAuthError,
  );
});

test('認証の失敗に API キーを含めない', async () => {
  const { impl } = sseFetch([], { status: 401 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => !(error as Error).message.includes('sk-test'),
  );
});

test('404 はモデル欠落として投げる', async () => {
  const { impl } = sseFetch([], { status: 404 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ModelMissingError && error.model === 'gpt-test',
  );
});

test('本文の model_not_found もモデル欠落として投げる', async () => {
  const { impl } = sseFetch([], {
    status: 400,
    body: '{"error":{"code":"model_not_found"}}',
  });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ModelMissingError,
  );
});

test('429 は流量制限として投げる', async () => {
  const { impl } = sseFetch([], { status: 429 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderRateLimitError,
  );
});

test('500 は可用性の問題として投げる', async () => {
  const { impl } = sseFetch([], { status: 500 });
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) => error instanceof ProviderUnavailableError,
  );
});

test('接続できないときは可用性の問題として投げる', async () => {
  const impl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) =>
      error instanceof ProviderUnavailableError && error.message.includes('api.openai.com'),
  );
});

test('呼び出し側の中断はそのまま伝える', async () => {
  const controller = new AbortController();
  const impl = (async (_url: string, options: RequestInit = {}) => {
    controller.abort();
    (options.signal as AbortSignal).throwIfAborted();
    return new Response('', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: controller.signal,
      fetchImpl: impl,
    }),
    (error: unknown) => (error as Error).name === 'AbortError',
  );
});

test('タイムアウトは可用性の問題として投げる（呼び出し側は中断していない）', async () => {
  // fetch 呼び出し自体（1 つ目の try/catch）でタイムアウトが発火する経路。
  // 呼び出し側の signal は最後まで abort しない — timeout.aborted の分岐だけを踏む。
  const impl = (async (_url: string, options: RequestInit = {}) => {
    const combined = options.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      combined.addEventListener('abort', () => reject(combined.reason));
    });
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config: { ...config, timeoutMs: 1 },
      signal: new AbortController().signal,
      fetchImpl: impl,
    }),
    (error: unknown) =>
      error instanceof ProviderUnavailableError &&
      error.message.includes('api.openai.com') &&
      error.message.includes('ms を超えました') &&
      !error.message.includes('sk-test'),
  );
});

test('ストリーム読み取り中の中断はそのまま伝える（可用性エラーに包まない）', async () => {
  // 1 チャンク届いた後、reader.read() のループが回っている最中に
  // 呼び出し側が abort する経路（2 つ目の try/catch）。
  const controller = new AbortController();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulls += 1;
      if (pulls === 1) {
        ctrl.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"A"}}]}\n\n'),
        );
        return;
      }
      controller.abort();
      ctrl.error(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  const impl = (async () => new Response(stream, { status: 200 })) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    translateWithOpenAi({
      source: 'x',
      headingContext: '',
      config,
      signal: controller.signal,
      fetchImpl: impl,
    }),
    (error: unknown) =>
      (error as Error).name === 'AbortError' && !(error instanceof ProviderUnavailableError),
  );
});
