import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LlmConfigInvalidError, LlmConfigMissingError, type LlmConfigService } from "../llmConfig.js";
import type { Store } from "../store.js";
import { authenticateDesktop } from "./shared.js";

type CheckoutStore = Pick<Store, "findSessionByTokenHash" | "consumeLlmQuota">;
const checkoutSchema = z.object({ request_id: z.string().regex(/^[A-Za-z0-9._~-]{8,160}$/) }).strict();

export function registerDesktopLlmRoutes(app: FastifyInstance, dependencies: {
  store: CheckoutStore; llmConfig: LlmConfigService; now?: () => Date;
}): void {
  const now = dependencies.now ?? (() => new Date());
  app.post("/api/desktop/llm/checkouts", async (request, reply) => {
    let session;
    try { session = await authenticateDesktop(dependencies.store, request.headers.authorization, now()); }
    catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
    if (!session) return reply.code(401).send({ error: "AUTH_REQUIRED" });
    const parsed = checkoutSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });

    let config;
    try { config = await dependencies.llmConfig.getDecrypted(); }
    catch (error) {
      if (error instanceof LlmConfigMissingError || error instanceof LlmConfigInvalidError)
        return reply.code(503).send({ error: "LLM_CONFIG_MISSING" });
      return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
    }

    let checkout: Awaited<ReturnType<CheckoutStore["consumeLlmQuota"]>>;
    try { checkout = await dependencies.store.consumeLlmQuota(session.userId, parsed.data.request_id, now()); }
    catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
    if (checkout.status !== "consumed" && checkout.status !== "reused") {
      if (checkout.status === "temporarily_unavailable") return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" });
      return reply.code(403).send({ error: "LLM_QUOTA_UNAVAILABLE" });
    }
    return {
      provider: config.provider, base_url: config.baseUrl, model: config.model, api_key: config.apiKey,
      timeout_seconds: config.timeoutSeconds,
      quota_remaining: Math.max(0, checkout.entitlement.llmQuotaLimit - checkout.entitlement.llmQuotaUsed),
    };
  });
}
