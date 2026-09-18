import { splitBlocks, TRANSLATABLE_KINDS, type Block } from './markdown/blocks';
import { reconcile } from './markdown/reconcile';
import { matchesStructure } from './markdown/verify';
import type { BlockState } from './panel/html';
import {
  ModelMissingError,
  ProviderAuthError,
  ProviderConfigError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './translate/errors';

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
  | { kind: 'banner'; text: string }
  | { kind: 'notice'; text: string };

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
  if (error instanceof ModelMissingError) {
    return `モデル ${error.model} がありません。ローカルなら "ollama pull ${error.model}"、クラウドならモデル名の設定を確かめてください。`;
  }
  if (error instanceof ProviderAuthError) {
    // 例外メッセージを埋め込まない。鍵が混ざりうる。
    return 'API キーが拒否されました。コマンド「md-ja: API キーを登録」で登録し直してください。';
  }
  if (error instanceof ProviderRateLimitError) {
    return '送信先が混雑しています。しばらく待ってから再試行してください。';
  }
  if (error instanceof ProviderConfigError) {
    return `設定を確かめてください: ${error.message}`;
  }
  if (error instanceof ProviderUnavailableError) {
    // 送信先（Ollama / OpenAI 互換 API）は error.message 側が正しく持っている。
    // ollama.ts / openai.ts はどちらも「<送信先> へ接続できません」を投げる実装なので、
    // ここでホスト名を決め打ちしない。
    return `翻訳先へ接続できません。原文のまま表示しています。（${error.message}）`;
  }
  return undefined;
}

export class TranslationSession {
  protected blockList: Block[] = [];
  protected translations = new Map<number, string>();
  private generation = 0;

  constructor(protected readonly deps: SessionDeps) {}

  get blocks(): readonly Block[] {
    return this.blockList;
  }

  async open(text: string): Promise<void> {
    const generation = ++this.generation;
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
    await this.run(this.blockList.map((block) => block.index), generation);
  }

  /** 保存時に呼ぶ。内容が変わったブロックだけを訳し直す。 */
  async update(text: string): Promise<void> {
    const generation = ++this.generation;
    const newBlocks = splitBlocks(text, this.deps.maxBlockChars);
    const { carried, pending } = reconcile(this.blockList, this.translations, newBlocks);

    this.blockList = newBlocks;
    this.translations = new Map(carried);

    this.deps.emit({ kind: 'banner', text: '' });
    this.deps.emit({
      kind: 'init',
      blocks: newBlocks.map((block) => {
        const ja = carried.get(block.index);
        return {
          index: block.index,
          markdown: ja ?? block.source,
          state: (ja !== undefined ? 'translated' : 'source') as BlockState,
          lineStart: block.lineStart,
          lineEnd: block.lineEnd,
        };
      }),
    });

    await this.run(pending, generation);
  }

  async retry(index: number): Promise<void> {
    await this.run([index], this.generation);
  }

  /** パネル破棄後に、遅れて完了した翻訳結果と後続処理を無効化する。 */
  dispose(): void {
    this.generation++;
  }

  protected async run(indices: readonly number[], generation: number): Promise<void> {
    for (const index of indices) {
      if (generation !== this.generation) return;
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

      const keepGoing = await this.translateOne(block, generation);
      if (!keepGoing) return;
    }
  }

  /** 翻訳を 1 ブロック実行する。false を返したら以降のブロックへ進まない。 */
  private async translateOne(block: Block, generation: number): Promise<boolean> {
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

      if (generation !== this.generation) return false;

      if (!matchesStructure(block.source, ja)) {
        // プロンプト遵守を信用しない。構造が壊れた訳は採用せず原文を残す。
        this.emitBlock(block.index, block.source, 'error');
        return true;
      }

      this.deps.cacheSet(this.deps.model, block.source, ja);
      this.publish(block.index, ja, 'translated');
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
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
