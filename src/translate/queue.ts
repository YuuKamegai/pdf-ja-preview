/** 並列度 1 の実行キュー。ローカル GPU を複数リクエストで詰まらせないために使う。 */
export class SequentialQueue {
  private tail: Promise<void> = Promise.resolve();
  private controller = new AbortController();

  enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { signal } = this.controller;

    const result = this.tail.then(() => {
      if (signal.aborted) throw signal.reason;
      return job(signal);
    });

    // 次のジョブは、成否にかかわらずこのジョブの完了後に始める。
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  /** 実行中のジョブを中断し、未実行のジョブを AbortError で落とす。 */
  cancelAll(): void {
    this.controller.abort(new DOMException('cancelled', 'AbortError'));
    this.controller = new AbortController();
    this.tail = Promise.resolve();
  }
}
