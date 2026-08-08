import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function authRateLimitKey(scope: string, purpose: string, value: string): string {
  return sha256(`studymind:auth-rate-limit:v1:${scope}:${purpose}:${value}`);
}

export function secureToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function otpCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
