import { sha256 } from "../security.js";
import type { Store } from "../store.js";
export function bearerToken(value: string | undefined): string | null { return value?.match(/^Bearer\s+(smds_[A-Za-z0-9_-]{10,200})$/)?.[1] ?? null; }
export async function authenticateDesktop(store: Pick<Store, "findSessionByTokenHash">, authorization: string | undefined, now: Date) {
  const token = bearerToken(authorization); return token ? store.findSessionByTokenHash(sha256(token), now) : null;
}
export function publicAuthError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const allowed = new Set(["A valid email address is required.", "Login state is invalid.", "Verification code is invalid or expired.", "Login ticket is invalid or expired.", "Please wait before requesting another verification code.", "Could not send verification code. Please try again later."]);
  return allowed.has(error.message) ? error.message : null;
}
export function isServerTemporarilyUnavailable(error: unknown): boolean { return error instanceof Error && error.message === "SERVER_TEMPORARILY_UNAVAILABLE"; }
