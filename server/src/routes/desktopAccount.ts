import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ActivationCodeService } from "../activation.js";
import type { LlmConfigService } from "../llmConfig.js";
import type { EntitlementRecord, Store } from "../store.js";
import { authenticateDesktop } from "./shared.js";

type AccountStore = Pick<Store, "findSessionByTokenHash" | "getUserById" | "getEntitlement">;
const redeemSchema = z.object({ code: z.string().min(8).max(64) }).strict();

export function registerDesktopAccountRoutes(app: FastifyInstance, dependencies: {
  store: AccountStore; activationCodes: ActivationCodeService; llmConfig: LlmConfigService; now?: () => Date;
}): void {
  const now = dependencies.now ?? (() => new Date());
  app.get("/api/desktop/account", async (request, reply) => {
    try {
      const at = now();
      const session = await authenticateDesktop(dependencies.store, request.headers.authorization, at);
      if (!session) return reply.code(401).send({ error: "AUTH_REQUIRED" });
      return await accountPayload(dependencies.store, dependencies.llmConfig, session.userId, at);
    } catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
  });
  app.post("/api/desktop/activation-codes/redeem", async (request, reply) => {
    let session;
    try { session = await authenticateDesktop(dependencies.store, request.headers.authorization, now()); }
    catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
    if (!session) return reply.code(401).send({ error: "AUTH_REQUIRED" });
    const parsed = redeemSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try {
      await dependencies.activationCodes.redeemCode({ sessionTokenHash: session.tokenHash, code: parsed.data.code });
      return await accountPayload(dependencies.store, dependencies.llmConfig, session.userId, now());
    } catch (error) {
      if (error instanceof Error && error.message === "Activation code is invalid or expired.")
        return reply.code(400).send({ error: "Activation code is invalid or expired." });
      if (error instanceof Error && error.message === "Desktop session is invalid or expired.")
        return reply.code(401).send({ error: "AUTH_REQUIRED" });
      return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
    }
  });
}

async function accountPayload(store: AccountStore, llmConfig: LlmConfigService, userId: string, now: Date) {
  const [user, entitlement, configured] = await Promise.all([store.getUserById(userId), store.getEntitlement(userId), llmConfig.isConfigured()]);
  const active = isActive(entitlement, now);
  const limit = entitlement?.llmQuotaLimit ?? 0;
  const used = entitlement?.llmQuotaUsed ?? 0;
  const remaining = active ? Math.max(0, limit - used) : 0;
  return {
    authenticated: true, email: user?.email ?? "", entitlement_status: active ? "active" : "inactive",
    entitlement_expires_at: entitlement?.expiresAt.toISOString() ?? null,
    llm_quota_limit: limit, llm_quota_used: used, llm_quota_remaining: remaining,
    llm_quota_resets_at: active ? entitlement?.expiresAt.toISOString() ?? null : null,
    llm_configured: configured, last_verified_at: now.toISOString(), can_process: active,
    can_generate_ai: active && remaining > 0 && configured,
  };
}

function isActive(entitlement: EntitlementRecord | null, now: Date): boolean {
  return Boolean(entitlement?.status === "active" && entitlement.expiresAt > now);
}
