import { describe, expect, test } from "vitest";
import { MemoryStore } from "../src/store.js";

const now = new Date("2026-08-08T08:00:00.000Z");
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds);

async function createUserSession(store: MemoryStore, email: string, tokenHash: string) {
  const user = await store.upsertUserByEmail(email, now);
  const session = await store.createSession({
    userId: user.id, tokenHash, createdAt: now, expiresAt: later(86_400_000),
  });
  return { user, session };
}

describe("MemoryStore semantic transaction safety", () => {
  test("does not erase a successful concurrent write when a compound transaction rolls back", async () => {
    let idCalls = 0;
    let transactionEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => { transactionEntered = resolve; });
    const store = new MemoryStore({
      createId: () => {
        idCalls += 1;
        if (idCalls === 6) transactionEntered();
        if (idCalls === 8) throw new Error("injected compound write failure");
        return `concurrent-id-${idCalls}`;
      },
    });
    const persistentUser = await store.upsertUserByEmail("persistent@studymind.local", now);
    await store.issueEmailOtp({
      purpose: "desktop_login", email: "failing-transaction@studymind.local", state: "failing-state",
      codeHash: "sha256:failing-otp", ip: "127.0.0.1", expiresAt: later(600_000), createdAt: now,
    });

    const failingTransaction = store.verifyDesktopOtpAndCreateTicketAndWebSession({
      email: "failing-transaction@studymind.local", state: "failing-state",
      codeHash: "sha256:failing-otp", ticketHash: "sha256:failing-ticket",
      sessionTokenHash: "sha256:failing-web-session", csrfTokenHash: "sha256:failing-csrf",
      now: later(1_000), ticketExpiresAt: later(60_000), sessionExpiresAt: later(86_400_000),
    });
    await entered;
    const durableSession = await store.createSession({
      userId: persistentUser.id, tokenHash: "sha256:durable-session",
      createdAt: later(1_000), expiresAt: later(86_400_000),
    });
    await expect(failingTransaction).rejects.toThrow("injected compound write failure");

    expect(await store.findSessionByTokenHash(durableSession.tokenHash, later(2_000))).toMatchObject({
      id: durableSession.id,
    });
    expect(store.users).toHaveLength(1);
    expect(store.desktopLoginTickets).toHaveLength(0);
    await expect(store.createOrder({
      userId: persistentUser.id, outTradeNo: "after-rollback-order", amountFen: 990,
      status: "pending", codeUrl: "weixin://after-rollback-order", expiresAt: later(1_800_000),
      createdAt: later(2_000), providerPayload: "{}",
    })).resolves.toMatchObject({ outTradeNo: "after-rollback-order" });
  });

  test("detaches records carried by compound semantic results", async () => {
    const quotaStore = new MemoryStore();
    const quotaUser = await quotaStore.upsertUserByEmail("compound-quota@studymind.local", now);
    await quotaStore.upsertEntitlement(quotaUser.id, later(86_400_000), now, {
      llmQuotaLimit: 2,
      llmQuotaUsed: 0,
    });
    const checkout = await quotaStore.consumeLlmQuota(quotaUser.id, "compound-request", now);
    expect(checkout.status).toBe("consumed");
    if (checkout.status !== "consumed") throw new Error("expected consumed checkout");
    checkout.entitlement.llmQuotaUsed = 999;
    checkout.entitlement.expiresAt.setUTCFullYear(1988);
    expect(await quotaStore.getEntitlement(quotaUser.id)).toMatchObject({
      llmQuotaUsed: 1,
      expiresAt: later(86_400_000),
    });

    const redemptionStore = new MemoryStore();
    const { user: redemptionUser, session } = await createUserSession(
      redemptionStore,
      "compound-redemption@studymind.local",
      "sha256:compound-redemption-session",
    );
    await redemptionStore.createActivationCode({
      codeHash: "sha256:compound-code", codePrefix: "SM-CMP", status: "active",
      entitlementDays: 30, redeemBy: later(86_400_000), createdAt: now,
      redeemedAt: null, redeemedByUserId: null,
    });
    const redemption = await redemptionStore.redeemActivationCodeAndGrantEntitlement({
      sessionTokenHash: session.tokenHash, codeHash: "sha256:compound-code",
      now, llmQuotaPerActivation: 20,
    });
    expect(redemption.status).toBe("redeemed");
    if (redemption.status !== "redeemed") throw new Error("expected redeemed result");
    redemption.entitlement.llmQuotaLimit = 999;
    expect(await redemptionStore.getEntitlement(redemptionUser.id)).toMatchObject({ llmQuotaLimit: 20 });

    const billingStore = new MemoryStore();
    const billingUser = await billingStore.upsertUserByEmail("compound-billing@studymind.local", now);
    await billingStore.createOrder({
      userId: billingUser.id, outTradeNo: "compound-order", amountFen: 990, status: "pending",
      codeUrl: "weixin://compound-order", expiresAt: later(1_800_000), createdAt: now,
      providerPayload: "{}",
    });
    const settlement = await billingStore.settlePaidOrder({
      provider: "wechat", eventId: "compound-event", outTradeNo: "compound-order",
      transactionId: "compound-transaction", paidAt: later(300_000), now: later(300_000), passDays: 30,
    });
    expect(settlement.status).toBe("settled");
    if (settlement.status !== "settled") throw new Error("expected settled result");
    settlement.entitlement.expiresAt.setUTCFullYear(1987);
    expect((await billingStore.getEntitlement(billingUser.id))!.expiresAt.getUTCFullYear()).toBe(2026);

    const adjustmentStore = new MemoryStore();
    const adjustmentUser = await adjustmentStore.upsertUserByEmail("compound-adjustment@studymind.local", now);
    const adjustment = await adjustmentStore.applyEntitlementAdjustmentWithAudit({
      adminEmail: "admin@studymind.local", userId: adjustmentUser.id, reason: "learning_support",
      note: null, extendDays: 7, quotaAdd: 5, now,
    });
    expect(adjustment.status).toBe("applied");
    if (adjustment.status !== "applied") throw new Error("expected applied adjustment");
    adjustment.entitlement.llmQuotaLimit = 999;
    adjustment.adjustment.reason = "attacker-reason";
    expect(await adjustmentStore.getEntitlement(adjustmentUser.id)).toMatchObject({ llmQuotaLimit: 5 });
    expect(await adjustmentStore.listAdminEntitlementAdjustments()).toMatchObject([
      { reason: "learning_support" },
    ]);
  });

  test("creates ticket and web session atomically while verifying a desktop OTP", async () => {
    const store = new MemoryStore();
    await store.issueEmailOtp({
      purpose: "desktop_login", email: "atomic-login@studymind.local", state: "atomic-state",
      codeHash: "sha256:otp", ip: "127.0.0.1", expiresAt: later(600_000), createdAt: now,
    });
    const result = await store.verifyDesktopOtpAndCreateTicketAndWebSession({
      email: "atomic-login@studymind.local", state: "atomic-state", codeHash: "sha256:otp",
      ticketHash: "sha256:ticket", sessionTokenHash: "sha256:web-session",
      csrfTokenHash: "sha256:csrf", now: later(1_000), ticketExpiresAt: later(60_000),
      sessionExpiresAt: later(86_400_000),
    });
    expect(result.status).toBe("verified");
    expect(store.desktopLoginTickets).toHaveLength(1);
    expect(store.userSessions).toHaveLength(1);
    expect(store.desktopLoginTickets[0]?.userId).toBe(store.userSessions[0]?.userId);
  });

  test("rolls back OTP, user, ticket, and web session when desktop verification fails midway", async () => {
    let idCalls = 0;
    const store = new MemoryStore({
      createId: () => {
        idCalls += 1;
        if (idCalls === 7) throw new Error("injected web session write failure");
        return `study-id-${idCalls}`;
      },
    });
    await store.issueEmailOtp({
      purpose: "desktop_login", email: "rollback-login@studymind.local", state: "rollback-state",
      codeHash: "sha256:otp", ip: "127.0.0.1", expiresAt: later(600_000), createdAt: now,
    });

    await expect(store.verifyDesktopOtpAndCreateTicketAndWebSession({
      email: "rollback-login@studymind.local", state: "rollback-state", codeHash: "sha256:otp",
      ticketHash: "sha256:ticket", sessionTokenHash: "sha256:web-session",
      csrfTokenHash: "sha256:csrf", now: later(1_000), ticketExpiresAt: later(60_000),
      sessionExpiresAt: later(86_400_000),
    })).rejects.toThrow("injected web session write failure");

    expect(store.users).toHaveLength(0);
    expect(store.desktopLoginTickets).toHaveLength(0);
    expect(store.userSessions).toHaveLength(0);
    expect(store.emailOtps[0]).toMatchObject({ attempts: 0, consumedAt: null });
  });

  test("creates a desktop session while consuming its ticket atomically", async () => {
    const store = new MemoryStore();
    await store.issueEmailOtp({
      purpose: "desktop_login", email: "exchange@studymind.local", state: "exchange-state",
      codeHash: "sha256:otp", ip: "127.0.0.1", expiresAt: later(600_000), createdAt: now,
    });
    await store.verifyDesktopOtpAndCreateTicket({
      email: "exchange@studymind.local", state: "exchange-state", codeHash: "sha256:otp",
      ticketHash: "sha256:ticket", now: later(1_000), ticketExpiresAt: later(60_000),
    });
    const results = await Promise.all([
      store.exchangeDesktopTicketAndCreateSession({
        ticketHash: "sha256:ticket", state: "exchange-state", sessionTokenHash: "sha256:first",
        now: later(2_000), sessionExpiresAt: later(86_400_000),
      }),
      store.exchangeDesktopTicketAndCreateSession({
        ticketHash: "sha256:ticket", state: "exchange-state", sessionTokenHash: "sha256:second",
        now: later(2_000), sessionExpiresAt: later(86_400_000),
      }),
    ]);
    expect(results.filter(({ status }) => status === "exchanged")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "invalid")).toHaveLength(1);
    expect(store.sessions).toHaveLength(1);
  });

  test("permits only one concurrent checkout of the final LLM credit", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUserByEmail("last-credit@studymind.local", now);
    await store.upsertEntitlement(user.id, later(86_400_000), now, { llmQuotaLimit: 1, llmQuotaUsed: 0 });
    const results = await Promise.all([
      store.consumeLlmQuota(user.id, "request-a", now),
      store.consumeLlmQuota(user.id, "request-b", now),
    ]);
    expect(results.filter(({ status }) => status === "consumed")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "unavailable")).toHaveLength(1);
    expect(store.llmUsageEvents).toHaveLength(1);
    expect(store.entitlements[0]?.llmQuotaUsed).toBe(1);
  });

  test("redeems an activation code only once", async () => {
    const store = new MemoryStore();
    const { user, session } = await createUserSession(
      store, "activation@studymind.local", "sha256:activation-session",
    );
    await store.createActivationCode({
      codeHash: "sha256:activation", codePrefix: "SM-ACT", status: "active", entitlementDays: 30,
      redeemBy: later(86_400_000), createdAt: now, redeemedAt: null, redeemedByUserId: null,
    });
    const results = await Promise.all([
      store.redeemActivationCodeAndGrantEntitlement({
        sessionTokenHash: session.tokenHash, codeHash: "sha256:activation", now, llmQuotaPerActivation: 20,
      }),
      store.redeemActivationCodeAndGrantEntitlement({
        sessionTokenHash: session.tokenHash, codeHash: "sha256:activation", now, llmQuotaPerActivation: 20,
      }),
    ]);
    expect(results.filter(({ status }) => status === "redeemed")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "code_invalid")).toHaveLength(1);
    expect(store.activationCodes[0]).toMatchObject({ status: "redeemed", redeemedByUserId: user.id });
    expect(await store.getEntitlement(user.id)).toMatchObject({ llmQuotaLimit: 20, llmQuotaUsed: 0 });
  });

  test("treats an identical webhook replay as idempotent and rejects a conflicting replay", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUserByEmail("billing@studymind.local", now);
    const order = await store.createOrder({
      userId: user.id, outTradeNo: "studymind-order-1", amountFen: 990, status: "pending",
      codeUrl: "weixin://studymind-order-1", expiresAt: later(1_800_000), createdAt: now,
      providerPayload: "{}",
    });
    const input = {
      provider: "wechat", eventId: "studymind-event-1", outTradeNo: order.outTradeNo,
      transactionId: "wechat-transaction-1", paidAt: later(300_000), now: later(300_000), passDays: 30,
    };
    expect((await store.settlePaidOrder(input)).status).toBe("settled");
    const expiry = store.entitlements[0]?.expiresAt;
    expect((await store.settlePaidOrder(input)).status).toBe("settled");
    expect(store.webhookEvents).toHaveLength(1);
    expect(store.entitlements[0]?.expiresAt).toEqual(expiry);
    expect((await store.settlePaidOrder({ ...input, transactionId: "wechat-conflict" })).status)
      .toBe("webhook_payload_conflict");
  });

  test("rejects a webhook replay whose paidAt differs without changing settled state", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUserByEmail("payload-replay@studymind.local", now);
    const order = await store.createOrder({
      userId: user.id, outTradeNo: "studymind-order-payload", amountFen: 990, status: "pending",
      codeUrl: "weixin://studymind-order-payload", expiresAt: later(1_800_000), createdAt: now,
      providerPayload: "{}",
    });
    const input = {
      provider: "wechat", eventId: "studymind-event-payload", outTradeNo: order.outTradeNo,
      transactionId: "wechat-transaction-payload", paidAt: later(300_000), now: later(300_000), passDays: 30,
    };
    expect((await store.settlePaidOrder(input)).status).toBe("settled");
    const originalOrder = structuredClone(store.orders[0]);
    const originalEntitlement = structuredClone(store.entitlements[0]);
    const replay = await store.settlePaidOrder({ ...input, paidAt: later(301_000), now: later(301_000) });

    expect(replay.status).toBe("webhook_payload_conflict");
    expect(store.webhookEvents).toHaveLength(1);
    expect(store.orders[0]).toEqual(originalOrder);
    expect(store.entitlements[0]).toEqual(originalEntitlement);
  });

  test("atomically claims every accepted webhook event ID for a paid order", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUserByEmail("event-claim@studymind.local", now);
    await store.createOrder({
      userId: user.id, outTradeNo: "event-claim-paid", amountFen: 990, status: "pending",
      codeUrl: "weixin://event-claim-paid", expiresAt: later(1_800_000), createdAt: now,
      providerPayload: "{}",
    });
    await store.createOrder({
      userId: user.id, outTradeNo: "event-claim-pending", amountFen: 990, status: "pending",
      codeUrl: "weixin://event-claim-pending", expiresAt: later(1_800_000), createdAt: now,
      providerPayload: "{}",
    });
    const first = {
      provider: "wechat", eventId: "event-claim-1", outTradeNo: "event-claim-paid",
      transactionId: "event-claim-transaction", paidAt: later(300_000), now: later(300_000), passDays: 30,
    };
    const second = { ...first, eventId: "event-claim-2" };
    expect((await store.settlePaidOrder(first)).status).toBe("settled");
    expect((await store.settlePaidOrder(second)).status).toBe("settled");
    expect((await store.settlePaidOrder(second)).status).toBe("settled");
    expect(store.webhookEvents).toHaveLength(2);

    const conflict = await store.settlePaidOrder({ ...second, outTradeNo: "event-claim-pending" });
    expect(conflict.status).toBe("webhook_order_mismatch");
    expect(await store.findOrderByOutTradeNo("event-claim-pending")).toMatchObject({ status: "pending" });
    expect(store.webhookEvents).toHaveLength(2);
  });

  test("enforces schema unique constraints for direct and semantic writes", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUserByEmail("unique@studymind.local", now);
    const orderInput = {
      userId: user.id, outTradeNo: "unique-order", amountFen: 990, status: "pending" as const,
      codeUrl: "weixin://unique-order", expiresAt: later(1_800_000), createdAt: now,
      providerPayload: "{}",
    };
    await store.createOrder(orderInput);
    await expect(store.createOrder(orderInput)).rejects.toMatchObject({
      name: "StoreConflictError", constraint: "Order.outTradeNo",
    });

    await store.createSession({
      userId: user.id, tokenHash: "sha256:unique-session", createdAt: now,
      expiresAt: later(86_400_000),
    });
    await expect(store.createSession({
      userId: user.id, tokenHash: "sha256:unique-session", createdAt: now,
      expiresAt: later(86_400_000),
    })).rejects.toMatchObject({ name: "StoreConflictError", constraint: "Session.tokenHash" });

    const activationInput = {
      codeHash: "sha256:unique-activation", codePrefix: "SM-UNI", status: "active" as const,
      entitlementDays: 30, redeemBy: later(86_400_000), createdAt: now,
      redeemedAt: null, redeemedByUserId: null,
    };
    await store.createActivationCode(activationInput);
    await expect(store.createActivationCode(activationInput)).rejects.toMatchObject({
      name: "StoreConflictError", constraint: "ActivationCode.codeHash",
    });

    await store.issueEmailOtp({
      purpose: "desktop_login", email: "ticket-one@studymind.local", state: "ticket-one",
      codeHash: "sha256:ticket-one-otp", ip: "127.0.0.2", expiresAt: later(600_000), createdAt: now,
    });
    await store.issueEmailOtp({
      purpose: "desktop_login", email: "ticket-two@studymind.local", state: "ticket-two",
      codeHash: "sha256:ticket-two-otp", ip: "127.0.0.3", expiresAt: later(600_000), createdAt: now,
    });
    expect((await store.verifyDesktopOtpAndCreateTicket({
      email: "ticket-one@studymind.local", state: "ticket-one", codeHash: "sha256:ticket-one-otp",
      ticketHash: "sha256:unique-ticket", now: later(1_000), ticketExpiresAt: later(60_000),
    })).status).toBe("verified");
    expect((await store.verifyDesktopOtpAndCreateTicket({
      email: "ticket-two@studymind.local", state: "ticket-two", codeHash: "sha256:ticket-two-otp",
      ticketHash: "sha256:unique-ticket", now: later(1_000), ticketExpiresAt: later(60_000),
    })).status).toBe("temporarily_unavailable");

    await store.createOrder({ ...orderInput, outTradeNo: "unique-payment-one" });
    await store.createOrder({ ...orderInput, outTradeNo: "unique-payment-two" });
    expect((await store.settlePaidOrder({
      provider: "wechat", eventId: "unique-payment-event-one", outTradeNo: "unique-payment-one",
      transactionId: "unique-payment-transaction", paidAt: later(300_000), now: later(300_000), passDays: 30,
    })).status).toBe("settled");
    expect((await store.settlePaidOrder({
      provider: "wechat", eventId: "unique-payment-event-two", outTradeNo: "unique-payment-two",
      transactionId: "unique-payment-transaction", paidAt: later(300_000), now: later(300_000), passDays: 30,
    })).status).toBe("transaction_mismatch");
    expect(await store.findOrderByOutTradeNo("unique-payment-two")).toMatchObject({ status: "pending" });
  });


  test("applies an administrator entitlement adjustment with its audit record", async () => {
    const store = new MemoryStore();
    const user = await store.upsertUserByEmail("adjustment@studymind.local", now);
    const result = await store.applyEntitlementAdjustmentWithAudit({
      adminEmail: "admin@studymind.local", userId: user.id, reason: "learning_support",
      note: "grant study credits", extendDays: 7, quotaAdd: 5, now,
    });
    expect(result.status).toBe("applied");
    expect(store.entitlements).toHaveLength(1);
    expect(store.adminEntitlementAdjustments).toHaveLength(1);
    expect(store.adminEntitlementAdjustments[0]).toMatchObject({
      userId: user.id, beforeLlmQuotaLimit: 0, afterLlmQuotaLimit: 5,
    });
  });

  test("rolls back entitlement creation when administrator audit creation fails", async () => {
    let idCalls = 0;
    const store = new MemoryStore({
      createId: () => {
        idCalls += 1;
        if (idCalls === 3) throw new Error("injected audit write failure");
        return `adjustment-id-${idCalls}`;
      },
    });
    const user = await store.upsertUserByEmail("rollback-adjustment@studymind.local", now);
    await expect(store.applyEntitlementAdjustmentWithAudit({
      adminEmail: "admin@studymind.local", userId: user.id, reason: "learning_support",
      note: null, extendDays: 7, quotaAdd: 5, now,
    })).rejects.toThrow("injected audit write failure");

    expect(await store.getEntitlement(user.id)).toBeNull();
    expect(store.entitlements).toHaveLength(0);
    expect(store.adminEntitlementAdjustments).toHaveLength(0);
  });
});
