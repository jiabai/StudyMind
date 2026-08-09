import type { FastifyInstance } from "fastify";
import { userSessionMaxAgeSeconds, type UserAuthService } from "../userAuth.js";
import { sha256 } from "../security.js";
import type { Store } from "../store.js";
import { emailStartSchema, emailVerifySchema } from "./authSchemas.js";
import { parseCookies, setCookie } from "./cookies.js";
import { isServerTemporarilyUnavailable, publicAuthError } from "./shared.js";
type Dependencies = { store: Pick<Store, "revokeUserSession">; auth: UserAuthService; secureCookies?: boolean; now?: () => Date };
export function registerUserAuthRoutes(app: FastifyInstance, d: Dependencies) {
  const now = d.now ?? (() => new Date()); const secure = d.secureCookies ?? true;
  app.post("/user/auth/email/start", async (request, reply) => { const parsed = emailStartSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" }); try { await d.auth.startEmailLogin({ ...parsed.data, ip: request.ip }); return { ok: true }; } catch (e) { return authError(reply, e); } });
  app.post("/user/auth/email/verify", async (request, reply) => { const parsed = emailVerifySchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" }); try { const result = await d.auth.verifyEmailCode(parsed.data); setCookie(reply, "studymind_user_session", result.sessionToken, { httpOnly: true, maxAgeSeconds: userSessionMaxAgeSeconds, secure }); setCookie(reply, "studymind_user_csrf", result.csrfToken, { httpOnly: false, maxAgeSeconds: userSessionMaxAgeSeconds, secure }); return { ok: true, redirect_url: "/dashboard" }; } catch (e) { return authError(reply, e); } });
  app.post("/user/auth/logout", async (request, reply) => { try { const cookies = parseCookies(request.headers.cookie); const token = cookies.get("studymind_user_session") ?? null; const session = await d.auth.authenticate(token); if (!session || !token) return reply.code(401).send({ error: "AUTH_REQUIRED" }); const csrf = firstHeader(request.headers["x-studymind-csrf"]); if (!csrf || csrf !== cookies.get("studymind_user_csrf") || !d.auth.validateCsrf(session, csrf)) return reply.code(403).send({ error: "CSRF_INVALID" }); await d.store.revokeUserSession(sha256(token), now()); clearCookie(reply, "studymind_user_session", true, secure); clearCookie(reply, "studymind_user_csrf", false, secure); return { ok: true, redirect_url: "/login" }; } catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); } });
}
function authError(reply: { code(status: number): { send(value: unknown): unknown } }, error: unknown) { if (isServerTemporarilyUnavailable(error)) return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); const message = publicAuthError(error); return message ? reply.code(400).send({ error: message }) : reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
function firstHeader(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function clearCookie(reply: Parameters<typeof setCookie>[0], name: string, httpOnly: boolean, secure: boolean) { setCookie(reply, name, "", { httpOnly, maxAgeSeconds: 0, secure }); }
