import { describe, expect, test } from "vitest";
import { AuthService } from "../src/auth.js";
import { sha256 } from "../src/security.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-08-08T08:00:00.000Z");

describe("StudyMind desktop authentication", () => {
  test("stores only the OTP hash and creates StudyMind tickets and sessions with exact lifetimes", async () => {
    const store = new MemoryStore();
    let code = "";
    const auth = new AuthService({ store, now: () => NOW, sendOtp: async (_email, value) => { code = value; } });

    await auth.startEmailLogin({ email: " USER@Example.COM ", state: "state-123456", ip: "203.0.113.10" });
    expect(code).toMatch(/^\d{6}$/);
    expect(store.emailOtps[0]?.codeHash).not.toBe(code);
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
    const auth = new AuthService({ store, now: () => clock, sendOtp: async (_email, value) => { code = value; } });
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
      codeHash: sha256("123456"), ip: "203.0.113.10",
      expiresAt: new Date(NOW.getTime() + 10 * 60_000), createdAt: NOW,
    });
    const auth = new AuthService({ store, now: () => NOW, sendOtp: async () => undefined });
    await expect(auth.verifyEmailCode({ email: "user@example.com", code: "123456", state: "state-123456" }))
      .rejects.toThrow("Verification code is invalid or expired.");
    expect(store.desktopLoginTickets).toHaveLength(0);
  });

  test("returns the maximum retryAt and preserves one-minute and hourly limits", async () => {
    const store = new MemoryStore();
    let clock = NOW;
    const auth = new AuthService({ store, now: () => clock, sendOtp: async () => undefined });
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
});
