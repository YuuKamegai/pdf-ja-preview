import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  ja: string;
  at: number;
}

export function cacheKey(model: string, source: string): string {
  return createHash('sha256').update(model).update('\n').update(source, 'utf8').digest('hex');
}

export class TranslationCache {
  private dirty = false;

  private constructor(
    private readonly filePath: string,
    private readonly entries: Map<string, CacheEntry>,
    private readonly now: () => number,
  ) {}

  static async load(
    filePath: string,
    options: { now?: () => number; maxAgeMs?: number } = {},
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

    return new TranslationCache(filePath, entries, now);
  }

  get size(): number {
    return this.entries.size;
  }

  get(model: string, source: string): string | undefined {
    return this.entries.get(cacheKey(model, source))?.ja;
  }

  set(model: string, source: string, ja: string): void {
    this.entries.set(cacheKey(model, source), { ja, at: this.now() });
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(Object.fromEntries(this.entries)), 'utf8');
    this.dirty = false;
  }
}
