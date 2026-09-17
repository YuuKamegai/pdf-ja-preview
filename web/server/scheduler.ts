/**
 * 翻訳ジョブの順番を決める。サーバー全体で一つ、並列度 1。
 *
 * 見ているページから先に訳す。ページを移っても実行中のジョブは止めない。途中で
 * 捨てると同じ原文をまた最初から訳すことになり、並列度 1 では損しかない。
 * 並べ替えるのは待機中のジョブだけ。
 */

export type JobRun = (signal: AbortSignal) => Promise<void>;

interface Job {
  sessionId: string;
  blockId: string;
  priority: number;
  /** 同じ優先度は先に入れた順（FIFO）。 */
  seq: number;
  run: JobRun;
}

export class Scheduler {
  #queue: Job[] = [];
  #running: { job: Job; controller: AbortController } | undefined;
  #paused = new Set<string>();
  #seq = 0;
  #idleWaiters: Array<() => void> = [];
  #closed = false;
  #pumpScheduled = false;

  enqueue(sessionId: string, blockId: string, priority: number, run: JobRun): void {
    if (this.#closed) return;
    // 同じブロックの待機ジョブは置き換える。ページを往復しても溜め込まない。
    this.#queue = this.#queue.filter(
      (job) => !(job.sessionId === sessionId && job.blockId === blockId),
    );
    this.#queue.push({ sessionId, blockId, priority, seq: this.#seq++, run });
    this.#pump();
  }

  /** 待機中のジョブだけ並べ替える。実行中には触らない。 */
  reprioritize(sessionId: string, priorities: Map<string, number>): void {
    for (const job of this.#queue) {
      if (job.sessionId !== sessionId) continue;
      const next = priorities.get(job.blockId);
      if (next !== undefined) job.priority = next;
    }
  }

  pause(sessionId: string): void {
    this.#paused.add(sessionId);
  }

  resume(sessionId: string): void {
    this.#paused.delete(sessionId);
    this.#pump();
  }

  isPaused(sessionId: string): boolean {
    return this.#paused.has(sessionId);
  }

  /** そのセッションの待機ジョブを捨て、実行中なら中断する。 */
  cancel(sessionId: string): void {
    this.#queue = this.#queue.filter((job) => job.sessionId !== sessionId);
    if (this.#running?.job.sessionId === sessionId) this.#running.controller.abort();
    this.#pump();
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  get runningBlockId(): string | undefined {
    return this.#running?.job.blockId;
  }

  /** 実行できるジョブが無くなるまで待つ。休止中のセッションのジョブは数えない。 */
  idle(): Promise<void> {
    if (this.#running === undefined && this.#pick() === undefined && !this.#pumpScheduled) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * 受け付けをやめ、待機を捨て、実行中を中断する。
   *
   * 実行中の完了は待たない。中断を無視するジョブがいると終了できなくなる。
   */
  close(): void {
    this.#closed = true;
    this.#queue = [];
    this.#running?.controller.abort();
    this.#settleIdle();
  }

  #pick(): Job | undefined {
    let best: Job | undefined;
    for (const job of this.#queue) {
      if (this.#paused.has(job.sessionId)) continue;
      if (best === undefined) {
        best = job;
        continue;
      }
      if (job.priority < best.priority || (job.priority === best.priority && job.seq < best.seq)) {
        best = job;
      }
    }
    return best;
  }

  #settleIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * 実行の開始は次のマイクロタスクまで待つ。
   *
   * 待たずに始めると、まとめて積んだ中で「最初に積まれたもの」が優先度に関係なく
   * 走ってしまう。文書順に積むと 3 ページ目が 1 ページ目より先に訳される。
   */
  #pump(): void {
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.#pumpNow();
    });
  }

  #pumpNow(): void {
    if (this.#running !== undefined) return;

    const job = this.#pick();
    if (job === undefined) {
      this.#settleIdle();
      return;
    }
    this.#queue = this.#queue.filter((queued) => queued !== job);

    const controller = new AbortController();
    this.#running = { job, controller };
    void job
      .run(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.#running = undefined;
        this.#pump();
      });
  }
}
