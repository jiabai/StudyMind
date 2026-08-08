import { describe, expect, test } from "vitest";
import { PrismaStore } from "../src/prismaStore.js";
import { createPrismaTestHarness } from "./prismaTestHarness.js";

const now = new Date("2026-08-08T08:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("PrismaStore transaction safety", () => {
  test("redeems an activation once and writes entitlement atomically", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const first = new PrismaStore(fixture.prisma);
      const second = new PrismaStore(await fixture.createClient());
      const user = await first.upsertUserByEmail("redeem@studymind.local", now);
      await first.createSession({ userId: user.id, tokenHash: "session", createdAt: now, expiresAt: later(60_000) });
      await first.createActivationCode({ codeHash: "code", codePrefix: "SM", status: "active", entitlementDays: 30, redeemBy: later(60_000), createdAt: now, redeemedAt: null, redeemedByUserId: null });
      const results = await Promise.all([
        first.redeemActivationCodeAndGrantEntitlement({ sessionTokenHash: "session", codeHash: "code", now, llmQuotaPerActivation: 5 }),
        second.redeemActivationCodeAndGrantEntitlement({ sessionTokenHash: "session", codeHash: "code", now, llmQuotaPerActivation: 5 }),
      ]);
      expect(results.filter((value) => value.status === "redeemed")).toHaveLength(1);
      expect(results.filter((value) => value.status === "code_invalid")).toHaveLength(1);
      expect(await fixture.prisma.activationCode.count({ where: { status: "redeemed", redeemedByUserId: user.id } })).toBe(1);
      expect(await fixture.prisma.entitlement.count()).toBe(1);
    } finally { await fixture.close(); }
  }, 30_000);

  test("applies admin adjustment with audit and settles canonical webhook payload", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const user = await store.upsertUserByEmail("billing@studymind.local", now);
      const adjusted = await store.applyEntitlementAdjustmentWithAudit({ adminEmail: "admin@studymind.local", userId: user.id, reason: "support", note: null, extendDays: 1, quotaAdd: 2, now });
      expect(adjusted.status).toBe("applied");
      expect(await fixture.prisma.adminEntitlementAdjustment.count()).toBe(1);
      await store.createOrder({ userId: user.id, outTradeNo: "order-1", amountFen: 990, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" });
      const settlement = { provider: "wechat", eventId: "event-1", outTradeNo: "order-1", transactionId: "transaction-1", paidAt: later(1_000), now: later(1_000), passDays: 30 };
      expect((await store.settlePaidOrder(settlement)).status).toBe("settled");
      expect((await store.settlePaidOrder(settlement)).status).toBe("settled");
      expect(await fixture.prisma.webhookEvent.findFirst()).toMatchObject({ payload: JSON.stringify({ outTradeNo: "order-1", transactionId: "transaction-1", paidAt: later(1_000).toISOString(), passDays: 30 }) });
      expect((await store.settlePaidOrder({ ...settlement, paidAt: later(2_000) })).status).toBe("webhook_payload_conflict");
    } finally { await fixture.close(); }
  }, 30_000);

  test("does not settle two orders with one payment transaction", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const user = await store.upsertUserByEmail("tx@studymind.local", now);
      for (const value of ["one", "two"]) await store.createOrder({ userId: user.id, outTradeNo: value, amountFen: 1, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" });
      expect((await store.settlePaidOrder({ provider: "wechat", eventId: "e1", outTradeNo: "one", transactionId: "same", paidAt: now, now, passDays: 1 })).status).toBe("settled");
      expect((await store.settlePaidOrder({ provider: "wechat", eventId: "e2", outTradeNo: "two", transactionId: "same", paidAt: now, now, passDays: 1 })).status).toBe("transaction_mismatch");
      expect(await store.findOrderByOutTradeNo("two")).toMatchObject({ status: "pending" });
    } finally { await fixture.close(); }
  }, 30_000);
});
