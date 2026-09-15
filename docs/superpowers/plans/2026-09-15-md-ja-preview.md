# md-ja-preview 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 英語で書かれたローカルの Markdown を、ローカル Ollama で日本語へ逐次翻訳し、VSCode の別パネルへリアルタイム表示する拡張機能を作る。

**Architecture:** 拡張側で原文をブロック分割し、逐次キューで 1 ブロックずつ Ollama へ投げ、訳せたブロックから Webview の DOM を差し替える。VSCode API へ依存するのは `src/extension.ts`、`src/panel/panel.ts` の 2 ファイルだけに閉じ、分割・差分・検証・キャッシュ・翻訳・オーケストレーションはすべて純粋な TypeScript として単体テストする。

**Tech Stack:** TypeScript 5.9 / Node.js 24 / VSCode Extension API 1.137 / markdown-it 14 / esbuild / node:test + tsx / @vscode/test-cli

**Spec:** `docs/superpowers/specs/2026-09-15-md-ja-preview-design.md`

## Global Constraints

- VSCode `engines` は `^1.137.0`。Node.js は 24 系。
- 翻訳先はローカル Ollama のみ。既定エンドポイント `http://127.0.0.1:11434`、既定モデル `qwen3.5:9b-q4_K_M`。
- Ollama への `/api/chat` リクエストは **必ず `think: false` を含める**。thinking 対応モデルで省略すると推論文が訳文へ混入する。
- **訳文をワークスペースへ書き出してはならない。** 永続先は拡張の `globalStorage` だけ。
- `markdown-it` の初期化は用途で分ける。**描画用（`render.ts`）は必ず `{ html: false }`**。
  **分割用（`blocks.ts`）は `{ html: true }`** — `html:false` だと生 HTML が `html_block` にならず
  `paragraph` として翻訳対象に入ってしまうため（実機検証済み）。分割用パーサの出力は描画に使わない。
- Webview には nonce 付き CSP を張り、インライン `<script>` を置かない。
- 翻訳しないブロック種別: `fence` / `html` / `hr`。これらは原文のまま表示する。
- 翻訳の並列度は 1。ローカル GPU を複数リクエストで詰まらせない。
- コミットメッセージの末尾には次の行を入れる:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## spec からの逸脱（1 件）

spec 5 章は「`maxBlockChars` 超過時はリストを項目単位、**表を行単位**へ分割する」としているが、
表を行単位で割ると各断片が見出し行を持たないため、断片が表として描画できない。
各断片に見出し行を複製すると、パネル上で 1 つの表が複数の表に割れて表示される。
よって **初版では表を分割しない**（長い表は 1 ブロックのまま翻訳する。遅くなるだけで壊れない）。
分割するのはリストのみ。spec 5 章はこの計画の確定後に同内容へ更新する。

## ファイル構成

| ファイル | 責務 | vscode 依存 |
|---|---|---|
| `src/markdown/blocks.ts` | 原文 md → `Block[]`（種別・原文・ハッシュ・行範囲）、リストの上限分割 | なし |
| `src/markdown/reconcile.ts` | 新旧ブロック列の LCS 差分。既存訳の持ち越しと再翻訳対象の決定 | なし |
| `src/markdown/verify.ts` | 訳文の構造検証（フェンス数・インラインコード数・リンク URL 集合） | なし |
| `src/markdown/render.ts` | Markdown → HTML（`html:false`） | なし |
| `src/translate/ollama.ts` | Ollama `/api/chat` クライアント。ストリーム解釈・abort・タイムアウト・エラー分類 | なし |
| `src/translate/queue.ts` | 並列度 1 の逐次キュー。全キャンセル | なし |
| `src/cache.ts` | キー生成と `globalStorage` 上の JSON 永続キャッシュ。期限切れの剪定 | なし |
| `src/session.ts` | オーケストレーション。初回翻訳・保存時差分・再試行・バナー | なし |
| `src/panel/html.ts` | Webview の HTML 骨格生成（nonce・CSP） | なし |
| `src/panel/sync.ts` | 行 ↔ ブロック解決と同期ループ抑制ゲート | なし |
| `src/panel/panel.ts` | `WebviewPanel` の生成・postMessage の送受信 | あり |
| `src/extension.ts` | activate / コマンド / 設定読み込み / 上記の配線 | あり |
| `media/preview.js` | Webview 側。ブロック DOM 差し替えと scroll 通知のみ | なし |
| `media/preview.css` | Webview 側スタイル（VSCode テーマ変数） | なし |

---

### Task 1: プロジェクト基盤とビルド・テストの土台

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `.gitignore`, `.vscode/launch.json`, `src/extension.ts`
- Test: `test/unit/contributes.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `npm run build` / `npm run typecheck` / `npm run test:unit` の 3 コマンド。コマンド ID `mdJaPreview.open`。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/contributes.test.ts`:

```ts
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
```

- [ ] **Step 2: 依存を入れてテストが失敗することを確認**

```bash
npm init -y
npm i markdown-it@^14.1.0
npm i -D @types/markdown-it@^14.1.2 @types/node@^24 @types/vscode@^1.137 @vscode/test-cli@^0.0.11 @vscode/test-electron@^2.5.2 esbuild@^0.25 tsx@^4.20 typescript@^5.9
node --import tsx --test "test/unit/**/*.test.ts"
```

Expected: FAIL（`contributes` が undefined で TypeError）

- [ ] **Step 3: package.json を書く**

`npm init -y` が生成した内容を次で置き換える。`dependencies` と `devDependencies` は
Step 2 の `npm i` が書き込んだ実際のバージョンをそのまま残すこと。

```json
{
  "name": "md-ja-preview",
  "displayName": "md-ja Preview",
  "description": "ローカル Ollama で英語 Markdown を日本語へ逐次翻訳して表示する",
  "version": "0.1.0",
  "publisher": "local",
  "private": true,
  "license": "MIT",
  "engines": { "vscode": "^1.137.0" },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "mdJaPreview.open",
        "title": "日本語プレビューを開く",
        "category": "md-ja"
      }
    ]
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test:unit": "node --import tsx --test \"test/unit/**/*.test.ts\"",
    "test": "npm run typecheck && npm run test:unit"
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit`
Expected: PASS（1 件）

- [ ] **Step 5: tsconfig / esbuild / .gitignore / launch.json / 最小の extension.ts を作る**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test"]
}
```

`esbuild.mjs`:

```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
```

`.gitignore`:

```gitignore
node_modules/
dist/
out/
.vscode-test/
*.vsix
```

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

`src/extension.ts`:

```ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mdJaPreview.open', () => {
      void vscode.window.showInformationMessage('md-ja Preview');
    }),
  );
}

export function deactivate(): void {}
```

- [ ] **Step 6: ビルドと型検査が通ることを確認**

Run: `npm run build && npm run typecheck`
Expected: どちらも成功し `dist/extension.js` が生成される

- [ ] **Step 7: F5 で拡張が起動することを目視確認**

VSCode でこのフォルダを開き F5。拡張開発ホストで `Ctrl+Shift+P` →
`md-ja: 日本語プレビューを開く` を実行して通知が出ることを確認する。

- [ ] **Step 8: コミット**

```bash
git add -A
git commit -m "chore: プロジェクト基盤とビルド・テストの土台を作る" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: ブロック分割

**Files:**
- Create: `src/markdown/blocks.ts`
- Test: `test/unit/blocks.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type BlockKind = 'heading' | 'paragraph' | 'list' | 'table' | 'blockquote' | 'fence' | 'html' | 'hr'`
  - `interface Block { index: number; kind: BlockKind; source: string; hash: string; lineStart: number; lineEnd: number }`
  - `function splitBlocks(text: string, maxBlockChars?: number): Block[]`
  - `function hashSource(source: string): string`
  - `const TRANSLATABLE_KINDS: ReadonlySet<BlockKind>`
  - `lineEnd` は終端排他（`[lineStart, lineEnd)`）。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/blocks.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks, hashSource, TRANSLATABLE_KINDS } from '../../src/markdown/blocks';

test('見出しと段落を別ブロックに分け、行範囲を持つ', () => {
  const blocks = splitBlocks('# Title\n\nHello world.\n');
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.source, b.lineStart, b.lineEnd]),
    [
      ['heading', '# Title', 0, 1],
      ['paragraph', 'Hello world.', 2, 3],
    ],
  );
});

