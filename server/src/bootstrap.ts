import { X509Certificate } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { ActivationCodeService } from "./activation.js";
import { AdminAuthService } from "./adminAuth.js";
import { AuthService } from "./auth.js";
import { BillingService } from "./billing.js";
import { connectDatabase as connectConfiguredDatabase } from "./database.js";
import { createOtpSender } from "./email.js";
import { EntitlementAdjustmentService } from "./entitlementAdjustment.js";
import { LlmConfigService } from "./llmConfig.js";
import { createRuntimeLogger, STUDYMIND_CODES, STUDYMIND_EVENTS, type RuntimeLogger } from "./observability.js";
import { PrismaStore } from "./prismaStore.js";
import { createDatabaseReadiness, type Readiness } from "./readiness.js";
import { parseRuntimeConfig, type RuntimeConfig } from "./runtimeConfig.js";
import { createServer } from "./server.js";
import { UserAuthService } from "./userAuth.js";
import { createWechatNativePayment, createWechatNotificationParser, type WechatConfig } from "./wechat.js";

type RuntimeApp = { listen(options: { host: string; port: number }): Promise<unknown>; close(): Promise<unknown> };
type Runtime = { app: RuntimeApp; readiness: Pick<Readiness, "beginDraining"> };
type PrismaResource = Pick<PrismaClient, "$disconnect">;
export type LifecycleResult = { shutdown(signal?: string): Promise<ShutdownResult>; app: Runtime["app"]; prisma: PrismaResource };
export type ShutdownResult = { exitCode: 0 | 1; signal: string };

export async function buildRuntime(config: RuntimeConfig, prisma: PrismaClient, options: { developmentOtpSink?: (email: string, code: string) => void } = {}): Promise<Runtime> {
  const store = new PrismaStore(prisma);
  const sendOtp = createOtpSender({ environment: config.environment, smtp: config.smtp, allowConsoleOtp: config.allowConsoleOtp }, undefined, {
    warn: () => undefined, error: () => undefined, write: options.developmentOtpSink,
  });
  const now = () => new Date();
  const auth = new AuthService({ store, sendOtp, otpHmacKey: config.otpHmacKey, now });
  const userAuth = new UserAuthService({ store, sendOtp, otpHmacKey: config.otpHmacKey, now });
  const adminAuth = new AdminAuthService({ store, sendOtp, otpHmacKey: config.otpHmacKey, adminEmail: config.adminEmail, now });
  const llmConfig = new LlmConfigService({ store, encryptionKey: config.llmEncryptionKey, now });
  const activationCodes = new ActivationCodeService({ store, now });
  const adjustments = new EntitlementAdjustmentService({ store, now });
  const wechat = config.wechat ? createWechatConfig(config) : null;
  const billing = wechat ? new BillingService({ store, now, createNativePayment: createWechatNativePayment({ ...wechat, allowInsecureNotify: false }) }) : null;
  const notificationParser = wechat ? createWechatNotificationParser(wechat, now) : null;
  const readiness = createDatabaseReadiness(prisma);
  await readiness.verifyStartup();
  const app = await createServer({ store, sendOtp, otpHmacKey: config.otpHmacKey, adminEmail: config.adminEmail, auth, userAuth, adminAuth, llmConfig, activationCodes, adjustments, billing, notificationParser, readiness, secureCookies: config.secureCookies, now, environment: config.environment });
  return { app, readiness };
}

