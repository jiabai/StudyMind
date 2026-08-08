import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { LlmConfigInvalidError, LlmConfigMissingError, LlmConfigService } from "../src/llmConfig.js";
import { StoreOperationError } from "../src/prismaStore/concurrency.js";
import { registerDesktopLlmRoutes } from "../src/routes/desktopLlm.js";
import { sha256 } from "../src/security.js";
import { MemoryStore } from "../src/store.js";

const NOW = new Date("2026-08-08T08:00:00.000Z");
const KEY = "0123456789abcdef0123456789abcdef";

async function fixture(store = new MemoryStore()) {
  const user = await store.upsertUserByEmail("student@example.com", NOW);
  const token = "smds_desktop-session-token";
  await store.createSession({ userId: user.id, tokenHash: sha256(token), createdAt: NOW, expiresAt: new Date("2026-12-01T00:00:00.000Z") });
  await store.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 2, llmQuotaUsed: 0 });
  const llmConfig = new LlmConfigService({ store, encryptionKey: KEY, now: () => NOW });
  await llmConfig.save({ provider: "openai_compatible", baseUrl: "https://llm.example/v1", model: "study-model", apiKey: "secret-api-key", timeoutSeconds: 45 });
  const app = Fastify();
  registerDesktopLlmRoutes(app, { store, llmConfig, now: () => NOW });
  return { app, store, user, token, llmConfig };
}

