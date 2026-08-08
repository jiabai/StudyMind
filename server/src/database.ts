import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

export const REQUIRED_TABLES = Object.freeze(["ActivationCode", "AdminEntitlementAdjustment", "AdminSession", "AuthRateLimit", "DesktopLoginTicket", "EmailOtp", "Entitlement", "LlmConfig", "LlmUsageEvent", "Order", "Session", "User", "UserSession", "WebhookEvent"]);

export function resolveSqliteDatabase(source: string, serverRoot: string): { url: string; path: string } {
  if (!source.startsWith("file:") || source.includes("?") || source.includes("#")) throw localOnly();
  const raw = source.slice(5);
  if (!raw || raw.startsWith("//") || /^\\\\/.test(raw) || /^\/(?:mnt|net|nfs|Volumes)\//i.test(raw)) throw localOnly();
  const normalized = decodeURIComponent(raw).replace(/\//g, "\\");
  if (/^(?:\\\\|\/\/)/.test(normalized)) throw localOnly();
  const path = isAbsolute(normalized) || /^[A-Za-z]:\\/.test(normalized) ? resolve(normalized) : resolve(serverRoot, normalized);
  if (!/\.sqlite(?:3|db)?$/i.test(path) && !/\.db$/i.test(path)) throw localOnly();
  return { path, url: `file:${path.replace(/\\/g, "/")}` };
}

export function createDatabaseClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

export async function connectDatabase(config: { databaseUrl: string; databasePath: string }): Promise<PrismaClient> {
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const prisma = createDatabaseClient(config.databaseUrl);
  try { await prisma.$connect(); await configureDatabase(prisma); return prisma; }
  catch (error) { await prisma.$disconnect().catch(() => undefined); throw error; }
}

export async function configureDatabase(prisma: Pick<PrismaClient, "$queryRawUnsafe">): Promise<void> {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000");
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys=ON");
}

function localOnly(): Error { return new Error("DATABASE_URL must reference a local SQLite file."); }
