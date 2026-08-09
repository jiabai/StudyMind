import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { ActivationCodeService } from "../src/activation.js";
import { AdminAuthService } from "../src/adminAuth.js";
import { EntitlementAdjustmentService } from "../src/entitlementAdjustment.js";
import { LlmConfigService } from "../src/llmConfig.js";
import { registerAdminRoutes } from "../src/routes/admin.js";
import { MemoryStore } from "../src/store.js";

const now = new Date("2026-08-09T08:00:00.000Z");
const hmac = "test-email-otp-hmac-key-with-at-least-32-bytes";
const encryptionKey = "test-llm-encryption-key-with-at-least-32-bytes";

function fixture() {
  const store = new MemoryStore(); let sentCode = "";
  const auth = new AdminAuthService({ store, adminEmail: "admin@studymind.test", otpHmacKey: hmac, now: () => now, sendOtp: async (_email, value) => { sentCode = value; } });
  const activationCodes = new ActivationCodeService({ store, now: () => now });
  const llmConfig = new LlmConfigService({ store, encryptionKey, now: () => now });
  const adjustments = new EntitlementAdjustmentService({ store, now: () => now });
  const app = Fastify();
  registerAdminRoutes(app, { store, auth, activationCodes, llmConfig, adjustments, adminEmail: "admin@studymind.test", now: () => now, secureCookies: true });
  return { app, store, auth, activationCodes, llmConfig, adjustments, sentCode: () => sentCode };
}
async function login() {
  const f = fixture();
  await f.app.inject({ method: "POST", url: "/admin/auth/email/start", payload: { state: "admin-state-1" } });
  const response = await f.app.inject({ method: "POST", url: "/admin/auth/email/verify", payload: { state: "admin-state-1", code: f.sentCode() } });
  const headers = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [String(response.headers["set-cookie"] ?? "")];
  const session = headers.find((v) => v.startsWith("studymind_admin_session="))!; const csrfHeader = headers.find((v) => v.startsWith("studymind_admin_csrf="))!;
  return { ...f, response, headers, cookie: `${session.split(";")[0]}; ${csrfHeader.split(";")[0]}`, csrf: csrfHeader.split(";")[0]!.split("=")[1]!, session, csrfHeader };
}

