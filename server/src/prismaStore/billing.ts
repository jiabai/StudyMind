import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { EntitlementRecord, OrderRecord, Store } from "../store/contracts.js";
import { StoreConflictError } from "../store/contracts.js";
import { isUnique, withConflictRetry } from "./concurrency.js";

export async function createOrder(prisma: PrismaClient, input: Parameters<Store["createOrder"]>[0]): ReturnType<Store["createOrder"]> { try { return await prisma.order.create({ data: { ...input, id: randomUUID(), paidAt: null, transactionId: null } }) as OrderRecord; } catch (error) { if (isUnique(error)) throw new StoreConflictError("Order.outTradeNo"); throw error; } }
export async function findOrderByOutTradeNo(prisma: PrismaClient, outTradeNo: string): ReturnType<Store["findOrderByOutTradeNo"]> { return await prisma.order.findUnique({ where: { outTradeNo } }) as OrderRecord | null; }
type Input = Parameters<Store["settlePaidOrder"]>[0];
function payload(input: Input): string { return JSON.stringify({ outTradeNo: input.outTradeNo, transactionId: input.transactionId, paidAt: input.paidAt.toISOString() }); }
async function grant(tx: Prisma.TransactionClient, userId: string, input: Input): Promise<EntitlementRecord> { const old = await tx.entitlement.findUnique({ where: { userId } }); const base = old && old.expiresAt > input.paidAt ? old.expiresAt : input.paidAt; return await tx.entitlement.upsert({ where: { userId }, update: { status: "active", expiresAt: new Date(base.getTime() + input.passDays * 86_400_000), updatedAt: input.now }, create: { id: randomUUID(), userId, status: "active", expiresAt: new Date(base.getTime() + input.passDays * 86_400_000), llmQuotaLimit: 0, llmQuotaUsed: 0, updatedAt: input.now } }) as EntitlementRecord; }
export async function settlePaidOrder(prisma: PrismaClient, input: Input): ReturnType<Store["settlePaidOrder"]> {
  const result = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    const event = await tx.webhookEvent.findUnique({ where: { provider_eventId: { provider: input.provider, eventId: input.eventId } } });
    if (event?.outTradeNo !== undefined && event.outTradeNo !== input.outTradeNo) return { status: "webhook_order_mismatch" } as const;
    if (event && event.payload !== payload(input)) return { status: "webhook_payload_conflict" } as const;
    const order = await tx.order.findUnique({ where: { outTradeNo: input.outTradeNo } }); if (!order) return { status: "order_not_found" } as const;
    const reusedTransaction = await tx.order.findFirst({ where: { transactionId: input.transactionId, id: { not: order.id } } }); if (reusedTransaction) return { status: "transaction_mismatch" } as const;
    if (order.status === "paid") {
      if (order.transactionId !== input.transactionId) return { status: "transaction_mismatch" } as const;
      const entitlement = await tx.entitlement.findUnique({ where: { userId: order.userId } });
      if (entitlement) { if (!event) await tx.webhookEvent.create({ data: { id: randomUUID(), provider: input.provider, eventId: input.eventId, outTradeNo: input.outTradeNo, payload: payload(input), createdAt: input.now } }); return { status: "settled", entitlement: entitlement as EntitlementRecord } as const; }
      if (!event) return { status: "order_state_conflict" } as const;
      return { status: "settled", entitlement: await grant(tx, order.userId, input) } as const;
    }
    if (order.status !== "pending" || order.transactionId || order.paidAt) return { status: "order_state_conflict" } as const;
    if (!event) await tx.webhookEvent.create({ data: { id: randomUUID(), provider: input.provider, eventId: input.eventId, outTradeNo: input.outTradeNo, payload: payload(input), createdAt: input.now } });
    try { await tx.order.update({ where: { id: order.id }, data: { status: "paid", transactionId: input.transactionId, paidAt: input.paidAt } }); } catch (error) { if (isUnique(error)) return { status: "transaction_mismatch" } as const; throw error; }
    return { status: "settled", entitlement: await grant(tx, order.userId, input) } as const;
  }));
  return result;
}
