import { describe, expect, test } from "vitest";
import { AdminAuthService } from "../src/adminAuth.js";
import { AuthService } from "../src/auth.js";
import { hashEmailOtp, normalizeAuthIp, sha256 } from "../src/security.js";
import { MemoryStore } from "../src/store.js";
import { UserAuthService } from "../src/userAuth.js";

const NOW = new Date("2026-08-08T08:00:00.000Z");
const OTP_KEY = "test-otp-hmac-key-32-bytes-long!!";
const OTHER_OTP_KEY = "other-otp-hmac-key-32-bytes-long!";

describe("StudyMind desktop authentication", () => {
  test("stores only the OTP hash and creates StudyMind tickets and sessions with exact lifetimes", async () => {
    const store = new MemoryStore();
    let code = "";
    const auth = new AuthService({ store, otpHmacKey: OTP_KEY, now: () => NOW, sendOtp: async (_email, value) => { code = value; } });

    await auth.startEmailLogin({ email: " USER@Example.COM ", state: "state-123456", ip: "203.0.113.10" });
    expect(code).toMatch(/^\d{6}$/);
    expect(store.emailOtps[0]?.codeHash).not.toBe(code);
    expect(store.emailOtps[0]?.codeHash).not.toBe(sha256(code));
    expect(store.emailOtps[0]?.expiresAt.toISOString()).toBe("2026-08-08T08:10:00.000Z");

    const verified = await auth.verifyEmailCode({ email: "user@example.com", code, state: "state-123456" });
    expect(verified.ticket).toMatch(/^smlt_/);
    expect(verified.redirectUrl).toMatch(/^studymind:\/\/auth\/callback\?/);
    expect(verified.webSessionToken).toMatch(/^smus_/);
    expect(verified.webCsrfToken).toMatch(/^smuc_/);
    expect(store.desktopLoginTickets[0]?.expiresAt.toISOString()).toBe("2026-08-08T08:05:00.000Z");
    expect(store.userSessions[0]?.expiresAt.toISOString()).toBe("2026-11-06T08:00:00.000Z");

    const exchanged = await auth.exchangeDesktopTicket({ ticket: verified.ticket, state: "state-123456" });
    expect(exchanged.sessionToken).toMatch(/^smds_/);
    expect(store.sessions[0]?.tokenHash).not.toBe(exchanged.sessionToken);
    expect(store.sessions[0]?.expiresAt.toISOString()).toBe("2026-11-06T08:00:00.000Z");
    await expect(auth.exchangeDesktopTicket({ ticket: verified.ticket, state: "state-123456" }))
      .rejects.toThrow("Login ticket is invalid or expired.");
  });

  test("isolates OTP purpose, rejects expiry, and locks after five attempts", async () => {
    const store = new MemoryStore();
    let clock = NOW;
    let code = "";
    const auth = new AuthService({ store, otpHmacKey: OTP_KEY, now: () => clock, sendOtp: async (_email, value) => { code = value; } });
    await auth.startEmailLogin({ email: "user@example.com", state: "state-123456", ip: "203.0.113.10" });
    clock = new Date(NOW.getTime() + 10 * 60_000);
    await expect(auth.verifyEmailCode({ email: "user@example.com", code, state: "state-123456" }))
      .rejects.toThrow("Verification code is invalid or expired.");

    clock = new Date(NOW.getTime() + 61_000);
    await auth.startEmailLogin({ email: "other@example.com", state: "state-654321", ip: "203.0.113.10" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.verifyEmailCode({ email: "other@example.com", code: "000000", state: "state-654321" }))
        .rejects.toThrow("Verification code is invalid or expired.");
    }
    await expect(auth.verifyEmailCode({ email: "other@example.com", code, state: "state-654321" }))
      .rejects.toThrow("Verification code is invalid or expired.");
  });

  test("does not accept an administrator OTP for desktop login", async () => {
    const store = new MemoryStore();
    await store.issueEmailOtp({
      purpose: "admin_login", email: "user@example.com", state: "state-123456",
      codeHash: hashEmailOtp({ key: OTP_KEY, purpose: "admin_login", email: "user@example.com", state: "state-123456", code: "123456" }), ip: "203.0.113.10",
      expiresAt: new Date(NOW.getTime() + 10 * 60_000), createdAt: NOW,
    });
    const auth = new AuthService({ store, otpHmacKey: OTP_KEY, now: () => NOW, sendOtp: async () => undefined });
    await expect(auth.verifyEmailCode({ email: "user@example.com", code: "123456", state: "state-123456" }))
      .rejects.toThrow("Verification code is invalid or expired.");
    expect(store.desktopLoginTickets).toHaveLength(0);
  });

  test("returns the maximum retryAt and preserves one-minute and hourly limits", async () => {
    const store = new MemoryStore();
    let clock = NOW;
    const auth = new AuthService({ store, otpHmacKey: OTP_KEY, now: () => clock, sendOtp: async () => undefined });
    await auth.startEmailLogin({ email: "rate@example.com", state: "state-123456", ip: "203.0.113.20" });
    await expect(auth.startEmailLogin({ email: "rate@example.com", state: "state-123456", ip: "203.0.113.20" }))
      .rejects.toMatchObject({ retryAt: new Date(NOW.getTime() + 60_000) });
    for (let index = 1; index < 5; index += 1) {
      clock = new Date(NOW.getTime() + index * 61_000);
      await auth.startEmailLogin({ email: "rate@example.com", state: `state-${index}23456`, ip: `203.0.113.${20 + index}` });
    }
    clock = new Date(NOW.getTime() + 5 * 61_000);
    await expect(auth.startEmailLogin({ email: "rate@example.com", state: "state-final12", ip: "203.0.113.30" }))
      .rejects.toMatchObject({ retryAt: new Date("2026-08-08T09:00:00.000Z") });
  });

  test("domain-separates OTP HMACs and rejects short keys", () => {
    const base = { key: OTP_KEY, purpose: "desktop_login" as const, email: "user@example.com", state: "state-123456", code: "123456" };
    const hashes = [hashEmailOtp(base), hashEmailOtp({ ...base, purpose: "admin_login" }), hashEmailOtp({ ...base, email: "other@example.com" }), hashEmailOtp({ ...base, state: "state-654321" })];
    expect(new Set(hashes)).toHaveLength(4);
    expect(hashes).not.toContain(sha256(base.code));
    expect(() => new AuthService({ store: new MemoryStore(), otpHmacKey: "short", sendOtp: async () => undefined })).toThrow("at least 32 bytes");
    expect(() => new UserAuthService({ store: new MemoryStore(), otpHmacKey: "", sendOtp: async () => undefined })).toThrow("at least 32 bytes");
    expect(() => new AdminAuthService({ store: new MemoryStore(), otpHmacKey: "short", adminEmail: "admin@example.com", sendOtp: async () => undefined })).toThrow("at least 32 bytes");
  });

  test("cannot verify an OTP with a different HMAC key", async () => {
    const store = new MemoryStore(); let code = "";
    const issuer = new AuthService({ store, otpHmacKey: OTP_KEY, now: () => NOW, sendOtp: async (_email, value) => { code = value; } });
    await issuer.startEmailLogin({ email: "keyed@example.com", state: "state-123456", ip: "203.0.113.10" });
    const verifier = new AuthService({ store, otpHmacKey: OTHER_OTP_KEY, now: () => NOW, sendOtp: async () => undefined });
    await expect(verifier.verifyEmailCode({ email: "keyed@example.com", state: "state-123456", code })).rejects.toThrow("invalid or expired");
  });

  test("normalizes IPv4-mapped addresses into the IPv4 rate bucket", async () => {
    expect(normalizeAuthIp(" ::FFFF:203.0.113.9 ")).toBe("203.0.113.9");
    const store = new MemoryStore(); let clock = NOW;
    const auth = new AuthService({ store, otpHmacKey: OTP_KEY, now: () => clock, sendOtp: async () => undefined });
    await auth.startEmailLogin({ email: "first@example.com", state: "state-123456", ip: "::ffff:203.0.113.9" });
    clock = new Date(NOW.getTime() + 61_000);
    await auth.startEmailLogin({ email: "second@example.com", state: "state-654321", ip: "203.0.113.9" });
    expect(store.authRateLimits.filter(({ scope }) => scope === "ip_hour")).toMatchObject([{ count: 2 }]);
  });

  test("does not disclose whether an administrator email is authorized", async () => {
    let sends = 0;
    const auth = new AdminAuthService({ store: new MemoryStore(), otpHmacKey: OTP_KEY, adminEmail: "admin@example.com", now: () => NOW, sendOtp: async () => { sends += 1; } });
    await expect(auth.startEmailLogin({ email: "unknown@example.com", state: "state-123456", ip: "203.0.113.10" })).resolves.toEqual({ accepted: true });
    expect(sends).toBe(0);
  });

  test("keeps user and admin delivery errors fixed when OTP invalidation also fails", async () => {
    class FailingInvalidationStore extends MemoryStore {
      override async invalidateIssuedOtpAfterDeliveryFailure(): Promise<void> { throw new Error("Prisma secret invalidation detail"); }
    }
    const deliveryFailure = async () => { throw new Error("SMTP secret delivery detail"); };
    const user = new UserAuthService({ store: new FailingInvalidationStore(), otpHmacKey: OTP_KEY, now: () => NOW, sendOtp: deliveryFailure });
    const admin = new AdminAuthService({ store: new FailingInvalidationStore(), otpHmacKey: OTP_KEY, adminEmail: "admin@example.com", now: () => NOW, sendOtp: deliveryFailure });
    await expect(user.startEmailLogin({ email: "user@example.com", state: "state-123456", ip: "203.0.113.1" })).rejects.toThrow("SERVER_TEMPORARILY_UNAVAILABLE");
    await expect(admin.startEmailLogin({ email: "admin@example.com", state: "state-123456", ip: "203.0.113.2" })).rejects.toThrow("SERVER_TEMPORARILY_UNAVAILABLE");
  });

  test("uses the same keyed OTP contract for user and administrator verification", async () => {
    let userCode = ""; const userStore = new MemoryStore();
    const user = new UserAuthService({ store: userStore, otpHmacKey: OTP_KEY, now: () => NOW, sendOtp: async (_email, code) => { userCode = code; } });
    await user.startEmailLogin({ email: "user@example.com", state: "state-123456", ip: "203.0.113.1" });
    await expect(user.verifyEmailCode({ email: "user@example.com", state: "state-123456", code: userCode })).resolves.toMatchObject({ sessionToken: expect.stringMatching(/^smus_/), csrfToken: expect.stringMatching(/^smuc_/) });

    let adminCode = ""; const adminStore = new MemoryStore();
    const admin = new AdminAuthService({ store: adminStore, otpHmacKey: OTP_KEY, adminEmail: "admin@example.com", now: () => NOW, sendOtp: async (_email, code) => { adminCode = code; } });
    await admin.startEmailLogin({ email: "admin@example.com", state: "state-123456", ip: "203.0.113.2" });
    await expect(admin.verifyEmailCode({ email: "admin@example.com", state: "state-123456", code: adminCode })).resolves.toMatchObject({ sessionToken: expect.stringMatching(/^smas_/), csrfToken: expect.stringMatching(/^smac_/) });
  });
});
