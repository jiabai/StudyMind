import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { ActivationCodeService } from "../src/activation.js";
import { EntitlementAdjustmentService } from "../src/entitlementAdjustment.js";
import { LlmConfigService } from "../src/llmConfig.js";
import { registerDesktopAccountRoutes } from "../src/routes/desktopAccount.js";
import { StoreOperationError } from "../src/prismaStore/concurrency.js";
import { sha256 } from "../src/security.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-08-08T08:00:00.000Z");
const LLM_KEY = "0123456789abcdef0123456789abcdef";

async function authorized(store: MemoryStore, email = "student@example.com") {
  const user = await store.upsertUserByEmail(email, NOW);
  const token = "smds_desktop-session-token";
  await store.createSession({ userId: user.id, tokenHash: sha256(token), createdAt: NOW, expiresAt: new Date("2026-12-01T00:00:00.000Z") });
  return { user, token };
}

describe("StudyMind activation codes", () => {
  test("generates a secure single-use StudyMind code without storing plaintext", async () => {
    const store = new MemoryStore();
    const service = new ActivationCodeService({ store, now: () => NOW });
    const generated = await service.generateCode();

    expect(generated.code).toMatch(/^SM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(generated.entitlementDays).toBe(31);
    expect(generated.llmCredits).toBe(20);
    expect(generated.redeemBy.toISOString()).toBe("2026-09-07T08:00:00.000Z");
    expect(store.activationCodes[0]).toMatchObject({
      codeHash: sha256(generated.code), codePrefix: generated.code.slice(0, 7), entitlementDays: 31,
      status: "active", redeemedAt: null, redeemedByUserId: null,
    });
    expect(JSON.stringify(store.activationCodes)).not.toContain(generated.code);
  });

  test("normalizes a valid code and permits only one concurrent redemption", async () => {
    const store = new MemoryStore();
    const { user, token } = await authorized(store);
    const service = new ActivationCodeService({ store, now: () => NOW });
    const generated = await service.generateCode();
    const code = `  ${generated.code.toLowerCase()}  `;

    const results = await Promise.allSettled([
      service.redeemCode({ sessionTokenHash: sha256(token), code }),
      service.redeemCode({ sessionTokenHash: sha256(token), code }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({ reason: { message: "Activation code is invalid or expired." } });
    await expect(store.getEntitlement(user.id)).resolves.toMatchObject({
      status: "active", expiresAt: new Date("2026-09-08T08:00:00.000Z"), llmQuotaLimit: 20, llmQuotaUsed: 0,
    });
  });

  test("rejects malformed, unknown, expired, redeemed, and invalid-session redemption identically", async () => {
    const store = new MemoryStore();
    const { token } = await authorized(store);
    const service = new ActivationCodeService({ store, now: () => NOW });
    const expired = await service.generateCode({ redeemBy: new Date("2026-08-08T07:59:59.000Z") });
    const valid = await service.generateCode();
    await service.redeemCode({ sessionTokenHash: sha256(token), code: valid.code });

    for (const input of ["bad", "SM-WRNG-WRNG-WRNG-WRNG", expired.code, valid.code]) {
      await expect(service.redeemCode({ sessionTokenHash: sha256(token), code: input }))
        .rejects.toThrow("Activation code is invalid or expired.");
    }
    await expect(service.redeemCode({ sessionTokenHash: "missing", code: (await service.generateCode()).code }))
      .rejects.toThrow("Desktop session is invalid or expired.");
  });

  test("does not redeem an activation code when the resulting quota exceeds Int32", async () => {
    const store = new MemoryStore();
    const { user, token } = await authorized(store);
    await store.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 2_147_483_647, llmQuotaUsed: 0 });
    const service = new ActivationCodeService({ store, now: () => NOW });
    const generated = await service.generateCode();

    await expect(service.redeemCode({ sessionTokenHash: sha256(token), code: generated.code }))
      .rejects.toThrow("ENTITLEMENT_RESULT_OUT_OF_RANGE");
    expect(store.activationCodes[0]).toMatchObject({ status: "active", redeemedAt: null, redeemedByUserId: null });
    await expect(store.getEntitlement(user.id)).resolves.toMatchObject({ expiresAt: new Date("2026-09-01T08:00:00.000Z"), llmQuotaLimit: 2_147_483_647, llmQuotaUsed: 0 });
  });
});

describe("entitlement adjustment service", () => {
  test("validates integer deltas and records before/after audit through the atomic store operation", async () => {
    const store = new MemoryStore();
    const { user } = await authorized(store);
    await store.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 20, llmQuotaUsed: 4 });
    const service = new EntitlementAdjustmentService({ store, now: () => NOW });

    const result = await service.apply({ adminEmail: "admin@studymind.local", userId: user.id, extendDays: 7, quotaAdd: 5, reason: "support", note: "classroom recovery" });
    if (result.status !== "applied") throw new Error("expected applied adjustment");
    expect(result.entitlement).toMatchObject({ expiresAt: new Date("2026-09-08T08:00:00.000Z"), llmQuotaLimit: 25, llmQuotaUsed: 4 });
    expect(result.adjustment).toMatchObject({
      adminEmail: "admin@studymind.local", beforeExpiresAt: new Date("2026-09-01T08:00:00.000Z"),
      afterExpiresAt: new Date("2026-09-08T08:00:00.000Z"), beforeLlmQuotaLimit: 20, afterLlmQuotaLimit: 25,
      beforeLlmQuotaUsed: 4, afterLlmQuotaUsed: 4,
    });
    await expect(service.apply({ adminEmail: "a@b.c", userId: user.id, extendDays: 1.5, reason: "bad" })).rejects.toThrow("INVALID_ENTITLEMENT_ADJUSTMENT");
    await expect(service.apply({ adminEmail: "a@b.c", userId: user.id, quotaAdd: -21, reason: "bad" })).rejects.toThrow("INVALID_ENTITLEMENT_ADJUSTMENT");
    await expect(service.apply({ adminEmail: "a@b.c", userId: user.id, extendDays: 36_501, reason: "bad" })).rejects.toThrow("INVALID_ENTITLEMENT_ADJUSTMENT");
    await expect(service.apply({ adminEmail: "a@b.c", userId: user.id, quotaAdd: 1_000_001, reason: "bad" })).rejects.toThrow("INVALID_ENTITLEMENT_ADJUSTMENT");
    await expect(service.apply({ adminEmail: "a@b.c", userId: user.id, expiresAt: new Date(Number.NaN), reason: "bad" })).rejects.toThrow("INVALID_ENTITLEMENT_ADJUSTMENT");
  });

  test("rejects an adjustment whose resulting credit limit exceeds Int32 without an audit write", async () => {
    const store = new MemoryStore();
    const { user } = await authorized(store);
    await store.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 2_147_483_647, llmQuotaUsed: 0 });
    await expect(store.applyEntitlementAdjustmentWithAudit({ adminEmail: "admin@studymind.local", userId: user.id, reason: "overflow", note: null, quotaAdd: 1, now: NOW }))
      .rejects.toThrow("ENTITLEMENT_ADJUSTMENT_OUT_OF_RANGE");
    expect(store.adminEntitlementAdjustments).toHaveLength(0);
    await expect(store.getEntitlement(user.id)).resolves.toMatchObject({ llmQuotaLimit: 2_147_483_647 });
  });
});

