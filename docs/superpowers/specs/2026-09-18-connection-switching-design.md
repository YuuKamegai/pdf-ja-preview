# 接続の登録と切り替え 設計

- 日付: 2026-09-18
- 状態: 承認済み（2026-09-18）。実装計画は未作成。実装未着手。
- 対象: PDF 日本語プレビュー（ローカル Web アプリ）のみ。VS Code 拡張は現状維持。
- 参照元: `<手元の別リポジトリ>` の「AI connections」。借りるのは設計であり、
  コードでもファイルでもない（Python と TypeScript で、保存先も別）。

## 1. 目的

「どの LLM へ送るか」を、**登録済みの接続を画面から選ぶ**だけで切り替えられるようにする。
ローカルの Ollama と外部 API（OpenAI 互換 / Azure OpenAI）を同じ一覧に並べ、行き来しても
訳し直しにならないようにする。

## 2. いま壊れている約束

PDF アプリの provider・送信先・モデル・クラウド送信許可は、すべて**起動時の環境変数**から
読んでいる。切り替えるには環境変数を書き換えてサーバーを立て直す必要があり、「登録して
選ぶ」という操作が存在しない。API キーもアプリに 1 つしか持てないため、ローカルとクラウドを
併用する利用者は毎回登録し直すことになる。

設計書 `2026-09-18-cloud-provider-and-split-design.md` §11 は「キーの複数登録と切り替え。
1 アプリ 1 キーとする」を対象外としていた。**本設計はこれを撤回する。**

## 3. 決めたこと（2026-09-18 の合意）

1. 対象は PDF Web アプリだけ。VS Code 拡張は `settings.json` + `SecretStorage` のまま。
2. 接続リストを唯一の真実にする。`PDF_JA_PROVIDER` / `PDF_JA_BASE_URL` / `PDF_JA_MODEL` /
   `PDF_JA_CLOUD_ALLOWED` は初回に一度だけ移行に使い、以後は読まない。
3. 1 つの接続が provider・送信先・**モデル**・鍵・信頼境界をまとめて持つ。
4. クラウド送信の許可は接続ごとに持つ。アプリ全体の許可フラグは置かない。
5. Use-LLLM の設定ファイルは読まない（案 A）。取り込み機能は作らない。

## 4. 保存する形

保存先は従来どおり `%LOCALAPPDATA%\pdf-ja-preview\settings.json`。

```jsonc
{
  "version": 2,
  "selected": "local",
  "connections": [
    {
      "name": "local",
      "provider": "ollama",
      "baseUrl": "http://127.0.0.1:11434",
      "model": "qwen3.5:9b-q4_K_M",
      "trust": "loopback"
    },
    {
      "name": "azure-mini",
      "provider": "azure",
      "baseUrl": "https://example.services.ai.azure.com/openai/v1",
      "model": "<deployment 名>",
      "trust": "cloud-allowed",
      "apiKeyProtected": "dpapi-current-user-v1:<base64>"
    }
  ]
}
```

### 4.1 各項目

| 項目 | 規則 |
|---|---|
| `name` | 識別子。1〜40 文字。制御文字を含まない。前後の空白を落とした結果が空でない。**大小文字を無視して一意**。 |
| `provider` | `ollama` / `openai` / `azure`。既存 `ProviderConfig` の `kind` と同じ値。 |
| `baseUrl` | provider ごとに検証（4.2）。 |
| `model` | Ollama はモデル名、`openai` はモデル名、`azure` は deployment 名。空を許す（未設定として扱い、選ぶと警告が出る）。 |
| `trust` | `loopback` または `cloud-allowed`。 |
| `apiKeyProtected` | DPAPI 暗号化済みの鍵。無ければ鍵未登録。**API にも画面にも返さない。** |

Use-LLLM の `lan_allowed`（LAN 上の Ollama）は入れない。現在の `assertSendable()` は Ollama を
ループバック限定にしており、そこを緩めるのは本設計の目的ではない。

### 4.2 保存時の検証

保存を受け付ける前に次を確かめ、1 つでも反したら 400 で断る。**断りの文に受け取った鍵を
含めない。**

- `provider === 'ollama'`: `trust` は `loopback` のみ。`baseUrl` はループバックの `http`/`https`。
- `provider === 'openai'`: `trust` は `cloud-allowed` のみ。`baseUrl` は `https`、ただし
  ループバックのホストに限り `http` を許す（手元の OpenAI 互換サーバー）。
- `provider === 'azure'`: `trust` は `cloud-allowed` のみ。`baseUrl` は
  `normalizeAzureBaseUrl()` を通す（公式ホスト・`https`・標準ポート・`/openai/v1`）。
  正規化後の値を保存する。
- 鍵を同時に渡す場合は、空でなく、制御文字を含まないこと（Task 14 と同じ規則）。

ループバックの OpenAI 互換サーバーにも `cloud-allowed` を要求するのはやや厳しいが、
`assertSendable()` の既存の分岐をそのまま使うため、規則を 1 本に保つ。

### 4.3 鍵を破棄する規則

