/**
 * ローカルサーバーの起動と終了。
 *
 * 127.0.0.1 にだけ bind する。設定はすべて環境変数で渡し、ハンドラーからは
 * 外部サービスを直接参照しない。
 */

import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';

import type { OllamaConfig } from '../../src/translate/ollama';
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
import { Storage, defaultDataDir } from './storage';

export const DEFAULT_PORT = 7391;
export const DEFAULT_MODEL = 'qwen3.5:9b-q4_K_M';
export const DEFAULT_IMAGE = 'pdf-ja-extractor:1';

export interface ServerSettings {
  port: number;
  dataDir: string;
  staticRoot: string;
  model: string;
  connection: Omit<OllamaConfig, 'model'>;
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
  const endpoint = assertLoopback(env.PDF_JA_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434');
  const python = env.PDF_JA_PYTHON ?? '';

  return {
    port: number(env.PDF_JA_PORT, DEFAULT_PORT),
    dataDir: defaultDataDir(env),
    staticRoot: resolve(env.PDF_JA_STATIC_ROOT ?? defaultStaticRoot),
    // 既定モデルは既存の拡張と同じ。
    model: env.PDF_JA_MODEL ?? DEFAULT_MODEL,
    connection: {
      endpoint,
      think: env.PDF_JA_THINK === '1',
      temperature: number(env.PDF_JA_TEMPERATURE, 0.2),
      timeoutMs: number(env.PDF_JA_REQUEST_TIMEOUT_MS, 120_000),
    },
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
    connection: settings.connection,
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

  // 前提を先に確かめる。足りないものは「症状」と「直し方」で出す。
  const problems = await preflight({
    staticRoot: settings.staticRoot,
    image: settings.image,
    python: settings.python,
    endpoint: settings.connection.endpoint,
    model: settings.model,
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
  console.log(`  Ollama  : ${settings.connection.endpoint} (${settings.model})`);
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
