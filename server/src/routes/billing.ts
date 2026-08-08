import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BillingService } from "../billing.js";
import type { Store } from "../store.js";
import type { WechatNotificationParser } from "../wechat.js";
import { authenticateDesktop } from "./shared.js";

type Dependencies = { store: Pick<Store, "findSessionByTokenHash" | "getEntitlement">; billing: BillingService | null; notificationParser: WechatNotificationParser | null; now?: () => Date };
const paramsSchema = z.object({ orderId: z.string().regex(/^sm_[A-Za-z0-9_-]{6,48}$/) }).strict();
export function registerBillingRoutes(app: FastifyInstance, dependencies: Dependencies) {
  const now = dependencies.now ?? (() => new Date()); const enabled = () => Boolean(dependencies.billing && dependencies.notificationParser);
  app.post("/api/desktop/billing/wechat-native", async (request, reply) => {
    if (!enabled()) return reply.code(404).send({ error: "BILLING_DISABLED" });
    let session; try { session = await authenticateDesktop(dependencies.store, request.headers.authorization, now()); } catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
    if (!session) return reply.code(401).send({ error: "AUTH_REQUIRED" });
    try { const order = await dependencies.billing!.createWechatNativeOrder({ sessionTokenHash: session.tokenHash }); return { order_id: order.outTradeNo, amount_fen: order.amountFen, currency: "CNY", code_url: order.codeUrl, expires_at: order.expiresAt.toISOString(), status: order.status }; }
    catch { return reply.code(503).send({ error: "PAYMENT_PROVIDER_UNAVAILABLE" }); }
  });
  app.get("/api/desktop/billing/orders/:orderId", async (request, reply) => {
    if (!enabled()) return reply.code(404).send({ error: "BILLING_DISABLED" });
    let session; try { session = await authenticateDesktop(dependencies.store, request.headers.authorization, now()); } catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
    if (!session) return reply.code(401).send({ error: "AUTH_REQUIRED" });
    const parsed = paramsSchema.safeParse(request.params); if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST" });
    try { const order = await dependencies.billing!.getOrderStatus(parsed.data.orderId); if (!order || order.userId !== session.userId) return reply.code(404).send({ error: "ORDER_NOT_FOUND" }); const entitlement = await dependencies.store.getEntitlement(session.userId); return { order_id: order.outTradeNo, status: order.status, entitlement_expires_at: entitlement?.expiresAt.toISOString() ?? null }; }
    catch { return reply.code(503).send({ error: "SERVER_TEMPORARILY_UNAVAILABLE" }); }
  });
  app.post("/api/wechat/notify", async (request, reply) => {
    if (!enabled()) return reply.code(404).send({ error: "BILLING_DISABLED" });
    const raw = (request as typeof request & { rawBody?: Buffer | string }).rawBody;
    if (raw === undefined) return reply.code(400).send({ code: "FAIL", message: "INVALID_WECHAT_NOTIFICATION" });
    try { const event = await dependencies.notificationParser!({ headers: request.headers, rawBody: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), body: request.body }); await dependencies.billing!.applyPaidOrder({ webhookId: event.webhookId, outTradeNo: event.outTradeNo, transactionId: event.transactionId, paidAt: event.paidAt }); return { code: "SUCCESS", message: "success" }; }
    catch { return reply.code(400).send({ code: "FAIL", message: "INVALID_WECHAT_NOTIFICATION" }); }
  });
}
