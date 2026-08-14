// Token bucket, service-wide (not per-client — see SUBMISSION.md's scope
// decision on why rate limiting is a shared budget, matching the single
// shared bearer token). Tokens refill continuously as a function of elapsed
// wall-clock time rather than on a fixed tick, so a sustained submission
// rate exactly at ratePerMinute never drains the bucket to zero regardless
// of how evenly-spaced the requests are.
export interface RateLimiter {
  // Attempts to consume one token. Returns { allowed: true } and deducts a
  // token if one was available; otherwise returns { allowed: false,
  // retryAfterSeconds } — the ceiling of the wait until at least one token
  // would be available, for the Retry-After header.
  tryConsume(): { allowed: true } | { allowed: false; retryAfterSeconds: number };
}

export function createRateLimiter(
  ratePerMinute: number,
  burst: number,
  now: () => number = Date.now,
): RateLimiter {
  const refillPerMs = ratePerMinute / 60_000;
  let tokens = burst;
  let lastRefillMs = now();

  function refill(): void {
    const nowMs = now();
    const elapsedMs = nowMs - lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }
    tokens = Math.min(burst, tokens + elapsedMs * refillPerMs);
    lastRefillMs = nowMs;
  }

  return {
    tryConsume() {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return { allowed: true };
      }
      const msUntilNextToken = (1 - tokens) / refillPerMs;
      return { allowed: false, retryAfterSeconds: Math.ceil(msUntilNextToken / 1000) };
    },
  };
}