describe("managed LLM configuration encryption", () => {
  test("requires an independent 32-byte encryption secret", () => {
    expect(() => new LlmConfigService({ store: new MemoryStore(), encryptionKey: "", now: () => NOW })).toThrow("STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY is required.");
    expect(() => new LlmConfigService({ store: new MemoryStore(), encryptionKey: "short", now: () => NOW })).toThrow("STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY is required.");
  });

  test("distinguishes missing and invalid config without swallowing store failures", async () => {
    const missing = new LlmConfigService({ store: new MemoryStore(), encryptionKey: KEY });
    await expect(missing.getDecrypted()).rejects.toBeInstanceOf(LlmConfigMissingError);
    await expect(missing.getPublic()).resolves.toEqual({ configured: false, apiKeyLast4: "" });

    class OperationalFailureStore extends MemoryStore {
      override async getLlmConfig(): ReturnType<MemoryStore["getLlmConfig"]> { throw new StoreOperationError(); }
    }
    const operational = new LlmConfigService({ store: new OperationalFailureStore(), encryptionKey: KEY });
    await expect(operational.getDecrypted()).rejects.toBeInstanceOf(StoreOperationError);
    await expect(operational.getPublic()).rejects.toBeInstanceOf(StoreOperationError);
    await expect(operational.isConfigured()).rejects.toBeInstanceOf(StoreOperationError);
  });

  test("encrypts with random nonces, exposes only last4, and fails closed on wrong key or tampering", async () => {
    const store = new MemoryStore();
    const service = new LlmConfigService({ store, encryptionKey: KEY, now: () => NOW });
    const publicConfig = await service.save({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-study", apiKey: "top-secret-value", timeoutSeconds: 60 });
    const firstCiphertext = store.llmConfig?.encryptedApiKey;
    await service.save({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-study", apiKey: "top-secret-value", timeoutSeconds: 60 });
    const secondCiphertext = store.llmConfig?.encryptedApiKey;
    expect(publicConfig).toEqual({ configured: true, apiKeyLast4: "alue" });
    expect(Object.keys(publicConfig).sort()).toEqual(["apiKeyLast4", "configured"]);
    expect(firstCiphertext).toMatch(/^v1:/);
    expect(secondCiphertext).not.toBe(firstCiphertext);
    expect(JSON.stringify(store)).not.toContain("top-secret-value");
    await expect(new LlmConfigService({ store, encryptionKey: "different-key-material-32-bytes!!" }).getDecrypted()).rejects.toBeInstanceOf(LlmConfigInvalidError);
    const stored = await store.getLlmConfig();
    if (stored) {
      const parts = stored.encryptedApiKey.split(":");
      const ciphertext = parts[3]!;
      parts[3] = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
      await store.upsertLlmConfig({
        provider: stored.provider, baseUrl: stored.baseUrl, model: stored.model,
        encryptedApiKey: parts.join(":"), apiKeyLast4: stored.apiKeyLast4,
        timeoutSeconds: stored.timeoutSeconds,
      }, NOW);
    }
    await expect(service.getDecrypted()).rejects.toBeInstanceOf(LlmConfigInvalidError);
    const tamperedPublic = await service.getPublic();
    expect(tamperedPublic).toEqual({ configured: false, apiKeyLast4: "alue" });
    expect(Object.keys(tamperedPublic ?? {}).sort()).toEqual(["apiKeyLast4", "configured"]);
  });

  test("validates provider, URL credentials, model, API key, timeout, and lengths", async () => {
    const service = new LlmConfigService({ store: new MemoryStore(), encryptionKey: KEY });
    const base = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1", model: "model", apiKey: "key", timeoutSeconds: 60 };
    for (const invalid of [
      { ...base, provider: "anthropic" }, { ...base, baseUrl: "ftp://example.com" }, { ...base, baseUrl: "https://user:pass@example.com" },
      { ...base, baseUrl: "https://example.com/v1?tenant=secret" }, { ...base, baseUrl: "https://example.com/v1#fragment" },
      { ...base, model: "" }, { ...base, apiKey: "1234567" }, { ...base, apiKey: "x".repeat(4097) },
      { ...base, timeoutSeconds: 0 }, { ...base, timeoutSeconds: 601 }, { ...base, timeoutSeconds: 1.5 },
    ]) await expect(service.save(invalid as never)).rejects.toThrow("INVALID_LLM_CONFIG");
    await expect(service.save({ ...base, baseUrl: "https://example.com/v1///", apiKey: "12345678" }))
      .resolves.toEqual({ configured: true, apiKeyLast4: "5678" });
    await expect(service.getDecrypted()).resolves.toMatchObject({ baseUrl: "https://example.com/v1", apiKey: "12345678" });
  });
});

describe("desktop managed LLM checkout", () => {
  test("consumes once per request id, reuses idempotently, and returns only the precise checkout fields", async () => {
    const { app, store, user, token } = await fixture();
    const request = { method: "POST" as const, url: "/api/desktop/llm/checkouts", headers: { authorization: `Bearer ${token}` }, payload: { request_id: "lesson-summary-0001" } };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ provider: "openai_compatible", base_url: "https://llm.example/v1", model: "study-model", api_key: "secret-api-key", timeout_seconds: 45, quota_remaining: 1 });
    expect((await app.inject(request)).json()).toMatchObject({ quota_remaining: 1 });
    expect((await app.inject({ ...request, payload: { request_id: "lesson-summary-0002" } })).json()).toMatchObject({ quota_remaining: 0 });
    await expect(store.getEntitlement(user.id)).resolves.toMatchObject({ llmQuotaUsed: 2 });
  });

  test("allows at most one final-credit checkout under concurrency", async () => {
    const { app, store, user, token } = await fixture();
    await store.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 1, llmQuotaUsed: 0 });
    const responses = await Promise.all(["parallel-request-a", "parallel-request-b"].map((request_id) => app.inject({ method: "POST", url: "/api/desktop/llm/checkouts", headers: { authorization: `Bearer ${token}` }, payload: { request_id } })));
    expect(responses.filter(({ statusCode }) => statusCode === 200)).toHaveLength(1);
    expect(responses.filter(({ statusCode }) => statusCode === 403)).toHaveLength(1);
    await expect(store.getEntitlement(user.id)).resolves.toMatchObject({ llmQuotaUsed: 1 });
  });

  test("authenticates and maps validation, missing config, quota, and store failures to fixed errors", async () => {
    const missingStore = new MemoryStore();
    const user = await missingStore.upsertUserByEmail("student@example.com", NOW);
    const token = "smds_desktop-session-token";
    await missingStore.createSession({ userId: user.id, tokenHash: sha256(token), createdAt: NOW, expiresAt: new Date("2026-12-01T00:00:00.000Z") });
    await missingStore.upsertEntitlement(user.id, new Date("2026-09-01T08:00:00.000Z"), NOW, { llmQuotaLimit: 1, llmQuotaUsed: 0 });
    const missingApp = Fastify();
    registerDesktopLlmRoutes(missingApp, { store: missingStore, llmConfig: new LlmConfigService({ store: missingStore, encryptionKey: KEY }), now: () => NOW });
    expect((await missingApp.inject({ method: "POST", url: "/api/desktop/llm/checkouts", payload: { request_id: "valid-request-id" } })).json()).toEqual({ error: "AUTH_REQUIRED" });
    expect((await missingApp.inject({ method: "POST", url: "/api/desktop/llm/checkouts", headers: { authorization: `Bearer ${token}` }, payload: { request_id: "bad" } })).statusCode).toBe(400);
    const missing = await missingApp.inject({ method: "POST", url: "/api/desktop/llm/checkouts", headers: { authorization: `Bearer ${token}` }, payload: { request_id: "valid-request-id" } });
    expect(missing.statusCode).toBe(503); expect(missing.json()).toEqual({ error: "LLM_CONFIG_MISSING" });

    class FailingStore extends MemoryStore { override async consumeLlmQuota(): ReturnType<MemoryStore["consumeLlmQuota"]> { throw new Error("SQLITE_BUSY secret detail"); } }
    const failing = await fixture(new FailingStore());
    const failed = await failing.app.inject({ method: "POST", url: "/api/desktop/llm/checkouts", headers: { authorization: `Bearer ${failing.token}` }, payload: { request_id: "valid-request-id" } });
    expect(failed.statusCode).toBe(503); expect(failed.json()).toEqual({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); expect(failed.body).not.toContain("SQLITE");

    class ConfigFailureStore extends MemoryStore {
      override async getLlmConfig(): ReturnType<MemoryStore["getLlmConfig"]> { throw new StoreOperationError(); }
    }
    const configFailure = await fixture(new ConfigFailureStore());
    const operational = await configFailure.app.inject({ method: "POST", url: "/api/desktop/llm/checkouts", headers: { authorization: `Bearer ${configFailure.token}` }, payload: { request_id: "valid-request-id" } });
    expect(operational.statusCode).toBe(503);
    expect(operational.json()).toEqual({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
  });
});
