/**
 * 起動前の前提チェック。
 *
 * ショートカットからの起動では、失敗しても窓が一瞬で消えて何も読めない。
 * ここで先に「何が足りないか」と「どう直すか」を言葉にしておく。
 *
 * 探査（system を触る側）と判定（純粋な側）を分けてある。判定だけを試験する。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

import { exists } from './storage';

const execFileAsync = promisify(execFile);

/** これが無いと画面が出ない。`npm run build:web` の産物。 */
export const REQUIRED_ASSETS = ['index.html', 'app.js', 'style.css', 'pdfjs/pdf.worker.mjs'];

export type ProblemLevel = 'fatal' | 'warning';

export interface Problem {
  level: ProblemLevel;
  /** 症状。 */
  title: string;
  /** 直し方。そのまま打てる形で書く。 */
  remedy: string;
}

export type ExtractorFacts =
  | { kind: 'docker'; daemon: boolean; image: boolean }
  | { kind: 'python'; ok: boolean };

export interface PreflightFacts {
  missingAssets: string[];
  extractor: ExtractorFacts;
  ollama: { reachable: boolean; models: string[] };
  cloud?: { hasKey: boolean; model: string; reachable: boolean };
}

export interface PreflightContext {
  image: string;
  python: string;
  endpoint: string;
  model: string;
  kind: 'ollama' | 'openai' | 'azure';
  /** 送信先のホスト名。表示にだけ使う。 */
  target: string;
}

/** `gemma3` と `gemma3:latest` は同じものとして扱う。 */
function sameModel(wanted: string, found: string): boolean {
  if (wanted === found) return true;
  return !wanted.includes(':') && found === `${wanted}:latest`;
}

export function judgePreflight(facts: PreflightFacts, context: PreflightContext): Problem[] {
  const fatal: Problem[] = [];
  const warnings: Problem[] = [];

  if (facts.missingAssets.length > 0) {
    fatal.push({
      level: 'fatal',
      title: `画面の資産がありません: ${facts.missingAssets.join(', ')}`,
      remedy: 'npm run build:web を実行してください。',
    });
  }

  if (facts.extractor.kind === 'docker') {
    if (!facts.extractor.daemon) {
      fatal.push({
        level: 'fatal',
        title: 'Docker が応答しません。抽出（Docling）はコンテナで動きます。',
        remedy: 'Docker Desktop を起動してから、もう一度開いてください。',
      });
    } else if (!facts.extractor.image) {
      fatal.push({
        level: 'fatal',
        title: `抽出イメージがありません: ${context.image}`,
        remedy: 'pwsh -File scripts/setup-pdf.ps1 を実行してください。',
      });
    }
  } else if (!facts.extractor.ok) {
    fatal.push({
      level: 'fatal',
      title: `抽出用の Python を実行できません: ${context.python}`,
      remedy: 'PDF_JA_PYTHON の指す実行ファイルを確かめてください。空にすると Docker を使います。',
    });
  }

  if (context.kind !== 'ollama') {
    const cloud = facts.cloud;
    if (cloud === undefined) {
      fatal.push({
        level: 'fatal',
        title: 'クラウドの状態を確認できませんでした。',
        remedy: 'PDF_JA_PROVIDER の設定を確かめてください。',
      });
    } else if (cloud.model.trim() === '') {
      // モデルも鍵も画面から直せる。ここで止めると、その画面へ辿り着けない。
      warnings.push({
        level: 'warning',
        title: 'この接続のモデル名が未設定です（訳は出ません）',
        remedy: '画面の「接続を管理」でモデル名を入れてください。既定値はありません。',
      });
    } else if (!cloud.hasKey) {
      warnings.push({
        level: 'warning',
        title: 'API キーが登録されていません（訳は出ません）',
        remedy:
          '画面の「接続を管理」から登録してください。node dist-web/server.cjs --set-key でも登録できます。',
      });
    } else if (!cloud.reachable) {
      warnings.push({
        level: 'warning',
        title: `${context.target} へ届きません（訳は出ません）`,
        remedy: '通信とモデル名、API キーを確かめてください。',
      });
    }
  } else if (!facts.ollama.reachable) {
    // サーバーは立つ。訳が出ないだけなので止めない。
    warnings.push({
      level: 'warning',
      title: `Ollama に繋がりません: ${context.endpoint}（訳は出ません）`,
      remedy: `Ollama を起動してください。確認: curl ${context.endpoint}/api/tags`,
    });
  } else if (!facts.ollama.models.some((found) => sameModel(context.model, found))) {
    warnings.push({
      level: 'warning',
      title: `モデルがありません: ${context.model}（訳は出ません）`,
      remedy: `ollama pull ${context.model}`,
    });
  }

  return [...fatal, ...warnings];
}

// ---- 探査 -----------------------------------------------------------------

