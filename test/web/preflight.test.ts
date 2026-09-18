import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REQUIRED_ASSETS,
  judgePreflight,
  probeAssets,
  probeExtractor,
  probeCloud,
  probeOllama,
  preflight,
  formatProblems,
  type ExtractorFacts,
  type PreflightContext,
  type PreflightFacts,
} from '../../web/server/preflight';

function context(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return {
    image: 'pdf-ja-extractor:1',
    python: '',
    endpoint: 'http://127.0.0.1:11434',
    model: 'qwen3.5:9b-q4_K_M',
    kind: 'ollama',
    target: '127.0.0.1:11434',
    ...overrides,
  };
}

function facts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    missingAssets: [],
    extractor: { kind: 'docker', daemon: true, image: true } as ExtractorFacts,
    ollama: { reachable: true, models: ['qwen3.5:9b-q4_K_M'] },
    ...overrides,
  };
}

function cloudContext(overrides: Partial<PreflightContext> = {}): PreflightContext {
  return { ...context(), kind: 'openai', target: 'api.openai.com', ...overrides };
}

function cloudFacts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    ...facts(),
    cloud: { allowed: true, hasKey: true, model: 'gpt-test', reachable: true },
    ...overrides,
  };
}

// ---- 判定 -----------------------------------------------------------------

test('すべて揃っていれば何も言わない', () => {
  assert.deepEqual(judgePreflight(facts(), context()), []);
});

test('配信資産が欠けていれば致命として build:web を出す', () => {
  const problems = judgePreflight(facts({ missingAssets: ['index.html', 'app.js'] }), context());
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.remedy ?? '', /npm run build:web/);
  assert.match(problems[0]?.title ?? '', /index\.html/);
});

test('Docker が動いていなければ致命として Docker Desktop を出す', () => {
  const problems = judgePreflight(
    facts({ extractor: { kind: 'docker', daemon: false, image: false } }),
    context(),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.title ?? '', /Docker/);
  assert.match(problems[0]?.remedy ?? '', /Docker Desktop/);
});

test('Docker は動いているがイメージが無ければ setup-pdf.ps1 を出す', () => {
  const problems = judgePreflight(
    facts({ extractor: { kind: 'docker', daemon: true, image: false } }),
    context(),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.title ?? '', /pdf-ja-extractor:1/);
  assert.match(problems[0]?.remedy ?? '', /setup-pdf\.ps1/);
});

test('ローカル Python の抽出器が動かなければ PDF_JA_PYTHON を指す', () => {
  const problems = judgePreflight(
    facts({ extractor: { kind: 'python', ok: false } }),
    context({ python: 'C:/py/python.exe' }),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.title ?? '', /C:\/py\/python\.exe/);
  assert.match(problems[0]?.remedy ?? '', /PDF_JA_PYTHON/);
});

test('Ollama に繋がらないのは警告に留める', () => {
  const problems = judgePreflight(
    facts({ ollama: { reachable: false, models: [] } }),
    context(),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'warning');
  assert.match(problems[0]?.title ?? '', /Ollama/);
  assert.match(problems[0]?.remedy ?? '', /127\.0\.0\.1:11434/);
});

test('Ollama に繋がらないときはモデルの話を重ねない', () => {
  const problems = judgePreflight(facts({ ollama: { reachable: false, models: [] } }), context());
  assert.equal(problems.filter((problem) => /pull/.test(problem.remedy)).length, 0);
});

test('モデルが無ければ警告として ollama pull を出す', () => {
  const problems = judgePreflight(
    facts({ ollama: { reachable: true, models: ['llama3:8b'] } }),
    context(),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'warning');
  assert.match(problems[0]?.remedy ?? '', /ollama pull qwen3\.5:9b-q4_K_M/);
});

test('タグの無いモデル名は :latest と同じものとみなす', () => {
  const problems = judgePreflight(
    facts({ ollama: { reachable: true, models: ['gemma3:latest'] } }),
    context({ model: 'gemma3' }),
  );
  assert.deepEqual(problems, []);
});

test('致命と警告は致命が先に並ぶ', () => {
  const problems = judgePreflight(
    facts({
      missingAssets: ['app.js'],
      ollama: { reachable: false, models: [] },
    }),
    context(),
  );
  assert.deepEqual(
    problems.map((problem) => problem.level),
    ['fatal', 'warning'],
  );
});

test('クラウドで許可が無ければ致命', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: false, hasKey: true, model: 'gpt-test', reachable: true } }),
    cloudContext(),
  );
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.remedy ?? '', /PDF_JA_CLOUD_ALLOWED/);
});

test('クラウドで鍵が無ければ致命', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: true, hasKey: false, model: 'gpt-test', reachable: true } }),
    cloudContext(),
  );
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.remedy ?? '', /--set-key/);
});

