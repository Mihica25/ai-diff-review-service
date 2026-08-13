export const LIMITS = {
  maxPayloadBytes: 1_048_576,
  chunkBytes: 65_536,
  maxConcurrentJobs: 4,
  rateLimitPerMinute: 30,
} as const;
