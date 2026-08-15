import type { FastifyInstance } from "fastify";
import { AuthRateLimitError, AuthService, userSessionMaxAgeSeconds } from "../auth.js";
import { detectLocale, extractQueryLang, LANG_COOKIE_MAX_AGE, resolveCookieLocale, SUPPORTED_LOCALES } from "../i18n.js";
import { renderLoginPage } from "../loginPage.js";
import { sha256 } from "../security.js";
import type { Store } from "../store.js";
import { emailStartSchema, emailVerifySchema, ticketExchangeSchema } from "./authSchemas.js";
import { setCookie } from "./cookies.js";
import { bearerToken, isServerTemporarilyUnavailable, publicAuthError } from "./shared.js";

type Dependencies = {
  store: Pick<Store, "issueEmailOtp" | "invalidateIssuedOtpAfterDeliveryFailure" | "verifyDesktopOtpAndCreateTicketAndWebSession" | "exchangeDesktopTicketAndCreateSession" | "revokeSession">;
  auth?: AuthService; sendOtp: (email: string, code: string) => Promise<void>; otpHmacKey: string; now?: () => Date; secureCookies?: boolean;
};

export function registerDesktopAuthRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  if (typeof dependencies.sendOtp !== "function") throw new Error("OTP sender is required.");
  const now = dependencies.now ?? (() => new Date());
  const auth = dependencies.auth ?? new AuthService({ store: dependencies.store, sendOtp: dependencies.sendOtp, otpHmacKey: dependencies.otpHmacKey, now });
  const secure = dependencies.secureCookies ?? true;
  app.get("/login", async (request, reply) => {
    reply.header("cache-control", "no-store").type("text/html; charset=utf-8");
    const queryLang = extractQueryLang(request.query);
    const acceptLanguage = request.headers["accept-language"];
    const locale = detectLocale({
      cookie: request.headers.cookie,
      queryLang,
      acceptLanguage: Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage,
    });
    // 深度链接 ?lang= 生效时写入 lang cookie；已有显式 cookie 选择则不覆盖。
    const hasCookieLocale = resolveCookieLocale(request.headers.cookie) != null;
    if (queryLang != null && (SUPPORTED_LOCALES as string[]).includes(queryLang) && !hasCookieLocale) {
      setCookie(reply, "lang", queryLang, { httpOnly: false, maxAgeSeconds: LANG_COOKIE_MAX_AGE, secure });
    }
    return renderLoginPage(locale);
  });
  app.post("/auth/email/start", async (request, reply) => {
    const parsed = emailStartSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { await auth.startEmailLogin({ ...parsed.data, ip: request.ip }); return { ok: true }; } catch (error) { return sendAuthError(reply, error, now()); }
  });
  app.post("/auth/email/verify", async (request, reply) => {
    const parsed = emailVerifySchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      const result = await auth.verifyEmailCodeAndCreateWebSession(parsed.data);
      setCookie(reply, "studymind_user_session", result.sessionToken, { httpOnly: true, maxAgeSeconds: userSessionMaxAgeSeconds, secure });
      setCookie(reply, "studymind_user_csrf", result.csrfToken, { httpOnly: false, maxAgeSeconds: userSessionMaxAgeSeconds, secure });
      return { ticket: result.ticket, redirect_url: result.redirectUrl };
    } catch (error) { return sendAuthError(reply, error, now()); }
  });
  app.post("/api/desktop/sessions/exchange", async (request, reply) => {
    const parsed = ticketExchangeSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { const result = await auth.exchangeDesktopTicket(parsed.data); return { session_token: result.sessionToken, email: result.email, expires_at: result.expiresAt.toISOString() }; }
    catch (error) { return sendAuthError(reply, error, now()); }
  });
  app.post("/api/desktop/logout", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token) {
      try { await dependencies.store.revokeSession(sha256(token), now()); }
      catch { return reply.code(500).send({ error: "INTERNAL_SERVER_ERROR" }); }
    }
    return { ok: true };
  });
}

function sendAuthError(reply: { header(name: string, value: string): unknown; code(status: number): { send(value: unknown): unknown } }, error: unknown, now: Date) {
  if (error instanceof AuthRateLimitError) {
    const retryAfter = Math.max(1, Math.ceil((error.retryAt.getTime() - now.getTime()) / 1000));
    reply.header("retry-after", String(retryAfter));
    return reply.code(429).send({ error: "RATE_LIMITED", retry_at: error.retryAt.toISOString() });
  }
  if (isServerTemporarilyUnavailable(error)) return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
  const message = publicAuthError(error); return message ? reply.code(400).send({ error: message }) : reply.code(500).send({ error: "INTERNAL_SERVER_ERROR" });
}
