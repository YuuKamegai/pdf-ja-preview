import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package.json が mdJaPreview.open コマンドを宣言している', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { contributes: { commands: Array<{ command: string }> } };
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('mdJaPreview.open'));
});

test('コマンド実行と Markdown 表示で extension を activate する', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { activationEvents: string[] };
  assert.deepEqual(pkg.activationEvents, [
    'onCommand:mdJaPreview.open',
    'onLanguage:markdown',
  ]);
});
