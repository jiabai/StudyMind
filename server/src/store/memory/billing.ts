import type { EntitlementRecord, Store, WebhookEventRecord } from "../contracts.js";
import type { MemoryAuthContext } from "./auth.js";
import { assertUnique } from "./atomic.js";
import { getEntitlement, upsertEntitlement } from "./entitlements.js";

export type MemoryBillingContext = MemoryAuthContext;

export async function createOrder(
  context: MemoryBillingContext, input: Parameters<Store["createOrder"]>[0],
): ReturnType<Store["createOrder"]> {
  assertUnique(context.state.orders, ({ outTradeNo }) => outTradeNo === input.outTradeNo, "Order.outTradeNo");
  const order = { ...input, id: context.allocateId(), paidAt: null, transactionId: null };
  context.state.orders.push(order);
  return order;
}
export async function findOrderByOutTradeNo(
  context: MemoryBillingContext, outTradeNo: string,
): ReturnType<Store["findOrderByOutTradeNo"]> {
  return context.state.orders.find((order) => order.outTradeNo === outTradeNo) ?? null;
}
async function markOrderPaid(
  context: MemoryBillingContext, outTradeNo: string, transactionId: string, paidAt: Date,
): Promise<NonNullable<Awaited<ReturnType<Store["findOrderByOutTradeNo"]>>>> {
  const order = await findOrderByOutTradeNo(context, outTradeNo);
  if (!order) throw new Error("Order not found.");
  assertUnique(
    context.state.orders,
    (candidate) => candidate.id !== order.id && candidate.transactionId === transactionId,
    "Order.transactionId",
  );
  order.status = "paid"; order.transactionId = transactionId; order.paidAt = paidAt;
  return order;
}
export async function settlePaidOrder(
  context: MemoryBillingContext, input: Parameters<Store["settlePaidOrder"]>[0],
): ReturnType<Store["settlePaidOrder"]> {
  return context.atomic.run(async () => {
    const existingEvent = context.state.webhookEvents.find((event) =>
      event.provider === input.provider && event.eventId === input.eventId,
    );
    const payload = canonicalWebhookPayload(input);
    if (existingEvent && existingEvent.outTradeNo !== input.outTradeNo) {
      return { status: "webhook_order_mismatch" };
    }
    if (existingEvent && existingEvent.payload !== payload) {
      return { status: "webhook_payload_conflict" };
    }
    const order = await findOrderByOutTradeNo(context, input.outTradeNo);
    if (!order) return { status: "order_not_found" };
    if (context.state.orders.some((candidate) =>
      candidate.id !== order.id && candidate.transactionId === input.transactionId,
    )) {
      return { status: "transaction_mismatch" };
    }
    if (order.status === "paid") {
      if (order.transactionId !== input.transactionId) return { status: "transaction_mismatch" };
      const entitlement = await getEntitlement(context, order.userId);
      if (entitlement) {
        if (!existingEvent) {
          const claimed = await createWebhookEvent(context, {
            provider: input.provider,
            eventId: input.eventId,
            outTradeNo: input.outTradeNo,
            payload,
            createdAt: input.now,
          });
          if (!claimed) return { status: "webhook_payload_conflict" };
        }
        return { status: "settled", entitlement };
      }
      if (!existingEvent) return { status: "order_state_conflict" };
      return { status: "settled", entitlement: await extend(context, order.userId, order.paidAt ?? input.paidAt, input) };
    }
    if (order.status !== "pending" || order.transactionId !== null || order.paidAt !== null) {
      return { status: "order_state_conflict" };
    }
    if (!existingEvent) {
      await createWebhookEvent(context, {
        provider: input.provider, eventId: input.eventId, outTradeNo: input.outTradeNo,
        payload,
        createdAt: input.now,
      });
    }
    await markOrderPaid(context, input.outTradeNo, input.transactionId, input.paidAt);
    return { status: "settled", entitlement: await extend(context, order.userId, input.paidAt, input) };
  });
}
async function createWebhookEvent(
  context: MemoryBillingContext, input: Omit<WebhookEventRecord, "id">,
): Promise<boolean> {
  if (context.state.webhookEvents.some((event) => event.provider === input.provider && event.eventId === input.eventId)) return false;
  context.state.webhookEvents.push({ ...input, id: context.allocateId() });
  return true;
}
async function extend(
  context: MemoryBillingContext, userId: string, paidAt: Date, input: { now: Date; passDays: number },
): Promise<EntitlementRecord> {
  const existing = await getEntitlement(context, userId);
  const base = existing && existing.expiresAt > paidAt ? existing.expiresAt : paidAt;
  return upsertEntitlement(context, userId, new Date(base.getTime() + input.passDays * 86_400_000), input.now);
}
function canonicalWebhookPayload(input: {
  outTradeNo: string; transactionId: string; paidAt: Date;
}): string {
  return JSON.stringify({
    outTradeNo: input.outTradeNo,
    transactionId: input.transactionId,
    paidAt: input.paidAt.toISOString(),
  });
}
