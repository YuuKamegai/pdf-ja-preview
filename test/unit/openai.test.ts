import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAiRequestBody, parseSseData, type OpenAiConfig } from '../../src/translate/openai';
import { SYSTEM_PROMPT } from '../../src/translate/ollama';

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
