# PDF 日本語プレビュー

英語の PDF を、原文と日本語訳を**左右に並べて読む**ためのローカル Web アプリです。原文は
PDF.js でそのまま描画し、段落ごとに訳を対応づけます。抽出は Docling（コンテナ）、翻訳は
既定ではローカルの [Ollama](https://ollama.com/) です。

翻訳結果を表示するだけで、**日本語版の PDF は作りません**。原文も書き換えません。既定では
この machine から出ません。クラウドを明示的に許可したときだけ、原文が指定した送信先へ
出ます。送信先（ローカル Ollama / OpenAI 互換 / Azure OpenAI）は**画面の接続一覧から
選んで切り替え**られます。

セットアップ・起動・制約・保存先・復旧方法は **[docs/pdf-web.md](docs/pdf-web.md)** を
読んでください。実文書での検証結果は
[docs/validation/pdf-web-initial.md](docs/validation/pdf-web-initial.md) にあります。

> Markdown 版（VS Code 拡張）は別リポジトリ `md-ja-preview` です。

## 使い方

```powershell
pwsh -File scripts/setup-pdf.ps1   # 初回だけ（Docker Desktop を起動しておく）
npm install
npm run build:web
npm run start:web                  # http://127.0.0.1:7391/
```

セットアップには **PowerShell 7 (`pwsh`)** が要ります。Windows 11 には同梱されていません
（`winget install --id Microsoft.PowerShell`）。理由は
[docs/pdf-web.md](docs/pdf-web.md#なぜ-powershell-7-が要るのか) にあります。

デスクトップから起動したいときは、ショートカットを作ります（`.exe` は作りません。
Smart App Control が未署名の実行ファイルを弾くためです）。こちらは 5.1 でも動きます。

```powershell
powershell -File scripts/install-shortcut.ps1
```

ショートカットはこのリポジトリの場所を焼き込みます。**リポジトリを移動したら
`-Force` を付けて貼り直してください。**

## 開発

```bash
npm install
npm run typecheck:web    # Web とブラウザ試験の型検査
npm run test:web         # 契約・制御・API の単体試験
npm run build:web        # dist-web/ を作る
npm run test:e2e:web     # 実ブラウザでの試験（Edge を使う）
```

```powershell
& ./.venv-pdf/Scripts/python.exe -m pytest python/tests -q   # 抽出の正規化と前検査
```

`test:web` と `test:e2e:web` は `127.0.0.1:7391` 前後のポートを使います。プレビューの
サーバーを立てたまま走らせると `EADDRINUSE` で落ちるので、先に止めてください。

## `src/translate/` は md-ja-preview と複製関係にあります

`src/translate/`（`provider.ts`・`ollama.ts`・`openai.ts`・`errors.ts`）は VS Code 拡張
リポジトリ `md-ja-preview` と**同じ内容の複製**です。npm パッケージへ切り出す運用は
この規模に見合わないと判断し、複製を選びました。

**片方を直したら、もう片方も見てください。** 送信先の判定（`assertSendable()`）や Azure の
URL 制限のような安全に関わる決まりは、両方に同じものが入っていなければ意味がありません。
