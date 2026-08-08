import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OtpPurpose } from "./store/contracts.js";

export const OTP_HMAC_KEY_ENV = "STUDYMIND_AUTH_OTP_HMAC_KEY";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function authRateLimitKey(scope: string, purpose: string, value: string): string {
  return sha256(`studymind:auth-rate-limit:v1:${scope}:${purpose}:${value}`);
}

export function assertEmailOtpHmacKey(key: string): void {
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 32) throw new Error(`${OTP_HMAC_KEY_ENV} must be at least 32 bytes.`);
}

export function hashEmailOtp(input: {
  key: string; purpose: OtpPurpose; email: string; state: string; code: string;
}): string {
  assertEmailOtpHmacKey(input.key);
  const fields = ["studymind:email-otp:v1", input.purpose, input.email.trim().toLowerCase(), input.state, input.code];
  const message = fields.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return createHmac("sha256", input.key).update(message, "utf8").digest("hex");
}

export function normalizeAuthIp(input: string): string {
  const value = input.trim().toLowerCase();
  const mapped = value.startsWith("::ffff:") ? value.slice(7) : "";
  if (mapped && isIpv4(mapped)) return mapped;
  return value;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
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
