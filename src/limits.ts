export const LIMITS = {
  maxPayloadBytes: 1_048_576,
  chunkBytes: 65_536,
  maxConcurrentJobs: 4,
  rateLimitPerMinute: 30,
  // Token-bucket capacity for POST /v1/reviews (see rateLimit.ts): headroom
  // above the sustained rate so a burst of legitimate traffic (or timing
  // jitter in a client sending "30/min" as unevenly-spaced requests rather
  // than one every 2s exactly) doesn't trip 429 before the sustained-rate
  // guarantee is actually violated. Declared here (and surfaced via /spec)
  // because the contract requires the declared burst to match real behavior.
  rateLimitBurst: 40,
} as const;
