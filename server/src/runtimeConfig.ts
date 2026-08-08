import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { optionalText, parseBoolean, parseEnvironment, parseInteger, requireUtf8Secret, type Environment } from "./env.js";
import { resolveSqliteDatabase } from "./database.js";

export type SmtpRuntimeConfig = { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
export type WechatRuntimeConfig = {
  appId: string; mchId: string; serialNo: string; privateKey: string; notifyUrl: string;
  apiV3Key: string; platformCertificate: string; allowInsecureNotify: boolean;
};
export type RuntimeConfig = {
  environment: Environment; host: string; port: number; databaseUrl: string; databasePath: string;
  adminEmail: string; otpHmacKey: string; llmEncryptionKey: string; allowConsoleOtp: boolean;
  smtp: SmtpRuntimeConfig | null; wechat: WechatRuntimeConfig | null; secureCookies: boolean;
};

const moduleRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEV_OTP_KEY = "studymind-development-otp-hmac-key-only";
const DEV_LLM_KEY = "studymind-development-llm-encryption-key";

export function parseRuntimeConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>, options: { serverRoot?: string } = {}): RuntimeConfig {
  const environment = parseEnvironment(env.NODE_ENV);
  const production = environment === "production";
  const serverRoot = resolve(options.serverRoot ?? moduleRoot);
  const host = optionalText(env.STUDYMIND_SERVER_HOST) ?? "127.0.0.1";
  if (!validHost(host)) throw new Error("STUDYMIND_SERVER_HOST is invalid.");
  const port = parseInteger("STUDYMIND_SERVER_PORT", env.STUDYMIND_SERVER_PORT, 8787, { min: 1, max: 65_535 });
  const databaseSource = optionalText(env.DATABASE_URL) ?? (production ? "" : `file:${resolve(serverRoot, "data", "studymind.sqlite").replace(/\\/g, "/")}`);
  if (!databaseSource) throw new Error("Production configuration is incomplete: DATABASE_URL is required.");
  let database;
  try { database = resolveSqliteDatabase(databaseSource, serverRoot); }
  catch { throw new Error("DATABASE_URL must identify an explicit local SQLite file."); }
  const adminEmail = optionalText(env.STUDYMIND_ADMIN_EMAIL) ?? "";
  const otpHmacKey = requireUtf8Secret("STUDYMIND_AUTH_OTP_HMAC_KEY", env.STUDYMIND_AUTH_OTP_HMAC_KEY, production, DEV_OTP_KEY);
  const llmEncryptionKey = requireUtf8Secret("STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY", env.STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY, production, DEV_LLM_KEY);
  if (otpHmacKey === llmEncryptionKey) throw new Error("STUDYMIND_AUTH_OTP_HMAC_KEY and STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY must be different.");
  const allowConsoleOtp = parseBoolean("STUDYMIND_ALLOW_CONSOLE_OTP", env.STUDYMIND_ALLOW_CONSOLE_OTP);
  const smtp = parseSmtp(env);
  const wechatEnabled = parseBoolean("STUDYMIND_WECHAT_PAY_ENABLED", env.STUDYMIND_WECHAT_PAY_ENABLED);
  const allowInsecureNotify = parseBoolean("STUDYMIND_WECHAT_DEV_INSECURE_NOTIFY", env.STUDYMIND_WECHAT_DEV_INSECURE_NOTIFY);
  if (production) {
    const missing = [!adminEmail && "STUDYMIND_ADMIN_EMAIL", !smtp && "complete STUDYMIND_SMTP_*", allowConsoleOtp && "STUDYMIND_ALLOW_CONSOLE_OTP=false", allowInsecureNotify && "STUDYMIND_WECHAT_DEV_INSECURE_NOTIFY=false"].filter(Boolean);
    if (missing.length) throw new Error(`Production configuration is incomplete: ${missing.join(", ")}.`);
  }
  const wechat = wechatEnabled ? parseWechat(env, allowInsecureNotify) : null;
  return { environment, host, port, databaseUrl: database.url, databasePath: database.path, adminEmail, otpHmacKey, llmEncryptionKey, allowConsoleOtp, smtp, wechat, secureCookies: production };
}

function parseSmtp(env: NodeJS.ProcessEnv | Record<string, string | undefined>): SmtpRuntimeConfig | null {
  const values = [env.STUDYMIND_SMTP_HOST, env.STUDYMIND_SMTP_PORT, env.STUDYMIND_SMTP_USER, env.STUDYMIND_SMTP_PASS, env.STUDYMIND_SMTP_FROM];
  if (values.every((value) => !optionalText(value))) return null;
  if (values.some((value) => !optionalText(value))) throw new Error("STUDYMIND_SMTP_* configuration must be complete.");
  const port = parseInteger("STUDYMIND_SMTP_PORT", env.STUDYMIND_SMTP_PORT, 0, { min: 1, max: 65_535 });
  return { host: env.STUDYMIND_SMTP_HOST!.trim(), port, secure: port === 465, user: env.STUDYMIND_SMTP_USER!.trim(), pass: env.STUDYMIND_SMTP_PASS!, from: env.STUDYMIND_SMTP_FROM!.trim() };
}

function parseWechat(env: NodeJS.ProcessEnv | Record<string, string | undefined>, allowInsecureNotify: boolean): WechatRuntimeConfig {
  const names = ["STUDYMIND_WECHAT_APP_ID", "STUDYMIND_WECHAT_MCH_ID", "STUDYMIND_WECHAT_MCH_SERIAL_NO", "STUDYMIND_WECHAT_MCH_PRIVATE_KEY", "STUDYMIND_WECHAT_NOTIFY_URL", "STUDYMIND_WECHAT_API_V3_KEY", "STUDYMIND_WECHAT_PLATFORM_CERT_PEM"] as const;
  const missing = names.filter((name) => !optionalText(env[name]));
  if (missing.length) throw new Error("STUDYMIND_WECHAT_* configuration must be complete.");
  return { appId: env.STUDYMIND_WECHAT_APP_ID!.trim(), mchId: env.STUDYMIND_WECHAT_MCH_ID!.trim(), serialNo: env.STUDYMIND_WECHAT_MCH_SERIAL_NO!.trim(), privateKey: env.STUDYMIND_WECHAT_MCH_PRIVATE_KEY!, notifyUrl: env.STUDYMIND_WECHAT_NOTIFY_URL!.trim(), apiV3Key: env.STUDYMIND_WECHAT_API_V3_KEY!, platformCertificate: env.STUDYMIND_WECHAT_PLATFORM_CERT_PEM!, allowInsecureNotify };
}

function validHost(host: string): boolean { return host === "localhost" || /^[A-Za-z0-9.-]+$/.test(host) || host.includes(":" ); }
