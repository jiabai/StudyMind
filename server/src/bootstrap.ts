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
type CleanupStatus = "success" | "failed" | "timeout";
export type LifecycleResult = { shutdown(signal?: string): Promise<ShutdownResult>; app: Runtime["app"]; prisma: PrismaResource };
export type ShutdownResult = { exitCode: 0 | 1; signal: string };
export class StartupInterruptedError extends Error { readonly name = "StartupInterruptedError"; constructor() { super("Server startup was interrupted by a signal."); } }

export async function buildRuntime(config: RuntimeConfig, prisma: PrismaClient, options: { developmentOtpWriter?: (email: string, code: string) => void } = {}): Promise<Runtime> {
  const store = new PrismaStore(prisma);
  const developmentOtpWriter = config.environment === "production" ? undefined : options.developmentOtpWriter;
  if (config.allowConsoleOtp && !config.smtp && !developmentOtpWriter) throw new Error("Development console OTP requires an explicit writer.");
  const sendOtp = createOtpSender({ environment: config.environment, smtp: config.smtp, allowConsoleOtp: config.allowConsoleOtp }, undefined, {
    warn: () => undefined, error: () => undefined, write: developmentOtpWriter,
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
  developmentOtpWriter?: (email: string, code: string) => void;
  registerSignalHandlers?: (handler: (signal: "SIGINT" | "SIGTERM") => Promise<void>) => void | (() => void);
} = {}): Promise<LifecycleResult> {
  const loadConfig = options.loadConfig ?? (() => parseRuntimeConfig(process.env));
  const connect = options.connectDatabase ?? ((config) => connectConfiguredDatabase(config));
  const assemble = options.buildRuntime ?? ((config, prisma) => buildRuntime(config, prisma, { developmentOtpWriter: options.developmentOtpWriter }));
  const logger = options.logger ?? createRuntimeLogger();
  const forceExit = options.forceExit ?? ((code) => process.exit(code));
  let prisma: PrismaClient | undefined;
  let runtime: Runtime | undefined;
  let shutdown: ReturnType<typeof shutdownRuntime> | undefined;
  let startupFinished = false;
  let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
  let signalDeadline = 0;
  let signalHandling: Promise<void> | undefined;
  let startupStoppedResolve: ((status: CleanupStatus) => void) | undefined;
  const startupStopped = new Promise<CleanupStatus>((resolve) => { startupStoppedResolve = resolve; });
  let startupStoppedSettled = false;
  const settleStartupStopped = (status: CleanupStatus) => { if (!startupStoppedSettled) { startupStoppedSettled = true; startupStoppedResolve?.(status); } };
  let listenersRemoved = false;
  let removeSignalListeners: () => void = () => undefined;
  let forced = false;
  const forceOnce = (code: number) => { if (!forced) { forced = true; forceExit(code); } };
  const handleSignal = (signal: "SIGINT" | "SIGTERM"): Promise<void> => signalHandling ??= (async () => {
    receivedSignal = signal; signalDeadline = Date.now() + (options.shutdownTimeoutMs ?? 15_000);
    if (startupFinished && shutdown) { const result = await shutdown(signal); process.exitCode = result.exitCode; return; }
    logger.info({ event: STUDYMIND_EVENTS.draining, code: STUDYMIND_CODES.draining, signal });
    const status = await completesBy(startupStopped, signalDeadline);
    if (status === "timeout") forceOnce(1);
    else process.exitCode = status === "success" ? 0 : 1;
  })().finally(() => { if (!listenersRemoved) { listenersRemoved = true; removeSignalListeners(); } });
  if (options.installSignalHandlers !== false) {
    const register = options.registerSignalHandlers ?? registerProcessSignalHandlers;
    removeSignalListeners = register(handleSignal) ?? (() => undefined);
  }
  logger.info({ event: STUDYMIND_EVENTS.startup, code: STUDYMIND_CODES.startup });
  try {
    const config = loadConfig();
    prisma = await connect(config);
    if (receivedSignal) throw new StartupInterruptedError();
    runtime = await assemble(config, prisma);
    if (receivedSignal) throw new StartupInterruptedError();
    await runtime.app.listen({ host: config.host, port: config.port });
    if (receivedSignal) throw new StartupInterruptedError();
    logger.info({ event: STUDYMIND_EVENTS.ready, code: STUDYMIND_CODES.ready });
  } catch (error) {
    if (error instanceof StartupInterruptedError) {
      settleStartupStopped(await cleanupInterruptedStartup({ runtime, prisma, deadline: signalDeadline, forceOnce, logger }));
      throw error;
    }
    logger.error({ event: STUDYMIND_EVENTS.startupFailed, code: STUDYMIND_CODES.startupFailed });
    if (receivedSignal) {
      const cleanup = await cleanupInterruptedStartup({ runtime, prisma, deadline: signalDeadline, forceOnce, logger });
      settleStartupStopped(cleanup === "timeout" ? "timeout" : "failed");
    } else {
      const cleanup = await cleanupStartupFailure({ runtime, prisma, timeoutMs: options.shutdownTimeoutMs ?? 15_000, forceExit: forceOnce, logger });
      settleStartupStopped(cleanup === "timeout" ? "timeout" : "failed");
      if (!listenersRemoved) { listenersRemoved = true; removeSignalListeners(); }
    }
    throw error;
  }
  shutdown = shutdownRuntime({ app: runtime.app, prisma, readiness: runtime.readiness, timeoutMs: options.shutdownTimeoutMs ?? 15_000, forceExit: forceOnce, logger });
  startupFinished = true;
  settleStartupStopped("success");
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

async function cleanupStartupFailure(input: { runtime?: Runtime; prisma?: PrismaClient; timeoutMs: number; forceExit: (code: number) => void; logger: RuntimeLogger }): Promise<CleanupStatus> {
  const deadline = Date.now() + input.timeoutMs;
  let status: CleanupStatus = "success";
  if (input.runtime) {
    input.runtime.readiness.beginDraining();
    const closeStatus = await settleBeforeDeadline(() => input.runtime!.app.close(), deadline);
    if (closeStatus === "timeout") { input.forceExit(1); return "timeout"; }
    if (closeStatus === "failed") { status = "failed"; logCleanupFailure(input.logger, "application", "startup_failure"); }
  }
  if (!input.prisma) return status;
  const disconnectStatus = await settleBeforeDeadline(() => input.prisma!.$disconnect(), deadline);
  if (disconnectStatus === "timeout") { input.forceExit(1); return "timeout"; }
  if (disconnectStatus === "failed") { status = "failed"; logCleanupFailure(input.logger, "database", "startup_failure"); }
  return status;
}

async function cleanupInterruptedStartup(input: { runtime?: Runtime; prisma?: PrismaClient; deadline: number; forceOnce(code: number): void; logger: RuntimeLogger }): Promise<CleanupStatus> {
  let status: CleanupStatus = "success";
  if (input.runtime) {
    input.runtime.readiness.beginDraining();
    const closeStatus = await settleBeforeDeadline(() => input.runtime!.app.close(), input.deadline);
    if (closeStatus === "timeout") { input.forceOnce(1); return "timeout"; }
    if (closeStatus === "failed") { status = "failed"; logCleanupFailure(input.logger, "application", "startup_signal"); }
  }
  if (!input.prisma) return status;
  if (Date.now() >= input.deadline) { void input.prisma.$disconnect().catch(() => undefined); input.forceOnce(1); return "timeout"; }
  const disconnectStatus = await settleBeforeDeadline(() => input.prisma!.$disconnect(), input.deadline);
  if (disconnectStatus === "timeout") { input.forceOnce(1); return "timeout"; }
  if (disconnectStatus === "failed") { status = "failed"; logCleanupFailure(input.logger, "database", "startup_signal"); }
  return status;
}

function logCleanupFailure(logger: RuntimeLogger, resource: "application" | "database", phase: "startup_signal" | "startup_failure"): void {
  logger.error({ event: STUDYMIND_EVENTS.cleanupFailed, code: STUDYMIND_CODES.cleanupFailed, phase, resource });
}

async function completesBy(operation: Promise<CleanupStatus>, deadline: number): Promise<CleanupStatus> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "timeout";
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function registerProcessSignalHandlers(handler: (signal: "SIGINT" | "SIGTERM") => Promise<void>): () => void {
  const sigint = () => { void handler("SIGINT"); }; const sigterm = () => { void handler("SIGTERM"); };
  process.on("SIGINT", sigint); process.on("SIGTERM", sigterm);
  return () => { process.off("SIGINT", sigint); process.off("SIGTERM", sigterm); };
}

function createWechatConfig(config: RuntimeConfig): WechatConfig {
  const source = config.wechat!;
  const certificate = new X509Certificate(source.platformCertificate);
  return { appId: source.appId, mchId: source.mchId, serialNo: source.serialNo, privateKey: source.privateKey, notifyUrl: source.notifyUrl, apiV3Key: source.apiV3Key, platformPublicKey: certificate.publicKey.export({ type: "spki", format: "pem" }).toString(), platformSerialNo: certificate.serialNumber, allowInsecureNotify: source.allowInsecureNotify, environment: config.environment };
}