describe("StudyMind admin routes", () => {
  test("starts OTP only for the configured identity and rejects caller-supplied email", async () => {
    const { app, store } = fixture();
    expect((await app.inject({ method: "POST", url: "/admin/auth/email/start", payload: { state: "admin-state-1" } })).statusCode).toBe(200);
    expect(store.emailOtps[0]?.email).toBe("admin@studymind.test");
    expect((await app.inject({ method: "POST", url: "/admin/auth/email/start", payload: { email: "attacker@example.com", state: "admin-state-2" } })).statusCode).toBe(400);
  });

  test("verifies OTP and sets a 12-hour HttpOnly session plus readable csrf cookie", async () => {
    const { response, session, csrfHeader } = await login();
    expect(response.json()).toEqual({ ok: true, redirect_url: "/admin" });
    expect(session).toContain("HttpOnly"); expect(session).toContain("Secure"); expect(session).toContain("SameSite=Lax"); expect(session).toContain("Max-Age=43200");
    expect(csrfHeader).not.toContain("HttpOnly"); expect(csrfHeader).toContain("Secure");
  });

  test("requires valid admin session and matching cookie/header csrf for every mutation", async () => {
    const { app, cookie, csrf } = await login();
    expect((await app.inject({ method: "POST", url: "/admin/api/activation-codes", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/admin/api/activation-codes", headers: { cookie }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/api/activation-codes", headers: { cookie, "x-studymind-csrf": `${csrf}x` }, payload: {} })).statusCode).toBe(403);
  });

  test("generates a raw activation code only in the creation response", async () => {
    const { app, store, cookie, csrf } = await login();
    const response = await app.inject({ method: "POST", url: "/admin/api/activation-codes", headers: { cookie, "x-studymind-csrf": csrf }, payload: { redeem_window_days: 7 } });
    expect(response.statusCode).toBe(200); expect(response.json<{ code: string }>().code).toMatch(/^SM-/); expect(response.json()).toMatchObject({ entitlement_days: 31, redeem_by: "2026-08-16T08:00:00.000Z" });
    expect(store.activationCodes[0]?.codeHash).not.toContain(response.json<{ code: string }>().code);
  });

  test("saves encrypted LLM config and exposes only configured plus last4", async () => {
    const { app, store, cookie, csrf } = await login();
    const response = await app.inject({ method: "POST", url: "/admin/api/llm-config", headers: { cookie, "x-studymind-csrf": csrf }, payload: { provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-test", api_key: "secret-api-key", timeout_seconds: 30 } });
    expect(response.json()).toEqual({ configured: true, api_key_last4: "-key" }); expect(response.body).not.toContain("secret-api-key"); expect(store.llmConfig?.encryptedApiKey).not.toContain("secret-api-key");
  });

  test("audits entitlement adjustment with the authenticated admin identity", async () => {
    const { app, store, cookie, csrf } = await login(); const user = await store.upsertUserByEmail("student@example.com", now);
    expect((await app.inject({ method: "POST", url: `/admin/api/users/${user.id}/entitlement-adjustments`, headers: { cookie, "x-studymind-csrf": csrf }, payload: { reason: "support", extend_days: 2, admin_email: "attacker@example.com" } })).statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: `/admin/api/users/${user.id}/entitlement-adjustments`, headers: { cookie, "x-studymind-csrf": csrf }, payload: { reason: "support", extend_days: 2 } });
    expect(response.statusCode).toBe(200); expect(store.adminEntitlementAdjustments[0]?.adminEmail).toBe("admin@studymind.test");
  });

  test("renders secure StudyMind pages and redirects invalid sessions", async () => {
    const { app, cookie } = await login(); const page = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    expect(page.statusCode).toBe(200); expect(page.headers["content-security-policy"]).toBeTruthy(); expect(page.body).toContain("StudyMind");
    expect(page.body).toContain('for="llm-provider"');
    expect(page.body).toContain('for="llm-base-url"');
    expect(page.body).toContain('for="llm-model"');
    expect(page.body).toContain('for="llm-api-key"');
    expect(page.body).toContain('for="llm-timeout"');
    expect(page.body).toContain("保存 LLM 配置");
    expect(page.body).toContain("/admin/api/llm-config");
    expect(page.body).toContain("x-studymind-csrf");
    const loginPage = await app.inject({ method: "GET", url: "/admin/login" }); expect(loginPage.headers["cache-control"]).toBe("no-store"); expect(loginPage.body).toContain("StudyMind");
    const invalid = await app.inject({ method: "GET", url: "/admin", headers: { cookie: "studymind_admin_session=invalid" } }); expect(invalid.statusCode).toBe(302); expect(invalid.headers.location).toBe("/admin/login");
  });

  test("logout requires csrf, revokes the session, and clears both cookies", async () => {
    const { app, store, cookie, csrf } = await login();
    expect((await app.inject({ method: "POST", url: "/admin/auth/logout", headers: { cookie } })).statusCode).toBe(403);
    const response = await app.inject({ method: "POST", url: "/admin/auth/logout", headers: { cookie, "x-studymind-csrf": csrf } });
    expect(response.json()).toEqual({ ok: true, redirect_url: "/admin/login" }); expect(String(response.headers["set-cookie"])).toContain("Max-Age=0"); expect(store.adminSessions[0]?.revokedAt).toEqual(now);
  });

  test("escapes csrf JSON embedded in the admin script while preserving its JavaScript value", async () => {
    const { app, store } = fixture(); const token = "admin-script-session"; const csrf = "</script><script>owned()</script>\u2028line\u2029end";
    const { sha256 } = await import("../src/security.js");
    await store.createAdminSession({ email: "admin@studymind.test", tokenHash: sha256(token), csrfTokenHash: sha256(csrf), createdAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    const response = await app.inject({ method: "GET", url: "/admin", headers: { cookie: `studymind_admin_session=${token}; studymind_admin_csrf=${encodeURIComponent(csrf)}` } });
    expect(response.statusCode).toBe(200); expect(response.body).not.toContain("</script><script>owned()"); expect(response.body).toContain("\\u003c/script>\\u003cscript>owned()\\u003c/script>"); expect(response.body).toContain("\\u2028line\\u2029");
    const literal = response.body.match(/const csrf=("(?:\\.|[^"\\])*")/)?.[1]; expect(literal).toBeTruthy(); expect(JSON.parse(literal!)).toBe(csrf);
  });

  test("maps admin auth, dashboard, and mutation dependency failures to a fixed private 503", async () => {
    const detail = "private database detail";
    const authFailure = fixture(); authFailure.auth.authenticate = async () => { throw new Error(detail); };
    await expectPrivate503(await authFailure.app.inject({ method: "GET", url: "/admin", headers: { cookie: "studymind_admin_session=value" } }), detail);
    const dashboardFailure = await login(); dashboardFailure.store.listUsers = async () => { throw new Error(detail); };
    await expectPrivate503(await dashboardFailure.app.inject({ method: "GET", url: "/admin", headers: { cookie: dashboardFailure.cookie } }), detail);
    for (const kind of ["activation", "llm", "adjustment"] as const) {
      const f = await login();
      if (kind === "activation") f.activationCodes.generateCode = async () => { throw new Error(detail); };
      if (kind === "llm") f.llmConfig.save = async () => { throw new Error(detail); };
      if (kind === "adjustment") f.adjustments.apply = async () => { throw new Error(detail); };
      const user = await f.store.upsertUserByEmail("failure@example.com", now);
      const requests = { activation: { url: "/admin/api/activation-codes", payload: {} }, llm: { url: "/admin/api/llm-config", payload: { provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt", api_key: "private-key", timeout_seconds: 30 } }, adjustment: { url: `/admin/api/users/${user.id}/entitlement-adjustments`, payload: { reason: "support", extend_days: 1 } } };
      const request = requests[kind]; await expectPrivate503(await f.app.inject({ method: "POST", url: request.url, headers: { cookie: f.cookie, "x-studymind-csrf": f.csrf }, payload: request.payload }), detail);
    }
  });
});

async function expectPrivate503(response: { statusCode: number; json(): unknown; body: string }, detail: string) { expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); expect(response.body).not.toContain(detail); }
