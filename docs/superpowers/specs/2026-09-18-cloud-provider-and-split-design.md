# クラウド LLM 対応とリポジトリ分離 設計

- 日付: 2026-09-18
- 状態: 承認済み（2026-09-18）。実装計画は未作成。実装未着手。
- 合意済み: OpenAI 互換の汎用 endpoint、拡張は SecretStorage・Web は DPAPI、送信は明示 opt-in で画面に常時表示、分離は `git subtree split` で履歴を保つ。

## 1. 目的

Markdown 版（VS Code 拡張）と PDF 版（ローカル Web アプリ）の両方で、ローカルの Ollama に
加えてクラウドの LLM を API キーで使えるようにする。そのうえで PDF 版を別リポジトリへ
分離し、両方を GitHub の public リポジトリとして公開する。

参照元は `<手元の別リポジトリ>`。そこから借りるのは実装ではなく次の 4 つの作りである。

- provider（ollama / クラウド）と trust（ローカル / クラウド送信許可）を別の軸として持つ。
- クラウドは明示許可がなければ保存も送信もできない。
- API キーは OS の保護機構で暗号化して保存し、UI にも API にも値を返さない。
- 送信先のホストを検証し、想定外の宛先を弾く。

## 2. いま壊れる約束

この repo の中心的な約束は「文書はこの machine から出ません」であり、文言だけでなく
`web/server/main.ts` の `assertLoopback()` がループバック以外の endpoint を例外で撥ねる形で
実装されている。クラウド対応はこの約束を条件付きに変える。

約束は次へ書き換える。**「既定ではこの machine から出ません。クラウドを明示的に許可した
ときだけ、原文が指定した送信先へ出ます。」** README・`docs/pdf-web.md` の該当箇所をすべて
この表現へ揃える。

e2e の「外部への通信をしない」試験はブラウザ発の通信を見ており、クラウド呼び出しは
サーバー側で起きるため、この試験は変更しない。破れるのは試験ではなく約束のほうである。

## 3. 段取り

3 段階に分け、各段階の終わりで承認を取る。段階をまたいで同時に進めない。

| 段階 | 中身 | 終了条件 |
|---|---|---|
| 1 | クラウド対応（両アプリ） | 既存 356 件と新規試験が全部緑。実キーで実翻訳を 1 回通す |
| 2 | PDF 側を別ディレクトリへ分離 | 両リポジトリが独立して build・test 緑 |
| 3 | GitHub public へ公開、漏洩監査 | push 済み。監査結果を報告 |

この設計書は 3 段階すべてを対象とするが、**実装計画は段階 1 だけを対象に書く**。
段階 2 と 3 の計画は、段階 1 の承認後に、そこで確定した実態を見てから書く。

## 4. provider 抽象（段階 1）

新規 `src/translate/provider.ts` を両アプリの唯一の入口にする。

```ts
export type ProviderConfig =
  | { kind: 'ollama'; endpoint: string; model: string; think: boolean;
      temperature: number; timeoutMs: number }
  | { kind: 'openai'; baseUrl: string; apiKey: string; model: string;
      temperature: number; timeoutMs: number };

export function assertSendable(config: ProviderConfig, cloudAllowed: boolean): void;
export function translate(args: TranslateArgs): Promise<string>;
export function describeTarget(config: ProviderConfig): string;
```

`translate()` の引数は既存 `translateBlock()` と同じ形（`source`・`headingContext`・`config`・
`signal`・`fetchImpl`・`onDelta`・`systemPrompt`）にする。これにより呼び出し側の変更は
`src/extension.ts` と `web/server/translation.ts` の 2 箇所に閉じる。

`assertSendable()` は次を検査し、どれかに反したら例外を投げる。**保存経路と送信経路の
両方でこれを呼ぶ。**

- `kind === 'openai'` かつ `cloudAllowed !== true` → 拒否。
- `kind === 'openai'` で `baseUrl` が `https:` でない → 拒否。ただしループバックのホストに
  限り `http:` を許す（手元の OpenAI 互換サーバーを使う場合）。
