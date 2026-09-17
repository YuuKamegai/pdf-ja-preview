import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDocument, DocumentContractError } from '../../web/shared/document';

const fixturePath = fileURLToPath(new URL('../fixtures/pdf/document-v1.json', import.meta.url));

function fixture(): any {
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

test('fixture の中間形式をそのまま受け入れる', () => {
  const doc = parseDocument(fixture());
  assert.equal(doc.schema, 'pdf-document.v1');
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.blocks.length, 5);
  assert.deepEqual(
    doc.blocks.filter((b) => b.translatable).map((b) => b.id),
    ['b0', 'b1', 'b2', 'b4'],
  );
});

test('ID が重複した文書を拒否する', () => {
  const raw = fixture();
  raw.blocks[2].id = 'b1';
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) =>
      error instanceof DocumentContractError && error.code === 'duplicate-block-id',
  );
});

test('ページ番号が重複した文書を拒否する', () => {
  const raw = fixture();
  raw.pages[1].number = 1;
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'duplicate-page',
  );
});

test('未知の schema を拒否する', () => {
  const raw = fixture();
  raw.schema = 'pdf-document.v2';
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'unknown-schema',
  );
});

test('存在しないページを指す領域を拒否する', () => {
  const raw = fixture();
  raw.blocks[1].regions[0].page = 9;
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'unknown-page',
  );
});

test('order の重複を拒否する', () => {
  const raw = fixture();
  raw.blocks[2].order = 1;
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'duplicate-order',
  );
});

test('未知の kind を拒否する', () => {
  const raw = fixture();
  raw.blocks[0].kind = 'sidebar';
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'unknown-kind',
  );
});

test('壊れた座標だけは領域を捨てて warning を足す', () => {
  const raw = fixture();
  raw.blocks[1].regions[0].box = [0.5, 0.2, 0.1, 0.4];
  const doc = parseDocument(raw);
  assert.deepEqual(doc.blocks[1].regions, []);
  assert.equal(doc.warnings.length, 1);
  assert.match(doc.warnings[0], /b1/);
});

test('範囲外の座標も領域を捨てる。ブロック自体は残す', () => {
  const raw = fixture();
  raw.blocks[2].regions[0].box = [0.1, 0.2, 1.4, 0.3];
  const doc = parseDocument(raw);
  assert.deepEqual(
    doc.blocks[2].regions.map((r) => r.page),
    [2],
  );
  assert.equal(doc.blocks[2].source, 'Spans two pages.');
  assert.equal(doc.warnings.length, 1);
});

test('相互参照されない relatedIds を拒否する', () => {
  const raw = fixture();
  raw.blocks[3].relatedIds = ['nope'];
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'unknown-related-id',
  );
});

test('charRange は終端排他で、逆転を拒否する', () => {
  const raw = fixture();
  raw.blocks[1].regions[0].charRange = [5, 5];
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'invalid-char-range',
  );
});

test('hash が 64 桁の 16 進でなければ拒否する', () => {
  const raw = fixture();
  raw.hash = 'abc';
  assert.throws(
    () => parseDocument(raw),
    (error: unknown) => error instanceof DocumentContractError && error.code === 'invalid-hash',
  );
});

test('parseDocument は入力を書き換えない', () => {
  const raw = fixture();
  raw.blocks[1].regions[0].box = [0.5, 0.2, 0.1, 0.4];
  const snapshot = JSON.stringify(raw);
  parseDocument(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});
