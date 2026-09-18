import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeTarget } from '../../src/translate/provider';
import { formatProblems, judgePreflight, preflight } from '../../web/server/preflight';
import { readSettings } from '../../web/server/main';

const KEY = 'sk-canary-0123456789abcdef';

test('設定の丸ごとに鍵が現れない', () => {
  const settings = readSettings(
    {
      LOCALAPPDATA: 'C:/tmp/local',
      PDF_JA_PROVIDER: 'openai',
      PDF_JA_MODEL: 'gpt-test',
      PDF_JA_API_KEY: KEY,
      OPENAI_API_KEY: KEY,
    } as NodeJS.ProcessEnv,
    'C:/tmp/dist-web',
  );
  assert.equal(JSON.stringify(settings).includes(KEY), false);
});

test('送信先の表示に鍵が現れない', () => {
  const target = describeTarget({
    kind: 'openai',
    baseUrl: `https://api.openai.com/v1?key=${KEY}`,
    apiKey: KEY,
    model: 'gpt-test',
    temperature: 0.2,
    timeoutMs: 1000,
  });
  assert.equal(target.includes(KEY), false);
  assert.equal(target, 'api.openai.com');
});

test('preflight の問題文に鍵が現れない', () => {
  const problems = judgePreflight(
    {
      missingAssets: [],
      extractor: { kind: 'docker', daemon: true, image: true },
      ollama: { reachable: true, models: [] },
      cloud: { allowed: false, hasKey: true, model: 'gpt-test', reachable: false },
    },
    {
      image: 'x:1',
      python: '',
      endpoint: 'http://127.0.0.1:11434',
      model: 'gpt-test',
      kind: 'openai',
      target: 'api.openai.com',
    },
  );
  for (const problem of problems) {
    assert.equal(problem.title.includes(KEY), false);
    assert.equal(problem.remedy.includes(KEY), false);
  }
});

test('preflight の実経路と整形ログに apiKey を問題文へ混ぜる mutation を検出する', async () => {
  let probedApiKey = '';
  const problems = await preflight(
    {
      staticRoot: 'C:/tmp/dist-web',
      image: 'x:1',
      python: '',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-test',
      kind: 'openai',
      target: 'api.openai.com',
      cloudAllowed: true,
      apiKey: KEY,
    },
    {
      assets: async () => [],
      extractor: async () => ({ kind: 'docker', daemon: true, image: true }),
      ollama: async () => {
        throw new Error('openai 経路では Ollama を探査しない');
      },
      cloud: async (_baseUrl, apiKey) => {
        probedApiKey = apiKey;
        return false;
      },
    },
  );

  assert.equal(probedApiKey, KEY, 'canary が実際の cloud probe 経路を通る');
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'warning');
  assert.equal(JSON.stringify(problems).includes(KEY), false);

  const logLines = formatProblems(problems);
  assert.equal(logLines.length, 2);
  assert.equal(logLines.join('\n').includes(KEY), false);
});
