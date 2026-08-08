import { describe, expect, test } from "vitest";
import { MemoryStore as DefiningMemoryStore } from "../src/store/memory.js";
import {
  MemoryStore as PublicMemoryStore,
  type EntitlementRecord,
  type LlmConfigRecord,
  type Store,
} from "../src/store.js";

const now = new Date("2026-08-08T08:00:00.000Z");
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds);

const storeMethods = [
  "upsertUserByEmail",
  "getUserById",
  "issueEmailOtp",
  "invalidateIssuedOtpAfterDeliveryFailure",
  "verifyDesktopOtpAndCreateTicket",
  "verifyDesktopOtpAndCreateTicketAndWebSession",
  "verifyAdminOtpAndCreateSession",
  "verifyUserOtpAndCreateWebSession",
  "exchangeDesktopTicketAndCreateSession",
  "createSession",
  "findSessionByTokenHash",
  "revokeSession",
  "createOrder",
  "findOrderByOutTradeNo",
  "settlePaidOrder",
  "getEntitlement",
  "upsertEntitlement",
  "consumeLlmQuota",
  "getLlmConfig",
  "upsertLlmConfig",
  "createActivationCode",
  "findActivationCodeByHash",
  "redeemActivationCodeAndGrantEntitlement",
  "listActivationCodes",
  "listUsers",
  "createAdminSession",
  "findAdminSessionByTokenHash",
  "revokeAdminSession",
  "createUserSession",
  "findUserSessionByTokenHash",
  "revokeUserSession",
  "applyEntitlementAdjustmentWithAudit",
  "listAdminEntitlementAdjustments",
] as const satisfies readonly (keyof Store)[];

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type ExactStoreSurface = Assert<Equal<keyof Store, (typeof storeMethods)[number]>>;
const exactStoreSurface: ExactStoreSurface = true;

async function issueOtp(
  store: PublicMemoryStore,
  purpose: "desktop_login" | "admin_login",
  overrides: Partial<{ email: string; state: string; codeHash: string; createdAt: Date }> = {},
) {
  const createdAt = overrides.createdAt ?? now;
  return store.issueEmailOtp({
    purpose,
    email: overrides.email ?? "student@studymind.local",
    state: overrides.state ?? "study-state",
    codeHash: overrides.codeHash ?? "sha256:otp-code",
    ip: "127.0.0.1",
    expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
    createdAt,
  });
}

