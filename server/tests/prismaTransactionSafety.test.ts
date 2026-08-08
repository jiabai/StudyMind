import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { PrismaStore } from "../src/prismaStore.js";
import { StoreOperationError, withConflictRetry } from "../src/prismaStore/concurrency.js";
import { createPrismaTestHarness } from "./prismaTestHarness.js";

const now = new Date("2026-08-08T08:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("PrismaStore transaction safety", () => {
  async function expectSanitized(operation: Promise<unknown>): Promise<void> {
    try {
      await operation;
      throw new Error("expected store operation to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreOperationError);
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect(error).toMatchObject({ name: "StoreOperationError", message: "Store operation failed." });
      expect(String((error as Error).message)).not.toMatch(/Prisma|SQLite|connector|CHECK|prismaStore|[A-Z]:\\/i);
      expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
    }
  }

  test("routes all thirty-three public facade methods through one call boundary", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/prismaStore.ts"), "utf8");
    const publicMethods = [...source.matchAll(/^  (?!constructor|private)([a-zA-Z][a-zA-Z0-9]*)\([^\n]+\{ return [^\n]+$/gm)];
    expect(publicMethods.map((match) => match[1])).toHaveLength(33);
    expect(publicMethods.every((match) => match[0].includes("return this.call("))).toBe(true);
  });

  test("sanitizes database failures from every module while preserving conflicts and programmer errors", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      await expectSanitized(store.createSession({ userId: "missing-auth-user", tokenHash: "auth-fk", createdAt: now, expiresAt: later(60_000) }));
      await expectSanitized(store.createUserSession({ userId: "missing-web-user", email: "missing@studymind.local", tokenHash: "web-fk", csrfTokenHash: "csrf", createdAt: now, expiresAt: later(60_000) }));
      await expectSanitized(store.upsertEntitlement("missing-entitlement-user", later(60_000), now));
      await expectSanitized(store.createOrder({ userId: "missing-order-user", outTradeNo: "billing-fk", amountFen: 1, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" }));
      await fixture.prisma.$executeRawUnsafe('CREATE TRIGGER "reject_llm_config" BEFORE INSERT ON "LlmConfig" BEGIN SELECT RAISE(ABORT, \'CHECK SQLite connector source path\'); END');
      await expectSanitized(store.upsertLlmConfig({ provider: "test", baseUrl: "https://llm.invalid", model: "test", encryptedApiKey: "cipher", apiKeyLast4: "last", timeoutSeconds: 1 }, now));

      const user = await store.upsertUserByEmail("stable-conflict@studymind.local", now);
      const order = { userId: user.id, outTradeNo: "stable-conflict", amountFen: 1, status: "pending" as const, codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" };
      await store.createOrder(order);
      await expect(store.createOrder(order)).rejects.toMatchObject({ name: "StoreConflictError", constraint: "Order.outTradeNo" });

      const programmerError = new Error("programmer invariant failed");
      const fakeClient = new Proxy(fixture.prisma, {
        get(target, property, receiver) {
          if (property === "user") return { findUnique: async () => { throw programmerError; } };
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PrismaClient;
      await expect(new PrismaStore(fakeClient).getUserById("irrelevant")).rejects.toBe(programmerError);
    } finally { await fixture.close(); }
  });

  test("retries recognized conflicts exactly three times then throws a domain error", async () => {
    let attempts = 0;
    const operation = withConflictRetry(async () => {
      attempts += 1;
      throw new Prisma.PrismaClientKnownRequestError("database is locked", { code: "P2034", clientVersion: "6.19.3" });
    });
    await expectSanitized(operation);
    expect(attempts).toBe(3);
  });
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
      expect(await fixture.prisma.webhookEvent.findFirst()).toMatchObject({ payload: JSON.stringify({ outTradeNo: "order-1", transactionId: "transaction-1", paidAt: later(1_000).toISOString() }) });
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
  test("uses event-first canonical replay semantics independent of passDays and order existence", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const user = await store.upsertUserByEmail("event-first@studymind.local", now);
      await store.createOrder({ userId: user.id, outTradeNo: "event-order", amountFen: 1, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" });
      const event = { provider: "wechat", eventId: "event-first", outTradeNo: "event-order", transactionId: "event-first-tx", paidAt: later(1_000), now: later(1_000), passDays: 30 };
      expect((await store.settlePaidOrder(event)).status).toBe("settled");
      expect((await store.settlePaidOrder({ ...event, passDays: 99 })).status).toBe("settled");
      expect((await store.settlePaidOrder({ ...event, outTradeNo: "missing-order" })).status).toBe("webhook_order_mismatch");
      expect(await fixture.prisma.webhookEvent.count()).toBe(1);
      expect((await fixture.prisma.webhookEvent.findFirstOrThrow()).payload).toBe(JSON.stringify({ outTradeNo: event.outTradeNo, transactionId: event.transactionId, paidAt: event.paidAt.toISOString() }));
    } finally { await fixture.close(); }
  });

  test("settles a pending order from a preclaimed matching canonical event without duplicating it", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const user = await store.upsertUserByEmail("preclaimed@studymind.local", now);
      await store.createOrder({ userId: user.id, outTradeNo: "preclaimed-order", amountFen: 1, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" });
      const input = { provider: "wechat", eventId: "preclaimed-event", outTradeNo: "preclaimed-order", transactionId: "preclaimed-tx", paidAt: later(1_000), now: later(1_000), passDays: 30 };
      await fixture.prisma.webhookEvent.create({ data: { id: "preclaimed-row", provider: input.provider, eventId: input.eventId, outTradeNo: input.outTradeNo, payload: JSON.stringify({ outTradeNo: input.outTradeNo, transactionId: input.transactionId, paidAt: input.paidAt.toISOString() }), createdAt: input.now } });

      await expect(store.settlePaidOrder(input)).resolves.toMatchObject({ status: "settled" });
      await expect(store.findOrderByOutTradeNo(input.outTradeNo)).resolves.toMatchObject({ status: "paid", transactionId: input.transactionId });
      expect(await fixture.prisma.webhookEvent.count()).toBe(1);
      expect(await fixture.prisma.entitlement.count({ where: { userId: user.id } })).toBe(1);

      await fixture.prisma.order.update({ where: { outTradeNo: input.outTradeNo }, data: { status: "pending", transactionId: null, paidAt: null } });
      const mismatch = await store.settlePaidOrder({ ...input, transactionId: "different-tx" });
      expect(mismatch.status).toBe("webhook_payload_conflict");
      await expect(store.findOrderByOutTradeNo(input.outTradeNo)).resolves.toMatchObject({ status: "pending", transactionId: null });
    } finally { await fixture.close(); }
  });

  test("claims a new event for a paid entitled order but not for a paid order without entitlement", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const entitled = await store.upsertUserByEmail("paid-entitled@studymind.local", now);
      await store.createOrder({ userId: entitled.id, outTradeNo: "paid-entitled", amountFen: 1, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" });
      await store.settlePaidOrder({ provider: "wechat", eventId: "original", outTradeNo: "paid-entitled", transactionId: "paid-tx", paidAt: now, now, passDays: 1 });
      expect((await store.settlePaidOrder({ provider: "wechat", eventId: "new-accepted", outTradeNo: "paid-entitled", transactionId: "paid-tx", paidAt: now, now, passDays: 1 })).status).toBe("settled");
      expect(await fixture.prisma.webhookEvent.count({ where: { eventId: "new-accepted" } })).toBe(1);

      const bare = await store.upsertUserByEmail("paid-bare@studymind.local", now);
      await store.createOrder({ userId: bare.id, outTradeNo: "paid-bare", amountFen: 1, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" });
      await fixture.prisma.order.update({ where: { outTradeNo: "paid-bare" }, data: { status: "paid", transactionId: "bare-tx", paidAt: now } });
      expect((await store.settlePaidOrder({ provider: "wechat", eventId: "must-not-claim", outTradeNo: "paid-bare", transactionId: "bare-tx", paidAt: now, now, passDays: 1 })).status).toBe("order_state_conflict");
      expect(await fixture.prisma.webhookEvent.count({ where: { eventId: "must-not-claim" } })).toBe(0);
    } finally { await fixture.close(); }
  });

  test("rolls back activation and admin writes on real constraint failures without leaking Prisma details", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const user = await store.upsertUserByEmail("rollback-domain@studymind.local", now);
      await store.createSession({ userId: user.id, tokenHash: "rollback-session", createdAt: now, expiresAt: later(60_000) });
      await store.createActivationCode({ codeHash: "rollback-code", codePrefix: "SM", status: "active", entitlementDays: 1, redeemBy: later(60_000), createdAt: now, redeemedAt: null, redeemedByUserId: null });
      const activation = store.redeemActivationCodeAndGrantEntitlement({ sessionTokenHash: "rollback-session", codeHash: "rollback-code", now, llmQuotaPerActivation: -1 });
      await expect(activation).rejects.not.toThrow(/Prisma|constraint|SQLite/i);
      await expect(fixture.prisma.activationCode.findUnique({ where: { codeHash: "rollback-code" } })).resolves.toMatchObject({ status: "active", redeemedAt: null });
      expect(await fixture.prisma.entitlement.count()).toBe(0);

      await store.upsertEntitlement(user.id, later(60_000), now, { llmQuotaLimit: 1, llmQuotaUsed: 1 });
      const adjustment = store.applyEntitlementAdjustmentWithAudit({ adminEmail: "admin@studymind.local", userId: user.id, reason: "bad", note: null, extendDays: 1, quotaAdd: -1, now });
      await expect(adjustment).rejects.not.toThrow(/Prisma|constraint|SQLite/i);
      await expect(store.getEntitlement(user.id)).resolves.toMatchObject({ llmQuotaLimit: 1, llmQuotaUsed: 1 });
      expect(await fixture.prisma.adminEntitlementAdjustment.count()).toBe(0);
    } finally { await fixture.close(); }
  });

  test("rolls back payment event and order when entitlement persistence fails", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const user = await store.upsertUserByEmail("payment-rollback@studymind.local", now);
      await store.createOrder({ userId: user.id, outTradeNo: "payment-rollback", amountFen: 1, status: "pending", codeUrl: "pay", expiresAt: later(60_000), createdAt: now, providerPayload: "{}" });
      const operation = store.settlePaidOrder({ provider: "wechat", eventId: "payment-rollback-event", outTradeNo: "payment-rollback", transactionId: "payment-rollback-tx", paidAt: now, now, passDays: Number.MAX_VALUE });
      await expect(operation).rejects.not.toThrow(/Prisma|SQLite|Invalid.*invocation/i);
      await expect(store.findOrderByOutTradeNo("payment-rollback")).resolves.toMatchObject({ status: "pending", transactionId: null, paidAt: null });
      expect(await fixture.prisma.webhookEvent.count({ where: { eventId: "payment-rollback-event" } })).toBe(0);
      expect(await fixture.prisma.entitlement.count({ where: { userId: user.id } })).toBe(0);
    } finally { await fixture.close(); }
  });
});
