import { describe, expect, test } from 'bun:test';
import { RateLimiter } from './rate-limiter.js';

/** Controllable clock so tests never actually wait. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('RateLimiter', () => {
  test('allows requests up to the window limit without waiting', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter([{ limit: 5, intervalMs: 10_000 }], clock);

    for (let i = 0; i < 5; i++) await limiter.acquire();

    expect(clock.now()).toBe(0);
  });

  test('waits once the window is saturated', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter([{ limit: 5, intervalMs: 10_000 }], clock);

    for (let i = 0; i < 5; i++) await limiter.acquire();
    await limiter.acquire();

    expect(clock.now()).toBe(10_000);
  });

  test('enforces the stricter of two overlapping windows', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(
      [
        { limit: 5, intervalMs: 10_000 },
        { limit: 20, intervalMs: 60_000 },
      ],
      clock,
    );

    // 20 requests fills the 60s window; the 10s window forces waits along the
    // way, so by request 20 we are 30s in (4 batches of 5).
    for (let i = 0; i < 20; i++) await limiter.acquire();
    const at20 = clock.now();
    expect(at20).toBe(30_000);

    // The 21st must wait for the 60s window, not just the 10s one.
    await limiter.acquire();
    expect(clock.now()).toBe(60_000);
  });

  test('serializes concurrent callers so none share a slot', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter([{ limit: 2, intervalMs: 1_000 }], clock);

    await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);

    // 4 requests at 2 per second means the last one lands at t=1000.
    expect(clock.now()).toBe(1_000);
  });

  test('frees slots as the window slides forward', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter([{ limit: 2, intervalMs: 1_000 }], clock);

    await limiter.acquire();
    await limiter.acquire();
    clock.advance(1_001);

    await limiter.acquire();
    expect(clock.now()).toBe(1_001);
  });
});
