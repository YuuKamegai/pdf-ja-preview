import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderConfig } from '../../src/translate/provider';
import { Scheduler } from '../../web/server/scheduler';
import {
  PRIORITY_CURRENT,
  PRIORITY_NEXT,
  PRIORITY_REST_BASE,
  Session,
  type ProviderConnection,
  type TranslateFn,
} from '../../web/server/session';
import {
  createTemporaryStorage,
  translationCacheKey,
  translationKey,
  type Storage,
} from '../../web/server/storage';
import { PDF_PROMPT_VERSION, PDF_VERIFIER_VERSION, TranslationError } from '../../web/server/translation';
import type { PdfBlock, PdfDocument, TranslationState } from '../../web/shared/document';
import type { ServerEvent } from '../../web/shared/protocol';

/** 条件が成り立つまでマイクロタスク・イベントループを回す。 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`条件が成立しませんでした: ${label}`);
}

const HASH = 'a'.repeat(64);

test('保存待ち中のモデル変更で旧訳を新しい世代へ公開しない', async (t) => {
  const {session, storage, scheduler, events} = await setup(t, [block('a',0,1)],
    async (_block, config) => config.model === 'm1' ? 'OLD' : 'NEW');
  const write = storage.writeJson.bind(storage);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  storage.writeJson = async (key, value) => { entered(); await gate; await write(key, value); };
  session.start();
  await started;
  session.setModel('m2');
  const generation = session.generation;
  release();
  await scheduler.idle();
  assert.equal(events.some(e => e.type === 'block' && e.generation === generation && e.value.ja === 'OLD'), false);
});

const connection = { kind: 'ollama' as const, endpoint: 'http://127.0.0.1:11434', think: false, temperature: 0.2, timeoutMs: 1000 };

function block(id: string, order: number, page: number, overrides: Partial<PdfBlock> = {}): PdfBlock {
  return {
    id,
    kind: 'paragraph',
    order,
    source: `Source of ${id}.`,
    headingContext: 'Methods',
    translatable: true,
    regions: [{ page, box: [0.1, 0.1, 0.9, 0.2] }],
    relatedIds: [],
    ...overrides,
  };
}

function document(blocks: PdfBlock[], pages = 3): PdfDocument {
  return {
    schema: 'pdf-document.v1',
    hash: HASH,
    extractor: { version: 'test', configHash: 'b'.repeat(64) },
    pages: Array.from({ length: pages }, (_, index) => ({
      number: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      status: 'ok' as const,
    })),
    blocks,
    warnings: [],
  };
}

async function setup(
  t: { after: (fn: () => unknown) => void },
  blocks: PdfBlock[],
  translate: TranslateFn,
  model = 'm1',
  provider?: ProviderConfig | ProviderConnection,
) {
  const storage: Storage = await createTemporaryStorage();
  const scheduler = new Scheduler();
  const events: ServerEvent[] = [];
  const session = new Session({
    sessionId: 's1',
    documentId: 'd1',
    documentHash: HASH,
    document: document(blocks),
    model,
    storage,
    scheduler,
    connection: provider ?? connection,
    translate,
  });
  session.subscribe((event) => events.push(event));
  t.after(async () => {
    await session.close();
    scheduler.close();
    await storage.close();
  });
  return { storage, scheduler, session, events };
}

test('snapshot は送信先のホスト名を持つ', async (t) => {
  const { session } = await setup(t, [block('b0', 0, 1)], async () => 'ja', 'gpt-test', {
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    temperature: 0.2,
    timeoutMs: 1000,
  });
  const snapshot = session.snapshot();
  assert.equal(snapshot.target, 'api.openai.com');
  assert.equal(snapshot.cloud, true);
});

test('ローカルなら cloud は false', async (t) => {
  const { session } = await setup(t, [block('b0', 0, 1)], async () => 'ja', 'm1', {
    kind: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    think: false,
    temperature: 0.2,
    timeoutMs: 1000,
  });
  assert.equal(session.snapshot().cloud, false);
  assert.equal(session.snapshot().target, '127.0.0.1:11434');
});

test('snapshot に API キーが現れない', async (t) => {
  const { session } = await setup(t, [block('b0', 0, 1)], async () => 'ja', 'gpt-test', {
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-secret-value',
    model: 'gpt-test',
    temperature: 0.2,
    timeoutMs: 1000,
  });
  assert.equal(JSON.stringify(session.snapshot()).includes('sk-secret-value'), false);
});

function stateOf(session: Session, id: string): TranslationState {
  const found = session.snapshot().blocks.find((state) => state.id === id);
  assert.ok(found, `ブロック ${id} がありません`);
  return found;
}

const echo: TranslateFn = async (b) => `訳: ${b.source}`;

test('翻訳対象だけを積み、図やヘッダは原文のままにする', async (t) => {
  const order: string[] = [];
  const { session, scheduler } = await setup(
    t,
    [
      block('b0', 0, 1),
      block('b1', 1, 1, { translatable: false, kind: 'picture', source: '' }),
      block('b2', 2, 2),
    ],
    async (b) => {
      order.push(b.id);
      return `訳: ${b.source}`;
    },
  );

  session.start();
  await scheduler.idle();

  assert.deepEqual(order, ['b0', 'b2']);
  assert.equal(stateOf(session, 'b1').status, 'source');
  assert.equal(stateOf(session, 'b0').ja, '訳: Source of b0.');
});

test('現在ページ・次ページ・残りの順に訳す', async (t) => {
  const order: string[] = [];
  const started: Array<() => void> = [];
  const { session, scheduler } = await setup(
    t,
    [block('p3', 0, 3), block('p1', 1, 1), block('p2', 2, 2)],
    async (b) => {
      order.push(b.id);
      return 'ja';
    },
  );
  void started;

  session.start();
  await scheduler.idle();
  assert.deepEqual(order, ['p1', 'p2', 'p3']);
});

test('複数ページにまたがるブロックは最小の優先度で扱う', async (t) => {
  const order: string[] = [];
  const spanning = block('span', 5, 3, {
    regions: [
      { page: 3, box: [0.1, 0.1, 0.9, 0.2] },
      { page: 1, box: [0.1, 0.8, 0.9, 0.9] },
    ],
  });
  const { session, scheduler } = await setup(t, [block('later', 0, 3), spanning], async (b) => {
    order.push(b.id);
    return 'ja';
  });

  session.start();
  await scheduler.idle();
  assert.deepEqual(order, ['span', 'later'], '1 ページ目に出るものが先');
});

test('優先度の値は現在 0・次 1・残り 2+order', () => {
  assert.equal(PRIORITY_CURRENT, 0);
  assert.equal(PRIORITY_NEXT, 1);
  assert.equal(PRIORITY_REST_BASE, 2);
});

test('ページを移ると未実行の順番が変わる', async (t) => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const { session, scheduler } = await setup(
    t,
    [block('p1', 0, 1), block('p2', 1, 2), block('p3', 2, 3)],
    async (b) => {
      order.push(b.id);
      if (b.id === 'p1') await gate;
      return 'ja';
    },
  );

  session.start();
  await waitUntil(() => order.length === 1, 'p1 が走り始める');
  assert.deepEqual(order, ['p1']);

  session.setPage(3);
  release();
  await scheduler.idle();
  assert.deepEqual(order, ['p1', 'p3', 'p2']);
});

test('キャッシュがあれば LLM を呼ばない', async (t) => {
  let calls = 0;
  const counting: TranslateFn = async (b) => {
    calls += 1;
    return `訳: ${b.source}`;
  };
  const blocks = [block('b0', 0, 1)];
  const { session, scheduler, storage } = await setup(t, blocks, counting);

  session.start();
  await scheduler.idle();
  assert.equal(calls, 1);

  const cached = await storage.readJson(
    translationCacheKey(
      HASH,
      translationKey({
        source: blocks[0].source,
        headingContext: blocks[0].headingContext,
        model: 'm1',
        think: false,
        temperature: 0.2,
        promptVersion: PDF_PROMPT_VERSION,
        verifierVersion: PDF_VERIFIER_VERSION,
      }),
    ),
  );
  assert.deepEqual(cached, { ja: '訳: Source of b0.' });

  session.invalidate();
  await scheduler.idle();
  assert.equal(calls, 1, '二度目はキャッシュから返る');
  assert.equal(stateOf(session, 'b0').status, 'translated');
});

test('モデルを変えるとキャッシュ検索からやり直す', async (t) => {
  const models: string[] = [];
  const watching: TranslateFn = async (b, config) => {
    models.push(config.model);
    return `訳(${config.model}): ${b.source}`;
  };
  const { session, scheduler } = await setup(t, [block('b0', 0, 1)], watching);

  session.start();
  await scheduler.idle();
  const generation = session.generation;

  session.setModel('m2');
  await scheduler.idle();

  assert.deepEqual(models, ['m1', 'm2']);
  assert.ok(session.generation > generation, '世代が上がる');
  assert.equal(stateOf(session, 'b0').ja, '訳(m2): Source of b0.');
});

test('再試行はキャッシュを飛ばして必ず呼び直す', async (t) => {
  let calls = 0;
  const counting: TranslateFn = async (b) => {
    calls += 1;
    return `訳${calls}: ${b.source}`;
  };
  const { session, scheduler } = await setup(t, [block('b0', 0, 1)], counting);

  session.start();
  await scheduler.idle();
  assert.equal(calls, 1);

  assert.equal(session.retry('b0', true), true);
  await scheduler.idle();
  assert.equal(calls, 2);
  assert.equal(stateOf(session, 'b0').ja, '訳2: Source of b0.');
});

test('翻訳対象でないブロックは再試行できない', async (t) => {
  const { session } = await setup(
    t,
    [block('pic', 0, 1, { translatable: false, kind: 'picture', source: '' })],
    echo,
  );
  assert.equal(session.retry('pic', true), false);
  assert.equal(session.retry('missing', true), false);
});

test('失敗は原文へ戻し、理由を残してイベントを出す', async (t) => {
  const failing: TranslateFn = async () => {
    throw new TranslationError('number-missing', '数値が訳文から落ちています: 25');
  };
  const { session, scheduler, events } = await setup(t, [block('b0', 0, 1)], failing);

  session.start();
  await scheduler.idle();

  const state = stateOf(session, 'b0');
  assert.equal(state.status, 'error');
  assert.equal(state.ja, undefined, '訳は出さない。原文を見せる');
  assert.equal(state.error?.code, 'number-missing');
  assert.ok(events.some((event) => event.type === 'error' && event.code === 'number-missing'));
});

test('中断は失敗にせず待機へ戻す', async (t) => {
  const blocked: TranslateFn = (b, config, signal) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const { session, scheduler } = await setup(t, [block('b0', 0, 1)], blocked);

  session.start();
  await waitUntil(() => stateOf(session, 'b0').status === 'translating', '翻訳が始まる');

  scheduler.cancel('s1');
  await scheduler.idle();
  assert.equal(stateOf(session, 'b0').status, 'source');
});

test('一時停止すると次のジョブが進まない', async (t) => {
  const order: string[] = [];
  const { session, scheduler } = await setup(
    t,
    [block('b0', 0, 1), block('b1', 1, 1)],
    async (b) => {
      order.push(b.id);
      return 'ja';
    },
  );

  session.pause();
  session.start();
  await scheduler.idle();
  assert.deepEqual(order, []);
  assert.equal(session.snapshot().paused, true);

  session.resume();
  await scheduler.idle();
  assert.deepEqual(order, ['b0', 'b1']);
});

test('閉じたセッションへはイベントを出さない', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: TranslateFn = async (b) => {
    await gate;
    return 'ja';
  };
  const { session, scheduler, events } = await setup(t, [block('b0', 0, 1)], slow);

  session.start();
  await waitUntil(() => stateOf(session, 'b0').status === 'translating', '翻訳が始まる');
  const before = events.length;

  await session.close();
  release();
  await scheduler.idle();

  assert.equal(events.length, before, '閉じた後は増えない');
});

test('世代が変わった後に返ってきた訳はキャッシュにも表示にも入らない', async (t) => {
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  let call = 0;
  const slowFirst: TranslateFn = async (b, config) => {
    call += 1;
    if (call === 1) return gate;
    return `訳(${config.model})`;
  };

  const blocks = [block('b0', 0, 1)];
  const { session, scheduler, storage } = await setup(t, blocks, slowFirst);

  session.start();
  await waitUntil(() => call === 1, '1 回目の翻訳が始まる');

  session.setModel('m2');
  release('遅れて届いた古い訳');
  await scheduler.idle();

  assert.equal(stateOf(session, 'b0').ja, '訳(m2)');

  const staleKey = translationCacheKey(
    HASH,
    translationKey({
      source: blocks[0].source,
      headingContext: blocks[0].headingContext,
      model: 'm1',
      think: false,
      temperature: 0.2,
      promptVersion: PDF_PROMPT_VERSION,
      verifierVersion: PDF_VERIFIER_VERSION,
    }),
  );
  assert.equal(await storage.readJson(staleKey), undefined, '古い世代の結果は保存しない');
});

test('スナップショットに世代とページと休止が入る', async (t) => {
  const { session } = await setup(t, [block('b0', 0, 1)], echo);
  session.setPage(2);
  session.pause();
  const snapshot = session.snapshot();
  assert.equal(snapshot.sessionId, 's1');
  assert.equal(snapshot.documentId, 'd1');
  assert.equal(snapshot.page, 2);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.model, 'm1');
  assert.equal(snapshot.generation, 0);
  assert.equal(snapshot.blocks.length, 1);
});

test('block イベントには世代とセッションが付く', async (t) => {
  const { session, scheduler, events } = await setup(t, [block('b0', 0, 1)], echo);
  session.start();
  await scheduler.idle();

  const blockEvents = events.filter((event) => event.type === 'block');
  assert.ok(blockEvents.length > 0);
  for (const event of blockEvents) {
    assert.equal(event.type === 'block' && event.sessionId, 's1');
    assert.equal(event.type === 'block' && event.generation, 0);
  }
});

test('二つのタブでも翻訳は一度に一つ', async (t) => {
  const storage = await createTemporaryStorage();
  const scheduler = new Scheduler();
  let active = 0;
  let peak = 0;
  const watched: TranslateFn = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return 'ja';
  };

  const sessions = ['tabA', 'tabB'].map(
    (id) =>
      new Session({
        sessionId: id,
        documentId: 'd1',
        documentHash: HASH,
        document: document([block('b0', 0, 1), block('b1', 1, 1)]),
        model: 'm1',
        storage,
        scheduler,
        connection,
        translate: watched,
      }),
  );
  for (const session of sessions) session.start();
  await scheduler.idle();

  assert.equal(peak, 1);
  for (const session of sessions) await session.close();
  scheduler.close();
  await storage.close();
});
