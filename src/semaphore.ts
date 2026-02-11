export class Semaphore {
  private inUse = 0;

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`Semaphore max must be > 0 (got: ${max})`);
    }
  }

  tryAcquire(): boolean {
    if (this.inUse >= this.max) return false;
    this.inUse += 1;
    return true;
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
  }

  current(): number {
    return this.inUse;
  }

  capacity(): number {
    return this.max;
  }
}

