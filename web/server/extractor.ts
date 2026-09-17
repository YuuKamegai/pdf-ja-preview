/**
 * 抽出ワーカーの監督。
 *
 * ワーカーは別プロセス。契約は「stdout に JSON 一件、ログは stderr」だけなので、
 * 中身が Docker でもローカルの Python でも、ここから先は同じに見える。
 *
 * この machine では Windows の Smart App Control が torch の未署名 DLL を弾くため、
 * 既定は Docker 経由。詳細は `docs/pdf-web.md`。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';

import { parseDocument, type PdfDocument } from '../shared/document';

/** stdout の上限。これを超えたら殺す。 */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
/** stderr は末尾だけ持つ。 */
export const MAX_STDERR_BYTES = 64 * 1024;
/** 抽出の既定タイムアウト。 */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 600_000;

export class ExtractorError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, message: string, detail = '') {
    super(message);
    this.name = 'ExtractorError';
    this.code = code;
    this.detail = detail;
  }
}

export interface ExtractorRunArgs {
  file: string;
  hash: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface Extractor {
  readonly description: string;
  run(args: ExtractorRunArgs): Promise<PdfDocument>;
}

interface ProcessOptions {
  command: string;
  args: string[];
  signal: AbortSignal;
  timeoutMs: number;
  /** プロセスを殺すだけでは止まらない実行形態（コンテナなど）の後始末。 */
  onCancel?: () => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** 末尾だけ保持するバッファ。ログで記憶を食い潰さない。 */
class TailBuffer {
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.limit && this.#chunks.length > 1) {
      const first = this.#chunks.shift();
      if (first) this.#size -= first.length;
    }
  }

  toString(): string {
    return Buffer.concat(this.#chunks).subarray(-this.limit).toString('utf8');
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Windows では子の子まで落ちない。taskkill /T で木ごと落とす。
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return;
    } catch {
      // taskkill が無ければ通常の kill に落とす
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* すでに終わっている */
  }
}

export function runExtractorProcess(options: ProcessOptions): Promise<PdfDocument> {
  return new Promise<PdfDocument>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new ExtractorError('cancelled', '抽出は取り消されました'));
      return;
    }

    const child = spawn(options.command, options.args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
      cwd: options.cwd,
    });

    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    const stderr = new TailBuffer(MAX_STDERR_BYTES);
    let failure: ExtractorError | undefined;
    let settled = false;

    const finish = (error: ExtractorError | undefined, document?: PdfDocument): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(document as PdfDocument);
    };

    const stop = (error: ExtractorError): void => {
      if (failure === undefined) failure = error;
      options.onCancel?.();
      killTree(child);
    };

    const timer = setTimeout(() => {
      stop(
        new ExtractorError(
          'timeout',
          `抽出が ${Math.round(options.timeoutMs / 1000)} 秒を超えたので打ち切りました`,
        ),
      );
    }, options.timeoutMs);

    const onAbort = (): void => {
      stop(new ExtractorError('cancelled', '抽出は取り消されました'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_STDOUT_BYTES) {
        stop(new ExtractorError('output-too-large', '抽出結果が大きすぎます'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', (error) => {
      finish(
        new ExtractorError(
          'spawn-failed',
          `抽出プロセスを起動できません: ${(error as Error).message}`,
          stderr.toString(),
        ),
      );
    });

    child.on('close', (code) => {
      if (failure) {
        finish(new ExtractorError(failure.code, failure.message, stderr.toString()));
        return;
      }

      const text = Buffer.concat(stdout).toString('utf8').trim();
      if (text === '') {
        finish(
          new ExtractorError(
            'worker-failed',
            `抽出プロセスが結果を返しませんでした (exit ${code})`,
            stderr.toString(),
          ),
        );
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        finish(
          new ExtractorError('invalid-output', '抽出結果が JSON ではありません', stderr.toString()),
        );
        return;
      }

      const record = payload as { ok?: unknown; document?: unknown; error?: unknown };
      if (record.ok !== true) {
        const error = (record.error ?? {}) as { code?: unknown; message?: unknown };
        finish(
          new ExtractorError(
            typeof error.code === 'string' ? error.code : 'extraction-failed',
            typeof error.message === 'string' ? error.message : '抽出に失敗しました',
            stderr.toString(),
          ),
        );
        return;
      }

      try {
        finish(undefined, parseDocument(record.document));
      } catch (error) {
        finish(
          new ExtractorError(
            'invalid-document',
            `抽出結果が契約に合いません: ${(error as Error).message}`,
            stderr.toString(),
          ),
        );
      }
    });
  });
}

export interface DockerExtractorOptions {
  image: string;
  /** `docker` 実行ファイル。試験では差し替える。 */
  docker?: string;
  /** コンテナ内のモデル置き場。 */
  models?: string;
  /** 抽出に使うスレッド数。GPU は Ollama が使うので CPU だけで回す。 */
  threads?: number;
}

/**
 * コンテナで抽出する。
 *
 * `--network none` で外へ出られないようにする。PDF は読み取り専用で渡す。
 * `docker run` を殺してもコンテナは止まらないので、取り消しでは `docker kill` する。
 */
export function buildDockerArgs(
  options: DockerExtractorOptions,
  input: { file: string; hash: string; containerName: string },
): string[] {
  return [
    'run',
    '--rm',
    '--name',
    input.containerName,
    // 原文を扱う実行時に外へ出さない。モデルはイメージに焼いてある。
    '--network',
    'none',
    '-e',
    `OMP_NUM_THREADS=${options.threads ?? 4}`,
    '-v',
    `${dirname(input.file)}:/in:ro`,
    options.image,
    '--input',
    `/in/${basename(input.file)}`,
    '--hash',
    input.hash,
    '--models',
    options.models ?? '/models',
  ];
}

export function dockerExtractor(options: DockerExtractorOptions): Extractor {
  const docker = options.docker ?? 'docker';

  return {
    description: `docker:${options.image}`,
    run({ file, hash, signal, timeoutMs }) {
      const name = `pdf-ja-${randomUUID()}`;
      const args = buildDockerArgs(options, { file, hash, containerName: name });
      return runExtractorProcess({
        command: docker,
        args,
        signal,
        timeoutMs: timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS,
        onCancel: () => {
          try {
            spawn(docker, ['kill', name], {
              shell: false,
              stdio: 'ignore',
              windowsHide: true,
            }).unref();
          } catch {
            /* docker が無ければ何もできない */
          }
        },
      });
    },
  };
}

export interface PythonExtractorOptions {
  python: string;
  models: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** ローカルの Python で抽出する。Smart App Control の無い環境向け。 */
export function pythonExtractor(options: PythonExtractorOptions): Extractor {
  return {
    description: `python:${options.python}`,
    run({ file, hash, signal, timeoutMs }) {
      return runExtractorProcess({
        command: options.python,
        args: [
          '-m',
          'pdf_ja.worker',
          '--input',
          file,
          '--hash',
          hash,
          '--models',
          options.models,
        ],
        signal,
        timeoutMs: timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS,
        cwd: options.cwd,
        env: options.env,
      });
    },
  };
}

/** 計画どおりの入口。ローカル Python 版の一回限りの実行。 */
export function runExtractor(args: {
  python: string;
  file: string;
  hash: string;
  models: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<PdfDocument> {
  return pythonExtractor({ python: args.python, models: args.models }).run({
    file: args.file,
    hash: args.hash,
    signal: args.signal,
    timeoutMs: args.timeoutMs,
  });
}