test('コードフェンスは 1 ブロックで、中身は分割されない', () => {
  const blocks = splitBlocks('```js\nconst a = 1;\n\nconst b = 2;\n```\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'fence');
  assert.ok(blocks[0].source.includes('const b = 2;'));
});

test('リストは項目ごとではなく 1 ブロックになる', () => {
  const blocks = splitBlocks('- one\n- two\n- three\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'list');
});

test('引用の中の段落は独立ブロックにならない', () => {
  const blocks = splitBlocks('> quoted one\n>\n> quoted two\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'blockquote');
});

test('表・水平線・生 HTML をそれぞれ 1 ブロックとして認識する', () => {
  const md = '| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n<div>raw</div>\n';
  assert.deepEqual(splitBlocks(md).map((b) => b.kind), ['table', 'hr', 'html']);
});

test('index は 0 始まりの通し番号になる', () => {
  assert.deepEqual(splitBlocks('# A\n\nb\n\n# C\n').map((b) => b.index), [0, 1, 2]);
});

test('hash は原文に依存し、同じ原文なら一致する', () => {
  assert.equal(hashSource('same'), hashSource('same'));
  assert.notEqual(hashSource('a'), hashSource('b'));
  assert.equal(splitBlocks('x\n')[0].hash, hashSource('x'));
});

test('翻訳対象の種別に fence / html / hr を含めない', () => {
  assert.equal(TRANSLATABLE_KINDS.has('paragraph'), true);
  assert.equal(TRANSLATABLE_KINDS.has('fence'), false);
  assert.equal(TRANSLATABLE_KINDS.has('html'), false);
  assert.equal(TRANSLATABLE_KINDS.has('hr'), false);
});

test('CRLF 改行でも行範囲が崩れない', () => {
  const blocks = splitBlocks('# T\r\n\r\nbody\r\n');
  assert.deepEqual(blocks.map((b) => [b.source, b.lineStart]), [['# T', 0], ['body', 2]]);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/markdown/blocks` が解決できない）

- [ ] **Step 3: 実装する**

`src/markdown/blocks.ts`:

```ts
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'blockquote'
  | 'fence'
  | 'html'
  | 'hr';

export interface Block {
  index: number;
  kind: BlockKind;
  source: string;
  hash: string;
  /** 原文の開始行（0 始まり） */
  lineStart: number;
  /** 原文の終端行（終端排他） */
  lineEnd: number;
}

const KIND_BY_TOKEN: Readonly<Record<string, BlockKind>> = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  table_open: 'table',
  blockquote_open: 'blockquote',
  fence: 'fence',
  code_block: 'fence',
  html_block: 'html',
  hr: 'hr',
};

export const TRANSLATABLE_KINDS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  'heading',
  'paragraph',
  'list',
  'table',
  'blockquote',
]);

// 分割専用のパーサ。html:false にすると生 HTML が html_block ではなく paragraph になり、
// 翻訳対象へ紛れ込む。ここでは構造を見るだけで、描画には render.ts の html:false を使う。
const md = new MarkdownIt({ html: true });

export function hashSource(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function makeBlock(
  index: number,
  kind: BlockKind,
  source: string,
  lineStart: number,
  lineEnd: number,
): Block {
  return { index, kind, source, hash: hashSource(source), lineStart, lineEnd };
}

export function splitBlocks(
  text: string,
  maxBlockChars = Number.POSITIVE_INFINITY,
): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];

  for (const token of md.parse(text, {})) {
    // ネスト深度 0 の開始トークンと自己完結トークンだけを拾う。
    // 閉じトークン (nesting < 0) と、引用やリストの内側 (level > 0) は無視する。
    if (token.level !== 0 || token.nesting < 0 || !token.map) continue;
    const kind = KIND_BY_TOKEN[token.type];
    if (!kind) continue;

    const [lineStart, lineEnd] = token.map;
    const source = lines.slice(lineStart, lineEnd).join('\n').replace(/\s+$/, '');
    if (source === '') continue;

    blocks.push(makeBlock(blocks.length, kind, source, lineStart, lineEnd));
  }

  return blocks;
}
```

`maxBlockChars` は Task 3 で実効化する。この時点では受け取るだけで使わない。

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit`
Expected: PASS（9 件 + Task 1 の 1 件）

- [ ] **Step 5: コミット**

```bash
git add src/markdown/blocks.ts test/unit/blocks.test.ts
git commit -m "feat(markdown): 原文をトップレベルブロックへ分割する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 長いリストの上限分割

**Files:**
- Modify: `src/markdown/blocks.ts`
- Test: `test/unit/blocks.test.ts`（追記）

**Interfaces:**
- Consumes: Task 2 の `Block` / `splitBlocks(text, maxBlockChars?)`
- Produces: `splitBlocks` の第 2 引数が実効になる。分割するのはリストのみ。表は分割しない。

- [ ] **Step 1: 失敗するテストを追記する**

`test/unit/blocks.test.ts` の末尾へ:

```ts
const listItem = (n: number) => `- ${'x'.repeat(40)} ${n}`;

test('maxBlockChars を超えるリストは項目単位でまとめ直される', () => {
  const md = [listItem(1), listItem(2), listItem(3), listItem(4)].join('\n') + '\n';
  const blocks = splitBlocks(md, 100);
  assert.ok(blocks.length > 1, '分割されること');
  assert.ok(blocks.every((b) => b.kind === 'list'));
  assert.equal(blocks.map((b) => b.source).join('\n'), md.trimEnd());
});

test('分割後も行範囲が連続し、index が振り直される', () => {
  const md = [listItem(1), listItem(2), listItem(3)].join('\n') + '\n';
  const blocks = splitBlocks(md, 60);
  assert.deepEqual(blocks.map((b) => b.index), blocks.map((_, i) => i));
  for (let i = 1; i < blocks.length; i++) {
    assert.equal(blocks[i].lineStart, blocks[i - 1].lineEnd);
  }
});

test('1 項目が単独で上限を超えても、その項目は割らない', () => {
  const blocks = splitBlocks(`- ${'y'.repeat(300)}\n`, 50);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, `- ${'y'.repeat(300)}`);
});