- `kind === 'openai'` で `apiKey` が空 → 拒否。
- `kind === 'ollama'` で endpoint がループバックでない → 拒否（既存 `assertLoopback` 相当）。

`describeTarget()` は表示用にホスト名だけを返す（例 `api.openai.com`）。**API キーを含めない。
パスもクエリも含めない。**

## 5. OpenAI 互換クライアント（段階 1）

新規 `src/translate/openai.ts`。

- `POST {baseUrl}/chat/completions`、`Authorization: Bearer <apiKey>`、`stream: true`。
- SSE を読む。`data: ` 行の JSON から `choices[0].delta.content` を繋ぐ。`data: [DONE]` で終端。
  chunk がイベント境界で分割して届く前提で、行バッファを持つ（既存 Ollama 実装と同じ作り）。
- 本文とプロンプトは既存と共有する。`SYSTEM_PROMPT` / `PDF_SYSTEM_PROMPT`、`stripOuterFence`、
  `verifyTranslation` はそのまま使う。**訳文の扱いと検証は一切変えない。**

例外は既存の分類へ寄せる。`src/session.ts` のバナー生成が型で分岐しているため、型を増やす
ときはそこも更新する。

| HTTP / 状況 | 投げるもの | 画面に出す言葉 |
|---|---|---|
| 401 / 403 | `ProviderAuthError`（新規） | API キーが拒否されました。登録し直してください |
| 404 / `model_not_found` | `ModelMissingError` | モデルがありません: `<model>` |
| 429 | `ProviderRateLimitError`（新規） | 送信先が混んでいます。しばらく待って再試行してください |
| その他 5xx・接続不可・タイムアウト | `ProviderUnavailableError` | 送信先へ接続できません: `<host>` |

命名は次で固定する。新しい名前を正とし、既存の名前は別名（`export { X as Y }`）として
残す。`src/session.ts:35` と `test/unit/session.test.ts` が既存の名前を `instanceof` で見て
いるため、別名は同一のクラスを指すこと。既存試験を一行も書き換えずに通すことを条件とする。

| 新しい名前（正） | 残す別名 |
|---|---|
| `ProviderUnavailableError` | `OllamaUnavailableError` |
| `ModelMissingError` | `OllamaModelMissingError` |
| `ProviderAuthError` | （新規。別名なし） |
| `ProviderRateLimitError` | （新規。別名なし） |

## 6. VS Code 拡張（段階 1）

追加する設定。

| 設定 | 既定 | 説明 |
|---|---|---|
| `mdJaPreview.provider` | `ollama` | `ollama` または `openai` |
| `mdJaPreview.baseUrl` | `https://api.openai.com/v1` | `openai` のときの送信先 |
| `mdJaPreview.cloudAllowed` | `false` | 原文を外部へ送ることを許可する |

モデル名は既存の `mdJaPreview.model` を両 provider で共用する。既定値
`qwen3.5:9b-q4_K_M` は Ollama 用なので、**`provider === 'openai'` のときは利用者が必ず
明示指定する**。既定のクラウドモデルは置かない。モデル名は時期で陳腐化し、既定を置くと
docs が腐るうえ、意図しない送信先モデルへ課金が発生しうるためである。未指定のまま
クラウドを選んだ場合は、赤バナー「クラウドで使うモデル名を設定してください」を出して
翻訳を開始しない。

**API キーは設定に置かない。** `settings.json` は同期・共有されうるため、キーが平文で
流出する経路になる。コマンドで登録する。

- `md-ja: API キーを登録` → `showInputBox({ password: true })` → `context.secrets.store()`
- `md-ja: API キーを削除` → `context.secrets.delete()`

パネルの表示は 3 状態。

- `provider === 'openai'` かつ `cloudAllowed === false` → 赤バナー「クラウドを使うには許可が
  必要です」と設定を開くリンク。**翻訳を開始しない。**
