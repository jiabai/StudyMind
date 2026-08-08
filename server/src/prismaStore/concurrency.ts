import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuthRateLimitScope, OtpPurpose, Store } from "../store/contracts.js";

type Reservation = { id: string; keyHash: string; purpose: OtpPurpose; scope: AuthRateLimitScope; windowStartedAt: Date; nextAllowedAt: Date; maxCount: number };
export class StoreOperationError extends Error { readonly name = "StoreOperationError"; constructor() { super("Store operation failed."); } }

export function rateLimitReservations(input: Parameters<Store["issueEmailOtp"]>[0]): Reservation[] {
  const hour = new Date(Math.floor(input.createdAt.getTime() / 3_600_000) * 3_600_000);
  const end = new Date(hour.getTime() + 3_600_000);
  const make = (scope: AuthRateLimitScope, value: string, start: Date, next: Date, maxCount: number): Reservation => ({
    id: randomUUID(), keyHash: createHash("sha256").update(`${scope}\0${input.purpose}\0${value}`).digest("hex"),
    purpose: input.purpose, scope, windowStartedAt: start, nextAllowedAt: next, maxCount,
  });
  return [make("email_minute", input.email, input.createdAt, new Date(input.createdAt.getTime() + 60_000), 1), make("email_hour", input.email, hour, end, 5), make("ip_hour", input.ip, hour, end, 20)];
}

export async function reserveRateLimit(tx: Prisma.TransactionClient, value: Reservation, now: Date): Promise<Date | null> {
  const rows = await tx.$queryRaw<Array<{ nextAllowedAt: Date }>>(Prisma.sql`
    INSERT INTO "AuthRateLimit" ("id","keyHash","purpose","scope","windowStartedAt","count","nextAllowedAt","updatedAt")
    VALUES (${value.id},${value.keyHash},${value.purpose},${value.scope},${value.windowStartedAt},1,${value.nextAllowedAt},${now})
    ON CONFLICT("keyHash") DO UPDATE SET
      "windowStartedAt"=excluded."windowStartedAt",
      "count"=CASE WHEN excluded."scope" <> 'email_minute' AND "AuthRateLimit"."windowStartedAt"=excluded."windowStartedAt" THEN "AuthRateLimit"."count"+1 ELSE 1 END,
      "nextAllowedAt"=excluded."nextAllowedAt", "updatedAt"=excluded."updatedAt"
    WHERE (excluded."scope"='email_minute' AND "AuthRateLimit"."nextAllowedAt" <= ${now})
       OR (excluded."scope"<>'email_minute' AND ("AuthRateLimit"."windowStartedAt"<>excluded."windowStartedAt" OR "AuthRateLimit"."count"<${value.maxCount}))
    RETURNING "nextAllowedAt"
  `);
  if (rows.length > 0) return null;
  const current = await tx.authRateLimit.findUnique({ where: { keyHash: value.keyHash } });
  return current?.nextAllowedAt ?? value.nextAllowedAt;
}

export async function withConflictRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (!isRetryable(error)) throw error;
      if (attempt === 3) throw new StoreOperationError();
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 10));
    }
  }
  throw new StoreOperationError();
}

export function isUnique(error: unknown): boolean { return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"; }
export function sanitizeStoreError(error: unknown): never {
  if (error instanceof StoreOperationError) throw error;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientValidationError
  ) throw new StoreOperationError();
  throw error;
}
function isRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034" || error.code === "P1008") return true;
    if (error.code === "P2010" || error.code === "P2028") return /SQLITE_BUSY|database (?:table )?is locked/i.test(error.message + JSON.stringify(error.meta));
    return false;
  }
  return error instanceof Prisma.PrismaClientUnknownRequestError && /SQLITE_BUSY|database (?:table )?is locked/i.test(error.message);
}
