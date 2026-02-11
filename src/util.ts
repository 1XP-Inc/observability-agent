export function isoNow(): string {
  return new Date().toISOString();
}

export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = idx;
      idx += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