- `provider === 'openai'` かつキー未登録 → 赤バナー「API キーが未登録です」と登録コマンドへの
  リンク。**翻訳を開始しない。**
- クラウドで動作中 → パネル上部に常時「原文を `<host>` へ送信しています」を表示する。
  スクロールで消えない位置に置く。

## 7. PDF Web アプリ（段階 1）

### 7.1 キーの登録は CLI で行う

キーを受け取る HTTP API を**作らない**。この app は「API に起動時 token を要求し、token は
ログにも HTML 以外にも出さない」という posture で作られている。そこへ平文のキーを受ける口を
新設すると、その posture を下げることになる。

```
node dist-web/server.cjs --set-key      非表示で入力し、暗号化して保存する
node dist-web/server.cjs --clear-key    保存済みのキーを消す
```

`--set-key` は TTY からのみ受け付ける。TTY でなければ拒否する（パイプ経由でキーが履歴や
ログへ残るのを防ぐ）。入力はエコーしない。

### 7.2 保存と暗号化

保存先は `%LOCALAPPDATA%\pdf-ja-preview\settings.json`。

```json
{ "apiKey": "dpapi-current-user-v1:<base64>" }
```

Node に DPAPI は無い。ネイティブモジュールはこの machine の Smart App Control が弾く
（`failures/astro-native-binding-blocked-by-app-control.md`）。したがって**署名済みの
`powershell.exe` を経由して** `System.Security.Cryptography.ProtectedData` を呼ぶ。
2026-09-18 に暗号化と復号の往復を実測で確認済み。

新規 `web/server/secret.ts` に閉じ込める。接点は `protect(value)` と `unprotect(value)` の
2 関数だけにする。Windows 以外では明示的に失敗させる（黙って平文で保存しない）。

### 7.3 設定

| 変数 | 既定 | 意味 |
|---|---|---|
| `PDF_JA_PROVIDER` | `ollama` | `ollama` または `openai` |
| `PDF_JA_BASE_URL` | `https://api.openai.com/v1` | `openai` のときの送信先 |
| `PDF_JA_CLOUD_ALLOWED` | （空） | `1` で外部送信を許可する |

モデル名は既存の `PDF_JA_MODEL` を共用する。拡張側と同じ理由で、`openai` のときは
明示指定を必須とし、既定のクラウドモデルは置かない。未指定なら preflight で致命とする。

`readSettings()` は `provider === 'ollama'` のときだけ `assertLoopback()` を適用する。
`openai` のときは `assertSendable()` の検査へ差し替える。

### 7.4 画面

`GET /api/session` の応答に `target`（ホスト名のみ）と `cloud`（真偽）を足す。**キーそのもの、
キーの断片、キーの長さを返さない。** 画面上部に、クラウド動作中は常時バナーを出す。

### 7.5 preflight

`web/server/preflight.ts` にクラウド用の判定を足す。

| 状況 | 扱い |
|---|---|
| `provider === 'openai'` かつ許可なし | 致命。許可の付け方を出す |
| `provider === 'openai'` かつキー未登録 | 致命。`--set-key` を促す |
| `provider === 'openai'` で `GET {baseUrl}/models` が通らない | 警告。訳が出ないだけなので止めない |

疎通確認の応答本文はログに出さない（キーやアカウント情報が混ざりうるため）。

## 8. 試験（段階 1）

- `assertSendable()` の判定表。許可なし・非 https・キー空・ループバック互換サーバー・
  ollama の非ループバック。
- SSE パーサ。分割到着、`[DONE]`、空 delta、エラーイベント、壊れた JSON。
- 例外分類。401・403・404・429・500・接続不可・タイムアウト。
- `describeTarget()` がホスト名だけを返し、キーもパスも含まないこと。
- DPAPI の往復。実際に暗号化し、復号して同じ値が戻ること。
- **キーが外へ出ないことの明示的な試験。** ログ出力、`/api/session` の応答、`/api/*` の
  全応答、エラーメッセージのいずれにも、登録したキーの文字列が現れないことを確かめる。
