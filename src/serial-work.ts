/** Serializes asynchronous work without allowing one rejection to poison later work. */
export class SerialWork {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> { await this.tail; }
}

export class KeyedSerialWork {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return result;
  }
}
