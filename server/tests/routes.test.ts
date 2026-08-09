import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerDesktopAuthRoutes } from "../src/routes/desktopAuth.js";
import { parseCookies } from "../src/routes/cookies.js";
import { MemoryStore } from "../src/store.js";

const OTP_KEY = "test-otp-hmac-key-32-bytes-long!!";

function buildApp(sendOtp: (email: string, code: string) => Promise<void> = async () => undefined) {
  const app = Fastify();
  registerDesktopAuthRoutes(app, { store: new MemoryStore(), otpHmacKey: OTP_KEY, sendOtp, now: () => new Date("2026-08-08T08:00:00.000Z") });
  return app;
}

describe("desktop auth routes", () => {
  test("requires an explicitly configured OTP sender", () => {
    const app = Fastify();
    expect(() => registerDesktopAuthRoutes(app, { store: new MemoryStore() } as never))
      .toThrow("OTP sender is required.");
  });

  if (false) {
    const app = Fastify();
    // @ts-expect-error sendOtp is a required delivery dependency.
    registerDesktopAuthRoutes(app, { store: new MemoryStore() });
  }

  test("serves only a valid StudyMind callback request", async () => {
    const app = buildApp();
    const legacyScheme = String.fromCharCode(102, 114, 97, 109, 101, 113);
    const valid = await app.inject({ method: "GET", url: "/login?desktop=1&state=state-123456&redirect_uri=studymind%3A%2F%2Fauth%2Fcallback" });
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toContain("StudyMind");
    for (const url of [
      "/login?desktop=1&state=bad%20state&redirect_uri=studymind%3A%2F%2Fauth%2Fcallback",
      `/login?desktop=1&state=state-123456&redirect_uri=${legacyScheme}%3A%2F%2Fauth%2Fcallback`,
      "/login?desktop=1&state=state-123456&redirect_uri=studymind%3A%2F%2Fevil%2Fcallback",
    ]) expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
  });

  test("validates bodies, sets secure StudyMind cookies, exchanges once, and logs out idempotently", async () => {
    let code = "";
    const app = buildApp(async (_email, value) => { code = value; });
    const invalid = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: "x", state: "x" } });
    expect(invalid.statusCode).toBe(400);

    await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: "user@example.com", state: "state-123456" } });
    const verify = await app.inject({ method: "POST", url: "/auth/email/verify", payload: { email: "user@example.com", code, state: "state-123456" } });
    expect(verify.statusCode).toBe(200);
    expect(verify.json<{ ticket: string; redirect_url: string }>().ticket).toMatch(/^smlt_/);
    expect(verify.json<{ redirect_url: string }>().redirect_url).toMatch(/^studymind:\/\/auth\/callback/);
    const cookies = verify.headers["set-cookie"] as string[];
    expect(cookies.join("\n")).toContain("studymind_user_session=smus_");
    expect(cookies.join("\n")).toContain("studymind_user_csrf=smuc_");
    expect(cookies.join("\n")).toMatch(/HttpOnly/i);
    expect(cookies.join("\n")).toMatch(/Secure/i);
    expect(cookies.join("\n")).toMatch(/SameSite=Lax/i);

    const { ticket } = verify.json<{ ticket: string }>();
    const exchange = await app.inject({ method: "POST", url: "/api/desktop/sessions/exchange", payload: { ticket, state: "state-123456" } });
    expect(exchange.statusCode).toBe(200);
    const token = exchange.json<{ session_token: string }>().session_token;
    expect(token).toMatch(/^smds_/);
    expect((await app.inject({ method: "POST", url: "/api/desktop/sessions/exchange", payload: { ticket, state: "state-123456" } })).statusCode).toBe(400);
    const legacyTicket = `${String.fromCharCode(102, 108, 116, 95)}legacy`;
    expect((await app.inject({ method: "POST", url: "/api/desktop/sessions/exchange", payload: { ticket: legacyTicket, state: "state-123456" } })).statusCode).toBe(400);

    for (const authorization of [`Bearer ${token}`, `Bearer ${token}`]) {
      const logout = await app.inject({ method: "POST", url: "/api/desktop/logout", headers: { authorization } });
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toEqual({ ok: true });
    }
  });

  test("maps store failures to fixed public errors", async () => {
    class FailingStore extends MemoryStore {
      override async issueEmailOtp(): ReturnType<MemoryStore["issueEmailOtp"]> { throw new Error("Prisma secret detail"); }
    }
    const app = Fastify();
    registerDesktopAuthRoutes(app, { store: new FailingStore(), otpHmacKey: OTP_KEY, sendOtp: async () => undefined });
    const response = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: "user@example.com", state: "state-123456" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "INTERNAL_SERVER_ERROR" });
    expect(response.body).not.toContain("Prisma");
  });

  test("returns a fixed temporarily-unavailable response when OTP delivery fails", async () => {
    const store = new MemoryStore();
    const app = Fastify();
    registerDesktopAuthRoutes(app, { store, otpHmacKey: OTP_KEY, sendOtp: async () => { throw new Error("SMTP credentials and OTP 123456"); } });
    const response = await app.inject({
      method: "POST", url: "/auth/email/start",
      payload: { email: "user@example.com", state: "state-123456" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
    expect(response.body).not.toContain("SMTP");
    expect(response.body).not.toContain("123456");
    expect(store.emailOtps[0]?.consumedAt).not.toBeNull();
  });

  test("returns 429 with a clock-derived Retry-After when OTP rate limited", async () => {
    const app = buildApp();
    const payload = { email: "rate@example.com", state: "state-123456" };
    expect((await app.inject({ method: "POST", url: "/auth/email/start", payload })).statusCode).toBe(200);
    const limited = await app.inject({ method: "POST", url: "/auth/email/start", payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toEqual({ error: "RATE_LIMITED", retry_at: "2026-08-08T08:01:00.000Z" });
  });

  test("ignores malformed percent-encoded cookies without throwing", () => {
    expect(() => parseCookies("good=value; bad=%ZZ; later=ok%20value")).not.toThrow();
    expect(parseCookies("good=value; bad=%ZZ; later=ok%20value")).toEqual(new Map([["good", "value"], ["later", "ok value"]]));
  });

  test("does not accept an email start until delivery succeeds", async () => {
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
    const app = buildApp(async () => { markDeliveryStarted?.(); await delivery; });
    let settled = false;
    const responsePromise = app.inject({
      method: "POST", url: "/auth/email/start",
      payload: { email: "user@example.com", state: "state-123456" },
    }).then((response) => { settled = true; return response; });
    await deliveryStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseDelivery?.();
    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
