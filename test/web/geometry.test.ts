import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedToPdf } from '../../web/client/geometry';

test('CropBox 原点を含めて PDF 座標へ変換する', () => {
  assert.deepEqual(normalizedToPdf([0.1, 0.2, 0.4, 0.5], [10, 20, 610, 820]),
    [70, 660, 250, 420]);
});

test('原点が 0 のページは幅・高さの比率そのままになる', () => {
  assert.deepEqual(normalizedToPdf([0, 0, 1, 1], [0, 0, 600, 800]), [0, 800, 600, 0]);
});

test('view の座標が逆順でも正規化して扱う', () => {
  assert.deepEqual(normalizedToPdf([0, 0, 1, 1], [610, 820, 10, 20]), [10, 820, 610, 20]);
});
