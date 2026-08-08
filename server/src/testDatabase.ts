import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";

export interface TestDatabase {
  reset(): Promise<void>;
  close(): Promise<void>;
}

export function createTestDatabase(): TestDatabase {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "studymind-server-test-"));
  const databasePath = join(temporaryDirectory, "test.db").replaceAll("\\", "/");
  const databaseUrl = `file:${databasePath}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const serverDirectory = resolve(sourceDirectory, "..");
  const prismaCli = resolve(serverDirectory, "node_modules/prisma/build/index.js");
  const schema = resolve(serverDirectory, "prisma/schema.prisma");

  process.env.DATABASE_URL = databaseUrl;

  let prismaPromise: Promise<PrismaClient>;
  try {
    execFileSync(
      process.execPath,
      [prismaCli, "db", "push", "--skip-generate", "--schema", schema],
      {
        cwd: serverDirectory,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          RUST_LOG: "info",
        },
        stdio: "pipe",
      },
    );
    prismaPromise = import("./lib/prisma.js").then(({ prisma }) => prisma);
  } catch (error) {
    restoreDatabaseUrl(originalDatabaseUrl);
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  let closed = false;

  return {
    async reset() {
      const prisma = await prismaPromise;
      await prisma.$transaction([
        prisma.aiGeneration.deleteMany(),
        prisma.taskProgress.deleteMany(),
        prisma.task.deleteMany(),
        prisma.asrModel.deleteMany(),
      ]);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        const prisma = await prismaPromise;
        await prisma.$disconnect();
      } finally {
        restoreDatabaseUrl(originalDatabaseUrl);
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    },
  };
}

function restoreDatabaseUrl(originalDatabaseUrl: string | undefined) {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
}
