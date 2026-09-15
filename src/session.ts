import { splitBlocks, TRANSLATABLE_KINDS, type Block } from './markdown/blocks';
import { matchesStructure } from './markdown/verify';
import type { BlockState } from './panel/html';
import {
  OllamaModelMissingError,
  OllamaUnavailableError,
} from './translate/ollama';

export interface SessionView {
  index: number;
  markdown: string;
  state: BlockState;
  lineStart: number;
  lineEnd: number;
}

export type SessionEvent =
  | { kind: 'init'; blocks: SessionView[] }
  | { kind: 'block'; index: number; markdown: string; state: BlockState }
  | { kind: 'banner'; text: string };

export interface SessionDeps {
  model: string;
  maxBlockChars: number;
  translate(source: string, headingContext: string, signal: AbortSignal): Promise<string>;
  enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cacheGet(model: string, source: string): string | undefined;
  cacheSet(model: string, source: string, ja: string): void;
  emit(event: SessionEvent): void;
}

/** 復帰不能なエラーならバナー文言を返す。ブロック単位の失敗なら undefined。 */
function fatalBanner(error: unknown): string | undefined {
  if (error instanceof OllamaModelMissingError) {
    return `モデル ${error.model} がありません。ターミナルで "ollama pull ${error.model}" を実行してください。`;
  }
  if (error instanceof OllamaUnavailableError) {
    return `Ollama へ接続できません。原文のまま表示しています。（${error.message}）`;
  }
  return undefined;
}

export class TranslationSession {
  protected blockList: Block[] = [];
  protected translations = new Map<number, string>();

  constructor(protected readonly deps: SessionDeps) {}

  get blocks(): readonly Block[] {
    return this.blockList;
  }

  async open(text: string): Promise<void> {
    this.blockList = splitBlocks(text, this.deps.maxBlockChars);
    this.translations = new Map();
    this.deps.emit({ kind: 'banner', text: '' });
    this.deps.emit({
      kind: 'init',
      blocks: this.blockList.map((block) => ({
        index: block.index,
        markdown: block.source,
        state: 'source' as BlockState,
        lineStart: block.lineStart,
        lineEnd: block.lineEnd,
      })),
    });
    await this.run(this.blockList.map((block) => block.index));
  }

  async retry(index: number): Promise<void> {
    await this.run([index]);
  }

  protected async run(indices: readonly number[]): Promise<void> {
    for (const index of indices) {
      const block = this.blockList[index];
      if (!block) continue;

      if (!TRANSLATABLE_KINDS.has(block.kind)) {
        this.publish(index, block.source, 'translated');
        continue;
      }

      const cached = this.deps.cacheGet(this.deps.model, block.source);
      if (cached !== undefined) {
        this.publish(index, cached, 'translated');
        continue;
      }

      const keepGoing = await this.translateOne(block);
      if (!keepGoing) return;
    }
  }

  /** 翻訳を 1 ブロック実行する。false を返したら以降のブロックへ進まない。 */
  private async translateOne(block: Block): Promise<boolean> {
    this.deps.emit({
      kind: 'block',
      index: block.index,
      markdown: block.source,
      state: 'translating',
    });

    try {
      const ja = await this.deps.enqueue((signal) =>
        this.deps.translate(block.source, this.headingContextFor(block.index), signal),
      );

      if (!matchesStructure(block.source, ja)) {
        // プロンプト遵守を信用しない。構造が壊れた訳は採用せず原文を残す。
        this.emitBlock(block.index, block.source, 'error');
        return true;
      }

      this.deps.cacheSet(this.deps.model, block.source, ja);
      this.publish(block.index, ja, 'translated');
      return true;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return false;

      const banner = fatalBanner(error);
      if (banner !== undefined) {
        this.deps.emit({ kind: 'banner', text: banner });
        this.emitBlock(block.index, block.source, 'source');
        return false;
      }

      this.emitBlock(block.index, block.source, 'error');
      return true;
    }
  }

  private headingContextFor(index: number): string {
    for (let i = index - 1; i >= 0; i--) {
      const block = this.blockList[i];
      if (block?.kind === 'heading') return block.source.replace(/^#+\s*/, '');
    }
    return '';
  }

  protected publish(index: number, markdown: string, state: BlockState): void {
    this.translations.set(index, markdown);
    this.emitBlock(index, markdown, state);
  }

  private emitBlock(index: number, markdown: string, state: BlockState): void {
    this.deps.emit({ kind: 'block', index, markdown, state });
  }
}
