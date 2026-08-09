import type { PrismaClient } from "@prisma/client";
import { REQUIRED_TABLES } from "./database.js";

export class Readiness {
  private startupVerified = false;
  private draining = false;
  constructor(private readonly options: { probe: () => Promise<boolean> }) {}
  async verifyStartup(): Promise<void> {
    if (!await this.options.probe()) throw new Error("Database schema readiness verification failed.");
    this.startupVerified = true;
  }
  beginDraining(): void { this.draining = true; }
  async isReady(): Promise<boolean> { return this.startupVerified && !this.draining && await this.options.probe().catch(() => false); }
}

export function createDatabaseReadiness(prisma: PrismaClient): Readiness {
  return new Readiness({ probe: async () => {
    const ping = await prisma.$queryRawUnsafe<Array<{ ok: bigint }>>("SELECT 1 AS ok");
    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name");
    const migrations = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL");
    return Number(ping[0]?.ok) === 1 && Number(migrations[0]?.count) > 0 && tables.map(({ name }) => name).join("\0") === [...REQUIRED_TABLES].sort().join("\0");
  } });
}