/** 欠けている配信資産を返す。配信元そのものが無ければ全部欠けている。 */
export async function probeAssets(staticRoot: string): Promise<string[]> {
  const missing: string[] = [];
  for (const asset of REQUIRED_ASSETS) {
    if (!(await exists(join(staticRoot, asset)))) missing.push(asset);
  }
  return missing;
}

/** 実行できたかどうかだけを見る。出力は使わない。 */
export type Run = (command: string, args: string[]) => Promise<void>;

export type ExtractorTarget = { kind: 'docker'; image: string } | { kind: 'python'; python: string };

const defaultRun: Run = async (command, args) => {
  await execFileAsync(command, args, { timeout: 15_000, windowsHide: true });
};

export async function probeExtractor(
  target: ExtractorTarget,
  run: Run = defaultRun,
): Promise<ExtractorFacts> {
  if (target.kind === 'python') {
    try {
      await run(target.python, ['--version']);
      return { kind: 'python', ok: true };
    } catch {
      return { kind: 'python', ok: false };
    }
  }

  try {
    await run('docker', ['version', '--format', '{{.Server.Version}}']);
  } catch {
    // daemon が落ちているならイメージは確かめようがない。
    return { kind: 'docker', daemon: false, image: false };
  }
  try {
    await run('docker', ['image', 'inspect', target.image]);
    return { kind: 'docker', daemon: true, image: true };
  } catch {
    return { kind: 'docker', daemon: true, image: false };
  }
}

export async function probeOllama(
  endpoint: string,
  timeoutMs = 5000,
): Promise<{ reachable: boolean; models: string[] }> {
  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, models: [] };
    const body = (await response.json()) as { models?: { name?: string }[] };
    const models = (body.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string');
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

export async function probeCloud(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 5000,
  authMode: 'bearer' | 'api-key' = 'bearer',
): Promise<boolean> {
  if (apiKey === '') return false;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers:
        authMode === 'api-key'
          ? { 'api-key': apiKey }
          : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 応答本文は読まない。鍵やアカウント情報が混ざりうる。
    return response.ok;
  } catch {
    return false;
  }
}

// ---- 組み立てと表示 -------------------------------------------------------

export interface PreflightSettings extends PreflightContext {
  staticRoot: string;
  cloudAllowed: boolean;
  apiKey: string;
}

export interface Probes {
  assets(staticRoot: string): Promise<string[]>;
  extractor(target: ExtractorTarget): Promise<ExtractorFacts>;
  ollama(endpoint: string): Promise<{ reachable: boolean; models: string[] }>;
  cloud(baseUrl: string, apiKey: string, authMode: 'bearer' | 'api-key'): Promise<boolean>;
}

const defaultProbes: Probes = {
  assets: probeAssets,
  extractor: (target) => probeExtractor(target),
  ollama: (endpoint) => probeOllama(endpoint),
  cloud: (baseUrl, apiKey, authMode) => probeCloud(baseUrl, apiKey, 5000, authMode),
};

export async function preflight(
  settings: PreflightSettings,
  probes: Probes = defaultProbes,
): Promise<Problem[]> {
  const target: ExtractorTarget =
    settings.python === ''
      ? { kind: 'docker', image: settings.image }
      : { kind: 'python', python: settings.python };

  const assets = probes.assets(settings.staticRoot);
  const extractor = probes.extractor(target);

  if (settings.kind !== 'ollama') {
    const canProbe =
      settings.cloudAllowed && settings.apiKey !== '' && settings.model.trim() !== '';
    const cloudProbe = canProbe
      ? probes.cloud(
          settings.endpoint,
          settings.apiKey,
          settings.kind === 'azure' ? 'api-key' : 'bearer',
        )
      : Promise.resolve(false);
    const [missingAssets, extractorFacts, reachable] = await Promise.all([
      assets,
      extractor,
      cloudProbe,
    ]);
    return judgePreflight(
      {
        missingAssets,
        extractor: extractorFacts,
        ollama: { reachable: true, models: [] },
        cloud: {
          hasKey: settings.apiKey !== '',
          model: settings.model,
          reachable,
        },
      },
      settings,
    );
  }

  const [missingAssets, extractorFacts, ollama] = await Promise.all([
    assets,
    extractor,
    probes.ollama(settings.endpoint),
  ]);
  return judgePreflight({ missingAssets, extractor: extractorFacts, ollama }, settings);
}

/** 症状の行と、その下に直し方の行。字下げを揃えて読みやすくする。 */
export function formatProblems(problems: Problem[]): string[] {
  const lines: string[] = [];
  for (const problem of problems) {
    lines.push(`${problem.level === 'fatal' ? '失敗' : '注意'}: ${problem.title}`);
    lines.push(`      → ${problem.remedy}`);
  }
  return lines;
}
