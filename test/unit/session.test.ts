import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationSession, type SessionDeps, type SessionEvent } from '../../src/session';
import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from '../../src/translate/ollama';
import {
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../../src/translate/errors';
import { SequentialQueue } from '../../src/translate/queue';

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
    throw new OllamaUnavailableError('Ollama へ接続できません: http://127.0.0.1:11434');
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

test('保存時に変わったブロックだけ翻訳し直す', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('# Title\n\nAlpha.\n\nBravo.\n');

  h.calls.length = 0;
  h.events.length = 0;
  await h.session.update('# Title\n\nAlpha edited.\n\nBravo.\n');

  assert.deepEqual(h.calls, ['Alpha edited.'], '変わった 1 ブロックだけ呼ぶ');
});

test('保存時の init は持ち越した訳を translated のまま出す', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('# Title\n\nAlpha.\n');

  h.events.length = 0;
  await h.session.update('# Title\n\nAlpha.\n\nBravo.\n');

  const init = initEvent(h.events);
  assert.ok(init, 'init イベントが出ること');
  assert.deepEqual(
    init.blocks.map((b) => [b.markdown, b.state]),
    [
      ['JA:# Title', 'translated'],
      ['JA:Alpha.', 'translated'],
      ['Bravo.', 'source'],
    ],
  );
});

test('保存で行が増えても持ち越した訳の行範囲が更新される', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('Alpha.\n');

  h.events.length = 0;
  await h.session.update('Intro.\n\nAlpha.\n');

  const init = initEvent(h.events);
  assert.ok(init, 'init イベントが出ること');
  assert.equal(init.blocks[1]?.markdown, 'JA:Alpha.');
  assert.equal(init.blocks[1]?.lineStart, 2);
});

test('保存後に旧翻訳が abort を無視して完了しても新しいブロックを上書きしない', async () => {
  const queue = new SequentialQueue();
  let resolveOld!: (value: string) => void;
  const oldTranslation = new Promise<string>((resolve) => { resolveOld = resolve; });
  const h = harness(async (source) =>
    source === 'Old first.' ? oldTranslation : `JA:${source}`,
    { enqueue: (job) => queue.enqueue(job) },
  );

  const opening = h.session.open('Old first.\n\nOld second.\n');
  await new Promise((resolve) => setImmediate(resolve));
  queue.cancelAll();
  const updating = h.session.update('New.\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls, ['Old first.'], '旧翻訳の収束前に新翻訳を重ねないこと');
  resolveOld('JA:Old.');
  await Promise.all([opening, updating]);

  const finalEvents = blockEvents(h.events).filter((event) => event.state === 'translated');
  assert.deepEqual(finalEvents.map((event) => event.markdown), ['JA:New.']);
  assert.deepEqual(h.calls, ['Old first.', 'New.'], '旧 run の次 index を新 blockList で処理しないこと');
  assert.equal(h.cache.has('test-model\nOld first.'), false, 'stale 訳を cache にも採用しないこと');
});

test('保存後に旧翻訳が abort を無視して失敗しても新しい表示へ error を出さない', async () => {
  let rejectOld!: (error: Error) => void;
  const oldTranslation = new Promise<string>((_resolve, reject) => { rejectOld = reject; });
  const h = harness(async (source) => source === 'Old.' ? oldTranslation : `JA:${source}`);

  const opening = h.session.open('Old.\n');
  await new Promise((resolve) => setImmediate(resolve));
  await h.session.update('New.\n');
  rejectOld(new Error('late failure'));
  await opening;

  const final = blockEvents(h.events).filter((event) => event.state !== 'translating');
  assert.deepEqual(final.map((event) => [event.markdown, event.state]), [['JA:New.', 'translated']]);
});

test('認証の失敗はバナーになる', async () => {
  const h = harness(async () => {
    throw new ProviderAuthError('api.openai.com が拒否');
  });
  await h.session.open('Alpha.\n');
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('API キー'));
});

test('流量制限はバナーになる', async () => {
  const h = harness(async () => {
    throw new ProviderRateLimitError('混雑');
  });
  await h.session.open('Alpha.\n');
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('混雑'));
});

test('設定の不備はバナーになる', async () => {
  const h = harness(async () => {
    throw new ProviderConfigError('原文を api.openai.com へ送る許可がありません。');
  });
  await h.session.open('Alpha.\n');
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('許可'));
});

test('認証エラーのバナーに例外メッセージを埋め込まない', async () => {
  const h = harness(async () => {
    throw new ProviderAuthError('sk-leak-0123456789 が拒否されました');
  });
  await h.session.open('Alpha.\n');
  for (const event of h.events) {
    if (event.kind === 'banner') assert.equal(event.text.includes('sk-leak-0123456789'), false);
  }
});

test('打ち切ったら 2 つ目のブロックは訳さない', async () => {
  const h = harness(async () => {
    throw new ProviderAuthError('拒否');
  });
  await h.session.open('Alpha.\n\nBravo.\n');
  assert.deepEqual(h.calls, ['Alpha.'], '2 つ目は呼ばない');
});

test('クラウド接続の失敗はバナーに送信先ホストを出し、Ollama とは書かない', async () => {
  const h = harness(async () => {
    throw new ProviderUnavailableError('api.openai.com へ接続できません');
  });
  await h.session.open('Alpha.\n');
  const banner = h.events.filter((e) => e.kind === 'banner').at(-1);
  assert.ok(banner && banner.kind === 'banner' && banner.text.includes('api.openai.com'));
  assert.ok(banner && banner.kind === 'banner' && !banner.text.includes('Ollama'));
});

test('dispose 後に遅い翻訳が完了しても cache 更新や後続翻訳をしない', async () => {
  let resolveOld!: (value: string) => void;
  const oldTranslation = new Promise<string>((resolve) => { resolveOld = resolve; });
  const h = harness(async (source) => source === 'Old first.' ? oldTranslation : `JA:${source}`);

  const opening = h.session.open('Old first.\n\nOld second.\n');
  await new Promise((resolve) => setImmediate(resolve));
  h.session.dispose();
  resolveOld('JA:Old first.');
  await opening;

  assert.deepEqual(h.calls, ['Old first.']);
  assert.equal(h.cache.size, 0);
});