test('クラウドでモデル名が無ければ致命', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: true, hasKey: true, model: '', reachable: true } }),
    cloudContext(),
  );
  assert.equal(problems[0]?.level, 'fatal');
  assert.match(problems[0]?.remedy ?? '', /PDF_JA_MODEL/);
});

test('クラウドへ届かないのは警告に留める', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: true, hasKey: true, model: 'gpt-test', reachable: false } }),
    cloudContext(),
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.level, 'warning');
  assert.match(problems[0]?.title ?? '', /api\.openai\.com/);
});

test('クラウドでは Ollama の確認をしない', () => {
  const problems = judgePreflight(
    cloudFacts({ ollama: { reachable: false, models: [] } }),
    cloudContext(),
  );
  assert.deepEqual(problems, []);
});

test('ローカルではクラウドの確認をしない', () => {
  const problems = judgePreflight(
    facts({ cloud: { allowed: false, hasKey: false, model: '', reachable: false } }),
    context(),
  );
  assert.deepEqual(problems, []);
});

test('クラウドの問題に API キーを含めない', () => {
  const problems = judgePreflight(
    cloudFacts({ cloud: { allowed: false, hasKey: true, model: 'gpt-test', reachable: true } }),
    cloudContext(),
  );
  for (const problem of problems) {
    assert.equal(problem.title.includes('sk-'), false);
    assert.equal(problem.remedy.includes('sk-'), false);
  }
});

// ---- 探査 -----------------------------------------------------------------

test('配信資産の欠けを実ディレクトリから数える', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preflight-'));
  try {
    assert.deepEqual(await probeAssets(dir), [...REQUIRED_ASSETS]);

    for (const asset of REQUIRED_ASSETS) {
      await mkdir(join(dir, asset, '..'), { recursive: true });
      await writeFile(join(dir, asset), 'x');
    }
    assert.deepEqual(await probeAssets(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配信元そのものが無ければ全部欠けている', async () => {
  assert.deepEqual(await probeAssets(join(tmpdir(), 'preflight-absent-dir')), [...REQUIRED_ASSETS]);
});

test('Ollama の /api/tags からモデル名を読む', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models: [{ name: 'a:1' }, { name: 'b:2' }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    const result = await probeOllama(`http://127.0.0.1:${port}`, 2000);
    assert.equal(result.reachable, true);
    assert.deepEqual(result.models, ['a:1', 'b:2']);
  } finally {
    server.close();
  }
});

test('Ollama が居なければ reachable false を返す（例外にしない）', async () => {
  const result = await probeOllama('http://127.0.0.1:1', 1000);
  assert.equal(result.reachable, false);
  assert.deepEqual(result.models, []);
});

test('クラウドの /models は本文を読まず応答コードだけを見る', async () => {
  let authorization = '';
  const server = createServer((request, response) => {
    authorization = request.headers.authorization ?? '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"secret":"account-data"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  try {
    assert.equal(await probeCloud(`http://127.0.0.1:${port}`, 'sk-test', 2000), true);
    assert.equal(authorization, 'Bearer sk-test');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Docker の探査は daemon とイメージを別々に見る', async () => {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]): Promise<void> => {
    calls.push([command, ...args]);
    if (args[0] === 'image') throw new Error('no such image');
  };
  const facts = await probeExtractor({ kind: 'docker', image: 'x:1' }, run);
  assert.deepEqual(facts, { kind: 'docker', daemon: true, image: false });
  assert.deepEqual(calls, [
    ['docker', 'version', '--format', '{{.Server.Version}}'],
    ['docker', 'image', 'inspect', 'x:1'],
  ]);
});

test('daemon が落ちていればイメージは確かめない', async () => {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]): Promise<void> => {
    calls.push([command, ...args]);
    throw new Error('cannot connect');
  };
  const facts = await probeExtractor({ kind: 'docker', image: 'x:1' }, run);
  assert.deepEqual(facts, { kind: 'docker', daemon: false, image: false });
  assert.equal(calls.length, 1);
});

test('Python の探査はその実行ファイルを叩く', async () => {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]): Promise<void> => {
    calls.push([command, ...args]);
  };
  const facts = await probeExtractor({ kind: 'python', python: 'C:/py/python.exe' }, run);
  assert.deepEqual(facts, { kind: 'python', ok: true });
  assert.deepEqual(calls, [['C:/py/python.exe', '--version']]);
});

// ---- 組み立てと表示 -------------------------------------------------------

