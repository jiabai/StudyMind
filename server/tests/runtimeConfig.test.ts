import { describe, expect, test } from "vitest";
import { parseRuntimeConfig } from "../src/runtimeConfig.js";

const KEY_A = "otp-hmac-key-with-at-least-32-bytes-a";
const KEY_B = "llm-encryption-key-with-at-least-32-b";

describe("runtime configuration", () => {
  test("uses loopback development defaults but never enables console OTP implicitly", () => {
    const config = parseRuntimeConfig({ NODE_ENV: "development" }, { serverRoot: "C:/srv/server" });
    expect(config).toMatchObject({ environment: "development", host: "127.0.0.1", port: 8787, allowConsoleOtp: false });
    expect(config.databaseUrl).toBe("file:C:/srv/server/data/studymind.sqlite");
  });

  test("parses explicit booleans and strict integer ports", () => {
    expect(parseRuntimeConfig({ NODE_ENV: "test", STUDYMIND_ALLOW_CONSOLE_OTP: "true", STUDYMIND_SERVER_PORT: "9001" }).allowConsoleOtp).toBe(true);
    expect(() => parseRuntimeConfig({ NODE_ENV: "test", STUDYMIND_SERVER_PORT: "9001x" })).toThrow("STUDYMIND_SERVER_PORT");
    expect(() => parseRuntimeConfig({ NODE_ENV: "test", STUDYMIND_ALLOW_CONSOLE_OTP: "yes" })).toThrow("STUDYMIND_ALLOW_CONSOLE_OTP");
  });

  test("production fails closed without every core secret, explicit local database, admin, and SMTP", () => {
    expect(() => parseRuntimeConfig({ NODE_ENV: "production" })).toThrow(/Production configuration is incomplete/);
    expect(() => parseRuntimeConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://db" })).toThrow(/DATABASE_URL/);
  });

  test("requires independent OTP and LLM keys", () => {
    expect(() => parseRuntimeConfig({ NODE_ENV: "test", STUDYMIND_AUTH_OTP_HMAC_KEY: KEY_A, STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY: KEY_A })).toThrow(/must be different/);
  });

  test("accepts a complete production configuration and forbids insecure delivery", () => {
    const config = parseRuntimeConfig({
      NODE_ENV: "production", DATABASE_URL: "file:C:/srv/data/prod.sqlite", STUDYMIND_ADMIN_EMAIL: "admin@example.com",
      STUDYMIND_AUTH_OTP_HMAC_KEY: KEY_A, STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY: KEY_B,
      STUDYMIND_SMTP_HOST: "smtp.example.com", STUDYMIND_SMTP_PORT: "465", STUDYMIND_SMTP_USER: "user",
      STUDYMIND_SMTP_PASS: "pass", STUDYMIND_SMTP_FROM: "StudyMind <noreply@example.com>",
      STUDYMIND_ALLOW_CONSOLE_OTP: "false", STUDYMIND_WECHAT_PAY_ENABLED: "false",
    });
    expect(config.smtp).toMatchObject({ port: 465, secure: true });
    expect(config.secureCookies).toBe(true);
    for (const [name, value] of [["STUDYMIND_ALLOW_CONSOLE_OTP", "true"], ["STUDYMIND_WECHAT_DEV_INSECURE_NOTIFY", "true"]] as const) {
      expect(() => parseRuntimeConfig({ ...configSource(), [name]: value })).toThrow(name);
    }
  });
});

function configSource(): Record<string, string> {
  return { NODE_ENV: "production", DATABASE_URL: "file:C:/srv/data/prod.sqlite", STUDYMIND_ADMIN_EMAIL: "admin@example.com", STUDYMIND_AUTH_OTP_HMAC_KEY: KEY_A, STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY: KEY_B, STUDYMIND_SMTP_HOST: "smtp.example.com", STUDYMIND_SMTP_PORT: "465", STUDYMIND_SMTP_USER: "user", STUDYMIND_SMTP_PASS: "pass", STUDYMIND_SMTP_FROM: "noreply@example.com", STUDYMIND_ALLOW_CONSOLE_OTP: "false", STUDYMIND_WECHAT_PAY_ENABLED: "false" };
}
