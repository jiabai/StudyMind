import { describe, expect, test } from "vitest";
import { createRequestId, sanitizeLogValue, STUDYMIND_EVENTS } from "../src/observability.js";

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
    expect(STUDYMIND_EVENTS).toEqual(expect.objectContaining({ startup: "studymind.server.startup", shutdown: "studymind.server.shutdown", requestFailed: "studymind.request.failed" }));
  });
});