Use-LLLM から借りる。**既存の接続の `provider` か `baseUrl` が変わったら、その接続の
`apiKeyProtected` を破棄する。** 別の送信先へ古い鍵を持ち越さないため。破棄したことは
応答で `configured: false` として伝わる。

### 4.4 version

`version` が 2 でない、または欠けている場合:

- `version` が無い（ファイルが無い場合を含む） → v1 とみなして移行（§6）。
- `version` が 3 以上 → **起動を止める**。「より新しい版で作られた設定です」と出す。
  読めない設定を上書きして利用者のデータを壊さない。

`version` が 2 でも中身が壊れている場合（`connections` が配列でない、全要素が §4.2 の検証を
通らない）は、起動を止めずに既定のローカル接続 1 件だけを持った状態で立ち上げ、起動ログに
警告を出す。訳が出ないだけで、画面から登録し直せるため。

## 5. API

すべて既存の token・Host・Origin 検査の内側に置く。`<name>` は `encodeURIComponent` して
道筋に載せる。

```
GET    /api/connections               → { selected, connections: [...] }
POST   /api/connections               追加        → 更新後の一覧
PUT    /api/connections/<name>        まるごと更新 → 更新後の一覧
DELETE /api/connections/<name>        削除        → 更新後の一覧
PUT    /api/connections/selected      { name }    → 更新後の一覧
POST   /api/connections/<name>/test   接続テスト   → { ok: boolean, detail: string }
```

一覧の各要素は次だけを含む。**鍵そのもの、断片、長さを返さない。**

```ts
{ name: string; provider: 'ollama' | 'openai' | 'azure';
  target: string;        // ホスト名だけ。パスも query も含めない
  model: string;
  trust: 'loopback' | 'cloud-allowed';
  configured: boolean }  // 鍵が登録されているか
```

`POST` / `PUT` の本文は `{ name, provider, baseUrl, model, trust, apiKey?: string | null }`。
`apiKey` を省略すると既存の鍵を保つ（§4.3 の破棄規則が優先する）。`apiKey: null` を渡すと
鍵だけを消す。文字列を渡すと登録・差し替える。

### 5.1 削除と選択

- 最後の 1 件は削除できない（400）。切り替え先が無い状態を作らない。
- 選択中の接続を削除したら、残りの先頭を選ぶ。
- `PUT /api/connections/selected` に存在しない名前を渡したら 404。
- 保存されている `selected` が、どの接続の名前とも一致しない場合（手で編集された等）は、
  読み込み時に先頭の接続を選ぶ。起動は止めない。

### 5.2 接続テスト

**保存済みの接続に対してのみ**行う。任意の URL を受け取らないので、この口が外部ホストの
探査に使われることはない。実装は preflight の探査を再利用する。

- `ollama`: `probeOllama()`（`GET {baseUrl}/api/tags`）。モデル一覧に `model` があるかも見る。
- `openai` / `azure`: `probeCloud()`（`GET {baseUrl}/models`、`azure` は `api-key` ヘッダー）。

応答本文は読まない（鍵やアカウント情報が混ざりうるため）。`detail` は「届いた」「届かない」
「鍵が未登録」「モデルが見つからない」程度の短い日本語で、送信先はホスト名だけを含む。

### 5.3 削除する API

Task 14 で足した `GET/PUT/DELETE /api/settings/api-key` は本設計に吸収して**削除する**。
鍵が接続ごとになり、「アプリに 1 つ」という前提が消えるため。

## 6. 環境変数からの移行

初回起動時（`version` の無い `settings.json`、またはファイルが無い）に一度だけ行う。

1. 環境変数から今までどおり provider を組み立て、接続 1 件にする。名前は provider 名
   （`ollama` / `openai` / `azure`）。同名があれば末尾に連番を付ける。
2. 保存済みの v1 の `apiKey`（DPAPI 暗号文）があれば、その接続へそのまま移す。再暗号化しない。
3. 作った接続がクラウドなら、ローカルの Ollama 接続（`local`、既定 endpoint、既定モデル）も
   併せて作る。切り替え先が無いと、この機能の意味が無い。
4. 作った接続を `selected` にする。
5. 書き出す。以後 `PDF_JA_PROVIDER` / `PDF_JA_BASE_URL` / `PDF_JA_MODEL` /
   `PDF_JA_CLOUD_ALLOWED` は読まない。

移行後もこれらの環境変数が設定されていたら、起動ログに 1 行出す。

```
注意: PDF_JA_PROVIDER などは使われません。送信先は画面の接続一覧で選びます。
```

`PDF_JA_PORT`・`PDF_JA_DATA_DIR`・`PDF_JA_STATIC_ROOT`・抽出器まわり・`PDF_JA_TEMPERATURE`・
`PDF_JA_REQUEST_TIMEOUT_MS` は今までどおり環境変数のまま。変えるのは「どの LLM へ送るか」の
4 つだけである。

## 7. 画面

### 7.1 ツールバー

今の「モデル」テキスト欄を**接続のドロップダウン**に置き換える。選ぶことが切り替えである。
隣に「接続を管理…」を置く。Task 14 でツールバーに置いた「APIキー」欄は、管理画面の中の
接続ごとの入力へ移す。

