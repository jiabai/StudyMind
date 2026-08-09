import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ActivationCodeService } from "../src/activation.js";
import { AdminAuthService } from "../src/adminAuth.js";
import { LlmConfigService } from "../src/llmConfig.js";
import { EntitlementAdjustmentService } from "../src/entitlementAdjustment.js";
import { Readiness } from "../src/readiness.js";
import { createServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";
import { UserAuthService } from "../src/userAuth.js";

const OTP_KEY = "test-otp-hmac-key-with-32-bytes-aa";
const LLM_KEY = "test-llm-encryption-key-32-bytes-bb";

function appDependencies(notificationParser: ((input: { rawBody: Buffer }) => Promise<never>) | null = null) {
  const store = new MemoryStore(); const sendOtp = async () => undefined; const now = () => new Date("2026-08-09T00:00:00Z");
  return { store, sendOtp, otpHmacKey: OTP_KEY, adminEmail: "admin@example.com", secureCookies: false, now,
    auth: undefined, userAuth: new UserAuthService({ store, sendOtp, otpHmacKey: OTP_KEY, now }), adminAuth: new AdminAuthService({ store, sendOtp, otpHmacKey: OTP_KEY, adminEmail: "admin@example.com", now }),
    llmConfig: new LlmConfigService({ store, encryptionKey: LLM_KEY, now }), activationCodes: new ActivationCodeService({ store, now }), adjustments: new EntitlementAdjustmentService({ store, now }),
    billing: notificationParser ? ({ applyPaidOrder: async () => undefined } as never) : null, notificationParser: notificationParser as never,
    readiness: new Readiness({ probe: async () => true }), logger: false as const,
  };
}

describe("server module and route boundary", () => {
  test("source imports only account runtime routes", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    for (const route of ["health", "desktopAuth", "desktopAccount", "desktopLlm", "billing", "admin", "userAuth", "dashboard"]) expect(source).toContain(`./routes/${route}.js`);
    expect(source).not.toMatch(/taskRoutes|progressRoutes|workerRoutes|updateRoutes|Access-Control-Allow-Origin/);
  });

  test("registers the exact product surface and no processing endpoints", async () => {
    const app = await createServer(appDependencies());
    const routes = app.printRoutes({ commonPrefix: false });
    for (const leaf of ["live (GET, HEAD)", "ready (GET, HEAD)", "account (GET, HEAD)", "llm/checkouts (POST)", "wechat-native (POST)", "wechat/notify (POST)", "user/auth/", "dashboard (GET, HEAD)"]) expect(routes).toContain(leaf);
    for (const path of ["/api/tasks", "/api/progress", "/api/worker", "/api/updates"]) expect((await app.inject(path)).statusCode).toBe(404);
    expect((await app.inject({ method: "OPTIONS", url: "/api/desktop/account", headers: { origin: "https://evil.example" } })).headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  test("retains exact JSON bytes only for the WeChat notification route", async () => {
    const payload = '{ "resource" : {"ciphertext":"opaque"} }'; let raw: Buffer = Buffer.alloc(0);
    const app = await createServer(appDependencies(async (input) => { raw = input.rawBody; throw new Error("INVALID_WECHAT_NOTIFICATION"); }));
    const notify = await app.inject({ method: "POST", url: "/api/wechat/notify", headers: { "content-type": "application/json" }, payload });
    expect(notify.statusCode).toBe(400); expect(raw.equals(Buffer.from(payload))).toBe(true);
    const source = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    expect(source).toContain('=== "/api/wechat/notify"');
    expect((await app.inject({ method: "POST", url: "/user/auth/email/start", payload: { hello: "world" } })).statusCode).toBe(400);
    await app.close();
  });

  test("preserves fixed Fastify protocol status codes without exposing parser details", async () => {
    const app = await createServer(appDependencies());
    const malformed = await app.inject({ method: "POST", url: "/user/auth/email/start", headers: { "content-type": "application/json" }, payload: "{secret-broken-json" });
    expect(malformed.statusCode).toBe(400); expect(malformed.json()).toEqual({ error: "INVALID_JSON_BODY" }); expect(malformed.body).not.toContain("secret-broken-json");
    const oversized = await app.inject({ method: "POST", url: "/user/auth/email/start", headers: { "content-type": "application/json" }, payload: JSON.stringify({ value: "x".repeat(1024 * 1024) }) });
    expect(oversized.statusCode).toBe(413); expect(oversized.json()).toEqual({ error: "REQUEST_BODY_TOO_LARGE" });
    const media = await app.inject({ method: "POST", url: "/user/auth/email/start", headers: { "content-type": "application/x-secret-format" }, payload: "provider-secret-detail" });
    expect(media.statusCode).toBe(415); expect(media.json()).toEqual({ error: "UNSUPPORTED_MEDIA_TYPE" }); expect(media.body).not.toContain("provider-secret-detail");
    await app.close();
  });
});
