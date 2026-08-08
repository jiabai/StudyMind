import { randomBytes } from "node:crypto";

export const STUDYMIND_EVENTS = Object.freeze({ startup: "studymind.server.startup", ready: "studymind.server.ready", draining: "studymind.server.draining", shutdown: "studymind.server.shutdown", startupFailed: "studymind.server.startup_failed", requestFailed: "studymind.request.failed" });
export const STUDYMIND_CODES = Object.freeze({ startup: "SERVER_STARTING", ready: "SERVER_READY", draining: "SERVER_DRAINING", shutdown: "SERVER_STOPPED", startupFailed: "SERVER_STARTUP_FAILED", shutdownTimeout: "SERVER_SHUTDOWN_TIMEOUT" });
const SENSITIVE = /authorization|cookie|set.?cookie|otp|email|api.*key|cipher|csrf|session|activation|request.?body|response.?body|prompt|output|payment|provider.?payload|raw.?body|error/i;

export type RuntimeLogRecord = Record<string, unknown>;
export type RuntimeLogger = { info(record: RuntimeLogRecord): void; error(record: RuntimeLogRecord): void };
type RuntimeLogSink = { info(record: unknown): void; error(record: unknown): void };

export function createRuntimeLogger(sink: RuntimeLogSink = {
  info: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  error: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
}): RuntimeLogger {
  const emit = (method: "info" | "error", record: RuntimeLogRecord) => sink[method](sanitizeLogValue(record));
  return { info: (record) => emit("info", record), error: (record) => emit("error", record) };
}

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
