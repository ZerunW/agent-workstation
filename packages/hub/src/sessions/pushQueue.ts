/**
 * Unbounded async push queue used as the SDK's streaming-input prompt.
 * It only ends when `close()` is called (session Close / process reaped).
 */
export class PushQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): boolean {
    if (this.closed) return false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((res) => (this.waiter = res));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
