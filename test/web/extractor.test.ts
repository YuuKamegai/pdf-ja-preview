import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  ExtractorError,
  buildDockerArgs,
  dockerExtractor,
  runExtractorProcess,
} from '../../web/server/extractor';

const WORKER = fileURLToPath(new URL('./helpers/fake-worker.mjs', import.meta.url));

function run(mode: string, extra: string[] = [], overrides: Partial<{ timeoutMs: number; signal: AbortSignal }> = {}) {
  return runExtractorProcess({
    command: process.execPath,
    args: [WORKER, '--mode', mode, ...extra],
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 20_000,
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '(resolved)';
  } catch (error) {
    assert.ok(error instanceof ExtractorError, `ExtractorError ではありません: ${error}`);
    return error.code;
  }
}

test('正しい出力は中間形式として返る', async () => {
  const document = await run('ok');
  assert.equal(document.schema, 'pdf-document.v1');
  assert.equal(document.blocks.length, 1);
});

test('stdout に混ざったログがあっても JSON が取れれば通す', async () => {
  const document = await run('noisy');
  assert.equal(document.blocks[0].source, 'Hello from the fake worker.');
});

test('ワーカーの失敗はその code のまま返る', async () => {
  assert.equal(await codeOf(run('error')), 'encrypted-pdf');
});

test('失敗のとき stderr の末尾を添える', async () => {
  try {
    await run('error');
    assert.fail('失敗するはず');
  } catch (error) {
    assert.ok(error instanceof ExtractorError);
    assert.match(error.detail, /worker log line/);
  }
});

test('JSON でない出力は invalid-output', async () => {
  assert.equal(await codeOf(run('broken')), 'invalid-output');
});

test('何も返さないワーカーは worker-failed', async () => {
  assert.equal(await codeOf(run('silent')), 'worker-failed');
});

test('契約に反する文書は invalid-document', async () => {
  assert.equal(await codeOf(run('invalid')), 'invalid-document');
});

test('起動できないコマンドは spawn-failed', async () => {
  const code = await codeOf(
    runExtractorProcess({
      command: 'definitely-not-a-real-command-xyz',
      args: [],
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    }),
  );
  assert.equal(code, 'spawn-failed');
});

test('上限を超える出力は殺して output-too-large', async () => {
  assert.equal(await codeOf(run('huge')), 'output-too-large');
});

test('タイムアウトで打ち切る', async () => {
  assert.equal(await codeOf(run('spin', [], { timeoutMs: 300 })), 'timeout');
});

test('取り消しで止める', async () => {
  const controller = new AbortController();
  const promise = run('spin', [], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal(await codeOf(promise), 'cancelled');
});

test('最初から中断されていれば起動しない', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await codeOf(run('ok', [], { signal: controller.signal })), 'cancelled');
});

test('遅いワーカーでも期限内なら成功する', async () => {
  const document = await run('slow', ['--delay', '150'], { timeoutMs: 10_000 });
  assert.equal(document.blocks.length, 1);
});

test('既定のタイムアウトは 10 分', () => {
  assert.equal(DEFAULT_EXTRACTION_TIMEOUT_MS, 600_000);
});

test('docker 版はネットワークを切り、PDF を読み取り専用で渡す', () => {
  const args = buildDockerArgs(
    { image: 'pdf-ja-extractor:1' },
    { file: join('C:', 'tmp', 'space dir', 'abc.pdf'), hash: 'f'.repeat(64), containerName: 'c1' },
  );

  assert.deepEqual(args.slice(0, 6), ['run', '--rm', '--name', 'c1', '--network', 'none']);
  const mount = args[args.indexOf('-v') + 1];
  assert.ok(mount.endsWith(':/in:ro'), mount);
  assert.ok(mount.includes('space dir'), 'マウント元は引数として渡す。shell を通さない');
  assert.deepEqual(args.slice(-6), [
    '--input',
    '/in/abc.pdf',
    '--hash',
    'f'.repeat(64),
    '--models',
    '/models',
  ]);
});

test('docker 版はファイル名だけをコンテナへ渡す（ホストのパスを漏らさない）', () => {
  const args = buildDockerArgs(
    { image: 'img' },
    { file: join('C:', 'Users', 'someone', 'x.pdf'), hash: 'a'.repeat(64), containerName: 'c2' },
  );
  assert.equal(args[args.indexOf('--input') + 1], '/in/x.pdf');
});

test('docker 版の説明にイメージ名が出る', () => {
  assert.equal(dockerExtractor({ image: 'pdf-ja-extractor:1' }).description, 'docker:pdf-ja-extractor:1');
});
