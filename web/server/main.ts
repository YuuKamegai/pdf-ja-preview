/**
 * ローカルサーバーの起動と終了。
 *
 * 127.0.0.1 にだけ bind する。設定はすべて環境変数で渡し、ハンドラーからは
 * 外部サービスを直接参照しない。
 */

import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

import {
  assertSendable,
  describeTarget,
  type ProviderConfig,
} from '../../src/translate/provider';
import { DocumentStore } from './documents';
import {
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  dockerExtractor,
  pythonExtractor,
  type Extractor,
} from './extractor';
import { createApp } from './http';
import { formatProblems, preflight } from './preflight';
import { Scheduler } from './scheduler';
import { allowedHostsFor, createToken } from './security';
import { SettingsStore } from './settings-store';
import { Storage, defaultDataDir } from './storage';

export const DEFAULT_PORT = 7391;
export const DEFAULT_MODEL = 'qwen3.5:9b-q4_K_M';
export const DEFAULT_IMAGE = 'pdf-ja-extractor:1';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface ServerSettings {
  port: number;
  dataDir: string;
  staticRoot: string;
  model: string;
  /** apiKey は空。起動時に SettingsStore から差し込む。 */
  provider: ProviderConfig;
  cloudAllowed: boolean;
  extractorKind: 'docker' | 'python';
  image: string;
  python: string;
  modelsDir: string;
  extractionTimeoutMs: number;
}

/** ループバック以外の endpoint は受け付けない。原文を外へ出さない。 */
export function assertLoopback(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`PDF_JA_OLLAMA_ENDPOINT が URL ではありません: ${endpoint}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!loopback) {
    throw new Error(`Ollama の endpoint はループバックだけです: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Ollama の endpoint の scheme が不正です: ${endpoint}`);
  }
  return endpoint.replace(/\/+$/, '');
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readSettings(
  env: NodeJS.ProcessEnv = process.env,
  defaultStaticRoot = join(process.cwd(), 'dist-web'),
): ServerSettings {
  const python = env.PDF_JA_PYTHON ?? '';
  const kind = env.PDF_JA_PROVIDER === 'openai' ? 'openai' : 'ollama';
  const model = env.PDF_JA_MODEL ?? (kind === 'openai' ? '' : DEFAULT_MODEL);
  const temperature = number(env.PDF_JA_TEMPERATURE, 0.2);
  const timeoutMs = number(env.PDF_JA_REQUEST_TIMEOUT_MS, 120_000);

  const provider: ProviderConfig =
    kind === 'openai'
      ? {
          kind: 'openai',
          baseUrl: env.PDF_JA_BASE_URL ?? DEFAULT_BASE_URL,
          // 鍵は環境変数から読まない。SettingsStore からだけ入る。
          apiKey: '',
          model,
          temperature,
          timeoutMs,
        }
      : {
          kind: 'ollama',
          // ローカルのときだけ、従来どおりループバックを強制する。
          endpoint: assertLoopback(
            env.PDF_JA_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434',
          ),
          model,
          think: env.PDF_JA_THINK === '1',
          temperature,
          timeoutMs,
        };

  return {
    port: number(env.PDF_JA_PORT, DEFAULT_PORT),
    dataDir: defaultDataDir(env),
    staticRoot: resolve(env.PDF_JA_STATIC_ROOT ?? defaultStaticRoot),
    model,
    provider,
    cloudAllowed: env.PDF_JA_CLOUD_ALLOWED === '1',
    extractorKind: python === '' ? 'docker' : 'python',
    image: env.PDF_JA_EXTRACTOR_IMAGE ?? DEFAULT_IMAGE,
    python,
    modelsDir: env.PDF_JA_MODELS_DIR ?? (python === '' ? '/models' : ''),
    extractionTimeoutMs: number(env.PDF_JA_EXTRACTION_TIMEOUT_MS, DEFAULT_EXTRACTION_TIMEOUT_MS),
  };
}

export function createExtractor(settings: ServerSettings): Extractor {
  if (settings.extractorKind === 'python') {
    return pythonExtractor({ python: settings.python, models: settings.modelsDir });
  }
  return dockerExtractor({ image: settings.image, models: settings.modelsDir || '/models' });
}

export interface RunningServer {
  url: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

export async function startServer(settings: ServerSettings): Promise<RunningServer> {
  let provider = settings.provider;
  if (provider.kind === 'openai') {
    const apiKey = await new SettingsStore(settings.dataDir).readApiKey();
    provider = { ...provider, apiKey };
  }
  assertSendable(provider, settings.cloudAllowed);

  const storage = new Storage(settings.dataDir);
  await storage.initialize();

  const scheduler = new Scheduler();
  const documents = new DocumentStore({
    storage,
    extractor: createExtractor(settings),
    timeoutMs: settings.extractionTimeoutMs,
  });

  const token = createToken();
  const allowedHosts = new Set<string>();
  const server = createApp({
    documents,
    storage,
    scheduler,
    connection: provider,
    defaultModel: settings.model,
    staticRoot: settings.staticRoot,
    security: { token, allowedHosts },
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : settings.port;
  for (const host of allowedHostsFor(port)) allowedHosts.add(host);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await server.shutdown();
    scheduler.close();
    await documents.close();
    await storage.close();
  };

  return { url: `http://127.0.0.1:${port}/`, port, server, close };
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* 開けなくても起動は続ける */
  }
}

