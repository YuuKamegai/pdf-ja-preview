import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Scheduler } from '../../web/server/scheduler';

/** 手で完了させられるジョブ。 */
function controllable(started: string[], id: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = async (): Promise<void> => {
    started.push(id);
    await gate;
  };
  return { run, release };
}

/** マイクロタスクを流す。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('実行中にページを移ると、未実行の順番だけ入れ替わる', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  const a = controllable(started, 'A');

  scheduler.enqueue('s', 'A', 0, a.run);
  scheduler.enqueue('s', 'B', 1, async () => {
    started.push('B');
  });
  scheduler.enqueue('s', 'C', 2, async () => {
    started.push('C');
  });
  await settle();

  assert.deepEqual(started, ['A']);
  scheduler.reprioritize('s', new Map([['C', 0], ['B', 2]]));
  a.release();
  await scheduler.idle();
  assert.deepEqual(started, ['A', 'C', 'B']);
});

test('同じ優先度は入れた順に実行する', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  for (const id of ['A', 'B', 'C']) {
    scheduler.enqueue('s', id, 5, async () => {
      started.push(id);
    });
  }
  await scheduler.idle();
  assert.deepEqual(started, ['A', 'B', 'C']);
});

test('実行中のジョブはページ移動で中断しない', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  let aborted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  scheduler.enqueue('s', 'A', 0, async (signal) => {
    started.push('A');
    signal.addEventListener('abort', () => {
      aborted = true;
    });
    await gate;
  });
  await settle();

  scheduler.reprioritize('s', new Map([['A', 9]]));
  assert.equal(aborted, false);
  release();
  await scheduler.idle();
  assert.equal(aborted, false);
});

test('並列度は 1。二つのセッションでも同時に走らない', async () => {
  const scheduler = new Scheduler();
  let active = 0;
  let peak = 0;
  const work = async (): Promise<void> => {
    active += 1;
    peak = Math.max(peak, active);
    await settle();
    active -= 1;
  };

  for (const session of ['tab1', 'tab2']) {
    for (const id of ['A', 'B', 'C']) scheduler.enqueue(session, id, 0, work);
  }
  await scheduler.idle();
  assert.equal(peak, 1);
});

test('pause はそのセッションの次のジョブだけ止める', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];

  scheduler.pause('paused');
  scheduler.enqueue('paused', 'A', 0, async () => {
    started.push('paused:A');
  });
  scheduler.enqueue('other', 'B', 1, async () => {
    started.push('other:B');
  });

  await scheduler.idle();
  assert.deepEqual(started, ['other:B'], '休止中のセッションは進まない');

  scheduler.resume('paused');
  await scheduler.idle();
  assert.deepEqual(started, ['other:B', 'paused:A']);
});

test('休止中は実行中のジョブを止めない', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  const a = controllable(started, 'A');
  scheduler.enqueue('s', 'A', 0, a.run);
  await settle();

  scheduler.pause('s');
  assert.equal(scheduler.runningBlockId, 'A');
  a.release();
  await scheduler.idle();
  assert.deepEqual(started, ['A']);
});

test('cancel は待機ジョブを捨て、実行中を中断する', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  let aborted = false;

  scheduler.enqueue('s', 'A', 0, async (signal) => {
    started.push('A');
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve();
      });
    });
  });
  scheduler.enqueue('s', 'B', 1, async () => {
    started.push('B');
  });
  scheduler.enqueue('keep', 'C', 1, async () => {
    started.push('C');
  });
  await settle();

  scheduler.cancel('s');
  await scheduler.idle();

  assert.equal(aborted, true);
  assert.deepEqual(started, ['A', 'C'], '他のセッションは残る');
});

test('同じブロックを入れ直しても待機は増えない', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  const a = controllable(started, 'A');
  scheduler.enqueue('s', 'A', 0, a.run);
  await settle();

  scheduler.enqueue('s', 'B', 1, async () => {
    started.push('B1');
  });
  scheduler.enqueue('s', 'B', 1, async () => {
    started.push('B2');
  });
  assert.equal(scheduler.queueLength, 1);

  a.release();
  await scheduler.idle();
  assert.deepEqual(started, ['A', 'B2'], '後から入れたものが勝つ');
});

test('失敗したジョブの次も実行する', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  scheduler.enqueue('s', 'A', 0, async () => {
    started.push('A');
    throw new Error('boom');
  });
  scheduler.enqueue('s', 'B', 1, async () => {
    started.push('B');
  });
  await scheduler.idle();
  assert.deepEqual(started, ['A', 'B']);
});

test('休止中のジョブだけ残っていても idle は返る', async () => {
  const scheduler = new Scheduler();
  scheduler.pause('s');
  scheduler.enqueue('s', 'A', 0, async () => undefined);
  await scheduler.idle();
  assert.equal(scheduler.queueLength, 1);
});

test('close で待機を捨て、実行中を中断する', async () => {
  const scheduler = new Scheduler();
  const started: string[] = [];
  scheduler.enqueue('s', 'A', 0, async (signal) => {
    started.push('A');
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
  });
  scheduler.enqueue('s', 'B', 1, async () => {
    started.push('B');
  });
  await settle();

  scheduler.close();
  assert.deepEqual(started, ['A']);
  scheduler.enqueue('s', 'C', 0, async () => {
    started.push('C');
  });
  await scheduler.idle();
  assert.deepEqual(started, ['A'], 'close 後は受け付けない');
});