test('設定から探査先を決める（Docker）', async () => {
  const targets: unknown[] = [];
  const problems = await preflight(
    {
      staticRoot: 'C:/x/dist-web',
      image: 'y:2',
      python: '',
      model: 'm',
      endpoint: 'http://127.0.0.1:1',
      kind: 'ollama',
      target: '127.0.0.1:1',
      cloudAllowed: false,
      apiKey: '',
    },
    {
      assets: async () => [],
      extractor: async (target) => {
        targets.push(target);
        return { kind: 'docker', daemon: true, image: true };
      },
      ollama: async () => ({ reachable: true, models: ['m'] }),
      cloud: async () => false,
    },
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(targets, [{ kind: 'docker', image: 'y:2' }]);
});

test('PDF_JA_PYTHON があれば Python を探査する', async () => {
  const targets: unknown[] = [];
  await preflight(
    {
      staticRoot: 'C:/x/dist-web',
      image: 'y:2',
      python: 'C:/py/python.exe',
      model: 'm',
      endpoint: 'http://127.0.0.1:1',
      kind: 'ollama',
      target: '127.0.0.1:1',
      cloudAllowed: false,
      apiKey: '',
    },
    {
      assets: async () => [],
      extractor: async (target) => {
        targets.push(target);
        return { kind: 'python', ok: true };
      },
      ollama: async () => ({ reachable: true, models: ['m'] }),
      cloud: async () => false,
    },
  );
  assert.deepEqual(targets, [{ kind: 'python', python: 'C:/py/python.exe' }]);
});

test('Ollama モードではクラウドを探査しない', async () => {
  let cloudCalls = 0;
  await preflight(
    {
      staticRoot: 'C:/x/dist-web',
      image: 'y:2',
      python: '',
      model: 'm',
      endpoint: 'http://127.0.0.1:1',
      kind: 'ollama',
      target: '127.0.0.1:1',
      cloudAllowed: true,
      apiKey: 'sk-test',
    },
    {
      assets: async () => [],
      extractor: async () => ({ kind: 'docker', daemon: true, image: true }),
      ollama: async () => ({ reachable: true, models: ['m'] }),
      cloud: async () => {
        cloudCalls += 1;
        return true;
      },
    },
  );
  assert.equal(cloudCalls, 0);
});

test('クラウドモードでは Ollama を探査しない', async () => {
  let ollamaCalls = 0;
  const problems = await preflight(
    {
      staticRoot: 'C:/x/dist-web',
      image: 'y:2',
      python: '',
      model: 'gpt-test',
      endpoint: 'https://api.openai.com/v1',
      kind: 'openai',
      target: 'api.openai.com',
      cloudAllowed: true,
      apiKey: 'sk-test',
    },
    {
      assets: async () => [],
      extractor: async () => ({ kind: 'docker', daemon: true, image: true }),
      ollama: async () => {
        ollamaCalls += 1;
        return { reachable: true, models: [] };
      },
      cloud: async () => true,
    },
  );
  assert.deepEqual(problems, []);
  assert.equal(ollamaCalls, 0);
});

for (const missing of [
  {
    name: '許可',
    settings: { cloudAllowed: false, apiKey: 'sk-test', model: 'gpt-test' },
    remedy: /PDF_JA_CLOUD_ALLOWED/,
  },
  {
    name: '鍵',
    settings: { cloudAllowed: true, apiKey: '', model: 'gpt-test' },
    remedy: /--set-key/,
  },
  {
    name: 'モデル名',
    settings: { cloudAllowed: true, apiKey: 'sk-test', model: '   ' },
    remedy: /PDF_JA_MODEL/,
  },
] as const) {
  test(`クラウドの${missing.name}が無ければ通信しない`, async () => {
    let cloudCalls = 0;
    let ollamaCalls = 0;
    const problems = await preflight(
      {
        staticRoot: 'C:/x/dist-web',
        image: 'y:2',
        python: '',
        endpoint: 'https://api.openai.com/v1',
        kind: 'openai',
        target: 'api.openai.com',
        ...missing.settings,
      },
      {
        assets: async () => [],
        extractor: async () => ({ kind: 'docker', daemon: true, image: true }),
        ollama: async () => {
          ollamaCalls += 1;
          return { reachable: true, models: [] };
        },
        cloud: async () => {
          cloudCalls += 1;
          return true;
        },
      },
    );
    assert.equal(problems[0]?.level, 'fatal');
    assert.match(problems[0]?.remedy ?? '', missing.remedy);
    assert.equal(cloudCalls, 0);
    assert.equal(ollamaCalls, 0);
  });
}

test('問題は症状と直し方の 2 行で出す', () => {
  const lines = formatProblems([
    { level: 'fatal', title: 'これが無い', remedy: 'これを打つ' },
    { level: 'warning', title: 'これが怪しい', remedy: 'これを見る' },
  ]);
  assert.deepEqual(lines, [
    '失敗: これが無い',
    '      → これを打つ',
    '注意: これが怪しい',
    '      → これを見る',
  ]);
});

test('問題が無ければ何も出さない', () => {
  assert.deepEqual(formatProblems([]), []);
});
