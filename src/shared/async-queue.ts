export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private ended = false;
  push(value: T): void {
    if (this.ended) return;
    const resolve = this.waiting.shift();
    if (resolve) resolve({ value, done: false });
    else this.values.push(value);
  }
  close(): void {
    this.ended = true;
    for (const resolve of this.waiting.splice(0)) resolve({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}
