import { describe, expect, test } from "vitest";
import { AuthService } from "../src/auth.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-08-08T08:00:00.000Z");
const OTP_KEY = "test-otp-hmac-key-32-bytes-long!!";

describe("authentication atomicity", () => {
  test("concurrent OTP requests send once and concurrent verification creates one ticket and web session", async () => {
    const store = new MemoryStore();
    let code = "";
    let sends = 0;
    const auth = new AuthService({
      store, otpHmacKey: OTP_KEY, now: () => NOW,
      sendOtp: async (_email, value) => { sends += 1; code = value; },
    });
    const start = { email: "race@example.com", state: "state-123456", ip: "203.0.113.10" };
    const dispatches = await Promise.allSettled([auth.startEmailLogin(start), auth.startEmailLogin(start)]);
    expect(dispatches.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(sends).toBe(1);

    const results = await Promise.allSettled([
      auth.verifyEmailCode({ email: start.email, state: start.state, code }),
      auth.verifyEmailCode({ email: start.email, state: start.state, code }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(store.desktopLoginTickets).toHaveLength(1);
    expect(store.userSessions).toHaveLength(1);
    expect(store.emailOtps[0]).toMatchObject({ attempts: 1, consumedAt: NOW });
  });

  test("ticket exchange is single-consumer under concurrency", async () => {
    const store = new MemoryStore();
    let code = "";
    const auth = new AuthService({ store, otpHmacKey: OTP_KEY, now: () => NOW, sendOtp: async (_email, value) => { code = value; } });
    await auth.startEmailLogin({ email: "race@example.com", state: "state-123456", ip: "203.0.113.10" });
    const { ticket } = await auth.verifyEmailCode({ email: "race@example.com", state: "state-123456", code });
    const results = await Promise.allSettled([
      auth.exchangeDesktopTicket({ ticket, state: "state-123456" }),
      auth.exchangeDesktopTicket({ ticket, state: "state-123456" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(store.sessions).toHaveLength(1);
  });
});
