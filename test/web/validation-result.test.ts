import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validationResult} from '../../scripts/validation-result';

test('検証で未完了ブロックが残れば成功にしない', () => {
  const result = validationResult(3, [{status:'translated'}, {status:'error'}]);
  assert.deepEqual(result, {requested:3, translated:1, failed:1, pending:1, exitCode:3});
});
test('翻訳対象がゼロでも翻訳成功扱いにしない', () => {
  assert.equal(validationResult(0, []).exitCode, 3);
});
test('全件の完了だけが検証成功', () => {
  assert.equal(validationResult(2, [{status:'translated'}, {status:'translated'}]).exitCode, 0);
});