test('上限以下のリストと、上限を超えた表は分割されない', () => {
  assert.equal(splitBlocks('- a\n- b\n', 1000).length, 1);
  const table = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n';
  assert.equal(splitBlocks(table, 10).length, 1, '表は上限を超えても割らない');
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（分割されず `blocks.length === 1` のまま）

- [ ] **Step 3: 実装する**

`src/markdown/blocks.ts` の `splitBlocks` を次で置き換え、下の 2 関数を追加する:

```ts
export function splitBlocks(
  text: string,
  maxBlockChars = Number.POSITIVE_INFINITY,
): Block[] {
  const lines = text.split(/\r?\n/);
  const raw: Array<{ kind: BlockKind; source: string; lineStart: number }> = [];

  for (const token of md.parse(text, {})) {
    if (token.level !== 0 || token.nesting < 0 || !token.map) continue;
    const kind = KIND_BY_TOKEN[token.type];
    if (!kind) continue;
    const [lineStart, lineEnd] = token.map;
    const source = lines.slice(lineStart, lineEnd).join('\n').replace(/\s+$/, '');
    if (source === '') continue;
    raw.push({ kind, source, lineStart });
  }

  const blocks: Block[] = [];
  for (const entry of raw) {
    const pieces =
      entry.kind === 'list' && entry.source.length > maxBlockChars
        ? chunkListItems(entry.source, maxBlockChars)
        : [entry.source];

    let line = entry.lineStart;
    for (const piece of pieces) {
      const lineEnd = line + piece.split('\n').length;
      blocks.push(makeBlock(blocks.length, entry.kind, piece, line, lineEnd));
      line = lineEnd;
    }
  }

  return blocks;
}

const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s/;

/** リスト原文をトップレベル項目単位へ切る。継続行は直前の項目へ付ける。 */
function splitListItems(source: string): string[] {
  const items: string[] = [];
  let current: string[] = [];
  for (const line of source.split('\n')) {
    if (LIST_MARKER.test(line) && current.length > 0) {
      items.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) items.push(current.join('\n'));
  return items;
}

/** 項目を上限まで詰め合わせる。単独で上限を超える項目はそれ自体を 1 塊にする。 */
function chunkListItems(source: string, maxBlockChars: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const item of splitListItems(source)) {
    if (current.length > 0 && length + 1 + item.length > maxBlockChars) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    length = current.length === 0 ? item.length : length + 1 + item.length;
    current.push(item);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit`
Expected: PASS（Task 2 の 9 件 + 追加 4 件）

- [ ] **Step 5: コミット**

```bash
git add src/markdown/blocks.ts test/unit/blocks.test.ts
git commit -m "feat(markdown): 長いリストを項目単位で上限まで詰め直す" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 保存時の差分照合

**Files:**
- Create: `src/markdown/reconcile.ts`
- Test: `test/unit/reconcile.test.ts`

**Interfaces:**
- Consumes: Task 2 の `Block`
- Produces:
  - `interface Reconciled { carried: Map<number, string>; pending: number[] }`
  - `function reconcile(oldBlocks: readonly Block[], oldTranslations: ReadonlyMap<number, string>, newBlocks: readonly Block[]): Reconciled`
  - `carried` のキーは **新** ブロックの index。`pending` は訳が無い新 index の昇順配列。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/reconcile.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks } from '../../src/markdown/blocks';
import { reconcile } from '../../src/markdown/reconcile';

const OLD = '# Title\n\nAlpha.\n\nBravo.\n';

function translationsFor(text: string): Map<number, string> {
  return new Map(splitBlocks(text).map((b) => [b.index, `JA:${b.source}`]));
}

test('先頭に段落を挿入しても既存訳がすべて持ち越される', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('Intro.\n\n' + OLD),
  );
  assert.deepEqual(pending, [0]);
  assert.equal(carried.get(1), 'JA:# Title');
  assert.equal(carried.get(2), 'JA:Alpha.');
  assert.equal(carried.get(3), 'JA:Bravo.');
});

test('1 段落だけ編集したらその 1 つだけが再翻訳対象になる', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('# Title\n\nAlpha edited.\n\nBravo.\n'),
  );
  assert.deepEqual(pending, [1]);
  assert.equal(carried.get(0), 'JA:# Title');
  assert.equal(carried.get(2), 'JA:Bravo.');
});

test('中間の段落を削除しても残りの訳がずれない', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('# Title\n\nBravo.\n'),
  );
  assert.deepEqual(pending, []);
  assert.equal(carried.get(1), 'JA:Bravo.');
});

test('同一内容のブロックが重複していても取り違えない', () => {
  const text = 'Same.\n\nOther.\n\nSame.\n';
  const translations = new Map([
    [0, 'JA-first'],
    [1, 'JA-other'],
    [2, 'JA-second'],
  ]);
  const { carried, pending } = reconcile(splitBlocks(text), translations, splitBlocks(text));
  assert.deepEqual(pending, []);
  assert.equal(carried.get(0), 'JA-first');
  assert.equal(carried.get(2), 'JA-second');
});

test('訳を持たない旧ブロックは pending に残る', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    new Map([[0, 'JA:# Title']]),
    splitBlocks(OLD),
  );
  assert.deepEqual(pending, [1, 2]);
  assert.equal(carried.get(0), 'JA:# Title');
});

test('全面的に書き換えたら全ブロックが pending になる', () => {
  const { carried, pending } = reconcile(
    splitBlocks(OLD),
    translationsFor(OLD),
    splitBlocks('Completely different.\n\nAnd more.\n'),
  );
  assert.deepEqual(pending, [0, 1]);
  assert.equal(carried.size, 0);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/markdown/reconcile` が解決できない）

- [ ] **Step 3: 実装する**

`src/markdown/reconcile.ts`:

```ts
import type { Block } from './blocks';

export interface Reconciled {
  /** キーは新ブロックの index。値は持ち越した訳文 Markdown。 */
  carried: Map<number, string>;
  /** 訳が無く、翻訳が必要な新ブロックの index（昇順）。 */
  pending: number[];
}

/** ハッシュ列の最長共通部分列を (旧index, 新index) の対応として返す。 */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function reconcile(
  oldBlocks: readonly Block[],
  oldTranslations: ReadonlyMap<number, string>,
  newBlocks: readonly Block[],
): Reconciled {
  const pairs = lcsPairs(
    oldBlocks.map((b) => b.hash),
    newBlocks.map((b) => b.hash),
  );

  const carried = new Map<number, string>();
  for (const [oldIndex, newIndex] of pairs) {
    const ja = oldTranslations.get(oldIndex);
    if (ja !== undefined) carried.set(newIndex, ja);
  }

  const pending = newBlocks.filter((b) => !carried.has(b.index)).map((b) => b.index);
  return { carried, pending };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS

- [ ] **Step 5: コミット**

```bash
git add src/markdown/reconcile.ts test/unit/reconcile.test.ts
git commit -m "feat(markdown): LCS 差分で既存訳を持ち越し再翻訳対象を絞る" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 訳文の構造検証

**Files:**
- Create: `src/markdown/verify.ts`
- Test: `test/unit/verify.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `interface StructureSignature { fences: number; inlineCodes: number; links: string[] }`
  - `function structureOf(markdown: string): StructureSignature`
  - `function matchesStructure(source: string, translated: string): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/verify.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { structureOf, matchesStructure } from '../../src/markdown/verify';

test('フェンス・インラインコード・リンクを数える', () => {
  const md = 'See `foo` and [site](https://example.com).\n\n```js\nx\n```\n';
  assert.deepEqual(structureOf(md), {
    fences: 1,
    inlineCodes: 1,
    links: ['https://example.com'],
  });
});

test('リンク URL は昇順に並べ替えられる', () => {
  const md = '[b](https://b.example) と [a](https://a.example)';
  assert.deepEqual(structureOf(md).links, ['https://a.example', 'https://b.example']);
});

test('構造が保たれた訳文を受け入れる', () => {
  const src = 'Run `npm test` and read [docs](https://example.com/docs).';
  const ja = '`npm test` を実行し、[ドキュメント](https://example.com/docs) を読む。';
  assert.equal(matchesStructure(src, ja), true);
});

test('インラインコードが訳されてしまった訳文を弾く', () => {
  assert.equal(matchesStructure('Run `npm test` now.', '今すぐ npm テスト を実行する。'), false);
});

test('URL が書き換えられた訳文を弾く', () => {
  const src = 'See [docs](https://example.com/en).';
  const ja = '[ドキュメント](https://example.com/ja) を参照。';
  assert.equal(matchesStructure(src, ja), false);
});

test('コードフェンスが増えた訳文を弾く', () => {
  assert.equal(matchesStructure('Plain sentence.', '```\n包んでしまった\n```'), false);
});

test('リンクもコードも無い散文はそのまま受け入れる', () => {
  assert.equal(matchesStructure('Hello world.', 'こんにちは世界。'), true);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/markdown/verify` が解決できない）

- [ ] **Step 3: 実装する**

`src/markdown/verify.ts`:

```ts
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export interface StructureSignature {
  fences: number;
  inlineCodes: number;
  /** 昇順に並べたリンク URL */
  links: string[];
}

const md = new MarkdownIt({ html: false });

function walkInline(children: readonly Token[], signature: StructureSignature): void {
  for (const child of children) {
    if (child.type === 'code_inline') signature.inlineCodes++;
    if (child.type === 'link_open') {
      const href = child.attrGet('href');
      if (href !== null) signature.links.push(href);
    }
    if (child.children) walkInline(child.children, signature);
  }
}

export function structureOf(markdown: string): StructureSignature {
  const signature: StructureSignature = { fences: 0, inlineCodes: 0, links: [] };

  for (const token of md.parse(markdown, {})) {
    if (token.type === 'fence' || token.type === 'code_block') signature.fences++;
    if (token.type === 'inline' && token.children) walkInline(token.children, signature);
  }

  signature.links.sort();
  return signature;
}

/** 訳文が原文の構造を保っているか。プロンプト遵守を信用せず機械的に確かめる。 */
export function matchesStructure(source: string, translated: string): boolean {
  const a = structureOf(source);
  const b = structureOf(translated);
  return (
    a.fences === b.fences &&
    a.inlineCodes === b.inlineCodes &&
    a.links.length === b.links.length &&
    a.links.every((href, i) => href === b.links[i])
  );
}
```

`markdown-it/lib/token.mjs` の型が解決できない場合は
`import type { Token } from 'markdown-it/index.js'` を試し、
それでも駄目なら `type Token = ReturnType<MarkdownIt['parse']>[number]` で代替する。

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS

- [ ] **Step 5: コミット**

```bash
git add src/markdown/verify.ts test/unit/verify.test.ts
git commit -m "feat(markdown): 訳文の構造検証を追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 翻訳キャッシュ

**Files:**
- Create: `src/cache.ts`
- Test: `test/unit/cache.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `function cacheKey(model: string, source: string): string`
  - `class TranslationCache` — `static load(filePath: string, options?: { now?: () => number; maxAgeMs?: number }): Promise<TranslationCache>` / `get(model: string, source: string): string | undefined` / `set(model: string, source: string, ja: string): void` / `flush(): Promise<void>` / `readonly size: number`
- 保存先は呼び出し側が渡す。`src/cache.ts` は `vscode` を import しない。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/cache.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, TranslationCache } from '../../src/cache';

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'md-ja-cache-'));
  return join(dir, 'translations.json');
}

test('キーはモデル名と原文の両方に依存する', () => {
  assert.equal(cacheKey('m1', 'text'), cacheKey('m1', 'text'));
  assert.notEqual(cacheKey('m1', 'text'), cacheKey('m2', 'text'));
  assert.notEqual(cacheKey('m1', 'text'), cacheKey('m1', 'other'));
});

test('保存した訳を再読み込み後も取り出せる', async () => {
  const path = await tempFile();
  const first = await TranslationCache.load(path);
  first.set('m1', 'Hello.', 'こんにちは。');
  await first.flush();

  const second = await TranslationCache.load(path);
  assert.equal(second.get('m1', 'Hello.'), 'こんにちは。');
});

test('モデルが違えば別の訳として扱われる', async () => {
  const cache = await TranslationCache.load(await tempFile());
  cache.set('m1', 'Hello.', 'A');
  assert.equal(cache.get('m2', 'Hello.'), undefined);
});

test('ファイルが無い場合は空のキャッシュとして開く', async () => {
  const cache = await TranslationCache.load(await tempFile());
  assert.equal(cache.size, 0);
  assert.equal(cache.get('m1', 'anything'), undefined);
});

test('壊れた JSON でも例外を投げず空で開く', async () => {
  const path = await tempFile();
  await writeFile(path, '{ not json', 'utf8');
  const cache = await TranslationCache.load(path);
  assert.equal(cache.size, 0);
});

test('期限切れの項目は読み込み時に剪定される', async () => {
  const path = await tempFile();
  const old = await TranslationCache.load(path, { now: () => 0 });
  old.set('m1', 'stale', 'ふるい');
  await old.flush();

  const day = 24 * 60 * 60 * 1000;
  const fresh = await TranslationCache.load(path, { now: () => 91 * day, maxAgeMs: 90 * day });
  assert.equal(fresh.size, 0);
});

test('flush はワークスペースではなく渡されたパスへだけ書く', async () => {
  const path = await tempFile();
  const cache = await TranslationCache.load(path);
  cache.set('m1', 'Hello.', 'こんにちは。');
  await cache.flush();

  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, { ja: string; at: number }>;
  assert.equal(Object.keys(raw).length, 1);
  assert.equal(Object.values(raw)[0].ja, 'こんにちは。');
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/cache` が解決できない）

- [ ] **Step 3: 実装する**

`src/cache.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  ja: string;
  at: number;
}

export function cacheKey(model: string, source: string): string {
  return createHash('sha256').update(model).update('\n').update(source, 'utf8').digest('hex');
}

export class TranslationCache {
  private dirty = false;

  private constructor(
    private readonly filePath: string,
    private readonly entries: Map<string, CacheEntry>,
    private readonly now: () => number,
  ) {}

  static async load(
    filePath: string,
    options: { now?: () => number; maxAgeMs?: number } = {},
  ): Promise<TranslationCache> {
    const now = options.now ?? Date.now;
    const maxAgeMs = options.maxAgeMs ?? NINETY_DAYS;
    const entries = new Map<string, CacheEntry>();

    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, CacheEntry>;
      for (const [key, entry] of Object.entries(raw)) {
        if (typeof entry?.ja !== 'string' || typeof entry?.at !== 'number') continue;
        if (now() - entry.at > maxAgeMs) continue;
        entries.set(key, entry);
      }
    } catch {
      // ファイルが無い、あるいは壊れている場合は空で開く。
    }

    return new TranslationCache(filePath, entries, now);
  }

  get size(): number {
    return this.entries.size;
  }

  get(model: string, source: string): string | undefined {
    return this.entries.get(cacheKey(model, source))?.ja;
  }

  set(model: string, source: string, ja: string): void {
    this.entries.set(cacheKey(model, source), { ja, at: this.now() });
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(Object.fromEntries(this.entries)), 'utf8');
    this.dirty = false;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS

- [ ] **Step 5: コミット**

```bash
git add src/cache.ts test/unit/cache.test.ts
git commit -m "feat(cache): globalStorage 上の翻訳キャッシュを追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Ollama クライアント

**Files:**
- Create: `src/translate/ollama.ts`
- Test: `test/unit/ollama.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `interface OllamaConfig { endpoint: string; model: string; think: boolean; temperature: number; timeoutMs: number }`
  - `class OllamaUnavailableError extends Error`
  - `class OllamaModelMissingError extends Error { readonly model: string }`
  - `const SYSTEM_PROMPT: string`
  - `function stripOuterFence(source: string, translated: string): string`
  - `function translateBlock(args: { source: string; headingContext: string; config: OllamaConfig; signal: AbortSignal; fetchImpl?: typeof globalThis.fetch; onDelta?: (chunk: string) => void }): Promise<string>`

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/ollama.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translateBlock,
  stripOuterFence,
  OllamaUnavailableError,
  OllamaModelMissingError,
  type OllamaConfig,
} from '../../src/translate/ollama';

const CONFIG: OllamaConfig = {
  endpoint: 'http://127.0.0.1:11434',
  model: 'test-model',
  think: false,
  temperature: 0.2,
  timeoutMs: 5000,
};

function ndjsonResponse(objects: unknown[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const object of objects) {
        controller.enqueue(encoder.encode(JSON.stringify(object) + '\n'));
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

function chunk(content: string, done = false): unknown {
  return { message: { role: 'assistant', content }, done };
}

test('ストリームの content を連結して返す', async () => {
  const fetchImpl = async () => ndjsonResponse([chunk('こんに'), chunk('ちは。'), chunk('', true)]);
  const result = await translateBlock({
    source: 'Hello.',
    headingContext: '',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  assert.equal(result, 'こんにちは。');
});

test('リクエスト本文に think:false とモデル名が入る', async () => {
  let captured: Record<string, unknown> = {};
  const fetchImpl = async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return ndjsonResponse([chunk('訳', true)]);
  };
  await translateBlock({
    source: 'Hello.',
    headingContext: '# Intro',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  assert.equal(captured.think, false);
  assert.equal(captured.model, 'test-model');
  assert.equal(captured.stream, true);
  assert.deepEqual(captured.options, { temperature: 0.2 });
});

test('thinking フィールドは訳文に混ぜない', async () => {
  const fetchImpl = async () =>
    ndjsonResponse([
      { message: { role: 'assistant', thinking: '考え中', content: '' }, done: false },
      chunk('本文。', true),
    ]);
  const result = await translateBlock({
    source: 'Body.',
    headingContext: '',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  assert.equal(result, '本文。');
});

test('onDelta が到着順に呼ばれる', async () => {
  const seen: string[] = [];
  const fetchImpl = async () => ndjsonResponse([chunk('あ'), chunk('い'), chunk('', true)]);
  await translateBlock({
    source: 'x',
    headingContext: '',
    config: CONFIG,
    signal: new AbortController().signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    onDelta: (c) => seen.push(c),
  });
  assert.deepEqual(seen, ['あ', 'い']);
});

test('404 はモデル未導入として分類する', async () => {
  const fetchImpl = async () => new Response('{"error":"model not found"}', { status: 404 });
  await assert.rejects(
    translateBlock({
      source: 'x',
      headingContext: '',
      config: CONFIG,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    (error: unknown) =>
      error instanceof OllamaModelMissingError && error.model === 'test-model',
  );
});

test('接続できない場合は OllamaUnavailableError になる', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    translateBlock({
      source: 'x',
      headingContext: '',
      config: CONFIG,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    OllamaUnavailableError,
  );
});

test('呼び出し側の abort は AbortError として伝わる', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  const promise = translateBlock({
    source: 'x',
    headingContext: '',
    config: CONFIG,
    signal: controller.signal,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
  controller.abort();
  await assert.rejects(promise, (error: unknown) => (error as Error).name === 'AbortError');
});

test('タイムアウトは OllamaUnavailableError になる', async () => {
  const fetchImpl = async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('timeout', 'TimeoutError')),
      );
    });
  await assert.rejects(
    translateBlock({
      source: 'x',
      headingContext: '',
      config: { ...CONFIG, timeoutMs: 20 },
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
    }),
    OllamaUnavailableError,
  );
});

test('原文にフェンスが無いのに訳文全体が包まれていたら外す', () => {
  assert.equal(stripOuterFence('Plain.', '```markdown\n訳文。\n```'), '訳文。');
  assert.equal(stripOuterFence('Plain.', '```\n訳文。\n```'), '訳文。');
});

test('原文にフェンスがある場合は訳文をそのまま通す', () => {
  const ja = '```js\nx\n```';
  assert.equal(stripOuterFence('```js\nx\n```', ja), ja);
});

test('包まれていない訳文はそのまま通す', () => {
  assert.equal(stripOuterFence('Plain.', '訳文。'), '訳文。');
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/translate/ollama` が解決できない）

- [ ] **Step 3: 実装する**

`src/translate/ollama.ts`:

```ts
export interface OllamaConfig {
  endpoint: string;
  model: string;
  think: boolean;
  temperature: number;
  timeoutMs: number;
}

export class OllamaUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OllamaUnavailableError';
  }
}

export class OllamaModelMissingError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`モデルが見つかりません: ${model}`);
    this.name = 'OllamaModelMissingError';
    this.model = model;
  }
}

export const SYSTEM_PROMPT = [
  'あなたは技術文書を英語から日本語へ訳す翻訳者です。',
  '入力は Markdown 文書の 1 ブロックです。次の規則を必ず守ってください。',
  '- Markdown 記法（見出し記号、リスト記号、表、強調、リンク記法）をそのまま保つ。',
  '- インラインコード、コードフェンスの中身、URL、数式、識別子は一切訳さず原文のまま残す。',
  '- 訳文だけを出力する。前置き、後書き、注釈、原文の再掲を書かない。',
  '- 入力に無いコードフェンスで訳文を包まない。',
].join('\n');

export function buildRequestBody(
  source: string,
  headingContext: string,
  config: OllamaConfig,
): Record<string, unknown> {
  const context = headingContext === '' ? '' : `直前の見出し: ${headingContext}\n\n`;
  return {
    model: config.model,
    think: config.think,
    stream: true,
    options: { temperature: config.temperature },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${context}次のブロックを日本語へ訳してください。\n\n${source}` },
    ],
  };
}

