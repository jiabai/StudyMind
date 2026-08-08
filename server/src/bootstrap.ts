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
} = {}): Promise<LifecycleResult> {
  const loadConfig = options.loadConfig ?? (() => parseRuntimeConfig(process.env));
  const connect = options.connectDatabase ?? ((config) => connectConfiguredDatabase(config));
  const assemble = options.buildRuntime ?? buildRuntime;
  const config = loadConfig();
  let prisma: PrismaClient | undefined;
  let runtime: Runtime | undefined;
  try {
    prisma = await connect(config);
    runtime = await assemble(config, prisma);
    await runtime.app.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (runtime) { runtime.readiness.beginDraining(); await runtime.app.close().catch(() => undefined); }
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
  const shutdown = shutdownRuntime({ app: runtime.app, prisma, readiness: runtime.readiness, timeoutMs: options.shutdownTimeoutMs ?? 15_000 });
  if (options.installSignalHandlers !== false) {
    const handle = (signal: "SIGINT" | "SIGTERM") => { void shutdown(signal).then(({ exitCode }) => { process.exitCode = exitCode; }); };
    process.once("SIGINT", handle); process.once("SIGTERM", handle);
  }
  return { app: runtime.app, prisma, shutdown };
}

export function shutdownRuntime(input: { app: Pick<RuntimeApp, "close">; prisma: PrismaResource; readiness: Pick<Readiness, "beginDraining">; timeoutMs: number }) {
  let result: Promise<ShutdownResult> | undefined;
  return (signal = "shutdown"): Promise<ShutdownResult> => result ??= (async () => {
    input.readiness.beginDraining();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([input.app.close(), new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, input.timeoutMs); timer.unref?.(); })]);
    } catch { timedOut = true; }
    finally { if (timer) clearTimeout(timer); await input.prisma.$disconnect().catch(() => { timedOut = true; }); }
    return { exitCode: timedOut ? 1 : 0, signal };
  })();
}

function createWechatConfig(config: RuntimeConfig): WechatConfig {
  const source = config.wechat!;
  const certificate = new X509Certificate(source.platformCertificate);
  return { appId: source.appId, mchId: source.mchId, serialNo: source.serialNo, privateKey: source.privateKey, notifyUrl: source.notifyUrl, apiV3Key: source.apiV3Key, platformPublicKey: certificate.publicKey.export({ type: "spki", format: "pem" }).toString(), platformSerialNo: certificate.serialNumber, allowInsecureNotify: source.allowInsecureNotify, environment: config.environment };
}
