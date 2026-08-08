import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { ActivationCodeService } from "./activation.js";
import type { AdminAuthService } from "./adminAuth.js";
import type { AuthService } from "./auth.js";
import type { BillingService } from "./billing.js";
import type { EntitlementAdjustmentService } from "./entitlementAdjustment.js";
import type { LlmConfigService } from "./llmConfig.js";
import { createRequestId, loggerOptions, STUDYMIND_EVENTS } from "./observability.js";
import type { Readiness } from "./readiness.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerDesktopAccountRoutes } from "./routes/desktopAccount.js";
import { registerDesktopAuthRoutes } from "./routes/desktopAuth.js";
import { registerDesktopLlmRoutes } from "./routes/desktopLlm.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerUserAuthRoutes } from "./routes/userAuth.js";
import type { Store } from "./store.js";
import type { UserAuthService } from "./userAuth.js";
import type { WechatNotificationParser } from "./wechat.js";

export type ServerDependencies = {
  store: Store; sendOtp: (email: string, code: string) => Promise<void>; otpHmacKey: string; adminEmail: string;
  auth?: AuthService; userAuth: UserAuthService; adminAuth: AdminAuthService; activationCodes: ActivationCodeService;
  llmConfig: LlmConfigService; adjustments: EntitlementAdjustmentService; billing: BillingService | null;
  notificationParser: WechatNotificationParser | null; readiness: Readiness; secureCookies?: boolean; now?: () => Date;
  logger?: false | Record<string, unknown> | FastifyBaseLogger; environment?: string;
};

export async function createServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger === false ? false : (dependencies.logger ?? loggerOptions(dependencies.environment ?? "production")) as never,
    trustProxy: (address) => isLoopbackProxy(address),
    genReqId: (request) => createRequestId(request.headers),
    bodyLimit: 1024 * 1024,
  });
  installJsonParser(app);
  app.setErrorHandler((error, request, reply) => {
    const protocol = publicProtocolError(error);
    if (protocol) { void reply.code(protocol.statusCode).send({ error: protocol.code }); return; }
    request.log.error({ event: STUDYMIND_EVENTS.requestFailed, errorName: error instanceof Error ? error.name : "Error", requestId: request.id });
    void reply.code(500).send({ error: "INTERNAL_SERVER_ERROR" });
  });
  registerHealthRoutes(app, dependencies.readiness);
  registerDesktopAuthRoutes(app, dependencies);
  registerDesktopAccountRoutes(app, dependencies);
  registerDesktopLlmRoutes(app, dependencies);
  registerBillingRoutes(app, dependencies);
  registerAdminRoutes(app, { store: dependencies.store, auth: dependencies.adminAuth, activationCodes: dependencies.activationCodes, llmConfig: dependencies.llmConfig, adjustments: dependencies.adjustments, adminEmail: dependencies.adminEmail, secureCookies: dependencies.secureCookies, now: dependencies.now });
  registerUserAuthRoutes(app, { store: dependencies.store, auth: dependencies.userAuth, secureCookies: dependencies.secureCookies, now: dependencies.now });
  registerDashboardRoutes(app, { store: dependencies.store, auth: dependencies.userAuth, llmConfig: dependencies.llmConfig, now: dependencies.now });
  await app.ready();
  return app;
}

export function isLoopbackProxy(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function installJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (request.raw.url?.split("?", 1)[0] === "/api/wechat/notify") (request as typeof request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    try { done(null, buffer.length === 0 ? {} : JSON.parse(buffer.toString("utf8"))); }
    catch { done(Object.assign(new Error("Invalid JSON body."), { code: "FST_ERR_CTP_INVALID_JSON_BODY", statusCode: 400 }), undefined); }
  });
}

function publicProtocolError(error: unknown): { statusCode: 400 | 413 | 415; code: string } | null {
  const value = error as { code?: string };
  if (value?.code === "FST_ERR_CTP_INVALID_JSON_BODY") return { statusCode: 400, code: "INVALID_JSON_BODY" };
  if (value?.code === "FST_ERR_CTP_BODY_TOO_LARGE") return { statusCode: 413, code: "REQUEST_BODY_TOO_LARGE" };
  if (value?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" };
  return null;
}
