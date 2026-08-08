import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { BillingAuthRequiredError, BillingService } from "../src/billing.js";
import { registerBillingRoutes } from "../src/routes/billing.js";
import { sha256 } from "../src/security.js";
import { MemoryStore } from "../src/store.js";
import { createWechatNotificationParser, type WechatConfig } from "../src/wechat.js";

const now = new Date("2026-08-09T08:00:00.000Z");

async function userFixture(store: MemoryStore, email: string, token: string) {
  const user = await store.upsertUserByEmail(email, now);
  await store.createSession({ userId: user.id, tokenHash: sha256(token), createdAt: now, expiresAt: new Date("2026-09-09T08:00:00.000Z") });
  return user;
}

describe("StudyMind billing", () => {
  test("creates the fixed monthly pass and settlement does not add LLM quota", async () => {
    const store = new MemoryStore();
    const user = await userFixture(store, "student@example.com", "owner-token");
    const billing = new BillingService({
      store, now: () => now, randomId: () => "safe_random",
      createNativePayment: async (input) => ({ codeUrl: `weixin://pay/${input.outTradeNo}`, providerPayload: input }),
    });
    const order = await billing.createWechatNativeOrder({ sessionTokenHash: sha256("owner-token") });
    expect(order).toMatchObject({ outTradeNo: "sm_safe_random", amountFen: 990, status: "pending", currency: "CNY" });
    expect(store.orders[0]?.providerPayload).toContain("StudyMind monthly pass");
    await store.upsertEntitlement(user.id, new Date("2026-08-10T08:00:00.000Z"), now, { llmQuotaLimit: 7, llmQuotaUsed: 2 });
    const paid = await billing.applyPaidOrder({ outTradeNo: order.outTradeNo, transactionId: "wx-tx", webhookId: "evt-1", paidAt: now });
    expect(paid.entitlementExpiresAt.toISOString()).toBe("2026-09-10T08:00:00.000Z");
    expect((await store.getEntitlement(user.id))?.llmQuotaLimit).toBe(7);
    const replay = await billing.applyPaidOrder({ outTradeNo: order.outTradeNo, transactionId: "wx-tx", webhookId: "evt-1", paidAt: now });
    expect(replay.entitlementExpiresAt).toEqual(paid.entitlementExpiresAt);
    await expect(billing.applyPaidOrder({ outTradeNo: order.outTradeNo, transactionId: "wx-tx", webhookId: "evt-1", paidAt: new Date("2026-08-09T08:01:00.000Z") })).rejects.toThrow("WEBHOOK_PAYLOAD_CONFLICT");
    await expect(billing.applyPaidOrder({ outTradeNo: order.outTradeNo, transactionId: "different-tx", webhookId: "evt-2", paidAt: now })).rejects.toThrow("TRANSACTION_MISMATCH");
    expect(store.webhookEvents).toHaveLength(1);
  });

  test("desktop routes enforce disabled mode, bearer ownership, and fixed provider errors", async () => {
    const store = new MemoryStore();
    await userFixture(store, "owner@example.com", "smds_owner-token");
    await userFixture(store, "other@example.com", "smds_other-token");
    const disabled = Fastify();
    registerBillingRoutes(disabled, { store, billing: null, notificationParser: null, now: () => now });
    expect((await disabled.inject({ method: "POST", url: "/api/desktop/billing/wechat-native", headers: { authorization: "Bearer smds_owner-token" } })).json()).toEqual({ error: "BILLING_DISABLED" });
    expect((await disabled.inject({ method: "POST", url: "/api/wechat/notify", payload: {} })).statusCode).toBe(404);
    expect((await disabled.inject({ method: "GET", url: "/api/desktop/billing/orders/sm_missing1", headers: { authorization: "Bearer smds_owner-token" } })).json()).toEqual({ error: "BILLING_DISABLED" });

    const failingBilling = new BillingService({ store, now: () => now, randomId: () => "provider_fail", createNativePayment: async () => { throw new Error("private provider detail"); } });
    const failedApp = Fastify();
    registerBillingRoutes(failedApp, { store, billing: failingBilling, notificationParser: async () => { throw new Error("unused"); }, now: () => now });
    const failed = await failedApp.inject({ method: "POST", url: "/api/desktop/billing/wechat-native", headers: { authorization: "Bearer smds_owner-token" } });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
    expect(failed.body).not.toContain("private provider detail");

    const billing = new BillingService({ store, now: () => now, randomId: () => "owned12", createNativePayment: async () => ({ codeUrl: "weixin://owned", providerPayload: {} }) });
    const app = Fastify();
    registerBillingRoutes(app, { store, billing, notificationParser: async () => { throw new Error("unused"); }, now: () => now });
    const created = await app.inject({ method: "POST", url: "/api/desktop/billing/wechat-native", headers: { authorization: "Bearer smds_owner-token" } });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ order_id: "sm_owned12", amount_fen: 990, currency: "CNY", code_url: "weixin://owned", expires_at: "2026-08-09T08:30:00.000Z", status: "pending" });
    const denied = await app.inject({ method: "GET", url: "/api/desktop/billing/orders/sm_owned12", headers: { authorization: "Bearer smds_other-token" } });
    expect(denied.statusCode).toBe(404);
  });

  test("webhook passes the injected exact raw bytes to verification before atomic settlement", async () => {
    const store = new MemoryStore(); const user = await userFixture(store, "paid@example.com", "smds_paid-token");
    await store.createOrder({ userId: user.id, outTradeNo: "sm_webhook1", amountFen: 990, status: "pending", codeUrl: "weixin://pay", expiresAt: new Date("2026-08-09T08:30:00.000Z"), createdAt: now, providerPayload: "{}" });
    const billing = new BillingService({ store, now: () => now, createNativePayment: async () => { throw new Error("unused"); } }); const app = Fastify();
    const trustedRaw = Buffer.from(JSON.stringify({ webhookId: "evt-web", outTradeNo: "sm_webhook1", transactionId: "tx-web" }));
    app.addHook("onRequest", async (request) => { (request as typeof request & { rawBody: Buffer }).rawBody = trustedRaw; });
    registerBillingRoutes(app, { store, billing, now: () => now, notificationParser: async ({ rawBody }) => { const trusted = JSON.parse(rawBody.toString()) as { webhookId: string; outTradeNo: string; transactionId: string }; return { ...trusted, paidAt: now, amountFen: 990, currency: "CNY" }; } });
    const response = await app.inject({ method: "POST", url: "/api/wechat/notify", payload: { webhookId: "attacker", outTradeNo: "sm_attacker", transactionId: "attacker-tx" } });
    expect(response.json()).toEqual({ code: "SUCCESS", message: "success" }); expect(store.orders[0]).toMatchObject({ status: "paid", transactionId: "tx-web" }); expect(store.webhookEvents).toHaveLength(1);
  });

  test("webhook refuses requests when raw body capture is absent", async () => {
    const store = new MemoryStore(); const billing = new BillingService({ store, createNativePayment: async () => { throw new Error("unused"); } }); const app = Fastify();
    registerBillingRoutes(app, { store, billing, notificationParser: async () => { throw new Error("must not run"); } });
    const response = await app.inject({ method: "POST", url: "/api/wechat/notify", payload: {} }); expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ code: "FAIL", message: "INVALID_WECHAT_NOTIFICATION" });
    const stringApp = Fastify(); let parserCalls = 0; stringApp.addHook("onRequest", async (request) => { (request as typeof request & { rawBody: string }).rawBody = "not-original-bytes"; }); registerBillingRoutes(stringApp, { store, billing, notificationParser: async () => { parserCalls += 1; throw new Error("must not run"); } }); const stringResponse = await stringApp.inject({ method: "POST", url: "/api/wechat/notify", payload: {} }); expect(stringResponse.statusCode).toBe(400); expect(stringResponse.json()).toEqual({ code: "FAIL", message: "INVALID_WECHAT_NOTIFICATION" }); expect(parserCalls).toBe(0);
  });

  test("invalid raw UTF-8 or JSON returns fixed 400 without settling an order", async () => {
    const config: WechatConfig = { appId: "wx-app", mchId: "merchant", serialNo: "serial", privateKey: "", notifyUrl: "https://studymind.example/api/wechat/notify", apiV3Key: "", platformPublicKey: "", platformSerialNo: "", allowInsecureNotify: true, environment: "test", requestTimeoutMs: 10_000 };
    for (const rawBody of [Buffer.from([0xff, 0xfe]), Buffer.from("{broken")]) { const store = new MemoryStore(); const billing = new BillingService({ store, createNativePayment: async () => { throw new Error("unused"); } }); let settlementCalls = 0; billing.applyPaidOrder = async () => { settlementCalls += 1; return { entitlementExpiresAt: now }; }; const app = Fastify(); app.addHook("onRequest", async (request) => { (request as typeof request & { rawBody: Buffer }).rawBody = rawBody; }); registerBillingRoutes(app, { store, billing, notificationParser: createWechatNotificationParser(config), now: () => now }); const response = await app.inject({ method: "POST", url: "/api/wechat/notify", payload: { valid: "parsed-body-must-be-ignored" } }); expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ code: "FAIL", message: "INVALID_WECHAT_NOTIFICATION" }); expect(settlementCalls).toBe(0); }
  });

  test("maps billing Store and unknown webhook failures to fixed private 503 responses", async () => {
    const detail = "private database detail"; const store = new MemoryStore(); await userFixture(store, "owner@example.com", "smds_owner-token"); const billing = new BillingService({ store, now: () => now, randomId: () => "private1", createNativePayment: async () => ({ codeUrl: "weixin://pay", providerPayload: {} }) });
    const statusApp = Fastify(); registerBillingRoutes(statusApp, { store, billing, notificationParser: async () => { throw new Error("unused"); }, now: () => now }); billing.getOrderStatus = async () => { throw new Error(detail); };
    await expectPrivate503(await statusApp.inject({ method: "GET", url: "/api/desktop/billing/orders/sm_private1", headers: { authorization: "Bearer smds_owner-token" } }), detail);
    const webhookApp = Fastify(); webhookApp.addHook("onRequest", async (request) => { (request as typeof request & { rawBody: Buffer }).rawBody = Buffer.from("raw"); }); registerBillingRoutes(webhookApp, { store, billing, notificationParser: async () => { throw new Error(detail); }, now: () => now });
    await expectPrivate503(await webhookApp.inject({ method: "POST", url: "/api/wechat/notify", payload: {} }), detail);
  });

  test("uses a typed, secret-free error when the service session check expires", async () => {
    const store = new MemoryStore(); const billing = new BillingService({ store, createNativePayment: async () => { throw new Error("unused"); } });
    try { await billing.createWechatNativeOrder({ sessionTokenHash: "private-session-token-hash" }); throw new Error("expected auth failure"); }
    catch (error) { expect(error).toBeInstanceOf(BillingAuthRequiredError); expect(error).toMatchObject({ name: "BillingAuthRequiredError", message: "Billing authentication is required." }); expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false); expect(JSON.stringify(error)).not.toContain("private-session-token-hash"); }
  });

  test("returns 401 when route authentication succeeds but the service recheck expires", async () => {
    const store = new MemoryStore(); const user = await userFixture(store, "race@example.com", "smds_race-token"); const original = store.findSessionByTokenHash.bind(store); let checks = 0;
    store.findSessionByTokenHash = async (tokenHash, at) => { checks += 1; return checks === 1 ? original(tokenHash, at) : null; };
    const billing = new BillingService({ store, now: () => now, randomId: () => "unused12", createNativePayment: async () => { throw new Error("must not reach provider"); } }); const app = Fastify(); registerBillingRoutes(app, { store, billing, notificationParser: async () => { throw new Error("unused"); }, now: () => now });
    const response = await app.inject({ method: "POST", url: "/api/desktop/billing/wechat-native", headers: { authorization: "Bearer smds_race-token" } });
    expect(user.email).toBe("race@example.com"); expect(checks).toBe(2); expect(response.statusCode).toBe(401); expect(response.json()).toEqual({ error: "AUTH_REQUIRED" });
  });
});

async function expectPrivate503(response: { statusCode: number; json(): unknown; body: string }, detail: string) { expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); expect(response.body).not.toContain(detail); }
