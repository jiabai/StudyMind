import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerDesktopAuthRoutes } from "../src/routes/desktopAuth.js";
import { MemoryStore } from "../src/store.js";

function buildApp(sendOtp: (email: string, code: string) => Promise<void> = async () => undefined) {
  const app = Fastify();
  registerDesktopAuthRoutes(app, { store: new MemoryStore(), sendOtp, now: () => new Date("2026-08-08T08:00:00.000Z") });
  return app;
}

describe("desktop auth routes", () => {
  test("serves only a valid StudyMind callback request", async () => {
    const app = buildApp();
    const valid = await app.inject({ method: "GET", url: "/login?desktop=1&state=state-123456&redirect_uri=studymind%3A%2F%2Fauth%2Fcallback" });
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toContain("StudyMind");
    for (const url of [
      "/login?desktop=1&state=bad%20state&redirect_uri=studymind%3A%2F%2Fauth%2Fcallback",
      "/login?desktop=1&state=state-123456&redirect_uri=frameq%3A%2F%2Fauth%2Fcallback",
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
    expect((await app.inject({ method: "POST", url: "/api/desktop/sessions/exchange", payload: { ticket: "flt_legacy", state: "state-123456" } })).statusCode).toBe(400);

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
    registerDesktopAuthRoutes(app, { store: new FailingStore(), sendOtp: async () => undefined });
    const response = await app.inject({ method: "POST", url: "/auth/email/start", payload: { email: "user@example.com", state: "state-123456" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "INTERNAL_SERVER_ERROR" });
    expect(response.body).not.toContain("Prisma");
  });
});