describe("desktop account and redemption routes", () => {
  test("returns the exact Rust account contract and never returns LLM secrets", async () => {
    const store = new MemoryStore();
    const { user, token } = await authorized(store);
    await store.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 20, llmQuotaUsed: 3 });
    const llmConfig = new LlmConfigService({ store, encryptionKey: LLM_KEY, now: () => NOW });
    await llmConfig.save({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-study", apiKey: "plaintext-secret", timeoutSeconds: 60 });
    const app = Fastify();
    registerDesktopAccountRoutes(app, { store, activationCodes: new ActivationCodeService({ store, now: () => NOW }), llmConfig, now: () => NOW });

    const response = await app.inject({ method: "GET", url: "/api/desktop/account", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authenticated: true, email: "student@example.com", entitlement_status: "active",
      entitlement_expires_at: "2026-09-01T08:00:00.000Z", llm_quota_limit: 20, llm_quota_used: 3,
      llm_quota_remaining: 17, llm_quota_resets_at: "2026-09-01T08:00:00.000Z", llm_configured: true,
      last_verified_at: NOW.toISOString(), can_process: true, can_generate_ai: true,
    });
    expect(response.body).not.toContain("plaintext-secret");
    expect(response.body).not.toContain("cret");
    expect((await app.inject({ method: "GET", url: "/api/desktop/account" })).json()).toEqual({ error: "AUTH_REQUIRED" });
  });

  test("redeems through bearer auth and returns the Rust account response", async () => {
    const store = new MemoryStore();
    const { token } = await authorized(store);
    const activation = new ActivationCodeService({ store, now: () => NOW });
    const generated = await activation.generateCode();
    const app = Fastify();
    registerDesktopAccountRoutes(app, { store, activationCodes: activation, llmConfig: new LlmConfigService({ store, encryptionKey: LLM_KEY }), now: () => NOW });

    const response = await app.inject({ method: "POST", url: "/api/desktop/activation-codes/redeem", headers: { authorization: `Bearer ${token}` }, payload: { code: generated.code.toLowerCase() } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: true, entitlement_status: "active", llm_quota_limit: 20, llm_quota_remaining: 20, can_process: true });
    expect(Object.keys(response.json()).sort()).toEqual([
      "authenticated", "can_generate_ai", "can_process", "email", "entitlement_expires_at", "entitlement_status",
      "last_verified_at", "llm_configured", "llm_quota_limit", "llm_quota_remaining", "llm_quota_resets_at", "llm_quota_used",
    ].sort());
  });

  test("does not mark a corrupted LLM configuration active", async () => {
    const store = new MemoryStore();
    const { user, token } = await authorized(store);
    await store.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 20, llmQuotaUsed: 0 });
    await store.upsertLlmConfig({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-study", encryptedApiKey: "v1:corrupted:config:value", apiKeyLast4: "alue", timeoutSeconds: 60 }, NOW);
    const app = Fastify();
    registerDesktopAccountRoutes(app, { store, activationCodes: new ActivationCodeService({ store }), llmConfig: new LlmConfigService({ store, encryptionKey: LLM_KEY }), now: () => NOW });

    const response = await app.inject({ method: "GET", url: "/api/desktop/account", headers: { authorization: `Bearer ${token}` } });
    expect(response.json()).toMatchObject({ llm_configured: false, can_process: true, can_generate_ai: false });
  });

  test("returns server unavailable when account LLM config storage fails", async () => {
    class ConfigFailureStore extends MemoryStore {
      override async getLlmConfig(): ReturnType<MemoryStore["getLlmConfig"]> { throw new StoreOperationError(); }
    }
    const store = new ConfigFailureStore();
    const { token } = await authorized(store);
    const app = Fastify();
    registerDesktopAccountRoutes(app, { store, activationCodes: new ActivationCodeService({ store }), llmConfig: new LlmConfigService({ store, encryptionKey: LLM_KEY }), now: () => NOW });
    const response = await app.inject({ method: "GET", url: "/api/desktop/account", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
  });
});
