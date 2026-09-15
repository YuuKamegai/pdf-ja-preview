# md-ja-preview 設計書

- 日付: 2026-09-15
- 状態: 承認済み（実装計画待ち）
- リポジトリ: `<repo>`

## 1. 目的とスコープ

英語で書かれたローカルの Markdown ファイルを、ローカル LLM（Ollama）で日本語に訳し、
VSCode の別パネル（別ウィンドウへ切り出し可）へリアルタイムに表示する拡張機能。

**日本語版ファイルは作らない。** 訳文はワークスペースへ一切書き込まない。

### 初版に含むもの

- アクティブな `.md` に対する日本語プレビューパネル
- パネルを開いた時点で先頭から全文を逐次翻訳し、訳せたブロックから差し替え表示
- 日本語のみを Markdown レンダリングして表示（対訳表示はしない）
- 原文保存時に、内容が変わったブロックだけ再翻訳
- 原文エディタと訳文パネルの双方向スクロール同期
- 翻訳結果の永続キャッシュ（VSCode `globalStorage`）

### 初版に含まないもの（YAGNI）

- 原語の自動判定、英語以外の原語、日本語→英語
- mermaid・数式のレンダリング
- 対訳（原文と訳の交互）表示
- 未保存の入力に追従する再翻訳
- Marketplace 公開、vsix 署名

## 2. 前提環境

- VSCode 1.137 以上、Node.js 24 系、TypeScript
- Ollama が `http://127.0.0.1:11434` で稼働
- 既定モデル `qwen3.5:9b-q4_K_M`（thinking 対応モデルのため `think:false` が必須）
- 代替モデル `ornith:35b` は設定で選択可能

## 3. アーキテクチャ

```
src/extension.ts         activate / コマンド登録 / ライフサイクル
src/markdown/blocks.ts   原文md -> ブロック配列（種別・原文・ハッシュ・行範囲）
src/markdown/render.ts   訳文md -> HTML（markdown-it, html:false）
src/markdown/verify.ts   訳文の構造検証（fence数・リンク数の一致）
src/translate/ollama.ts  Ollama クライアント（/api/chat, stream, AbortSignal）
src/translate/queue.ts   翻訳キュー（並列度1・先頭優先・キャンセル）
src/cache.ts             globalStorage 上の永続キャッシュ
src/panel.ts             Webview 管理・postMessage プロトコル・スクロール同期
media/preview.js         Webview 側：ブロック単位の DOM 差し替えと scroll 通知のみ
media/preview.css        Webview 側スタイル（VSCode テーマ変数を使用）
```

### 責務の分離

各ユニットは単体でテスト可能であること。`blocks.ts` と `verify.ts` と `cache.ts` は
VSCode API に依存しない純関数群とし、`ollama.ts` は `fetch` を注入可能にする。
VSCode API に触れるのは `extension.ts` と `panel.ts` だけに閉じる。

### レンダリングの所在

Markdown → HTML の変換は**拡張側**で行い、Webview へは `{index, html}` を送る。
Webview 側の JavaScript は DOM 差し替えとスクロール通知だけを行う。
`markdown-it` は `html:false` で初期化するため原文中の生 HTML は無効化され、
Webview には厳格な CSP（`default-src 'none'`, nonce 付き script のみ）を張る。

## 4. データフロー

1. コマンド `md-ja: 日本語プレビューを開く` を実行、またはエディタタイトルのボタンを押す
2. 拡張がアクティブ `.md` のテキストをブロック分割する
3. **全ブロックを原文のまま薄字で即座に描画**（開いた瞬間から読める状態を作る）
4. キューが先頭ブロックから順に翻訳。キャッシュヒットは LLM を呼ばず即時差し替え
5. 1 ブロック完了ごとに該当 `<div data-block-index>` だけを日本語 HTML へ差し替える
6. 要素の置換であるためスクロール位置は保持される。閲覧位置によって翻訳順は変えない

## 5. ブロック分割

`markdown-it` の `parse` が返すトークン列から、ネスト深度 0 のブロックを単位として
原文をスライスする。各ブロックは次を保持する。

| フィールド | 内容 |
|---|---|
| `index` | 0 始まりの通し番号 |
| `kind` | `heading` / `paragraph` / `list` / `table` / `blockquote` / `fence` / `html` / `hr` |
| `source` | 原文そのまま（前後の空行は含まない） |
| `hash` | `sha256(source)` |
| `lineStart` / `lineEnd` | 原文の行範囲（`token.map` 由来、0 始まり・終端排他） |

### 翻訳しないブロック

`fence` / `html` / `hr` は翻訳せず原文のまま通す。

### 分割の上限

1 ブロックが `maxBlockChars`（既定 1500）を超える場合に限り、リストは項目単位、
表は行単位へ分割する。上限未満のリスト・表は 1 ブロックのまま訳し、訳語の一貫性を保つ。

## 6. 翻訳呼び出し

`POST {endpoint}/api/chat` を `stream:true` で呼ぶ。

```json
{
  "model": "<設定値>",
  "think": false,
  "stream": true,
  "options": { "temperature": 0.2 },
  "messages": [
    { "role": "system", "content": "<下記>" },
    { "role": "user", "content": "<直前の見出し文脈 + 対象ブロック原文>" }
  ]
}
```