/**
 * ショートカットから起動すると、失敗しても窓が一瞬で消えて何も読めない。
 * `--launcher` のときだけ、キーを押すまで開いたままにする。
 */
async function holdWindow(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stdout.write('\n閉じるには何かキーを押してください… ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\n');
}

/** 画面に出さずに 1 行読む。TTY でなければ拒否する。 */
async function readSecretLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('API キーは対話的にのみ入力できます（履歴やログへ残さないため）。');
  }
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // 入力をエコーしない。
  const output = rl as unknown as { _writeToOutput?: (text: string) => void };
  output._writeToOutput = () => undefined;
  try {
    const value = await new Promise<string>((resolve) => rl.question('', resolve));
    process.stdout.write('\n');
    return value;
  } finally {
    rl.close();
  }
}

async function manageKey(argv: string[], dataDir: string): Promise<number> {
  const store = new SettingsStore(dataDir);
  if (argv.includes('--clear-key')) {
    await store.clearApiKey();
    console.log('API キーを削除しました。');
    return 0;
  }
  const value = await readSecretLine('API キー（入力は表示されません）: ');
  await store.setApiKey(value);
  console.log(`API キーを暗号化して保存しました: ${store.path}`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const launcher = argv.includes('--launcher');

  let settings: ServerSettings;
  try {
    settings = readSettings();
  } catch (error) {
    console.error(`設定を読めません: ${(error as Error).message}`);
    if (launcher) await holdWindow();
    return 1;
  }

  if (argv.includes('--set-key') || argv.includes('--clear-key')) {
    try {
      return await manageKey(argv, settings.dataDir);
    } catch (error) {
      console.error((error as Error).message);
      if (launcher) await holdWindow();
      return 1;
    }
  }

  // 前提を先に確かめる。足りないものは「症状」と「直し方」で出す。
  let apiKey = '';
  if (settings.provider.kind === 'openai') {
    try {
      apiKey = await new SettingsStore(settings.dataDir).readApiKey();
    } catch {
      // 読めない鍵は未登録として preflight で案内する。内容はログへ出さない。
    }
  }
  const problems = await preflight({
    staticRoot: settings.staticRoot,
    image: settings.image,
    python: settings.python,
    endpoint:
      settings.provider.kind === 'ollama'
        ? settings.provider.endpoint
        : settings.provider.baseUrl,
    model: settings.model,
    kind: settings.provider.kind,
    target: describeTarget(settings.provider),
    cloudAllowed: settings.cloudAllowed,
    apiKey,
  });
  for (const line of formatProblems(problems)) console.log(line);
  if (problems.some((problem) => problem.level === 'fatal')) {
    if (launcher) await holdWindow();
    return 1;
  }
  if (problems.length > 0) console.log('');

  let running: RunningServer;
  try {
    running = await startServer(settings);
  } catch (error) {
    console.error(`起動できません: ${(error as Error).message}`);
    if (launcher) await holdWindow();
    return 1;
  }

  // token はログに出さない。URL だけ出す。
  console.log(`PDF 日本語プレビュー: ${running.url}`);
  console.log(`  保存先  : ${settings.dataDir}`);
  console.log(`  配信元  : ${settings.staticRoot}`);
  console.log(`  抽出    : ${settings.extractorKind === 'docker' ? settings.image : settings.python}`);
  console.log(`  翻訳先  : ${describeTarget(settings.provider)} (${settings.model})`);
  console.log(`  終了    : ${launcher ? 'この窓を閉じる（または Ctrl+C）' : 'Ctrl+C'}`);

  if (argv.includes('--open')) openBrowser(running.url);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('\n片づけています…');
    void running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`終了処理で失敗: ${(error as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return 0;
}
