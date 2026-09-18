# Azure OpenAI と画面内 API キー登録 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Azure OpenAI v1 を正式な provider として扱い、PDF WebUI から暗号化 API キーを登録でき、最新版 VS Code 拡張でもコマンドから登録できるようにする。

**Architecture:** 共通 provider 層に `azure` を追加し、既存 Chat Completions 実装を認証ヘッダーだけ切り替えて再利用する。PDF サーバーは鍵をセッション作成時に `SettingsStore` から読み、鍵未登録でも設定画面を配信する。VS Code は既存の `SecretStorage` を維持し、Azure の設定と配布物だけを追加する。

**Tech Stack:** TypeScript, Node.js HTTP, VS Code Extension API, DPAPI, node:test, Playwright, esbuild, vsce

**Spec:** `docs/superpowers/specs/2026-09-18-cloud-provider-and-split-design.md` および 2026-09-18 に承認された Azure/OpenAI キー登録追補

## Global Constraints

- API キーをレスポンス、ログ、HTML、例外、テストスナップショットへ出さない。
- Azure は `https://<resource>.openai.azure.com/openai/v1/` または `https://<resource>.services.ai.azure.com/openai/v1/` だけを受け付け、`api-key` ヘッダーを使う。
- Azure の `model` はモデル名ではなく Azure deployment name として扱う。
- PDF の保存値は Windows DPAPI CurrentUser で暗号化し、VS Code は `SecretStorage` に保存する。
- `.vscode/launch.json` の利用者設定値を上書きしない。

---

### Task 13: 共通 Azure provider

**Files:**
- Modify: `src/translate/openai.ts`
- Modify: `src/translate/provider.ts`
- Modify: `src/config.ts`
- Modify: `package.json`
- Modify: `web/server/main.ts`
- Modify: `web/server/preflight.ts`
- Test: `test/unit/openai.test.ts`
- Test: `test/unit/provider.test.ts`
- Test: `test/unit/config.test.ts`
- Test: `test/unit/contributes.test.ts`
- Test: `test/web/main.test.ts`
- Test: `test/web/preflight.test.ts`

**Interfaces:**
- Produces: `ProviderConfig` の `{ kind: 'azure'; baseUrl; apiKey; model; temperature; timeoutMs }` 分岐。
- Produces: Azure URL 正規化・検証と、Chat Completions の `api-key` 認証。
- Consumes: 既存 `translateWithOpenAi()` の本文、SSE、エラー分類。

- [ ] **Step 1: Azure provider、公式ホスト制限、`api-key` ヘッダーを期待する失敗テストを書く。**
- [ ] **Step 2: `npm run test:unit -- --test-name-pattern azure` と対象 Web テストを実行し、未実装で失敗することを確認する。**
- [ ] **Step 3: Azure設定型、URL正規化、認証ヘッダー切替、設定解決、preflightを最小実装する。**
- [ ] **Step 4: `npm run typecheck && npm run typecheck:web && npm run test:unit && npm run test:web` を実行する。**
- [ ] **Step 5: `feat(provider): Azure OpenAI v1 を追加` でコミットする。**

### Task 14: PDF WebUI の API キー登録

**Files:**
- Modify: `web/server/http.ts`
- Modify: `web/server/main.ts`
- Modify: `web/server/preflight.ts`
- Modify: `web/client/api.ts`
- Modify: `web/client/main.ts`
- Modify: `web/client/index.html`
- Modify: `web/client/style.css`
- Test: `test/web/http.test.ts`
- Test: `test/web/main.test.ts`
- Test: `test/web/client-state.test.ts`
- Test: `test/web/no-key-leak.test.ts`
- Test: `test/web-e2e/preview.spec.ts`

**Interfaces:**
- Produces: `GET /api/settings/api-key -> { configured: boolean }`。
- Produces: `PUT /api/settings/api-key`（`{ apiKey: string }`）と `DELETE /api/settings/api-key`。
- Produces: `AppDeps.resolveConnection(): Promise<ProviderConnection>`。セッション作成時に最新の暗号化鍵を読む。
- Consumes: `SettingsStore.setApiKey/readApiKey/clearApiKey` と既存 Host/Origin/token 防御。

- [ ] **Step 1: 鍵の状態・登録・削除、レスポンス非漏えい、未登録セッションの409を期待する失敗テストを書く。**
- [ ] **Step 2: 対象テストを実行し、APIとUIが未実装で失敗することを確認する。**
- [ ] **Step 3: 鍵API、動的接続解決、パスワード入力、登録・削除ボタン、状態表示を実装する。**
- [ ] **Step 4: `npm run typecheck:web && npm run test:web && npm run build:web && npm run test:e2e:web` を実行する。**
- [ ] **Step 5: `feat(pdf-web): 画面から API キーを管理できるようにする` でコミットする。**

### Task 15: VS Code 最新版の配布と総合検証

**Files:**
- Modify: `README.md`
- Modify: `docs/pdf-app.md`
- Modify: `docs/superpowers/specs/2026-09-18-cloud-provider-and-split-design.md`
- Generated: `md-ja-preview.vsix`

**Interfaces:**
- Consumes: `mdJaPreview.provider = "azure"`、`mdJaPreview.baseUrl`、`mdJaPreview.model`、`mdJaPreview.cloudAllowed`、`mdJaPreview.setApiKey`。
- Produces: `code --install-extension md-ja-preview.vsix --force` で導入できる最新版 VSIX。

- [ ] **Step 1: Azure設定例、deployment名、PDF WebUIとVS Codeコマンドの鍵登録手順を文書化する。**
- [ ] **Step 2: `npm run typecheck && npm run test:unit && npm run typecheck:web && npm run test:web && npm run build && npm run build:web && npm run test:e2e:web && npm run test:integration` を実行する。**
- [ ] **Step 3: `npm run package` で VSIX を作成し、`code --install-extension md-ja-preview.vsix --force` で再導入する。**
- [ ] **Step 4: 導入済み拡張の `package.json` と `dist/extension.js` に Azure と `mdJaPreview.setApiKey` が含まれることを検査する。**
- [ ] **Step 5: APIキーを使わない自動試験結果と、実キー疎通が利用者操作待ちであることを記録してコミットする。**

