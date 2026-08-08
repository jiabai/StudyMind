import { describe, expect, test } from "vitest";
import { PrismaStore } from "../src/prismaStore.js";
import { createPrismaTestHarness } from "./prismaTestHarness.js";

const now = new Date("2026-08-08T08:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("PrismaStore database concurrency", () => {
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
