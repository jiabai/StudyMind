import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { configureDatabase, REQUIRED_TABLES, resolveSqliteDatabase } from "../src/database.js";
import { createPrismaTestHarness } from "./prismaTestHarness.js";

describe("database runtime", () => {
  test.each(["postgres://db", "file://server/share/db.sqlite", "file:/mnt/nfs/db.sqlite", "file:C:/server/share/db.sqlite?mode=memory"])("rejects non-local database URL %s", (url) => {
    expect(() => resolveSqliteDatabase(url, "C:/srv/server")).toThrow("local SQLite");
  });

  test("configures WAL, timeout, and foreign keys on the migrated 14-table schema", async () => {
    const harness = await createPrismaTestHarness();
    try {
      await configureDatabase(harness.prisma);
      const journal = await harness.prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode");
      const timeout = await harness.prisma.$queryRawUnsafe<Array<{ timeout: bigint }>>("PRAGMA busy_timeout");
      const foreignKeys = await harness.prisma.$queryRawUnsafe<Array<{ foreign_keys: bigint }>>("PRAGMA foreign_keys");
      const tables = await harness.prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name");
      expect(journal[0]?.journal_mode.toLowerCase()).toBe("wal");
      expect(Number(timeout[0]?.timeout)).toBe(5000);
      expect(Number(foreignKeys[0]?.foreign_keys)).toBe(1);
      expect(tables.map(({ name }) => name)).toEqual([...REQUIRED_TABLES].sort());
      expect(readFileSync(harness.databasePath).subarray(0, 16).toString()).toBe("SQLite format 3\0");
    } finally { await harness.close(); }
  });
});