describe("StudyMind Store compatibility", () => {
  test("exports one exact semantic Store surface", () => {
    expect(exactStoreSurface).toBe(true);
    expect(PublicMemoryStore).toBe(DefiningMemoryStore);
    const prototypeMethods = Object.getOwnPropertyNames(PublicMemoryStore.prototype);
    for (const method of storeMethods) expect(prototypeMethods).toContain(method);
  });

  test("keeps public fixture collections readable", () => {
    const store = new PublicMemoryStore();
    for (const field of [
      "users", "emailOtps", "desktopLoginTickets", "sessions", "orders",
      "entitlements", "llmUsageEvents", "activationCodes", "adminSessions",
      "adminEntitlementAdjustments", "webhookEvents", "authRateLimits", "userSessions",
    ] as const) expect(Array.isArray(store[field]), field).toBe(true);
    expect(store.llmConfig).toBeNull();
  });

  test("does not expose partial transaction writers", () => {
    const surface = new PublicMemoryStore() as unknown as Record<string, unknown>;
    for (const method of [
      "markOrderPaid",
      "markActivationCodeRedeemed",
      "createAdminEntitlementAdjustment",
      "createWebhookEvent",
    ]) {
      expect(surface[method], method).toBeUndefined();
    }
  });

  test("returns detached fixture records that cannot mutate internal state", async () => {
    const store = new PublicMemoryStore();
    const user = await store.upsertUserByEmail("snapshot@studymind.local", now);
    await store.upsertEntitlement(user.id, later(86_400_000), now, {
      llmQuotaLimit: 2,
      llmQuotaUsed: 0,
    });

    const exposed = store.entitlements as EntitlementRecord[];
    exposed[0]!.llmQuotaUsed = 999;
    exposed.push({ ...exposed[0]!, id: "forged-entitlement" });

    expect(await store.getEntitlement(user.id)).toMatchObject({ llmQuotaUsed: 0 });
    expect(store.entitlements).toHaveLength(1);
  });

  test("detaches user and entitlement records returned by public methods", async () => {
    const store = new PublicMemoryStore();
    const expectedNow = new Date(now);
    const expectedExpiry = later(86_400_000);
    const createdUser = await store.upsertUserByEmail("detached-user@studymind.local", now);
    const userId = createdUser.id;
    createdUser.email = "attacker@studymind.local";
    createdUser.createdAt.setUTCFullYear(1999);

    const foundUser = await store.getUserById(userId);
    expect(foundUser).toMatchObject({ email: "detached-user@studymind.local", createdAt: expectedNow });
    foundUser!.email = "second-attack@studymind.local";
    foundUser!.updatedAt.setUTCFullYear(1998);
    expect(await store.getUserById(userId)).toMatchObject({
      email: "detached-user@studymind.local",
      updatedAt: expectedNow,
    });

    const createdEntitlement = await store.upsertEntitlement(userId, later(86_400_000), now, {
      llmQuotaLimit: 3,
      llmQuotaUsed: 0,
    });
    createdEntitlement.llmQuotaUsed = 998;
    createdEntitlement.expiresAt.setUTCFullYear(1997);
    const foundEntitlement = await store.getEntitlement(userId);
    foundEntitlement!.llmQuotaUsed = 999;
    foundEntitlement!.expiresAt.setUTCFullYear(1996);

    expect(await store.getEntitlement(userId)).toMatchObject({
      llmQuotaUsed: 0,
      expiresAt: expectedExpiry,
    });
    expect(store.entitlements[0]).toMatchObject({ llmQuotaUsed: 0, expiresAt: expectedExpiry });
  });

  test("detaches session, order, and LLM configuration find results including Dates", async () => {
    const store = new PublicMemoryStore();
    const user = await store.upsertUserByEmail("detached-records@studymind.local", now);
    await store.createSession({
      userId: user.id,
      tokenHash: "sha256:detached-session",
      createdAt: now,
      expiresAt: later(86_400_000),
    });
    const session = await store.findSessionByTokenHash("sha256:detached-session", later(1_000));
    session!.tokenHash = "sha256:session-attack";
    session!.expiresAt.setUTCFullYear(1995);
    expect(await store.findSessionByTokenHash("sha256:detached-session", later(1_000))).toMatchObject({
      tokenHash: "sha256:detached-session",
      expiresAt: later(86_400_000),
    });

    await store.createOrder({
      userId: user.id,
      outTradeNo: "detached-order",
      amountFen: 990,
      status: "pending",
      codeUrl: "weixin://detached-order",
      expiresAt: later(1_800_000),
      createdAt: now,
      providerPayload: "{}",
    });
    const order = await store.findOrderByOutTradeNo("detached-order");
    order!.status = "cancelled";
    order!.expiresAt.setUTCFullYear(1994);
    expect(await store.findOrderByOutTradeNo("detached-order")).toMatchObject({
      status: "pending",
      expiresAt: later(1_800_000),
    });

    await store.upsertLlmConfig({
      provider: "openai-compatible",
      baseUrl: "https://llm.studymind.local/v1",
      model: "detached-model",
      encryptedApiKey: "ciphertext",
      apiKeyLast4: "mind",
      timeoutSeconds: 60,
    }, now);
    const config = await store.getLlmConfig() as LlmConfigRecord;
    config.model = "attacker-model";
    config.updatedAt.setUTCFullYear(1993);
    expect(await store.getLlmConfig()).toMatchObject({ model: "detached-model", updatedAt: now });
  });

  test("clones public inputs so later object and Date mutations cannot alter stored state", async () => {
    const store = new PublicMemoryStore();
    const user = await store.upsertUserByEmail("detached-input@studymind.local", now);
    const expiresAt = later(86_400_000);
    const sessionInput = {
      userId: user.id,
      tokenHash: "sha256:input-session",
      createdAt: new Date(now),
      expiresAt,
    };
    await store.createSession(sessionInput);
    sessionInput.tokenHash = "sha256:mutated-input";
    sessionInput.createdAt.setUTCFullYear(1992);
    sessionInput.expiresAt.setUTCFullYear(1991);

    expect(await store.findSessionByTokenHash("sha256:input-session", later(1_000))).toMatchObject({
      tokenHash: "sha256:input-session",
      createdAt: now,
      expiresAt: later(86_400_000),
    });

    const orderInput = {
      userId: user.id,
      outTradeNo: "detached-input-order",
      amountFen: 990,
      status: "pending" as const,
      codeUrl: "weixin://detached-input-order",
      expiresAt: later(1_800_000),
      createdAt: new Date(now),
      providerPayload: "{}",
    };
    await store.createOrder(orderInput);
    orderInput.expiresAt.setUTCFullYear(1990);
    orderInput.createdAt.setUTCFullYear(1989);
    expect(await store.findOrderByOutTradeNo(orderInput.outTradeNo)).toMatchObject({
      expiresAt: later(1_800_000),
      createdAt: now,
    });
  });

  test("isolates OTP purpose and replaces an older OTP of the same purpose", async () => {
    const store = new PublicMemoryStore();
    await issueOtp(store, "desktop_login", { codeHash: "sha256:desktop-old" });
    await issueOtp(store, "admin_login", { codeHash: "sha256:admin" });
    await issueOtp(store, "desktop_login", {
      codeHash: "sha256:desktop-new",
      createdAt: later(61_000),
    });

    expect(store.emailOtps).toHaveLength(3);
    expect(store.emailOtps[0]).toMatchObject({ purpose: "desktop_login", consumedAt: later(61_000) });
    expect(store.emailOtps[1]).toMatchObject({ purpose: "admin_login", consumedAt: null });

    const oldResult = await store.verifyDesktopOtpAndCreateTicket({
      email: "student@studymind.local",
      state: "study-state",
      codeHash: "sha256:desktop-old",
      ticketHash: "sha256:old-ticket",
      now: later(62_000),
      ticketExpiresAt: later(362_000),
    });
    const newResult = await store.verifyDesktopOtpAndCreateTicket({
      email: "student@studymind.local",
      state: "study-state",
      codeHash: "sha256:desktop-new",
      ticketHash: "sha256:new-ticket",
      now: later(62_000),
      ticketExpiresAt: later(362_000),
    });
    expect(oldResult.status).toBe("invalid");
    expect(newResult.status).toBe("verified");
  });

  test("replaces an older OTP for the same purpose and email across states", async () => {
    const store = new PublicMemoryStore();
    await issueOtp(store, "desktop_login", {
      state: "older-study-state",
      codeHash: "sha256:older-state-code",
    });
    await issueOtp(store, "desktop_login", {
      state: "newer-study-state",
      codeHash: "sha256:newer-state-code",
      createdAt: later(61_000),
    });

    expect(store.emailOtps[0]).toMatchObject({ consumedAt: later(61_000) });
    expect((await store.verifyDesktopOtpAndCreateTicket({
      email: "student@studymind.local", state: "older-study-state",
      codeHash: "sha256:older-state-code", ticketHash: "sha256:older-state-ticket",
      now: later(62_000), ticketExpiresAt: later(362_000),
    })).status).toBe("invalid");
    expect((await store.verifyDesktopOtpAndCreateTicket({
      email: "student@studymind.local", state: "newer-study-state",
      codeHash: "sha256:newer-state-code", ticketHash: "sha256:newer-state-ticket",
      now: later(62_000), ticketExpiresAt: later(362_000),
    })).status).toBe("verified");
  });

  test("rejects expired OTPs and locks an OTP after five attempts", async () => {
    const store = new PublicMemoryStore();
    await issueOtp(store, "desktop_login", { codeHash: "sha256:expiring" });
    expect((await store.verifyDesktopOtpAndCreateTicket({
      email: "student@studymind.local", state: "study-state", codeHash: "sha256:expiring",
      ticketHash: "sha256:late", now: later(11 * 60_000), ticketExpiresAt: later(20 * 60_000),
    })).status).toBe("invalid");

    await issueOtp(store, "desktop_login", {
      email: "attempts@studymind.local", codeHash: "sha256:right", createdAt: later(12 * 60_000),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await store.verifyDesktopOtpAndCreateTicket({
        email: "attempts@studymind.local", state: "study-state", codeHash: "sha256:wrong",
        ticketHash: `sha256:wrong-${attempt}`, now: later(13 * 60_000), ticketExpiresAt: later(20 * 60_000),
      })).status).toBe("invalid");
    }
    expect((await store.verifyDesktopOtpAndCreateTicket({
      email: "attempts@studymind.local", state: "study-state", codeHash: "sha256:right",
      ticketHash: "sha256:locked", now: later(13 * 60_000), ticketExpiresAt: later(20 * 60_000),
    })).status).toBe("invalid");
    expect(store.emailOtps.at(-1)?.attempts).toBe(5);
  });

  test("exchanges a desktop ticket only once and persists no raw ticket", async () => {
    const store = new PublicMemoryStore();
    await issueOtp(store, "desktop_login");
    const verified = await store.verifyDesktopOtpAndCreateTicket({
      email: "student@studymind.local", state: "study-state", codeHash: "sha256:otp-code",
      ticketHash: "sha256:desktop-ticket", now: later(1_000), ticketExpiresAt: later(60_000),
    });
    expect(verified.status).toBe("verified");
    if (verified.status !== "verified") throw new Error("expected verified result");
    expect(verified.ticket.ticketHash).not.toContain("smlt_");

    const input = {
      ticketHash: verified.ticket.ticketHash, state: "study-state",
      sessionTokenHash: "sha256:desktop-session", now: later(2_000), sessionExpiresAt: later(86_400_000),
    };
    expect((await store.exchangeDesktopTicketAndCreateSession(input)).status).toBe("exchanged");
    expect((await store.exchangeDesktopTicketAndCreateSession(input)).status).toBe("invalid");
  });

  test("reuses a quota request once and binds usage to its entitlement owner", async () => {
    const store = new PublicMemoryStore();
    const user = await store.upsertUserByEmail("quota@studymind.local", now);
    const entitlement = await store.upsertEntitlement(user.id, later(86_400_000), now, {
      llmQuotaLimit: 2, llmQuotaUsed: 0,
    });

    expect((await store.consumeLlmQuota(user.id, "summary-request-1", now)).status).toBe("consumed");
    const secondCheckout = await store.consumeLlmQuota(user.id, "summary-request-1", now);
    expect(secondCheckout.status).toBe("reused");
    expect(store.llmUsageEvents).toHaveLength(1);
    expect(store.llmUsageEvents[0]).toMatchObject({ userId: user.id, entitlementId: entitlement.id });
    for (const event of store.llmUsageEvents) {
      expect(store.entitlements.find(({ id }) => id === event.entitlementId)?.userId).toBe(event.userId);
    }
  });

  test("supports LLM configuration and established list ordering", async () => {
    const store = new PublicMemoryStore();
    const zulu = await store.upsertUserByEmail("zulu@studymind.local", now);
    const alpha = await store.upsertUserByEmail("alpha@studymind.local", later(1_000));
    expect(await store.getUserById(zulu.id)).toEqual(zulu);
    expect(await store.listUsers()).toEqual([alpha, zulu]);

    const config = await store.upsertLlmConfig({
      provider: "openai-compatible", baseUrl: "https://llm.studymind.local/v1",
      model: "study-model", encryptedApiKey: "ciphertext", apiKeyLast4: "mind", timeoutSeconds: 60,
    }, now);
    expect(await store.getLlmConfig()).toEqual(config);
  });
});