/** 原文にフェンスが無いのに訳文全体がフェンスで包まれていた場合だけ外す。 */
export function stripOuterFence(source: string, translated: string): string {
  if (/^\s*```/m.test(source)) return translated;
  const match = translated.trim().match(/^```[A-Za-z0-9_-]*\n([\s\S]*?)\n?```$/);
  if (!match) return translated;
  const inner = match[1];
  if (inner === undefined || inner.includes('```')) return translated;
  return inner;
}

interface ChatChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  error?: string;
}

export async function translateBlock(args: {
  source: string;
  headingContext: string;
  config: OllamaConfig;
  signal: AbortSignal;
  fetchImpl?: typeof globalThis.fetch;
  onDelta?: (chunk: string) => void;
}): Promise<string> {
  const { source, headingContext, config, signal, onDelta } = args;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const url = `${config.endpoint.replace(/\/+$/, '')}/api/chat`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildRequestBody(source, headingContext, config)),
      signal: combined,
    });
  } catch (cause) {
    // 呼び出し側の中断はそのまま伝える。タイムアウトと接続失敗は可用性の問題として扱う。
    if (signal.aborted) throw cause;
    if (timeout.aborted) {
      throw new OllamaUnavailableError(
        `Ollama の応答が ${config.timeoutMs}ms を超えました`,
        { cause },
      );
    }
    throw new OllamaUnavailableError(`Ollama へ接続できません: ${config.endpoint}`, { cause });
  }

  if (response.status === 404) throw new OllamaModelMissingError(config.model);
  if (!response.ok) {
    throw new OllamaUnavailableError(`Ollama が HTTP ${response.status} を返しました`);
  }
  if (!response.body) throw new OllamaUnavailableError('Ollama の応答本文が空です');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    const parsed = JSON.parse(trimmed) as ChatChunk;
    if (parsed.error) throw new OllamaUnavailableError(`Ollama エラー: ${parsed.error}`);
    const content = parsed.message?.content ?? '';
    if (content !== '') {
      text += content;
      onDelta?.(content);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
    }
    consume(buffer);
  } finally {
    reader.releaseLock();
  }

  return stripOuterFence(source, text.trim());
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS（11 件）

- [ ] **Step 5: コミット**

```bash
git add src/translate/ollama.ts test/unit/ollama.test.ts
git commit -m "feat(translate): Ollama のストリーミング翻訳クライアントを追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 逐次キュー

**Files:**
- Create: `src/translate/queue.ts`
- Test: `test/unit/queue.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `class SequentialQueue` — `enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>` / `cancelAll(): void`

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/queue.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SequentialQueue } from '../../src/translate/queue';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('投入順に、重ならずに実行される', async () => {
  const queue = new SequentialQueue();
  const log: string[] = [];

  const job = (name: string) => async () => {
    log.push(`${name}:start`);
    await tick();
    log.push(`${name}:end`);
    return name;
  };

  const results = await Promise.all([
    queue.enqueue(job('a')),
    queue.enqueue(job('b')),
    queue.enqueue(job('c')),
  ]);

  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, [
    'a:start', 'a:end',
    'b:start', 'b:end',
    'c:start', 'c:end',
  ]);
});

test('前のジョブが失敗しても後続は実行される', async () => {
  const queue = new SequentialQueue();
  const failing = queue.enqueue(async () => {
    throw new Error('boom');
  });
  const following = queue.enqueue(async () => 'ok');

  await assert.rejects(failing, /boom/);
  assert.equal(await following, 'ok');
});

test('cancelAll で未実行のジョブは実行されず reject する', async () => {
  const queue = new SequentialQueue();
  let secondRan = false;

  const first = queue.enqueue(async () => {
    await tick();
    return 'first';
  });
  const second = queue.enqueue(async () => {
    secondRan = true;
    return 'second';
  });

  queue.cancelAll();

  await assert.rejects(second, (error: unknown) => (error as Error).name === 'AbortError');
  await first.catch(() => undefined);
  assert.equal(secondRan, false);
});

test('cancelAll は実行中ジョブへ渡した signal を abort する', async () => {
  const queue = new SequentialQueue();
  let aborted = false;

  const running = queue.enqueue(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve('stopped');
        });
      }),
  );

  await tick();
  queue.cancelAll();

  assert.equal(await running, 'stopped');
  assert.equal(aborted, true);
});