- 既存 356 件（`npm test` 118 / `test:web` 238）を全部通す。e2e 22 件も通す。
- 実キーでの実翻訳を 1 回通す。これは自動試験にしない（キーを CI へ置かないため）。

## 9. 分離（段階 2）

PDF 側を `<repo>` へ移す。`git subtree split` で履歴を保つ。

移すもの: `web/`、`python/`、`dist-web` のビルド設定、`docs/pdf-web.md`、
`docs/validation/pdf-web-initial.md`、`docs/superpowers/**/pdf-ja-web*`、`scripts/setup-pdf.ps1`、
`scripts/validate-pdf.ps1`、`scripts/create-pdf-fixtures.py`、`scripts/inspect-document.ts`、
`scripts/install-shortcut.ps1`、`scripts/make-icon.ps1`、`media/pdf-ja.ico`、
`test/web/`、`test/web-e2e/`、`playwright.pdf.config.ts`。

残すもの: `src/`（`translate/` を除く）、`media/preview.*`、`test/unit/`、`test/integration*`、
`esbuild.mjs`、`.vscode-test.mjs`、拡張の `package.json` 設定。

`src/translate/`（`ollama.ts`・`provider.ts`・`openai.ts`・`queue.ts`）は両方が要る。**複製する。**
npm パッケージとして切り出す案は採らない。2 つの repo のために private registry か
GitHub Packages の運用を足すのは、この規模に見合わない。複製したことと、片方を直したら
もう片方も見る必要があることを、両方の README に明記する。

`package.json` はそれぞれの repo で必要なものだけに削る。PDF 側は `vscode` 関連の
devDependencies を落とし、拡張側は `pdfjs-dist` と `@playwright/test` を落とす。

分離後、両方で全試験を通すまでを段階 2 の終了条件とする。

## 10. 公開と監査（段階 3）

GitHub の public リポジトリを 2 つ作り push する。リポジトリ名と説明は公開の直前に確認する。

公開前に次を確認し、結果を報告する。**1 つでも引っかかったら公開しない。**

- API キー、token、資格情報が履歴のどのコミットにも無いこと。文字列検索は working tree
  だけでなく `git log -p` 全体に対して行う。
- 絶対パス（`<home>...`）がコード・設定・ドキュメント・ロックファイルに無いこと。
  ある場合は相対パスか環境変数へ置き換える。ただし docs 内の例示で、利用者が自分の環境へ
  読み替える前提のものは残してよい。その場合は `<repo>` のような記法へ揃える。
- メールアドレスが git の author 以外に無いこと。
- 検証に使った実文書（論文 PDF）と、そこから作られた抽出 JSON・訳文が入っていないこと。
- `%LOCALAPPDATA%` 配下のデータ、`.venv-pdf*`、`node_modules`、`dist*`、`test-results` が
  `.gitignore` で除外され、履歴にも無いこと。
- `md-ja-preview.vsix` のようなビルド済み配布物に、絶対パスやローカル固有の情報が
  埋まっていないこと。埋まっていれば配布物を履歴から外す。
- `.claude` 配下、`.superpowers`、`.ai-team`、`.agents` のようなエージェント設定が入っていないこと。

## 11. 対象外

- Anthropic・Gemini の専用実装。OpenAI 互換の口で扱えないものは今回作らない。
- クラウド利用の課金・使用量の表示。
- キーの複数登録と切り替え。1 アプリ 1 キーとする。
- Windows 以外での鍵の保存。PDF 版は DPAPI 前提であり、Windows 以外では明示的に失敗する。
- npm パッケージによる共通コードの共有（§9 の理由により複製する）。

## 12. 未確定

- GitHub のリポジトリ名と説明。段階 3 の直前に確認する。これ以外に未確定な点は無い。
