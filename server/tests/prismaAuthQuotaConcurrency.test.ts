import { describe, expect, test } from "vitest";
import { PrismaStore } from "../src/prismaStore.js";
import { MemoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/contracts.js";
import { createPrismaTestHarness } from "./prismaTestHarness.js";
import { authRateLimitKey, sha256 } from "../src/security.js";

const now = new Date("2026-08-08T08:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("PrismaStore database concurrency", () => {
  test("persists the versioned StudyMind rate keys identically to MemoryStore", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const input = { purpose: "desktop_login" as const, email: "key@studymind.local", state: "rate-key", codeHash: "code", ip: "203.0.113.44", expiresAt: later(600_000), createdAt: now };
      const memory = new MemoryStore();
      await memory.issueEmailOtp(input);
      await new PrismaStore(fixture.prisma).issueEmailOtp(input);
      const prismaKeys = (await fixture.prisma.authRateLimit.findMany()).map(({ keyHash }) => keyHash).sort();
      const memoryKeys = memory.authRateLimits.map(({ keyHash }) => keyHash).sort();
      expect(prismaKeys).toEqual(memoryKeys);
      expect(prismaKeys).toContain(authRateLimitKey("email_minute", input.purpose, input.email));
      expect(prismaKeys).not.toContain(sha256(`email_minute\0${input.purpose}\0${input.email}`));
    } finally { await fixture.close(); }
  });

  async function wrongOtpWithDuplicateArtifacts(store: Store): Promise<string> {
    const user = await store.upsertUserByEmail("ordering@studymind.local", now);
    await store.createUserSession({ userId: user.id, email: user.email, tokenHash: "duplicate-web", csrfTokenHash: "csrf", createdAt: now, expiresAt: later(600_000) });
    await store.issueEmailOtp({ purpose: "desktop_login", email: user.email, state: "ordering", codeHash: "correct", ip: "198.51.100.1", expiresAt: later(600_000), createdAt: later(61_000) });
    return (await store.verifyDesktopOtpAndCreateTicketAndWebSession({ email: user.email, state: "ordering", codeHash: "wrong", ticketHash: "unused-ticket", sessionTokenHash: "duplicate-web", csrfTokenHash: "csrf-2", now: later(62_000), ticketExpiresAt: later(600_000), sessionExpiresAt: later(600_000) })).status;
  }

  test("matches MemoryStore OTP ordering when a duplicate session token accompanies a wrong code", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const memory = new MemoryStore();
      const prisma = new PrismaStore(fixture.prisma);
      expect(await wrongOtpWithDuplicateArtifacts(memory)).toBe("invalid");
      expect(await wrongOtpWithDuplicateArtifacts(prisma)).toBe("invalid");
      expect(memory.emailOtps[0]?.attempts).toBe(1);
      await expect(fixture.prisma.emailOtp.findFirst()).resolves.toMatchObject({ attempts: 1 });
    } finally { await fixture.close(); }
  });

  test("does not consume a correct OTP when duplicate artifacts prevent creation", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const store = new PrismaStore(fixture.prisma);
      const user = await store.upsertUserByEmail("duplicate-correct@studymind.local", now);
      await store.createUserSession({ userId: user.id, email: user.email, tokenHash: "existing-web", csrfTokenHash: "csrf", createdAt: now, expiresAt: later(600_000) });
      await store.issueEmailOtp({ purpose: "desktop_login", email: user.email, state: "duplicate-correct", codeHash: "correct", ip: "198.51.100.2", expiresAt: later(600_000), createdAt: later(61_000) });
      await expect(store.verifyDesktopOtpAndCreateTicketAndWebSession({ email: user.email, state: "duplicate-correct", codeHash: "correct", ticketHash: "not-created", sessionTokenHash: "existing-web", csrfTokenHash: "csrf-2", now: later(62_000), ticketExpiresAt: later(600_000), sessionExpiresAt: later(600_000) })).resolves.toEqual({ status: "temporarily_unavailable" });
      await expect(fixture.prisma.emailOtp.findFirst({ where: { state: "duplicate-correct" } })).resolves.toMatchObject({ attempts: 1, consumedAt: null });
      expect(await fixture.prisma.desktopLoginTicket.count({ where: { ticketHash: "not-created" } })).toBe(0);
      expect(await fixture.prisma.userSession.count()).toBe(1);
    } finally { await fixture.close(); }
  });

  test("matches MemoryStore ticket validation before duplicate session handling", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      for (const store of [new MemoryStore(), new PrismaStore(fixture.prisma)] satisfies Store[]) {
        const user = await store.upsertUserByEmail(`ticket-order-${store.constructor.name}@studymind.local`, now);
        await store.createSession({ userId: user.id, tokenHash: "duplicate-desktop", createdAt: now, expiresAt: later(600_000) });
        await expect(store.exchangeDesktopTicketAndCreateSession({ ticketHash: "missing", state: "missing", sessionTokenHash: "duplicate-desktop", now, sessionExpiresAt: later(600_000) })).resolves.toEqual({ status: "invalid" });
      }
    } finally { await fixture.close(); }
  });

  test("returns the latest retryAt when minute and hour limits are both blocked", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const memory = new MemoryStore(); const prisma = new PrismaStore(fixture.prisma);
      const stores: Store[] = [memory, prisma];
      for (const store of stores) {
        for (let index = 0; index < 5; index += 1) {
          const createdAt = later(index * 61_000);
          expect((await store.issueEmailOtp({ purpose: "desktop_login", email: `limits-${store.constructor.name}@studymind.local`, state: `${index}`, codeHash: `${index}`, ip: `203.0.113.${index + 1}`, expiresAt: new Date(createdAt.getTime() + 600_000), createdAt })).status).toBe("issued");
        }
      }
      const attemptAt = later(4 * 61_000 + 1_000);
      const countersBefore = await fixture.prisma.authRateLimit.count();
      const results = await Promise.all(stores.map((store) => store.issueEmailOtp({ purpose: "desktop_login", email: `limits-${store.constructor.name}@studymind.local`, state: "blocked", codeHash: "blocked", ip: "203.0.113.99", expiresAt: new Date(attemptAt.getTime() + 600_000), createdAt: attemptAt })));
      expect(results).toEqual([{ status: "rate_limited", retryAt: new Date("2026-08-08T09:00:00.000Z") }, { status: "rate_limited", retryAt: new Date("2026-08-08T09:00:00.000Z") }]);
      expect(await fixture.prisma.authRateLimit.count()).toBe(countersBefore);
    } finally { await fixture.close(); }
  });
  test("one OTP creates at most one ticket and web session across independent clients", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const first = new PrismaStore(fixture.prisma);
      const second = new PrismaStore(await fixture.createClient());
      await first.issueEmailOtp({ purpose: "desktop_login", email: "otp@studymind.local", state: "s", codeHash: "code", ip: "127.0.0.1", expiresAt: later(60_000), createdAt: now });
      const input = { email: "otp@studymind.local", state: "s", codeHash: "code", ticketHash: "ticket", sessionTokenHash: "web", csrfTokenHash: "csrf", now, ticketExpiresAt: later(60_000), sessionExpiresAt: later(60_000) };
      const results = await Promise.all([first.verifyDesktopOtpAndCreateTicketAndWebSession(input), second.verifyDesktopOtpAndCreateTicketAndWebSession(input)]);
      expect(results.filter((value) => value.status === "verified")).toHaveLength(1);
      expect(await fixture.prisma.desktopLoginTicket.count()).toBeLessThanOrEqual(1);
      expect(await fixture.prisma.userSession.count()).toBeLessThanOrEqual(1);
    } finally { await fixture.close(); }
  }, 30_000);

  test("one ticket creates one desktop session across independent clients", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const first = new PrismaStore(fixture.prisma);
      const second = new PrismaStore(await fixture.createClient());
      await first.issueEmailOtp({ purpose: "desktop_login", email: "ticket@studymind.local", state: "s", codeHash: "code", ip: "127.0.0.2", expiresAt: later(60_000), createdAt: now });
      await first.verifyDesktopOtpAndCreateTicket({ email: "ticket@studymind.local", state: "s", codeHash: "code", ticketHash: "ticket", now, ticketExpiresAt: later(60_000) });
      const results = await Promise.all([first.exchangeDesktopTicketAndCreateSession({ ticketHash: "ticket", state: "s", sessionTokenHash: "desktop-a", now, sessionExpiresAt: later(60_000) }), second.exchangeDesktopTicketAndCreateSession({ ticketHash: "ticket", state: "s", sessionTokenHash: "desktop-b", now, sessionExpiresAt: later(60_000) })]);
      expect(results.filter((value) => value.status === "exchanged")).toHaveLength(1);
      expect(await fixture.prisma.session.count()).toBe(1);
    } finally { await fixture.close(); }
  }, 30_000);

  test("prevents final-credit overspend and reuses identical request IDs", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const first = new PrismaStore(fixture.prisma);
      const second = new PrismaStore(await fixture.createClient());
      const user = await first.upsertUserByEmail("quota@studymind.local", now);
      const entitlement = await first.upsertEntitlement(user.id, later(60_000), now, { llmQuotaLimit: 1, llmQuotaUsed: 0 });
      const distinct = await Promise.all([first.consumeLlmQuota(user.id, "a", now), second.consumeLlmQuota(user.id, "b", now)]);
      expect(distinct.filter((value) => value.status === "consumed")).toHaveLength(1);
      expect(distinct.filter((value) => value.status === "unavailable")).toHaveLength(1);
      expect(await fixture.prisma.llmUsageEvent.count()).toBe(1);
      const event = await fixture.prisma.llmUsageEvent.findFirstOrThrow();
      expect(event).toMatchObject({ userId: user.id, entitlementId: entitlement.id });

      const user2 = await first.upsertUserByEmail("reuse@studymind.local", now);
      await first.upsertEntitlement(user2.id, later(60_000), now, { llmQuotaLimit: 2, llmQuotaUsed: 0 });
      const same = await Promise.all([first.consumeLlmQuota(user2.id, "same", now), second.consumeLlmQuota(user2.id, "same", now)]);
      expect(same.filter((value) => value.status === "consumed")).toHaveLength(1);
      expect(same.filter((value) => value.status === "reused")).toHaveLength(1);
      expect((await first.consumeLlmQuota(user2.id, "same", now)).status).toBe("reused");
      expect(await fixture.prisma.llmUsageEvent.count({ where: { userId: user2.id } })).toBe(1);
    } finally { await fixture.close(); }
  }, 30_000);
});
