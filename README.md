# md-ja Preview

英語の文書を、ローカルの [Ollama](https://ollama.com/) で日本語へ逐次翻訳して**並べて読む**
ための道具です。二つあります。

| | 対象 | 使い方 |
|---|---|---|
| **VS Code 拡張** | Markdown | 本 README（以下） |
| **ローカル Web アプリ** | PDF | [docs/pdf-web.md](docs/pdf-web.md) |

どちらも翻訳結果を表示するだけで、**日本語版のファイルは作りません**。原文も書き換えません。
文書はこの machine から出ません。

---

## VS Code 拡張（Markdown）

英語の Markdown を、ローカルの Ollama で日本語へ逐次翻訳し、**別パネルに表示する**
VS Code 拡張です。

## 前提

- Ollama がローカルで動いていること（既定では `http://127.0.0.1:11434`）
- 使うモデルを `ollama pull` 済みであること

```bash
ollama pull qwen3.5:9b-q4_K_M
```

モデルが未導入のときは、パネル上部のバナーに `ollama pull` コマンドが出ます。

## 使い方

1. 英語の Markdown ファイルを開く
2. コマンドパレットから **`md-ja: 日本語プレビューを開く`** を実行する
3. 右隣に訳文パネルが開く

パネルを別ウィンドウへ出したいときは、パネルのタブを右クリックして
`Move Panel into New Window` を選びます。

## 挙動

- 開いた瞬間に**全文が薄字の原文**で出て、**先頭のブロックから順に日本語へ差し替わります**。
  翻訳は並列度 1 で、上から順に進みます。
- **保存すると、内容が変わったブロックだけ**を訳し直します。変わっていないブロックは
  日本語のまま残ります。
- **コードフェンス・水平線・生 HTML は翻訳しません**。原文のまま確定します。
- 訳文はブロックごとに構造検証され、**インラインコードやリンク URL が書き換わった訳は採用しません**
  （そのブロックは原文のまま `error` 表示になり、クリックで再試行できます）。
- 訳文は `globalStorage` にキャッシュされます。キーは **モデル名と原文**の組なので、
  同じファイルを開き直せば即座に日本語が出ます。モデルを変えると訳し直します。
- 原文エディタと訳文パネルのスクロールは双方向に同期します
  （`mdJaPreview.scrollSync` で切れます）。

## 設定

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| `mdJaPreview.endpoint` | `http://127.0.0.1:11434` | Ollama のベース URL。 |
| `mdJaPreview.model` | `qwen3.5:9b-q4_K_M` | 翻訳に使う Ollama のモデル名。 |
| `mdJaPreview.think` | `false` | thinking を有効にする。有効にすると推論文が訳文へ混ざることがある。 |
| `mdJaPreview.temperature` | `0.2` | 生成温度。 |
| `mdJaPreview.requestTimeoutMs` | `120000` | 1 ブロックあたりのタイムアウト（ミリ秒）。 |
| `mdJaPreview.maxBlockChars` | `1500` | この文字数を超えるリストを項目単位で分割する。 |
| `mdJaPreview.scrollSync` | `true` | 原文エディタと訳文パネルのスクロールを同期する。 |
| `mdJaPreview.autoOpen` | `false` | Markdown を開いたとき自動で日本語プレビューを開く。 |

---

## PDF 日本語プレビュー（ローカル Web アプリ）

英語の PDF を、原文と日本語訳を左右に並べて読むためのローカルアプリです。原文は PDF.js で
そのまま描画し、段落ごとに訳を対応づけます。抽出は Docling（コンテナ）、翻訳は Ollama です。

セットアップ・起動・制約・保存先・復旧方法は **[docs/pdf-web.md](docs/pdf-web.md)** を
読んでください。実文書での検証結果は
[docs/validation/pdf-web-initial.md](docs/validation/pdf-web-initial.md) にあります。

```powershell
pwsh -File scripts/setup-pdf.ps1   # 初回だけ（Docker Desktop を起動しておく）
npm run build:web
npm run start:web                  # http://127.0.0.1:7391/
```

---

## 開発

```bash
npm install
npm run build            # dist/extension.js と統合テストをバンドルする
npm test                 # 型検査 + 単体テスト
npm run test:integration # VS Code を起動して統合テスト（初回は VS Code の DL が走る）
```

VS Code でこのリポジトリを開き **F5** を押すと、拡張がロードされた別ウィンドウが起動します。

PDF 側は次で確かめます。

```bash
npm run typecheck:web    # Web とブラウザ試験の型検査
npm run test:web         # 契約・制御・API の単体試験
npm run build:web        # dist-web/ を作る
npm run test:e2e:web     # 実ブラウザでの試験（Edge を使う）
```

```powershell
& ./.venv-pdf/Scripts/python.exe -m pytest python/tests -q   # 抽出の正規化と前検査
```