test('cancelAll の後に投入したジョブは通常どおり実行される', async () => {
  const queue = new SequentialQueue();
  queue.cancelAll();
  assert.equal(await queue.enqueue(async () => 'fresh'), 'fresh');
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/translate/queue` が解決できない）

- [ ] **Step 3: 実装する**

`src/translate/queue.ts`:

```ts
/** 並列度 1 の実行キュー。ローカル GPU を複数リクエストで詰まらせないために使う。 */
export class SequentialQueue {
  private tail: Promise<void> = Promise.resolve();
  private controller = new AbortController();

  enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { signal } = this.controller;

    const result = this.tail.then(() => {
      if (signal.aborted) throw signal.reason;
      return job(signal);
    });

    // 次のジョブは、成否にかかわらずこのジョブの完了後に始める。
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  /** 実行中のジョブを中断し、未実行のジョブを AbortError で落とす。 */
  cancelAll(): void {
    this.controller.abort(new DOMException('cancelled', 'AbortError'));
    this.controller = new AbortController();
    this.tail = Promise.resolve();
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS（5 件）

- [ ] **Step 5: コミット**

```bash
git add src/translate/queue.ts test/unit/queue.test.ts
git commit -m "feat(translate): 並列度 1 の逐次キューを追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Markdown レンダリング

**Files:**
- Create: `src/markdown/render.ts`
- Test: `test/unit/render.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `function renderMarkdown(markdown: string): string`

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/render.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../src/markdown/render';

test('見出しとリストを HTML へ変換する', () => {
  const html = renderMarkdown('# 題\n\n- 一\n- 二\n');
  assert.match(html, /<h1>題<\/h1>/);
  assert.match(html, /<li>一<\/li>/);
});

test('コードフェンスは pre/code になる', () => {
  assert.match(renderMarkdown('```js\nconst a = 1;\n```'), /<pre><code/);
});

test('生 HTML は実行可能な形で出力されない', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n');
  assert.ok(!html.includes('<script>'), '生の script タグを通さないこと');
});

test('javascript: スキームのリンクは href にならない', () => {
  const html = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!/href="javascript:/i.test(html));
});

test('表を table 要素へ変換する', () => {
  assert.match(renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n'), /<table>/);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/markdown/render` が解決できない）

- [ ] **Step 3: 実装する**

`src/markdown/render.ts`:

```ts
import MarkdownIt from 'markdown-it';

// html:false により原文中の生 HTML はエスケープされる。Webview の CSP と合わせた二重の防御。
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS（5 件）

- [ ] **Step 5: コミット**

```bash
git add src/markdown/render.ts test/unit/render.test.ts
git commit -m "feat(markdown): 生 HTML を通さない Markdown レンダラを追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 行とブロックの対応、同期ループ抑制

**Files:**
- Create: `src/panel/sync.ts`
- Test: `test/unit/sync.test.ts`

**Interfaces:**
- Consumes: Task 2 の `Block`
- Produces:
  - `function blockIndexAtLine(blocks: readonly Block[], line: number): number` — 該当ブロックが無ければ `-1`
  - `function lineForBlock(blocks: readonly Block[], index: number): number` — 無ければ `0`
  - `class SyncGate` — `constructor(windowMs?: number, now?: () => number)` / `markSelfInitiated(): void` / `shouldAccept(): boolean`

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/sync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks } from '../../src/markdown/blocks';
import { blockIndexAtLine, lineForBlock, SyncGate } from '../../src/panel/sync';

const DOC = '# Title\n\nAlpha.\n\nBravo.\n\nCharlie.\n';
// 行: 0=# Title, 2=Alpha., 4=Bravo., 6=Charlie.

test('行番号から、その行を含むブロックを引ける', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(blockIndexAtLine(blocks, 0), 0);
  assert.equal(blockIndexAtLine(blocks, 2), 1);
  assert.equal(blockIndexAtLine(blocks, 4), 2);
  assert.equal(blockIndexAtLine(blocks, 6), 3);
});

test('ブロック間の空行は直前のブロックに寄せる', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(blockIndexAtLine(blocks, 3), 1);
  assert.equal(blockIndexAtLine(blocks, 5), 2);
});

test('文書末尾より後ろの行は最後のブロックになる', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(blockIndexAtLine(blocks, 999), 3);
});

test('ブロックが無ければ -1 を返す', () => {
  assert.equal(blockIndexAtLine([], 0), -1);
});

test('ブロック index から開始行を引ける', () => {
  const blocks = splitBlocks(DOC);
  assert.equal(lineForBlock(blocks, 2), 4);
  assert.equal(lineForBlock(blocks, 99), 0);
});

test('自分が起こした同期は抑制窓の間だけ拒否される', () => {
  let now = 1000;
  const gate = new SyncGate(250, () => now);

  assert.equal(gate.shouldAccept(), true);
  gate.markSelfInitiated();
  assert.equal(gate.shouldAccept(), false);

  now = 1249;
  assert.equal(gate.shouldAccept(), false);

  now = 1250;
  assert.equal(gate.shouldAccept(), true);
});

test('抑制はマークのたびに延長される', () => {
  let now = 0;
  const gate = new SyncGate(100, () => now);
  gate.markSelfInitiated();
  now = 90;
  gate.markSelfInitiated();
  now = 150;
  assert.equal(gate.shouldAccept(), false);
  now = 190;
  assert.equal(gate.shouldAccept(), true);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/panel/sync` が解決できない）

- [ ] **Step 3: 実装する**

`src/panel/sync.ts`:

```ts
import type { Block } from '../markdown/blocks';

/** 指定行を含む（あるいは直前の）ブロックの index。ブロックが無ければ -1。 */
export function blockIndexAtLine(blocks: readonly Block[], line: number): number {
  if (blocks.length === 0) return -1;

  let found = 0;
  for (const block of blocks) {
    if (block.lineStart <= line) found = block.index;
    else break;
  }
  return found;
}

export function lineForBlock(blocks: readonly Block[], index: number): number {
  return blocks[index]?.lineStart ?? 0;
}

/**
 * 双方向スクロール同期のループを止めるゲート。
 * 自分が起こしたスクロールの跳ね返りを、一定時間だけ無視する。
 */
export class SyncGate {
  private suppressUntil = 0;

  constructor(
    private readonly windowMs = 250,
    private readonly now: () => number = Date.now,
  ) {}

  markSelfInitiated(): void {
    this.suppressUntil = this.now() + this.windowMs;
  }

  shouldAccept(): boolean {
    return this.now() >= this.suppressUntil;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS（7 件）

- [ ] **Step 5: コミット**

```bash
git add src/panel/sync.ts test/unit/sync.test.ts
git commit -m "feat(panel): 行とブロックの対応と同期ループ抑制を追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Webview の骨格と表示資産

**Files:**
- Create: `src/panel/html.ts`, `media/preview.js`, `media/preview.css`
- Test: `test/unit/html.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type BlockState = 'source' | 'translating' | 'translated' | 'error'`
  - `function createNonce(): string`
  - `function buildWebviewHtml(options: { nonce: string; cspSource: string; scriptUri: string; styleUri: string }): string`
- Webview メッセージ契約（以降のタスクはこの形に従う）
  - 拡張 → Webview: `{ kind: 'init', blocks: Array<{ index, html, state, lineStart, lineEnd }> }` / `{ kind: 'block', index, html, state }` / `{ kind: 'banner', text }`（`text: ''` で消す）/ `{ kind: 'scrollTo', index, ratio }`
  - Webview → 拡張: `{ kind: 'ready' }` / `{ kind: 'scrolled', index, ratio }` / `{ kind: 'retry', index }`

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/html.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebviewHtml, createNonce } from '../../src/panel/html';

const OPTIONS = {
  nonce: 'NONCE123',
  cspSource: 'vscode-webview://abc',
  scriptUri: 'vscode-webview://abc/media/preview.js',
  styleUri: 'vscode-webview://abc/media/preview.css',
};

test('CSP を default-src none で固定し、cspSource を埋め込む', () => {
  const html = buildWebviewHtml(OPTIONS);
  assert.match(html, /default-src 'none'/);
  assert.ok(html.includes(OPTIONS.cspSource));
});

test('script は nonce 付きの外部ファイル参照だけになる', () => {
  const html = buildWebviewHtml(OPTIONS);
  assert.match(html, /<script nonce="NONCE123" src="vscode-webview:\/\/abc\/media\/preview\.js">/);
  assert.equal(html.match(/<script/g)?.length, 1, 'script タグは 1 つだけ');
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'インライン script を置かないこと');
});

test('ブロックの受け皿とバナーの要素を持つ', () => {
  const html = buildWebviewHtml(OPTIONS);
  assert.ok(html.includes('id="banner"'));
  assert.ok(html.includes('id="blocks"'));
});

test('nonce は毎回異なる', () => {
  assert.notEqual(createNonce(), createNonce());
  assert.equal(createNonce().length >= 16, true);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/panel/html` が解決できない）

- [ ] **Step 3: 実装する**

`src/panel/html.ts`:

```ts
import { randomBytes } from 'node:crypto';

export type BlockState = 'source' | 'translating' | 'translated' | 'error';

export function createNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function buildWebviewHtml(options: {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
}): string {
  const { nonce, cspSource, scriptUri, styleUri } = options;
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>日本語プレビュー</title>
</head>
<body>
<div id="banner" hidden></div>
<main id="blocks"></main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
```

`media/preview.css`:

```css
body {
  margin: 0;
  padding: 1.2rem 1.6rem 6rem;
  font-family: var(--vscode-editor-font-family, system-ui), sans-serif;
  font-size: var(--vscode-editor-font-size, 14px);
  line-height: 1.8;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
}

#banner {
  position: sticky;
  top: 0;
  z-index: 1;
  margin: -1.2rem -1.6rem 1rem;
  padding: 0.6rem 1.6rem;
  color: var(--vscode-inputValidation-errorForeground, inherit);
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
}

.block {
  position: relative;
  scroll-margin-top: 3rem;
}

.block.state-source {
  opacity: 0.45;
}

.block.state-translating {
  opacity: 0.45;
  border-left: 2px solid var(--vscode-progressBar-background, #0e70c0);
  padding-left: 0.6rem;
  margin-left: -0.8rem;
}

.block.state-error {
  border-left: 2px solid var(--vscode-inputValidation-errorBorder, #be1100);
  padding-left: 0.6rem;
  margin-left: -0.8rem;
}

.retry {
  margin: 0.2rem 0 0.8rem;
  padding: 0.1rem 0.6rem;
  font: inherit;
  font-size: 0.85em;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: none;
  border-radius: 2px;
  cursor: pointer;
}

pre {
  padding: 0.6rem 0.8rem;
  overflow-x: auto;
  background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.1));
}

code {
  font-family: var(--vscode-editor-font-family, monospace);
}

table {
  border-collapse: collapse;
}

th,
td {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.4));
}
```

`media/preview.js`:

```js
// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const banner = document.getElementById('banner');
  const container = document.getElementById('blocks');

  /** 拡張が起こしたスクロールの跳ね返りを拡張へ返さないための抑制。 */
  let suppressScrollUntil = 0;

  function renderBlock(view) {
    let element = document.querySelector(`[data-index="${view.index}"]`);
    if (!element) {
      element = document.createElement('section');
      element.dataset.index = String(view.index);
      container.appendChild(element);
    }
    element.className = `block state-${view.state}`;
    element.dataset.lineStart = String(view.lineStart ?? element.dataset.lineStart ?? 0);
    element.innerHTML = view.html;

    if (view.state === 'error') {
      const button = document.createElement('button');
      button.className = 'retry';
      button.textContent = '再試行';
      button.addEventListener('click', () =>
        vscode.postMessage({ kind: 'retry', index: view.index }),
      );
      element.appendChild(button);
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.kind === 'init') {
      container.textContent = '';
      for (const view of message.blocks) renderBlock(view);
      return;
    }

    if (message.kind === 'block') {
      const existing = document.querySelector(`[data-index="${message.index}"]`);
      renderBlock({
        index: message.index,
        html: message.html,
        state: message.state,
        lineStart: existing ? Number(existing.dataset.lineStart) : 0,
      });
      return;
    }

    if (message.kind === 'banner') {
      banner.textContent = message.text;
      banner.hidden = message.text === '';
      return;
    }

    if (message.kind === 'scrollTo') {
      const target = document.querySelector(`[data-index="${message.index}"]`);
      if (!target) return;
      suppressScrollUntil = Date.now() + 250;
      const offset = target.offsetTop + target.offsetHeight * (message.ratio || 0);
      window.scrollTo({ top: offset - 24, behavior: 'auto' });
    }
  });

  window.addEventListener(
    'scroll',
    () => {
      if (Date.now() < suppressScrollUntil) return;
      const blocks = container.children;
      for (let i = 0; i < blocks.length; i++) {
        const element = blocks[i];
        if (element.offsetTop + element.offsetHeight <= window.scrollY) continue;
        const ratio = (window.scrollY - element.offsetTop) / (element.offsetHeight || 1);
        vscode.postMessage({
          kind: 'scrolled',
          index: Number(element.dataset.index),
          ratio: Math.min(Math.max(ratio, 0), 1),
        });
        return;
      }
    },
    { passive: true },
  );

  vscode.postMessage({ kind: 'ready' });
})();
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS（4 件）

- [ ] **Step 5: コミット**

```bash
git add src/panel/html.ts media/preview.js media/preview.css test/unit/html.test.ts
git commit -m "feat(panel): Webview の HTML 骨格と表示資産を追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: 翻訳オーケストレーション（初回表示と再試行）

**Files:**
- Create: `src/session.ts`
- Test: `test/unit/session.test.ts`

**Interfaces:**
- Consumes: Task 2 `splitBlocks` / `TRANSLATABLE_KINDS` / `Block`、Task 5 `matchesStructure`、Task 7 `OllamaUnavailableError` / `OllamaModelMissingError`、Task 11 `BlockState`
- Produces:
  - `interface SessionView { index: number; markdown: string; state: BlockState; lineStart: number; lineEnd: number }`
  - `type SessionEvent = { kind: 'init'; blocks: SessionView[] } | { kind: 'block'; index: number; markdown: string; state: BlockState } | { kind: 'banner'; text: string }`
  - `interface SessionDeps { model: string; maxBlockChars: number; translate(source: string, headingContext: string, signal: AbortSignal): Promise<string>; enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>; cacheGet(model: string, source: string): string | undefined; cacheSet(model: string, source: string, ja: string): void; emit(event: SessionEvent): void }`
  - `class TranslationSession` — `constructor(deps: SessionDeps)` / `open(text: string): Promise<void>` / `retry(index: number): Promise<void>` / `readonly blocks: readonly Block[]`
- `update(text)` は Task 14 で追加する。

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/session.test.ts`:

```ts
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

test('init で全ブロックを原文のまま先に出す', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('# Title\n\nAlpha.\n');

  const init = h.events[0];
  assert.equal(init.kind, 'init');
  assert.deepEqual(
    init.kind === 'init' ? init.blocks.map((b) => [b.markdown, b.state]) : [],
    [
      ['# Title', 'source'],
      ['Alpha.', 'source'],
    ],
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/session` が解決できない）

- [ ] **Step 3: 実装する**

`src/session.ts`:

```ts
import { splitBlocks, TRANSLATABLE_KINDS, type Block } from './markdown/blocks';
import { matchesStructure } from './markdown/verify';
import type { BlockState } from './panel/html';
import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from './translate/ollama';

export interface SessionView {
  index: number;
  markdown: string;
  state: BlockState;
  lineStart: number;
  lineEnd: number;
}

export type SessionEvent =
  | { kind: 'init'; blocks: SessionView[] }
  | { kind: 'block'; index: number; markdown: string; state: BlockState }
  | { kind: 'banner'; text: string };

export interface SessionDeps {
  model: string;
  maxBlockChars: number;
  translate(source: string, headingContext: string, signal: AbortSignal): Promise<string>;
  enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cacheGet(model: string, source: string): string | undefined;
  cacheSet(model: string, source: string, ja: string): void;
  emit(event: SessionEvent): void;
}

/** 復帰不能なエラーならバナー文言を返す。ブロック単位の失敗なら undefined。 */
function fatalBanner(error: unknown): string | undefined {
  if (error instanceof OllamaModelMissingError) {
    return `モデル ${error.model} がありません。ターミナルで "ollama pull ${error.model}" を実行してください。`;
  }
  if (error instanceof OllamaUnavailableError) {
    return `Ollama へ接続できません。原文のまま表示しています。（${error.message}）`;
  }
  return undefined;
}

export class TranslationSession {
  protected blockList: Block[] = [];
  protected translations = new Map<number, string>();

  constructor(protected readonly deps: SessionDeps) {}

  get blocks(): readonly Block[] {
    return this.blockList;
  }

  async open(text: string): Promise<void> {
    this.blockList = splitBlocks(text, this.deps.maxBlockChars);
    this.translations = new Map();
    this.deps.emit({ kind: 'banner', text: '' });
    this.deps.emit({
      kind: 'init',
      blocks: this.blockList.map((block) => ({
        index: block.index,
        markdown: block.source,
        state: 'source' as BlockState,
        lineStart: block.lineStart,
        lineEnd: block.lineEnd,
      })),
    });
    await this.run(this.blockList.map((block) => block.index));
  }

  async retry(index: number): Promise<void> {
    await this.run([index]);
  }

  protected async run(indices: readonly number[]): Promise<void> {
    for (const index of indices) {
      const block = this.blockList[index];
      if (!block) continue;

      if (!TRANSLATABLE_KINDS.has(block.kind)) {
        this.publish(index, block.source, 'translated');
        continue;
      }

      const cached = this.deps.cacheGet(this.deps.model, block.source);
      if (cached !== undefined) {
        this.publish(index, cached, 'translated');
        continue;
      }

      const keepGoing = await this.translateOne(block);
      if (!keepGoing) return;
    }
  }

  /** 翻訳を 1 ブロック実行する。false を返したら以降のブロックへ進まない。 */
  private async translateOne(block: Block): Promise<boolean> {
    this.deps.emit({
      kind: 'block',
      index: block.index,
      markdown: block.source,
      state: 'translating',
    });

    try {
      const ja = await this.deps.enqueue((signal) =>
        this.deps.translate(block.source, this.headingContextFor(block.index), signal),
      );

      if (!matchesStructure(block.source, ja)) {
        // プロンプト遵守を信用しない。構造が壊れた訳は採用せず原文を残す。
        this.emitBlock(block.index, block.source, 'error');
        return true;
      }

      this.deps.cacheSet(this.deps.model, block.source, ja);
      this.publish(block.index, ja, 'translated');
      return true;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return false;

      const banner = fatalBanner(error);
      if (banner !== undefined) {
        this.deps.emit({ kind: 'banner', text: banner });
        this.emitBlock(block.index, block.source, 'source');
        return false;
      }

      this.emitBlock(block.index, block.source, 'error');
      return true;
    }
  }

  private headingContextFor(index: number): string {
    for (let i = index - 1; i >= 0; i--) {
      const block = this.blockList[i];
      if (block?.kind === 'heading') return block.source.replace(/^#+\s*/, '');
    }
    return '';
  }

  protected publish(index: number, markdown: string, state: BlockState): void {
    this.translations.set(index, markdown);
    this.emitBlock(index, markdown, state);
  }

  private emitBlock(index: number, markdown: string, state: BlockState): void {
    this.deps.emit({ kind: 'block', index, markdown, state });
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS（12 件）

- [ ] **Step 5: コミット**

```bash
git add src/session.ts test/unit/session.test.ts
git commit -m "feat(session): 逐次翻訳のオーケストレーションを追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: 設定とパネル、拡張の配線（初のエンドツーエンド）

**Files:**
- Create: `src/config.ts`, `src/panel/panel.ts`
- Modify: `src/extension.ts`, `package.json`（`contributes.configuration`）
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: Task 6 `TranslationCache`、Task 7 `translateBlock` / `OllamaConfig`、Task 8 `SequentialQueue`、Task 9 `renderMarkdown`、Task 11 `buildWebviewHtml` / `createNonce`、Task 12 `TranslationSession` / `SessionEvent`
- Produces:
  - `interface ResolvedConfig { ollama: OllamaConfig; maxBlockChars: number; scrollSync: boolean; autoOpen: boolean }`
  - `function resolveConfig(read: (key: string) => unknown): ResolvedConfig`
  - `class PreviewPanel` — `static create(context: vscode.ExtensionContext, title: string): PreviewPanel` / `post(message: unknown): void` / `onMessage(handler: (message: any) => void): void` / `onDispose(handler: () => void): void` / `reveal(): void` / `dispose(): void`
  - `activate()` は `{ events: SessionEvent[] }` を返す（統合テスト用の観測点。Task 16 で使う）

- [ ] **Step 1: 失敗するテストを書く**

`test/unit/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../../src/config';

const empty = () => undefined;

test('未設定なら仕様どおりの既定値になる', () => {
  assert.deepEqual(resolveConfig(empty), {
    ollama: {
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b-q4_K_M',
      think: false,
      temperature: 0.2,
      timeoutMs: 120000,
    },
    maxBlockChars: 1500,
    scrollSync: true,
    autoOpen: false,
  });
});

test('設定値を読み取る', () => {
  const values: Record<string, unknown> = {
    endpoint: 'http://192.168.0.2:11434/',
    model: 'ornith:35b',
    think: true,
    temperature: 0.7,
    requestTimeoutMs: 30000,
    maxBlockChars: 800,
    scrollSync: false,
    autoOpen: true,
  };
  const config = resolveConfig((key) => values[key]);

  assert.equal(config.ollama.endpoint, 'http://192.168.0.2:11434/');
  assert.equal(config.ollama.model, 'ornith:35b');
  assert.equal(config.ollama.think, true);
  assert.equal(config.ollama.temperature, 0.7);
  assert.equal(config.ollama.timeoutMs, 30000);
  assert.equal(config.maxBlockChars, 800);
  assert.equal(config.scrollSync, false);
  assert.equal(config.autoOpen, true);
});

test('型が違う値は既定値へ落とす', () => {
  const config = resolveConfig((key) => (key === 'temperature' ? 'hot' : undefined));
  assert.equal(config.ollama.temperature, 0.2);
});

test('package.json が設定項目をすべて宣言している', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { contributes: { configuration: { properties: Record<string, unknown> } } };

  const declared = Object.keys(pkg.contributes.configuration.properties).sort();
  assert.deepEqual(declared, [
    'mdJaPreview.autoOpen',
    'mdJaPreview.endpoint',
    'mdJaPreview.maxBlockChars',
    'mdJaPreview.model',
    'mdJaPreview.requestTimeoutMs',
    'mdJaPreview.scrollSync',
    'mdJaPreview.temperature',
    'mdJaPreview.think',
  ]);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`src/config` が無く、`contributes.configuration` も無い）

- [ ] **Step 3: `src/config.ts` と `contributes.configuration` を書く**

`src/config.ts`:

```ts
import type { OllamaConfig } from './translate/ollama';

export interface ResolvedConfig {
  ollama: OllamaConfig;
  maxBlockChars: number;
  scrollSync: boolean;
  autoOpen: boolean;
}

function pick<T>(value: unknown, fallback: T, type: 'string' | 'number' | 'boolean'): T {
  return typeof value === type ? (value as T) : fallback;
}

export function resolveConfig(read: (key: string) => unknown): ResolvedConfig {
  return {
    ollama: {
      endpoint: pick(read('endpoint'), 'http://127.0.0.1:11434', 'string'),
      model: pick(read('model'), 'qwen3.5:9b-q4_K_M', 'string'),
      // thinking 対応モデルで true にすると推論文が訳文へ混入する。既定は false。
      think: pick(read('think'), false, 'boolean'),
      temperature: pick(read('temperature'), 0.2, 'number'),
      timeoutMs: pick(read('requestTimeoutMs'), 120000, 'number'),
    },
    maxBlockChars: pick(read('maxBlockChars'), 1500, 'number'),
    scrollSync: pick(read('scrollSync'), true, 'boolean'),
    autoOpen: pick(read('autoOpen'), false, 'boolean'),
  };
}
```

`package.json` の `contributes` へ追加:

```json
"configuration": {
  "title": "md-ja Preview",
  "properties": {
    "mdJaPreview.endpoint": {
      "type": "string",
      "default": "http://127.0.0.1:11434",
      "description": "Ollama のベース URL。"
    },
    "mdJaPreview.model": {
      "type": "string",
      "default": "qwen3.5:9b-q4_K_M",
      "description": "翻訳に使う Ollama のモデル名。"
    },
    "mdJaPreview.think": {
      "type": "boolean",
      "default": false,
      "description": "thinking を有効にする。有効にすると推論文が訳文へ混ざることがある。"
    },
    "mdJaPreview.temperature": {
      "type": "number",
      "default": 0.2,
      "description": "生成温度。"
    },
    "mdJaPreview.requestTimeoutMs": {
      "type": "number",
      "default": 120000,
      "description": "1 ブロックあたりのタイムアウト（ミリ秒）。"
    },
    "mdJaPreview.maxBlockChars": {
      "type": "number",
      "default": 1500,
      "description": "この文字数を超えるリストを項目単位で分割する。"
    },
    "mdJaPreview.scrollSync": {
      "type": "boolean",
      "default": true,
      "description": "原文エディタと訳文パネルのスクロールを同期する。"
    },
    "mdJaPreview.autoOpen": {
      "type": "boolean",
      "default": false,
      "description": "Markdown を開いたとき自動で日本語プレビューを開く。"
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit`
Expected: PASS（4 件）

- [ ] **Step 5: パネルと拡張本体を配線する**

`src/panel/panel.ts`:

```ts
import * as vscode from 'vscode';
import { buildWebviewHtml, createNonce } from './html';

export class PreviewPanel {
  private constructor(private readonly panel: vscode.WebviewPanel) {}

  static create(context: vscode.ExtensionContext, title: string): PreviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'mdJaPreview',
      `日本語: ${title}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    const nonce = createNonce();
    const asUri = (name: string) =>
      panel.webview
        .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name))
        .toString();

    panel.webview.html = buildWebviewHtml({
      nonce,
      cspSource: panel.webview.cspSource,
      scriptUri: asUri('preview.js'),
      styleUri: asUri('preview.css'),
    });

    return new PreviewPanel(panel);
  }

  post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  onMessage(handler: (message: { kind: string; [key: string]: unknown }) => void): void {
    this.panel.webview.onDidReceiveMessage(handler);
  }

  onDispose(handler: () => void): void {
    this.panel.onDidDispose(handler);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  dispose(): void {
    this.panel.dispose();
  }
}
```

`src/extension.ts`（全置き換え）:

```ts
import * as vscode from 'vscode';
import { resolveConfig } from './config';
import { TranslationCache } from './cache';
import { renderMarkdown } from './markdown/render';
import { PreviewPanel } from './panel/panel';
import { TranslationSession, type SessionEvent } from './session';
import { SequentialQueue } from './translate/queue';
import { translateBlock } from './translate/ollama';

interface Live {
  document: vscode.TextDocument;
  panel: PreviewPanel;
  session: TranslationSession;
  queue: SequentialQueue;
}

let live: Live | undefined;

export function activate(context: vscode.ExtensionContext): { events: SessionEvent[] } {
  // 統合テストから翻訳の進行を観測するための記録。
  const events: SessionEvent[] = [];

  context.subscriptions.push(
    vscode.commands.registerCommand('mdJaPreview.open', () => open(context, events)),
  );

  return { events };
}

export function deactivate(): void {
  live?.queue.cancelAll();
  live?.panel.dispose();
  live = undefined;
}

async function open(context: vscode.ExtensionContext, events: SessionEvent[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    void vscode.window.showWarningMessage('Markdown ファイルを開いてから実行してください。');
    return;
  }

  // 別のファイルへ切り替えたときは、前のパネルと進行中の翻訳を畳む。
  live?.queue.cancelAll();
  live?.panel.dispose();
  live = undefined;

  const config = resolveConfig((key) =>
    vscode.workspace.getConfiguration('mdJaPreview').get(key),
  );

  const document = editor.document;
  const queue = new SequentialQueue();
  const panel = PreviewPanel.create(context, document.fileName.split(/[\\/]/).pop() ?? 'markdown');

  const cachePath = vscode.Uri.joinPath(context.globalStorageUri, 'translations.json').fsPath;
  const cache = await TranslationCache.load(cachePath);

  const session = new TranslationSession({
    model: config.ollama.model,
    maxBlockChars: config.maxBlockChars,
    translate: (source, headingContext, signal) =>
      translateBlock({ source, headingContext, config: config.ollama, signal }),
    enqueue: (job) => queue.enqueue(job),
    cacheGet: (model, source) => cache.get(model, source),
    cacheSet: (model, source, ja) => cache.set(model, source, ja),
    emit: (event) => {
      events.push(event);
      panel.post(toWebviewMessage(event));
    },
  });

  live = { document, panel, session, queue };

  panel.onMessage((message) => {
    if (message.kind === 'retry' && typeof message.index === 'number') {
      void session.retry(message.index);
    }
  });

  panel.onDispose(() => {
    queue.cancelAll();
    void cache.flush();
    live = undefined;
  });

  await session.open(document.getText());
  await cache.flush();
}

/** SessionEvent の Markdown を HTML へ変換して Webview のメッセージ契約へ写す。 */
function toWebviewMessage(event: SessionEvent): unknown {
  if (event.kind === 'init') {
    return {
      kind: 'init',
      blocks: event.blocks.map((view) => ({
        index: view.index,
        html: renderMarkdown(view.markdown),
        state: view.state,
        lineStart: view.lineStart,
        lineEnd: view.lineEnd,
      })),
    };
  }
  if (event.kind === 'block') {
    return {
      kind: 'block',
      index: event.index,
      html: renderMarkdown(event.markdown),
      state: event.state,
    };
  }
  return { kind: 'banner', text: event.text };
}
```

- [ ] **Step 6: ビルドと型検査を通す**

Run: `npm run build && npm run typecheck && npm run test:unit`
Expected: すべて成功

- [ ] **Step 7: 実際に動くことを目視確認**

1. Ollama が動いていることを確認: `curl http://127.0.0.1:11434/api/tags`
2. F5 で拡張開発ホストを起動
3. 英語の `.md`（数十行程度のもの）を開く
4. `Ctrl+Shift+P` → `md-ja: 日本語プレビューを開く`
5. 横のパネルに **全文が薄字の原文で即座に出る**こと、先頭から順に日本語へ差し替わっていくことを確認
6. Ollama を停止して再実行し、赤いバナーが出て原文表示のままになることを確認

- [ ] **Step 8: コミット**

```bash
git add -A
git commit -m "feat: 設定・パネル・拡張本体を配線して逐次翻訳を動かす" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: 保存時の部分再翻訳

**Files:**
- Modify: `src/session.ts`（`update` を追加）, `src/extension.ts`（`onDidSaveTextDocument` を配線）
- Test: `test/unit/session.test.ts`（追記）

**Interfaces:**
- Consumes: Task 4 `reconcile`、Task 12 `TranslationSession`
- Produces: `TranslationSession.update(text: string): Promise<void>`

- [ ] **Step 1: 失敗するテストを追記する**

`test/unit/session.test.ts` の末尾へ:

```ts
test('保存時に変わったブロックだけ翻訳し直す', async () => {
  const h = harness(async (s) => `JA:${s}`);
  await h.session.open('# Title\n\nAlpha.\n\nBravo.\n');
  assert.deepEqual(h.calls, ['# Title', 'Alpha.', 'Bravo.']);

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

  const init = h.events[0];
  assert.equal(init.kind, 'init');
  assert.deepEqual(
    init.kind === 'init' ? init.blocks.map((b) => [b.markdown, b.state]) : [],
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

  const init = h.events[0];
  assert.equal(init.kind, 'init');
  const alpha = init.kind === 'init' ? init.blocks[1] : undefined;
  assert.equal(alpha?.markdown, 'JA:Alpha.');
  assert.equal(alpha?.lineStart, 2);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run test:unit`
Expected: FAIL（`session.update is not a function`）

- [ ] **Step 3: `update` を実装する**

`src/session.ts` の import へ `reconcile` を足し、`TranslationSession` へ次を追加する:

```ts
import { reconcile } from './markdown/reconcile';
```

```ts
  /** 保存時に呼ぶ。内容が変わったブロックだけを訳し直す。 */
  async update(text: string): Promise<void> {
    const newBlocks = splitBlocks(text, this.deps.maxBlockChars);
    const { carried, pending } = reconcile(this.blockList, this.translations, newBlocks);

    this.blockList = newBlocks;
    this.translations = new Map(carried);

    this.deps.emit({ kind: 'banner', text: '' });
    this.deps.emit({
      kind: 'init',
      blocks: newBlocks.map((block) => {
        const ja = carried.get(block.index);
        return {
          index: block.index,
          markdown: ja ?? block.source,
          state: (ja !== undefined ? 'translated' : 'source') as BlockState,
          lineStart: block.lineStart,
          lineEnd: block.lineEnd,
        };
      }),
    });

    await this.run(pending);
  }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run test:unit && npm run typecheck`
Expected: どちらも PASS（Task 12 の 12 件 + 追加 3 件）

- [ ] **Step 5: 保存イベントを配線する**

`src/extension.ts` の `open()` 内、`await session.open(...)` の直前へ:

```ts
  const saveListener = vscode.workspace.onDidSaveTextDocument((saved) => {
    if (saved.uri.toString() !== document.uri.toString()) return;
    queue.cancelAll();
    void session.update(saved.getText()).then(() => cache.flush());
  });
  context.subscriptions.push(saveListener);

  panel.onDispose(() => saveListener.dispose());
```

既存の `panel.onDispose(...)` は残し、この行を追加で登録する。

- [ ] **Step 6: 目視確認**

F5 で起動し、英語 md を開いてプレビューを出す。原文の 1 段落だけ書き換えて保存し、
**その段落だけが再翻訳され、他は即座に日本語のまま**であることを確認する。

- [ ] **Step 7: コミット**

```bash
git add -A
git commit -m "feat(session): 保存時に変更ブロックだけ再翻訳する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: スクロール同期の配線

**Files:**
- Modify: `src/extension.ts`
- Test: 目視確認と Task 16 の統合テスト（純粋部分は Task 10 で検証済み）

**Interfaces:**
- Consumes: Task 10 `blockIndexAtLine` / `lineForBlock` / `SyncGate`、Task 12 `TranslationSession.blocks`

- [ ] **Step 1: エディタ → パネルの同期を書く**

`src/extension.ts` の import へ追加:

```ts
import { blockIndexAtLine, lineForBlock, SyncGate } from './panel/sync';
```

`open()` 内、`live = { ... }` の直後へ:

```ts
  const gate = new SyncGate();

  if (config.scrollSync) {
    const scrollListener = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (event.textEditor.document.uri.toString() !== document.uri.toString()) return;
      if (!gate.shouldAccept()) return;
      const topLine = event.visibleRanges[0]?.start.line;
      if (topLine === undefined) return;
      const index = blockIndexAtLine(session.blocks, topLine);
      if (index < 0) return;
      gate.markSelfInitiated();
      panel.post({ kind: 'scrollTo', index, ratio: 0 });
    });
    context.subscriptions.push(scrollListener);
    panel.onDispose(() => scrollListener.dispose());
  }
```

- [ ] **Step 2: パネル → エディタの同期を書く**

`panel.onMessage(...)` のハンドラへ、`retry` の分岐の後ろに追加:

```ts
    if (message.kind === 'scrolled' && typeof message.index === 'number') {
      if (!config.scrollSync || !gate.shouldAccept()) return;
      const line = lineForBlock(session.blocks, message.index);
      const editorForDocument = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === document.uri.toString(),
      );
      if (!editorForDocument) return;
      gate.markSelfInitiated();
      editorForDocument.revealRange(
        new vscode.Range(line, 0, line, 0),
        vscode.TextEditorRevealType.AtTop,
      );
    }
```

- [ ] **Step 3: ビルドと型検査を通す**

Run: `npm run build && npm run typecheck && npm run test:unit`
Expected: すべて成功

- [ ] **Step 4: 目視確認**

1. F5 で起動し、200 行程度の英語 md を開いてプレビューを出す
2. **原文側**を上下にスクロールし、訳文パネルが追従することを確認
3. **訳文パネル側**をスクロールし、原文エディタが追従することを確認
4. 両方を素早く交互に動かし、**画面が震え続ける無限ループにならない**ことを確認
5. 設定 `mdJaPreview.scrollSync` を false にして、同期が止まることを確認

- [ ] **Step 5: コミット**

```bash
git add -A
git commit -m "feat(panel): 原文と訳文の双方向スクロール同期を配線する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: 統合テスト

**Files:**
- Create: `.vscode-test.mjs`, `test/integration/extension.test.ts`, `test/fixtures/sample.md`
- Modify: `esbuild.mjs`（統合テストもバンドルする）, `package.json`（`test:integration`）

**Interfaces:**
- Consumes: Task 13 の `activate()` が返す `{ events: SessionEvent[] }`
- Produces: `npm run test:integration`

- [ ] **Step 1: 統合テストを書く**

`test/fixtures/sample.md`:

```markdown
# Getting Started

Install the package first.

```bash
npm install sample
```

Then run the command.
```

`test/integration/extension.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionEvent } from '../../src/session';

let server: Server;
let requests: string[] = [];

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
        requests.push(parsed.messages[1]!.content);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ message: { content: '訳文。' }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('条件が満たされないままタイムアウトしました');
}

suite('md-ja-preview 統合', () => {
  let events: SessionEvent[];

  suiteSetup(async () => {
    const endpoint = await startStub();
    const settings = vscode.workspace.getConfiguration('mdJaPreview');
    await settings.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
    await settings.update('model', 'stub-model', vscode.ConfigurationTarget.Global);

    const extension = vscode.extensions.getExtension('local.md-ja-preview');
    assert.ok(extension, '拡張が見つかること');
    events = ((await extension.activate()) as { events: SessionEvent[] }).events;
  });

  suiteTeardown(() => {
    server.close();
  });

  setup(() => {
    events.length = 0;
    requests = [];
  });

  test('パネルを開くと翻訳対象ブロックだけが逐次翻訳される', async () => {
    const fixture = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'sample.md');
    const document = await vscode.workspace.openTextDocument(fixture);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('mdJaPreview.open');

    await waitFor(() => events.filter((e) => e.kind === 'block' && e.state === 'translated').length === 4);

    // 見出し・段落 2 つの計 3 ブロックを翻訳し、コードフェンスは呼ばない。
    assert.equal(requests.length, 3);
    assert.ok(!requests.some((content) => content.includes('npm install sample')));

    const init = events.find((e) => e.kind === 'init');
    assert.ok(init && init.kind === 'init');
    assert.ok(init.blocks.every((block) => block.state === 'source'));
  });

  test('保存すると変更したブロックだけ再翻訳する', async () => {
    const document = vscode.window.activeTextEditor!.document;
    const editor = vscode.window.activeTextEditor!;
    requests = [];

    await editor.edit((builder) => {
      builder.replace(new vscode.Range(2, 0, 2, document.lineAt(2).text.length), 'Install it now.');
    });
    await document.save();

    await waitFor(() => requests.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(requests.map((c) => c.includes('Install it now.')), [true]);
  });
});
```

`.vscode-test.mjs`:

```js
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: 'stable',
  mocha: { ui: 'tdd', timeout: 60000 },
});
```

`package.json` の `scripts` へ:

```json
"pretest:integration": "npm run build",
"test:integration": "vscode-test"
```

`package.json` に `"publisher": "local"` があることを確認する（拡張 ID `local.md-ja-preview` を
統合テストが使う）。無ければ追加する。

- [ ] **Step 2: esbuild で統合テストもバンドルする**

`esbuild.mjs` を次で置き換える:

```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'mocha'],
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  {
    ...common,
    entryPoints: ['test/integration/extension.test.ts'],
    outdir: 'out/test/integration',
  },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
```

- [ ] **Step 3: 統合テストを実行する**

Run: `npm run test:integration`
Expected: 2 件 PASS。初回は VSCode のダウンロードが走るため数分かかる。

失敗する場合の切り分け:
- 拡張が見つからない → `package.json` の `publisher` と `name` を確認
- `__dirname` でフィクスチャに届かない → `out/test/integration` からの相対段数を実際の出力先で数え直す
- Webview 由来のエラーは無視してよい（このテストは `events` だけを見ている）

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "test: Ollama スタブを使った統合テストを追加する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: README と実データでの手動確認

**Files:**
- Create: `README.md`
- Modify: `package.json`（`test` スクリプトへ統合テストを含めるかの判断）

**Interfaces:**
- Consumes: すべてのタスク
- Produces: 配布可能な状態のリポジトリ

- [ ] **Step 1: README を書く**

`README.md` に次を含める。

- 何をする拡張か（英語 md をローカル Ollama で日本語へ逐次翻訳して別パネルへ出す。**日本語版ファイルは作らない**）
- 前提（Ollama が動いていること、モデルを `ollama pull` 済みであること）
- 使い方（英語 md を開く → `md-ja: 日本語プレビューを開く` → パネルを別ウィンドウに出したい場合は
  パネルのタブを右クリックして `Move Panel into New Window`）
- 設定項目 8 つの表（`src/config.ts` の既定値と一致させる）
- 挙動（開いた瞬間に原文が薄字で出て先頭から日本語に差し替わる／保存で変更ブロックだけ再翻訳／
  コードフェンス・URL・インラインコードは訳さない／訳文は `globalStorage` にキャッシュされる）
- 開発コマンド（`npm run build` / `npm test` / `npm run test:integration` / F5）

- [ ] **Step 2: 実データで手動確認する**

1. 数百行規模の英語 README（任意の OSS のもの）をローカルに保存して開く
2. プレビューを開き、次を確認する
   - 開いた瞬間に全文が薄字の原文で出る
   - 先頭から順に日本語へ差し替わる
   - コードブロックが原文のまま残り、日本語化されていない
   - リンクの URL が書き換わっていない
   - 途中でスクロールしても表示が飛ばない
   - 原文・訳文どちらをスクロールしても同期し、震え続けない
3. 1 段落だけ編集して保存し、その段落だけが訳し直されることを確認
4. 同じファイルを閉じて開き直し、キャッシュが効いて即座に日本語が出ることを確認
5. `mdJaPreview.model` を `ornith:35b` に変えて開き直し、訳が作り直される（キャッシュキーが変わる）ことを確認

観察した問題は、直すかここに記録するかを判断する。

- [ ] **Step 3: 全チェックを通す**

Run: `npm run build && npm run typecheck && npm run test:unit && npm run test:integration`
Expected: すべて成功

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "docs: README を追加し実データでの確認結果を反映する" -m "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 実行順の依存関係

```
Task 1 (基盤)
  ├─ Task 2 (分割) ─ Task 3 (上限分割)
  │                    └─ Task 4 (差分)
  ├─ Task 5 (検証)
  ├─ Task 6 (キャッシュ)
  ├─ Task 7 (Ollama)
  ├─ Task 8 (キュー)
  ├─ Task 9 (レンダリング)
  └─ Task 11 (Webview 骨格)
        Task 10 (同期の純粋部分)  ← Task 2 に依存

Task 12 (session) ← Task 2, 3, 5, 7, 11
Task 13 (配線)    ← Task 6, 7, 8, 9, 11, 12
Task 14 (保存)    ← Task 4, 12, 13
Task 15 (同期)    ← Task 10, 13
Task 16 (統合)    ← Task 13, 14
Task 17 (README)  ← すべて
```

Task 2〜11 は互いに独立しているため、並行して進めてよい（Task 3 は Task 2 の後、
Task 4 は Task 3 の後、Task 10 は Task 2 の後）。
