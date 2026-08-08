import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { createPrismaTestHarness } from "./prismaTestHarness.js";

describe("StudyMind baseline migration", () => {
  test("deploys exactly fourteen domain tables with valid foreign keys", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const database = new DatabaseSync(fixture.databasePath);
      try {
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name").all();
        expect(tables).toEqual([
          { name: "ActivationCode" }, { name: "AdminEntitlementAdjustment" },
          { name: "AdminSession" }, { name: "AuthRateLimit" }, { name: "DesktopLoginTicket" },
          { name: "EmailOtp" }, { name: "Entitlement" }, { name: "LlmConfig" },
          { name: "LlmUsageEvent" }, { name: "Order" }, { name: "Session" },
          { name: "User" }, { name: "UserSession" }, { name: "WebhookEvent" },
        ]);
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare('SELECT migration_name FROM "_prisma_migrations"').all()).toEqual([
          { migration_name: "202608080001_account_server_baseline" },
        ]);
      } finally { database.close(); }
    } finally { await fixture.close(); }
  }, 30_000);

  test("enforces relationship, quota, purpose, and transaction uniqueness contracts", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      await expect(fixture.prisma.session.create({ data: { id: "bad-fk", userId: "missing", tokenHash: "bad", createdAt: new Date(), expiresAt: new Date() } })).rejects.toThrow();
      await expect(fixture.prisma.emailOtp.create({ data: { id: "bad-purpose", purpose: "other", email: "x", state: "s", codeHash: "h", ip: "i", expiresAt: new Date(), createdAt: new Date() } })).rejects.toThrow();
      const user = await fixture.prisma.user.create({ data: { id: "u", email: "schema@studymind.local", createdAt: new Date(), updatedAt: new Date() } });
      await expect(fixture.prisma.entitlement.create({ data: { id: "e", userId: user.id, status: "active", expiresAt: new Date(), llmQuotaLimit: 0, llmQuotaUsed: 1, updatedAt: new Date() } })).rejects.toThrow();
      const base = { userId: user.id, amountFen: 1, status: "pending", codeUrl: "x", expiresAt: new Date(), createdAt: new Date(), providerPayload: "{}", transactionId: "tx" };
      await fixture.prisma.order.create({ data: { id: "o1", outTradeNo: "one", ...base } });
      await expect(fixture.prisma.order.create({ data: { id: "o2", outTradeNo: "two", ...base } })).rejects.toThrow();
    } finally { await fixture.close(); }
  }, 30_000);

  test("enforces that usage user ownership matches its entitlement", async () => {
    const fixture = await createPrismaTestHarness();
    try {
      const first = await fixture.prisma.user.create({ data: { id: "usage-u1", email: "usage-u1@studymind.local", createdAt: new Date(), updatedAt: new Date() } });
      const second = await fixture.prisma.user.create({ data: { id: "usage-u2", email: "usage-u2@studymind.local", createdAt: new Date(), updatedAt: new Date() } });
      const entitlement = await fixture.prisma.entitlement.create({ data: { id: "usage-entitlement", userId: second.id, status: "active", expiresAt: new Date(Date.now() + 60_000), llmQuotaLimit: 2, llmQuotaUsed: 0, updatedAt: new Date() } });
      await expect(fixture.prisma.llmUsageEvent.create({ data: { id: "usage-invalid", userId: first.id, entitlementId: entitlement.id, requestId: "invalid", createdAt: new Date() } })).rejects.toThrow();
      await expect(fixture.prisma.llmUsageEvent.create({ data: { id: "usage-valid", userId: second.id, entitlementId: entitlement.id, requestId: "valid", createdAt: new Date() } })).resolves.toMatchObject({ userId: second.id, entitlementId: entitlement.id });
      expect(await fixture.prisma.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
    } finally { await fixture.close(); }
  }, 30_000);
});
