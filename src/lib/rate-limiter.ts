export interface RateLimitWindow {
  /** Maximum requests permitted within the window. */
  limit: number;
  /** Window length in milliseconds. */
  intervalMs: number;
}

/**
 * Expensify enforces two overlapping windows (documented as 5 requests per
 * 10 seconds and 20 per 60 seconds). Both must hold, so a request waits for
 * whichever window is furthest from having a slot free.
 */
export const EXPENSIFY_RATE_LIMITS: RateLimitWindow[] = [
  { limit: 5, intervalMs: 10_000 },
  { limit: 20, intervalMs: 60_000 },
];

type SleepFn = (ms: number) => Promise<void>;
type NowFn = () => number;

const defaultSleep: SleepFn = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly windows: RateLimitWindow[];
  private readonly timestamps: number[] = [];
  private readonly now: NowFn;
  private readonly sleep: SleepFn;
  /** Serializes acquire() so concurrent callers cannot claim the same slot. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    windows: RateLimitWindow[] = EXPENSIFY_RATE_LIMITS,
    options: { now?: NowFn; sleep?: SleepFn } = {},
  ) {
    this.windows = windows;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Resolves once it is safe to issue another request. */
  async acquire(): Promise<void> {
    const run = this.queue.then(() => this.reserveSlot());
    // Swallow rejection on the chain itself so one failure cannot poison the
    // queue for every subsequent caller; the caller still sees its own error.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reserveSlot(): Promise<void> {
    // A single wait may not be enough: clearing the 10s window can still leave
    // the 60s window saturated, so re-check until every window has room.
    for (;;) {
      this.prune();
      const waitMs = this.longestWait();
      if (waitMs <= 0) {
        this.timestamps.push(this.now());
        return;
      }
      await this.sleep(waitMs);
    }
  }

  private prune(): void {
    const longest = Math.max(...this.windows.map((w) => w.intervalMs));
    const cutoff = this.now() - longest;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Milliseconds until the most-constrained window frees a slot. */
  private longestWait(): number {
    const current = this.now();
    let wait = 0;
    for (const window of this.windows) {
      const windowStart = current - window.intervalMs;
      const inWindow = this.timestamps.filter((t) => t > windowStart);
      if (inWindow.length < window.limit) continue;
      // The oldest entry in this window is the next one to expire.
      const oldest = inWindow[inWindow.length - window.limit]!;
      wait = Math.max(wait, oldest + window.intervalMs - current);
    }
    return wait;
  }
}
