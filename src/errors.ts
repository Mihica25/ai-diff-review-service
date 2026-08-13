export type ErrorCode =
  | "unauthorized"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_diff"
  | "idempotency_conflict"
  | "not_found"
  | "rate_limited"
  | "internal";

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

export function errorEnvelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
