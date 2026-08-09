import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, test } from "vitest";
import { createPrismaTestHarness } from "./prismaTestHarness.js";

describe("StudyMind Prisma test harness", () => {
  test("deploys into an absolute temporary file URL shared by independent clients", async () => {
    const fixture = await createPrismaTestHarness();
    const directory = fixture.directory;
    try {
      const second = await fixture.createClient();
      expect(second).not.toBe(fixture.prisma);
      expect(isAbsolute(fixture.databasePath)).toBe(true);
      expect(fixture.databaseUrl).toMatch(/^file:[A-Za-z]:\//);
      await fixture.prisma.user.create({ data: { id: "u", email: "fixture@studymind.local", createdAt: new Date(0), updatedAt: new Date(0) } });
      await expect(second.user.count()).resolves.toBe(1);
    } finally {
      await fixture.close();
      await fixture.close();
    }
    expect(existsSync(directory)).toBe(false);
  }, 30_000);

  test("removes the temporary directory after setup failure", async () => {
    let directory = "";
    await expect(createPrismaTestHarness({ beforeConnect(value) { directory = value; throw new Error("injected setup failure"); } }))
      .rejects.toThrow("injected setup failure");
    expect(directory).not.toBe("");
    expect(existsSync(directory)).toBe(false);
  }, 30_000);
});
