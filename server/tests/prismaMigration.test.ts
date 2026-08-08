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
        expect(tables).toHaveLength(14);
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
});
