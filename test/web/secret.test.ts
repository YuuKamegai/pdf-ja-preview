import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROTECTED_PREFIX, isProtected, protect, unprotect } from '../../web/server/secret';

const windows = process.platform === 'win32';

test('暗号化した値は接頭辞と base64 になる', { skip: !windows }, async () => {
  const protectedValue = await protect('sk-test-1234567890');
  assert.ok(protectedValue.startsWith(PROTECTED_PREFIX));
  const encoded = protectedValue.slice(PROTECTED_PREFIX.length);
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
});

test('暗号文に平文が現れない', { skip: !windows }, async () => {
  const protectedValue = await protect('sk-test-1234567890');
  assert.equal(protectedValue.includes('sk-test-1234567890'), false);
});

test('暗号化して復号すると元へ戻る', { skip: !windows }, async () => {
  const original = 'sk-test-1234567890';
  assert.equal(await unprotect(await protect(original)), original);
});

test('日本語と記号も往復できる', { skip: !windows }, async () => {
  const original = 'キー:日本語/+=あ';
  assert.equal(await unprotect(await protect(original)), original);
});

test('空の値は暗号化しない', async () => {
  await assert.rejects(protect(''), /空/);
});

test('接頭辞の無い値は復号しない', async () => {
  await assert.rejects(unprotect('sk-plain-text'), /形式/);
});

test('壊れた base64 は復号しない', async () => {
  await assert.rejects(unprotect(`${PROTECTED_PREFIX}!!!not-base64!!!`), /不正|復号/);
});

test('保護済みかどうかを見分ける', () => {
  assert.equal(isProtected(`${PROTECTED_PREFIX}abc`), true);
  assert.equal(isProtected('sk-plain'), false);
  assert.equal(isProtected(''), false);
});
