import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(serverRoot, "prisma", "schema.prisma");
const prismaCliPath = join(serverRoot, "node_modules", "prisma", "build", "index.js");

export const temporaryDatabasePrefix = "studymind-prisma-";

export type PrismaTestHarness = {
  prisma: PrismaClient;
  createClient(): Promise<PrismaClient>;
  databasePath: string;
  databaseUrl: string;
  directory: string;
  close(): Promise<void>;
};

export async function createPrismaTestHarness(input: {
  beforeConnect?: (directory: string) => void;
} = {}): Promise<PrismaTestHarness> {
  const directory = mkdtempSync(join(tmpdir(), temporaryDatabasePrefix));
  const databasePath = join(directory, "studymind.sqlite");
  const databaseUrl = `file:${databasePath.replace(/\\/g, "/")}`;
  const clients = new Set<PrismaClient>();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await Promise.all([...clients].map((client) => client.$disconnect().catch(() => undefined)));
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  try {
    execFileSync(process.execPath, [prismaCliPath, "migrate", "deploy", "--schema", schemaPath], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" },
      stdio: "pipe",
    });
    input.beforeConnect?.(directory);
    const createClient = async (): Promise<PrismaClient> => {
      if (closed) throw new Error("Prisma test harness is closed.");
      const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      try {
        await client.$connect();
        await client.$queryRawUnsafe("PRAGMA busy_timeout=5000");
        clients.add(client);
        return client;
      } catch (error) {
        await client.$disconnect().catch(() => undefined);
        throw error;
      }
    };
    const prisma = await createClient();
    return { prisma, createClient, databasePath, databaseUrl, directory, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function temporaryDirectoryExists(directory: string): boolean {
  return existsSync(directory);
}
