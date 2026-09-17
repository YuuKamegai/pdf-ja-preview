/**
 * ディスク上の置き場所。キャッシュ・一時 PDF・所有ロック。
 *
 * 既定は `%LOCALAPPDATA%/pdf-ja-preview`。`PDF_JA_DATA_DIR` で変えられる。
 * 文書と訳文はリポジトリではなくここに置き、文書単位で丸ごと消せる形にする。
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** 訳文キャッシュの鍵に入る要素。どれか一つでも違えば別の訳。 */
export interface TranslationKey {
  source: string;
  headingContext: string;
  model: string;
  think: boolean;
  temperature: number;
  promptVersion: string;
  verifierVersion: string;
}

/**
 * 訳文キャッシュの鍵。
 *
 * 見出し文脈・モデル・温度・think・各版のどれが違っても別の鍵になる。文脈が違えば
 * 訳し分けが要るので、原文が同じでも流用しない。
 */
export function translationKey(input: TranslationKey): string {
  const canonical = JSON.stringify([
    input.source,
    input.headingContext,
    input.model,
    input.think,
    input.temperature,
    input.promptVersion,
    input.verifierVersion,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 既定の保存先。 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PDF_JA_DATA_DIR;
  if (override && override.trim() !== '') return resolve(override);
  const local = env.LOCALAPPDATA;
  if (local && local.trim() !== '') return join(local, 'pdf-ja-preview');
  return join(homedir(), '.cache', 'pdf-ja-preview');
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export class StorageKeyError extends Error {
  constructor(key: string) {
    super(`保存キーの形式が不正です: ${key}`);
    this.name = 'StorageKeyError';
  }
}

/** `docs/<hash>/meta` のような相対キーだけを許す。`..` や絶対パスは弾く。 */
function keyToParts(key: string): string[] {
  const parts = key.split('/');
  if (parts.length === 0 || parts.length > 8) throw new StorageKeyError(key);
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || !SEGMENT.test(part)) {
      throw new StorageKeyError(key);
    }
  }
  return parts;
}

const HASH = /^[0-9a-f]{64}$/;

export function documentKey(hash: string, name: string): string {
  if (!HASH.test(hash)) throw new StorageKeyError(hash);
  return `docs/${hash}/${name}`;
}

export function translationCacheKey(hash: string, key: string): string {
  if (!HASH.test(hash)) throw new StorageKeyError(hash);
  return `docs/${hash}/tr/${key}`;
}

interface OwnerRecord {
  pid: number;
  startedAt: string;
}

export class Storage {
  readonly root: string;
  /** このサーバーが所有する一時領域。終了時に消す。 */
  readonly serverId: string;

  #writes = new Map<string, Promise<unknown>>();
  #tempRoot: string | undefined;
  #initialized = false;

  constructor(root: string = defaultDataDir()) {
    this.root = resolve(root);
    this.serverId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  get tempDir(): string {
    if (this.#tempRoot === undefined) throw new Error('initialize() を先に呼んでください');
    return this.#tempRoot;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(join(this.root, 'docs'), { recursive: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true });

    this.#tempRoot = join(this.root, 'tmp', this.serverId);
    await mkdir(this.#tempRoot, { recursive: true });
    const owner: OwnerRecord = { pid: process.pid, startedAt: new Date().toISOString() };
    await writeFile(join(this.#tempRoot, 'owner.json'), JSON.stringify(owner), 'utf8');

    await this.#reapAbandoned();
    this.#initialized = true;
  }

  /** 死んだサーバーの一時領域だけ回収する。生きている別サーバーの PDF は消さない。 */
  async #reapAbandoned(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(join(this.root, 'tmp'));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === this.serverId) continue;
      const dir = join(this.root, 'tmp', entry);
      let owner: OwnerRecord | undefined;
      try {
        owner = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8')) as OwnerRecord;
      } catch {
        owner = undefined;
      }
      if (owner && Number.isInteger(owner.pid) && isProcessAlive(owner.pid)) continue;
      await rm(dir, { recursive: true, force: true });
    }
  }

  #pathFor(key: string): string {
    return join(this.root, ...keyToParts(key)) + '.json';
  }

  /** 壊れている、または読めないキャッシュは `undefined`。次に取り直させる。 */
  async readJson(key: string): Promise<unknown | undefined> {
    const path = this.#pathFor(key);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      await rm(path, { force: true });
      return undefined;
    }
  }

  /**
   * 一時ファイルへ書いてから rename する。途中で落ちても半端な JSON を残さない。
   * 同じ保存先への書き込みは直列化する。
   */
  async writeJson(key: string, value: unknown): Promise<void> {
    const path = this.#pathFor(key);
    const previous = this.#writes.get(path) ?? Promise.resolve();
    const next = previous.then(
      () => this.#writeNow(path, value),
      () => this.#writeNow(path, value),
    );
    this.#writes.set(path, next);
    try {
      await next;
    } finally {
      if (this.#writes.get(path) === next) this.#writes.delete(path);
    }
  }

  async #writeNow(path: string, value: unknown): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf(sep));
    await mkdir(dir, { recursive: true });
    const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temp, JSON.stringify(value), 'utf8');
    await rename(temp, path);
  }

  /** 文書に紐づくものを丸ごと消す。訳文キャッシュもこの下にある。 */
  async deleteDocument(hash: string): Promise<void> {
    if (!HASH.test(hash)) throw new StorageKeyError(hash);
    await rm(join(this.root, 'docs', hash), { recursive: true, force: true });
  }

  /** 受け取った PDF を置く場所。元の名前はパスに使わない。 */
  async createTempFile(): Promise<string> {
    return join(this.tempDir, `${randomUUID()}.pdf`);
  }

  async removeTempFile(path: string): Promise<void> {
    const temp = resolve(path);
    if (!temp.startsWith(this.tempDir + sep)) return;
    await rm(temp, { force: true });
  }

  async close(): Promise<void> {
    if (this.#tempRoot === undefined) return;
    await rm(this.#tempRoot, { recursive: true, force: true });
    this.#initialized = false;
    this.#tempRoot = undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 試験用に、その場限りの保存先を作る。 */
export async function createTemporaryStorage(): Promise<Storage> {
  const root = await mkdtemp(join(tmpdir(), 'pdf-ja-test-'));
  const storage = new Storage(root);
  await storage.initialize();
  return storage;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
