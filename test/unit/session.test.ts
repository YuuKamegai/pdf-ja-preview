import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationSession, type SessionDeps, type SessionEvent } from '../../src/session';
import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from '../../src/translate/ollama';

interface Harness {
  session: TranslationSession;
  events: SessionEvent[];
  calls: string[];
  cache: Map<string, string>;
}

function harness(
  translate: (source: string) => Promise<string>,
  overrides: Partial<SessionDeps> = {},
): Harness {
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const cache = new Map<string, string>();

  const deps: SessionDeps = {
    model: 'test-model',
    maxBlockChars: 1500,
    translate: async (source) => {
      calls.push(source);
      return translate(source);
    },
    enqueue: (job) => job(new AbortController().signal),
    cacheGet: (model, source) => cache.get(`${model}\n${source}`),
    cacheSet: (model, source, ja) => void cache.set(`${model}\n${source}`, ja),
    emit: (event) => void events.push(event),
    ...overrides,
  };

  return { session: new TranslationSession(deps), events, calls, cache };
}

const blockEvents = (events: SessionEvent[]) =>
  events.filter((e): e is Extract<SessionEvent, { kind: 'block' }> => e.kind === 'block');

const initEvent = (events: SessionEvent[]) =>
  events.find((e): e is Extract<SessionEvent, { kind: 'init' }> => e.kind === 'init');

test('init で全ブロックを原文のまま先に出す', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('# Title\n\nAlpha.\n');

  const init = initEvent(h.events);
  assert.ok(init, 'init イベントが出ること');
  assert.deepEqual(
    init.blocks.map((b) => [b.markdown, b.state]),
    [
      ['# Title', 'source'],
      ['Alpha.', 'source'],
    ],
  );
});

test('バナーの消去は init より前に出る', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('Alpha.\n');

  const kinds = h.events.map((e) => e.kind);
  assert.ok(
    kinds.indexOf('banner') < kinds.indexOf('init'),
    '古いバナーを消してから本文を並べ替えること',
  );
});

test('先頭から順に翻訳し、訳せたブロックを translated で流す', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('# Title\n\nAlpha.\n');

  assert.deepEqual(h.calls, ['# Title', 'Alpha.']);
  assert.deepEqual(
    blockEvents(h.events).map((e) => [e.index, e.markdown, e.state]),
    [
      [0, '# Title', 'translating'],
      [0, 'JA:# Title', 'translated'],
      [1, 'Alpha.', 'translating'],
      [1, 'JA:Alpha.', 'translated'],
    ],
  );
});

test('コードフェンス・水平線・生 HTML は翻訳せず確定させる', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('```js\nx\n```\n\n---\n\n<div>raw</div>\n');

  assert.deepEqual(h.calls, []);
  assert.deepEqual(
    blockEvents(h.events).map((e) => [e.index, e.state]),
    [
      [0, 'translated'],
      [1, 'translated'],
      [2, 'translated'],
    ],
  );
});

test('キャッシュに当たったブロックは LLM を呼ばない', async () => {
  const h = harness(async (s) => `JA:${s}`);
  h.cache.set('test-model\nAlpha.', 'キャッシュ訳');
  await h.session.open('Alpha.\n\nBravo.\n');

  assert.deepEqual(h.calls, ['Bravo.']);
  const translated = blockEvents(h.events).filter((e) => e.state === 'translated');
  assert.equal(translated[0].markdown, 'キャッシュ訳');
});

test('訳した結果はキャッシュへ書かれる', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('Alpha.\n');
  assert.equal(h.cache.get('test-model\nAlpha.'), 'JA:Alpha.');
});

test('直前の見出しを文脈として渡す', async () => {
  const contexts: string[] = [];
  const h = harness(async (s) => `JA:${s}`, {
    translate: async (source, headingContext) => {
      contexts.push(headingContext);
      return `JA:${source}`;
    },
  });
  await h.session.open('# Chapter One\n\nAlpha.\n\nBravo.\n');

  assert.deepEqual(contexts, ['', 'Chapter One', 'Chapter One']);
});

test('構造検証に落ちたブロックは error になりキャッシュされない', async () => {
  const h = harness(async () => 'コードを訳してしまった');
  await h.session.open('Run `npm test`.\n');

  const last = blockEvents(h.events).at(-1);
  assert.equal(last?.state, 'error');
  assert.equal(last?.markdown, 'Run `npm test`.', '原文を表示し続けること');
  assert.equal(h.cache.size, 0);
});

test('1 ブロックの失敗は後続の翻訳を止めない', async () => {
  const h = harness(async (s) => {
    if (s === 'Alpha.') throw new Error('一時的な失敗');
    return `JA:${s}`;
  });
  await h.session.open('Alpha.\n\nBravo.\n');

  assert.deepEqual(h.calls, ['Alpha.', 'Bravo.']);
  const states = blockEvents(h.events).filter((e) => e.state !== 'translating');
  assert.deepEqual(states.map((e) => [e.index, e.state]), [
    [0, 'error'],
    [1, 'translated'],
  ]);
});

test('Ollama 未起動ならバナーを出し、原文表示のまま打ち切る', async () => {
  const h = harness(async () => {
    throw new OllamaUnavailableError('接続できません');
  });
  await h.session.open('Alpha.\n\nBravo.\n');

  // open() が最初に空のバナーを出すので、最後のバナーを見る。
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('Ollama'));
  assert.deepEqual(h.calls, ['Alpha.'], '2 つ目は呼ばない');
  assert.equal(blockEvents(h.events).at(-1)?.state, 'source');
});

test('モデル未導入なら pull コマンドを添えたバナーを出す', async () => {
  const h = harness(async () => {
    throw new OllamaModelMissingError('test-model');
  });
  await h.session.open('Alpha.\n');

  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('ollama pull test-model'));
});

test('retry は指定ブロックだけを訳し直す', async () => {
  let attempt = 0;
  const h = harness(async (s) => {
    attempt++;
    return attempt === 1 ? '`壊れた`訳' : `JA:${s}`;
  });
  await h.session.open('Plain.\n');
  assert.equal(blockEvents(h.events).at(-1)?.state, 'error');

  await h.session.retry(0);
  assert.equal(blockEvents(h.events).at(-1)?.state, 'translated');
  assert.equal(blockEvents(h.events).at(-1)?.markdown, 'JA:Plain.');
});

test('open のたびにバナーを消す', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('Alpha.\n');
  assert.equal(h.events.some((e) => e.kind === 'banner' && e.text === ''), true);
});
