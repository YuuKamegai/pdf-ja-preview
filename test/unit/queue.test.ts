import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SequentialQueue } from '../../src/translate/queue';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('投入順に、重ならずに実行される', async () => {
  const queue = new SequentialQueue();
  const log: string[] = [];

  const job = (name: string) => async () => {
    log.push(`${name}:start`);
    await tick();
    log.push(`${name}:end`);
    return name;
  };

  const results = await Promise.all([
    queue.enqueue(job('a')),
    queue.enqueue(job('b')),
    queue.enqueue(job('c')),
  ]);

  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, [
    'a:start', 'a:end',
    'b:start', 'b:end',
    'c:start', 'c:end',
  ]);
});

test('前のジョブが失敗しても後続は実行される', async () => {
  const queue = new SequentialQueue();
  const failing = queue.enqueue(async () => {
    throw new Error('boom');
  });
  const following = queue.enqueue(async () => 'ok');

  await assert.rejects(failing, /boom/);
  assert.equal(await following, 'ok');
});

test('cancelAll で未実行のジョブは実行されず reject する', async () => {
  const queue = new SequentialQueue();
  let secondRan = false;

  const first = queue.enqueue(async () => {
    await tick();
    return 'first';
  });
  const second = queue.enqueue(async () => {
    secondRan = true;
    return 'second';
  });

  queue.cancelAll();

  await assert.rejects(second, (error: unknown) => (error as Error).name === 'AbortError');
  await first.catch(() => undefined);
  assert.equal(secondRan, false);
});

test('cancelAll は実行中ジョブへ渡した signal を abort する', async () => {
  const queue = new SequentialQueue();
  let aborted = false;

  const running = queue.enqueue(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve('stopped');
        });
      }),
  );

  await tick();
  queue.cancelAll();

  assert.equal(await running, 'stopped');
  assert.equal(aborted, true);
});

test('cancelAll の後に投入したジョブは通常どおり実行される', async () => {
  const queue = new SequentialQueue();
  queue.cancelAll();
  assert.equal(await queue.enqueue(async () => 'fresh'), 'fresh');
});