export async function runServerLifecycle(options: {
  loadConfig?: () => RuntimeConfig; connectDatabase?: (config: RuntimeConfig) => Promise<PrismaClient>;
  buildRuntime?: (config: RuntimeConfig, prisma: PrismaClient) => Promise<Runtime>; installSignalHandlers?: boolean; shutdownTimeoutMs?: number;
  logger?: RuntimeLogger; forceExit?: (code: number) => void;
  registerSignalHandlers?: (handler: (signal: "SIGINT" | "SIGTERM") => Promise<void>) => void;
} = {}): Promise<LifecycleResult> {
  const loadConfig = options.loadConfig ?? (() => parseRuntimeConfig(process.env));
  const connect = options.connectDatabase ?? ((config) => connectConfiguredDatabase(config));
  const assemble = options.buildRuntime ?? buildRuntime;
  const logger = options.logger ?? createRuntimeLogger();
  const forceExit = options.forceExit ?? ((code) => process.exit(code));
  let prisma: PrismaClient | undefined;
  let runtime: Runtime | undefined;
  logger.info({ event: STUDYMIND_EVENTS.startup, code: STUDYMIND_CODES.startup });
  try {
    const config = loadConfig();
    prisma = await connect(config);
    runtime = await assemble(config, prisma);
    await runtime.app.listen({ host: config.host, port: config.port });
    logger.info({ event: STUDYMIND_EVENTS.ready, code: STUDYMIND_CODES.ready });
  } catch (error) {
    if (runtime) { runtime.readiness.beginDraining(); await runtime.app.close().catch(() => undefined); }
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    logger.error({ event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed });
    throw error;
  }
  const shutdown = shutdownRuntime({ app: runtime.app, prisma, readiness: runtime.readiness, timeoutMs: options.shutdownTimeoutMs ?? 15_000, forceExit, logger });
  if (options.installSignalHandlers !== false) {
    const handle = async (signal: "SIGINT" | "SIGTERM") => { const result = await shutdown(signal); process.exitCode = result.exitCode; };
    const register = options.registerSignalHandlers ?? ((handler: typeof handle) => { process.once("SIGINT", () => { void handler("SIGINT"); }); process.once("SIGTERM", () => { void handler("SIGTERM"); }); });
    register(handle);
  }
  return { app: runtime.app, prisma, shutdown };
}

export function shutdownRuntime(input: { app: Pick<RuntimeApp, "close">; prisma: PrismaResource; readiness: Pick<Readiness, "beginDraining">; timeoutMs: number; forceExit?: (code: number) => void; logger?: RuntimeLogger }) {
  let result: Promise<ShutdownResult> | undefined;
  return (signal = "shutdown"): Promise<ShutdownResult> => result ??= (async () => {
    const logger = input.logger;
    const deadline = Date.now() + input.timeoutMs;
    input.readiness.beginDraining();
    logger?.info({ event: STUDYMIND_EVENTS.draining, code: STUDYMIND_CODES.draining, signal });
    const closeStatus = await settleBeforeDeadline(() => input.app.close(), deadline);
    if (closeStatus === "timeout") return forceTimedOut(input, signal);
    const disconnectStatus = await settleBeforeDeadline(() => input.prisma.$disconnect(), deadline);
    if (disconnectStatus === "timeout") return forceTimedOut(input, signal);
    const exitCode = closeStatus === "failed" || disconnectStatus === "failed" ? 1 : 0;
    logger?.info({ event: STUDYMIND_EVENTS.shutdown, code: STUDYMIND_CODES.shutdown, signal, exitCode });
    return { exitCode, signal };
  })();
}

async function settleBeforeDeadline(operation: () => Promise<unknown>, deadline: number): Promise<"completed" | "failed" | "timeout"> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "timeout";
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(() => "completed" as const, () => "failed" as const),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function forceTimedOut(input: { forceExit?: (code: number) => void; logger?: RuntimeLogger }, signal: string): ShutdownResult {
  input.logger?.error({ event: STUDYMIND_EVENTS.shutdown, code: STUDYMIND_CODES.shutdownTimeout, signal, exitCode: 1 });
  input.forceExit?.(1);
  return { exitCode: 1, signal };
}

function createWechatConfig(config: RuntimeConfig): WechatConfig {
  const source = config.wechat!;
  const certificate = new X509Certificate(source.platformCertificate);
  return { appId: source.appId, mchId: source.mchId, serialNo: source.serialNo, privateKey: source.privateKey, notifyUrl: source.notifyUrl, apiV3Key: source.apiV3Key, platformPublicKey: certificate.publicKey.export({ type: "spki", format: "pem" }).toString(), platformSerialNo: certificate.serialNumber, allowInsecureNotify: source.allowInsecureNotify, environment: config.environment };
}