`think:false` は必須。thinking 対応モデルで省略すると推論文が訳文へ混入する。

### system プロンプトの要件

- 技術文書の英日翻訳者として振る舞う
- 入力は Markdown ブロック 1 個。Markdown 記法をそのまま保持する
- インラインコード、コードフェンス、URL、数式、識別子は原文のまま残す
- 訳文だけを出力し、前置き・後書き・注釈を書かない

### 文脈

直前の見出しテキストのみを文脈として添える。全文を毎回渡さない。

### 訳文の構造検証

プロンプトの遵守を信用しない。`verify.ts` が原文と訳文で次を比較する。

- コードフェンスの個数
- リンク（`[...](...)`）の個数と URL 文字列の集合
- インラインコードの個数

いずれかが食い違ったブロックは訳を破棄し、原文表示のまま「再試行」ボタンを出す。

## 7. キャッシュと保存時の差分再翻訳

### キャッシュ

- キー: `sha256(model + "\n" + source)`
- 置き場: 拡張の `globalStorage`（ワークスペースには何も書かない）
- 値: 訳文 Markdown、生成日時
- モデルを変えるとキーが変わるため、訳文が混ざらない

### 保存時の更新

`onDidSaveTextDocument` を契機に再分割し、旧ブロックのハッシュ列と
新ブロックのハッシュ列を LCS で差分する。一致したブロックは既存の訳をそのまま持ち越し、
新規・変更ブロックだけをキューへ積む。行の挿入・削除が起きても対応がずれない。

## 8. スクロール同期

Webview の各ブロック要素は `data-line-start` / `data-line-end` を持つ。
行番号とブロックの対応表を双方向同期の唯一の基準とする。

- **エディタ → パネル**: `window.onDidChangeTextEditorVisibleRanges` から先頭可視行を取得し、
  対応ブロックとブロック内の相対位置を Webview へ送ってスクロールさせる
- **パネル → エディタ**: Webview の `scroll` から先頭可視ブロックを拡張へ通知し、
  `revealRange` で原文側を合わせる
- **ループ防止**: 自分が発火させた同期は約 250ms の抑制フラグで無視する
- 対応付けが行数比ではなくブロック単位であるため、逐次翻訳でブロック高が変化してもずれない
- 設定 `scrollSync`（既定 on）で無効化できる。別ウィンドウへ切り出しても同じ経路で動く

## 9. 設定項目

| 設定 | 既定値 | 内容 |
|---|---|---|
| `mdJaPreview.endpoint` | `http://127.0.0.1:11434` | Ollama のベース URL |
| `mdJaPreview.model` | `qwen3.5:9b-q4_K_M` | 翻訳モデル |
| `mdJaPreview.think` | `false` | thinking を有効にするか |
| `mdJaPreview.temperature` | `0.2` | 生成温度 |
| `mdJaPreview.maxBlockChars` | `1500` | ブロック分割の上限文字数 |
| `mdJaPreview.scrollSync` | `true` | 双方向スクロール同期 |
| `mdJaPreview.autoOpen` | `false` | `.md` を開いたら自動でパネルを開く |
| `mdJaPreview.requestTimeoutMs` | `120000` | 1 ブロックあたりのタイムアウト |

## 10. エラー処理

| 事象 | 挙動 |
|---|---|
| Ollama へ接続できない | パネル上部に赤帯。全文を原文表示のまま維持し、パネルは壊さない |
| 指定モデルが存在しない | 赤帯に導入コマンド（`ollama pull <model>`）を提示 |
| 個別ブロックの失敗・タイムアウト | そのブロックだけ原文表示のまま「再試行」ボタンを出す |
| 構造検証の不一致 | 訳を破棄し、失敗と同じ扱いにする |
| パネルを閉じた / 対象を切り替えた | 進行中のリクエストを `AbortSignal` で中断し、キューを捨てる |

## 11. テスト戦略

TDD で実装する。実装前にテストを書く。

### 単体（VSCode 非依存、`node:test` + `tsx`）

- `blocks.ts`: 見出し・段落・リスト・表・引用・fence・hr の分割、行範囲、`maxBlockChars` 超過時の分割
- 差分検出: 挿入・削除・置換・移動で持ち越しが正しいこと
- `cache.ts`: キー生成がモデル名と原文の両方に依存すること
- `verify.ts`: fence 数・リンク数・インラインコード数の不一致を検出すること
- `ollama.ts`: `fetch` をモックし、`think:false` の送出、ストリーム解釈、abort を検証
- スクロール同期: 行番号 → ブロック解決、抑制フラグの動作

### 統合（`@vscode/test-electron`）

- Ollama をローカル HTTP スタブへ差し替え、パネルを開いて逐次差し替えが起きること
- 保存時に変更ブロックだけが再翻訳されること（スタブへの呼び出し回数で検証）
- スクロール同期が往復し、無限ループしないこと

### 手動確認

実在の英語 Markdown（任意の OSS の README など、数百行規模のもの）を開き、
逐次表示・スクロール同期・保存時更新を目視確認する。

## 12. 未決事項

なし。
