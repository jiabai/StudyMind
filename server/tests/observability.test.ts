import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequestId, createRuntimeLogger, sanitizeLogValue, STUDYMIND_CODES, STUDYMIND_EVENTS } from "../src/observability.js";

describe("observability", () => {
  test("accepts safe request IDs and replaces hostile values", () => {
    expect(createRequestId({ "x-request-id": "req_A-123" })).toBe("req_A-123");
    expect(createRequestId({ "x-request-id": "bad id\nforged" })).toMatch(/^smreq_/);
  });

  test("redacts credentials, bodies, prompts, payment data, ciphertext, and raw errors recursively", () => {
    const secret = "FULL_SECRET_FIXTURE_123456";
    const safe = sanitizeLogValue({ authorization: `Bearer ${secret}`, cookie: secret, setCookie: secret, otp: secret, email: secret, apiKey: secret, encryptedApiKey: secret, csrfToken: secret, sessionToken: secret, activationCode: secret, requestBody: secret, responseBody: secret, prompt: secret, output: secret, providerPayload: secret, error: new Error(secret), nested: { api_v3_key: secret } });
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).toContain("[REDACTED]");
  });

  test("uses fixed StudyMind event names", () => {
    expect(STUDYMIND_EVENTS).toEqual({ startup: "studymind.server.startup", ready: "studymind.server.ready", draining: "studymind.server.draining", shutdown: "studymind.server.shutdown", startupFailed: "studymind.server.startup_failed", requestFailed: "studymind.request.failed" });
    expect(STUDYMIND_CODES).toEqual({ startup: "SERVER_STARTING", ready: "SERVER_READY", draining: "SERVER_DRAINING", shutdown: "SERVER_STOPPED", startupFailed: "SERVER_STARTUP_FAILED", shutdownTimeout: "SERVER_SHUTDOWN_TIMEOUT" });
  });

  test("runtime logger sanitizes every structured field before emission", () => {
    const records: unknown[] = [];
    const logger = createRuntimeLogger({ info: (record) => records.push(record), error: (record) => records.push(record) });
    const secret = "DATABASE_ERROR_WITH_SECRET_123456";
    logger.error({ event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed, error: new Error(secret), apiKey: secret });
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records).toEqual([{ event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed, error: "[REDACTED]", apiKey: "[REDACTED]" }]);
  });

  test("entrypoint explicitly injects the secret-safe runtime logger", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(source).toContain("createRuntimeLogger");
    expect(source).toContain("runServerLifecycle({ logger:");
  });
});
