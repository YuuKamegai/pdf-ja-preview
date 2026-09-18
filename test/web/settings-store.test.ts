import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsStore } from '../../web/server/settings-store';
import { protect } from '../../web/server/secret';

const windows = process.platform === 'win32';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'settings-'));
  return { dir, store: new SettingsStore(dir) };
}

test('鍵が無ければ空文字を返す', async () => {
  const { dir, store: subject } = await store();
  try {
    assert.equal(await subject.readApiKey(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存した鍵を読み戻せる', { skip: !windows }, async () => {
  const { dir, store: subject } = await store();
  try {
    await subject.setApiKey('sk-test-1234567890');
    assert.equal(await subject.readApiKey(), 'sk-test-1234567890');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('設定ファイルに平文の鍵を書かない', { skip: !windows }, async () => {
  const { dir, store: subject } = await store();
  try {
    await subject.setApiKey('sk-test-1234567890');
    const raw = await readFile(join(dir, 'settings.json'), 'utf8');
    assert.equal(raw.includes('sk-test-1234567890'), false);
    assert.ok(raw.includes('dpapi-current-user-v1:'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('鍵を消せる', { skip: !windows }, async () => {
  const { dir, store: subject } = await store();
  try {
    await subject.setApiKey('sk-test-1234567890');
    await subject.clearApiKey();
    assert.equal(await subject.readApiKey(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空の鍵は保存しない', async () => {
  const { dir, store: subject } = await store();
  try {
    await assert.rejects(subject.setApiKey('  '), /空/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('平文で置かれた鍵は読まずに拒否する', async () => {
  const { dir, store: subject } = await store();
  try {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ apiKey: 'sk-plain' }), 'utf8');
    await assert.rejects(subject.readApiKey(), /形式/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('壊れた JSON は空として扱う', async () => {
  const { dir, store: subject } = await store();
  try {
    await writeFile(join(dir, 'settings.json'), '{壊れている', 'utf8');
    assert.equal(await subject.readApiKey(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Task 7 レビューの申し送り（Minor）への対応。
//
// `setApiKey` は空文字チェックのため入力を trim してから保存する（これは
// SettingsStore の仕様であり、先頭・末尾の空白は保存時点で落ちる）。
//
// これとは別の層として、`secret.ts` の `protect`/`unprotect` は往復で値を
// 一字一句変えない設計になっている（末尾空白を含む鍵でも壊れない）。この試験は
// `setApiKey` を経由せず、`protect()` した値を直接 settings.json へ書き込み、
// `readApiKey()`（内部で `unprotect` を呼ぶ）が末尾の空白ごと元の値を返すことを
// 確かめる。つまり「secret.ts の往復保証」を検証するものであり、
// 「SettingsStore.setApiKey の trim 仕様」を確かめるものではない。
test(
  'secret.ts の往復保証: 末尾空白を含む鍵も protect/unprotect で一字一句変わらず戻る（setApiKey の trim とは別層）',
  { skip: !windows },
  async () => {
    const { dir, store: subject } = await store();
    try {
      const withTrailingSpace = 'sk-test-1234567890  ';
      const protectedValue = await protect(withTrailingSpace);
      await writeFile(
        join(dir, 'settings.json'),
        JSON.stringify({ apiKey: protectedValue }),
        'utf8',
      );
      assert.equal(await subject.readApiKey(), withTrailingSpace);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
