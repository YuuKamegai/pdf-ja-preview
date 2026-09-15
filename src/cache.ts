import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  ja: string;
  at: number;
}

type WriteFile = (path: string, data: string, encoding: 'utf8') => Promise<void>;

export function cacheKey(model: string, source: string): string {
  // モデル名の長さを前置きする。区切り文字だけで連結すると、モデル名に区切り文字が
  // 含まれたとき別の (model, source) が同じハッシュ入力になりうる。
  return createHash('sha256')
    .update(`${model.length}\n`)
    .update(model, 'utf8')
    .update(source, 'utf8')
    .digest('hex');
}

export class TranslationCache {
  private dirty = false;
  private mutationVersion = 0;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly entries: Map<string, CacheEntry>,
    private readonly now: () => number,
    private readonly writeFile: WriteFile,
  ) {}

  static async load(
    filePath: string,
    options: { now?: () => number; maxAgeMs?: number; writeFile?: WriteFile } = {},
  ): Promise<TranslationCache> {
    const now = options.now ?? Date.now;
    const maxAgeMs = options.maxAgeMs ?? NINETY_DAYS;
    const entries = new Map<string, CacheEntry>();

    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, CacheEntry>;
      for (const [key, entry] of Object.entries(raw)) {
        if (typeof entry?.ja !== 'string' || typeof entry?.at !== 'number') continue;
        if (now() - entry.at > maxAgeMs) continue;
        entries.set(key, entry);
      }
    } catch {
      // ファイルが無い、あるいは壊れている場合は空で開く。
    }

    return new TranslationCache(filePath, entries, now, options.writeFile ?? writeFile);
  }

  get size(): number {
    return this.entries.size;
  }

  get(model: string, source: string): string | undefined {
    return this.entries.get(cacheKey(model, source))?.ja;
  }

  set(model: string, source: string, ja: string): void {
    this.entries.set(cacheKey(model, source), { ja, at: this.now() });
    this.mutationVersion++;
    this.dirty = true;
  }

  async flush(): Promise<void> {
    // 保存後とパネル破棄の 2 経路から呼ばれるため多重呼び出しが起きる。
    // 同一パスへの writeFile が重なると内容が混ざるので書き込みを直列化する。
    const next = this.writing.then(
      () => this.write(),
      () => this.write(),
    );
    this.writing = next.catch(() => undefined);
    await next;
  }

  private async write(): Promise<void> {
    if (!this.dirty) return;
    const version = this.mutationVersion;
    const snapshot = JSON.stringify(Object.fromEntries(this.entries));
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.writeFile(this.filePath, snapshot, 'utf8');
    // 書き込み待ち中に set() された場合、その更新はこの snapshot に含まれない。
    // dirty を残して、直列キュー上の次の flush に最新 snapshot を保存させる。
    if (this.mutationVersion === version) this.dirty = false;
  }
}