クラウドの接続を選んでいる間の送信先バナー（`cloud-notice`）は現状のまま。ローカルを
選んでいる間は消える。

### 7.2 管理画面

一覧・追加・編集・削除・接続テスト・鍵の入力を 1 か所で行う。各行には名前、provider、
送信先ホスト、モデル、鍵の有無を出す。**鍵の値は出さない。**

クラウドの接続を追加・編集するときは「原文をこの送信先へ送ることを許可する」を明示的に
チェックしないと保存できない（`trust: cloud-allowed`）。チェックの近くに、原文が外部へ
出ることを一文で書く。

### 7.3 鍵の無い接続へ切り替えたとき

切り替え自体は通す。翻訳は始めず、バナーに「API キーが登録されていません」と、その場から
登録できることを出す。登録すれば、そのまま続きを訳し始める（Task 14 の挙動を踏襲）。

## 8. 切り替えたとき、開いているセッションはどうなるか

本設計の芯であり、Task 14 の持ち越し（翻訳中に鍵を消しても、そのセッションの送信は
止まらない）をここで解消する。

- 選択が変わったら、**開いているセッション全部に即時反映する。** 実行中の翻訳を打ち切り、
  世代を上げ、新しい接続とモデルで訳し直す。
- 選択中の接続が編集・削除されたときも同じ。
- 訳文キャッシュの鍵にはモデル名が入っている（`translationKey()`）。したがって、前に同じ
  モデルで訳した分はキャッシュから即座に戻る。**ローカルとクラウドを往復しても訳し直しに
  ならない。**
- 新しい接続に鍵が無ければ、訳し直しは始めず §7.3 の案内を出す。

実装は `Session` に `setConnection(connection, model)` を足し、今の `setModel()` をそれに
吸収する。`http.ts` は選択が変わるたびに、開いている全セッションへこれを配る。

`POST /api/sessions` と `PATCH /api/sessions/<id>` から `model` を**廃止する**。モデルは
接続の持ち物になり、クライアントが指定する筋合いが無くなるため。`Snapshot` は `model`・
`target`・`cloud` を今までどおり持ち、加えて選択中の接続名 `connection` を持つ。

## 9. preflight

選択中の接続だけを見る。

| 状況 | 扱い |
|---|---|
| 配信資産が欠けている | 致命 |
| 抽出器（Docker または Python）が使えない | 致命 |
| 選択中の接続に鍵が無い | 警告。画面から登録できる |
| 選択中の接続にモデル名が無い | 警告。画面から直せる |
| 選択中の送信先へ届かない | 警告。訳が出ないだけなので止めない |

`trust` の不整合は保存時に弾くので、起動時には存在しない。結果として、**起動を止める致命は
配信資産と抽出器だけ**になる。

## 10. 試験

| 層 | 固めること |
|---|---|
| `settings-store` | v1→v2 移行（鍵の持ち越しを含む）、`provider`/`baseUrl` 変更で鍵を破棄、名前の一意性と形式、最後の 1 件を消させない、選択中を消したら先頭を選ぶ、未知の `version` で起動を止める |
| `http` | CRUD と選択切替の契約、鍵がどの応答にも現れないこと、ローカル接続を選んでいる間はクラウドへ 1 バイトも出ないこと、接続テストが保存済みの接続にしか当たらないこと |
| `session` | 切り替えで世代が上がり新しい接続で訳すこと、**古い接続への送信が止まること**、同じモデルへ戻すとキャッシュが効いて訳し直さないこと |
| `client-state` | 一覧と選択状態を組み立てる純関数 |
| E2E | ローカル↔クラウドの往復。Task 14 で立てた隣ポートのクラウド fixture を流用 |

鍵を扱う試験は、Task 14 と同じく合成した canary 値だけを使う。DPAPI を通す通しの試験は
Windows 限定で 1 本だけ置く。

## 11. 触る範囲

- `web/server/settings-store.ts` — 接続リストの読み書きへ作り替える（最も大きい）
- `web/server/http.ts` — 接続 API、鍵 API の削除、選択変更のセッションへの配布
- `web/server/main.ts` — 移行、`resolveConnection()` の差し替え、起動ログ
- `web/server/session.ts` — `setConnection()`
- `web/server/preflight.ts` — 選択中の接続を見る形へ
- `web/shared/protocol.ts` — `Snapshot.connection`、`model` の廃止
- `web/client/` — ドロップダウン、管理画面、API 呼び出し
- `docs/pdf-web.md`、`README.md` — 手順の書き換え
- `docs/superpowers/specs/2026-09-18-cloud-provider-and-split-design.md` — §7.3 の環境変数の表と
  §11 の「1 アプリ 1 キー」を撤回し、本設計を指す

## 12. 対象外

- VS Code 拡張の接続リスト化。拡張は `settings.json` の編集で切り替える。
- Use-LLLM の設定ファイルの取り込み。
- LAN 上の Ollama（`lan_allowed`）。
- 接続ごとのコンテキスト上限。Use-LLLM にはあるが、こちらはブロック単位で訳すため要らない。
- 接続の並べ替えと、複数接続の同時使用。
