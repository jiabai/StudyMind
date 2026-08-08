import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const readFixture = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const schema = readFixture("../prisma/schema.prisma");
const migration = readFixture(
  "../prisma/migrations/202608080001_account_server_baseline/migration.sql",
);
const gitignore = readFixture("../../.gitignore");

const modelBlock = (modelName: string) => {
  const match = schema.match(new RegExp(`^\\s*model\\s+${modelName}\\s*\\{([\\s\\S]*?)^\\s*\\}`, "m"));
  expect(match, `missing model ${modelName}`).not.toBeNull();
  return match?.[1] ?? "";
};

describe("account schema integrity", () => {
  test("models entitlement as a nullable one-to-one user relation", () => {
    expect(modelBlock("User")).toMatch(/^\s*entitlement\s+Entitlement\?/m);
    expect(modelBlock("User")).not.toMatch(/^\s*entitlements\s+Entitlement\[\]/m);
    expect(modelBlock("Entitlement")).toMatch(/^\s*user\s+User\s+@relation/m);
    expect(modelBlock("Entitlement")).toMatch(/@@unique\(\[userId\]\)/);
  });

  test("relates login tickets and LLM usage events to their owners", () => {
    expect(modelBlock("User")).toMatch(/^\s*desktopLoginTickets\s+DesktopLoginTicket\[\]/m);
    expect(modelBlock("User")).not.toMatch(/^\s*llmUsageEvents\s+LlmUsageEvent\[\]/m);
    expect(modelBlock("DesktopLoginTicket")).toMatch(
      /^\s*user\s+User\s+@relation\(fields: \[userId\], references: \[id\]\)/m,
    );
    expect(modelBlock("Entitlement")).toMatch(/^\s*llmUsageEvents\s+LlmUsageEvent\[\]/m);
    expect(modelBlock("LlmUsageEvent")).toMatch(
      /^\s*entitlement\s+Entitlement\s+@relation\(fields: \[entitlementId, userId\], references: \[id, userId\]\)/m,
    );
    expect(modelBlock("Entitlement")).toMatch(/@@unique\(\[id, userId\]\)/);
    expect(modelBlock("LlmUsageEvent")).toMatch(/@@index\(\[entitlementId\]\)/);
  });

  test("makes provider transaction IDs unique while permitting pending nulls", () => {
    expect(modelBlock("Order")).toMatch(/^\s*transactionId\s+String\?\s+@unique/m);
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "Order_transactionId_key" ON "Order"("transactionId");',
    );
  });

  test("creates restrictive foreign keys and the entitlement usage index", () => {
    expect(migration).toContain(
      'CONSTRAINT "DesktopLoginTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(migration).toContain(
      'CONSTRAINT "LlmUsageEvent_entitlementId_userId_fkey" FOREIGN KEY ("entitlementId", "userId") REFERENCES "Entitlement" ("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE',
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "Entitlement_id_userId_key" ON "Entitlement"("id", "userId");');
    expect(migration).toContain(
      'CREATE INDEX "LlmUsageEvent_entitlementId_idx" ON "LlmUsageEvent"("entitlementId");',
    );
  });

  test.each(["server/prisma/*.db-journal", "server/prisma/*.db-wal", "server/prisma/*.db-shm"])(
    "ignores the SQLite sidecar pattern %s",
    (pattern) => {
      expect(gitignore.split(/\r?\n/)).toContain(pattern);
    },
  );
});
