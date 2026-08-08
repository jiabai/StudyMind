import { randomBytes } from "node:crypto";

export const STUDYMIND_EVENTS = Object.freeze({ startup: "studymind.server.startup", shutdown: "studymind.server.shutdown", requestFailed: "studymind.request.failed" });
const SENSITIVE = /authorization|cookie|set.?cookie|otp|email|api.*key|cipher|csrf|session|activation|request.?body|response.?body|prompt|output|payment|provider.?payload|raw.?body|error/i;

export function createRequestId(headers: Record<string, string | string[] | undefined>): string {
  const candidate = Array.isArray(headers["x-request-id"]) ? headers["x-request-id"][0] : headers["x-request-id"];
  return typeof candidate === "string" && /^[A-Za-z0-9._~-]{8,128}$/.test(candidate) ? candidate : `smreq_${randomBytes(16).toString("base64url")}`;
}

export function sanitizeLogValue(value: unknown, key = ""): unknown {
  if (SENSITIVE.test(key)) return "[REDACTED]";
  if (value instanceof Error) return { name: value.name, message: "[REDACTED]" };
  if (Array.isArray(value)) return value.map((entry) => sanitizeLogValue(entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, sanitizeLogValue(entry, entryKey)]));
  return value;
}

export function loggerOptions(environment: string) {
  return { level: environment === "production" ? "info" : "warn", serializers: {
    req: (request: { id?: string; method?: string; url?: string; ip?: string }) => ({ id: request.id, method: request.method, url: request.url?.split("?")[0], ip: request.ip }),
    res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
    err: (error: Error) => sanitizeLogValue(error),
  } };
}
