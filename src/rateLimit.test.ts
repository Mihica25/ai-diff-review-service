import { createRateLimiter } from "./rateLimit";

describe("createRateLimiter", () => {
  it("allows exactly `burst` requests immediately, then rejects the next one", () => {
    const now = 0;
    const limiter = createRateLimiter(30, 5, () => now);

    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume()).toEqual({ allowed: true });
    }
    const result = limiter.tryConsume();
    expect(result.allowed).toBe(false);
  });

  it("returns a positive integer retryAfterSeconds when rejected", () => {
    const now = 0;
    const limiter = createRateLimiter(30, 1, () => now);

    expect(limiter.tryConsume()).toEqual({ allowed: true });
    const result = limiter.tryConsume();
    if (result.allowed) throw new Error("expected rejection");
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
  });

  it("refills continuously with elapsed time, not on a fixed tick", () => {
    let now = 0;
    const limiter = createRateLimiter(60, 1, () => now); // 1 token/sec

    expect(limiter.tryConsume()).toEqual({ allowed: true });
    expect(limiter.tryConsume().allowed).toBe(false);

    now += 500; // half a second — not enough for a full token yet
    expect(limiter.tryConsume().allowed).toBe(false);

    now += 500; // one full second elapsed since the first consume
    expect(limiter.tryConsume()).toEqual({ allowed: true });
  });

  it("never exhausts the bucket under a sustained rate exactly at the declared limit", () => {
    // 30/min == one token every 2000ms. Submitting exactly on that cadence,
    // starting from a drained bucket, must never be rejected — this is the
    // literal "sustained 30/min must succeed" contract requirement.
    let now = 0;
    const limiter = createRateLimiter(30, 40, () => now);

    // Drain the initial burst first, simulating a prior spike.
    for (let i = 0; i < 40; i++) {
      limiter.tryConsume();
    }

    for (let i = 0; i < 60; i++) {
      now += 2000;
      expect(limiter.tryConsume()).toEqual({ allowed: true });
    }
  });

  it("caps refill at the burst capacity — idling doesn't accumulate unbounded tokens", () => {
    let now = 0;
    const limiter = createRateLimiter(60, 3, () => now); // 1 token/sec, capacity 3

    now += 10_000; // idle for far longer than it'd take to refill to capacity
    for (let i = 0; i < 3; i++) {
      expect(limiter.tryConsume()).toEqual({ allowed: true });
    }
    expect(limiter.tryConsume().allowed).toBe(false);
  });
});
