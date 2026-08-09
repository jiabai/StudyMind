import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionRecord, DesktopLoginTicketRecord, SessionRecord, Store, UserRecord } from "../store/contracts.js";
import { StoreConflictError } from "../store/contracts.js";
import { isUnique, rateLimitReservations, reserveRateLimit, withConflictRetry } from "./concurrency.js";

export function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
class BlockedRateLimitsError extends Error { constructor(readonly retryAt: Date) { super("AUTH_RATE_LIMITED"); } }
export const upsertUserByEmail = (prisma: PrismaClient, email: string, now: Date): ReturnType<Store["upsertUserByEmail"]> => prisma.user.upsert({ where: { email }, update: { updatedAt: now }, create: { id: randomUUID(), email, createdAt: now, updatedAt: now } });
export const getUserById = (prisma: PrismaClient, userId: string): ReturnType<Store["getUserById"]> => prisma.user.findUnique({ where: { id: userId } });

export async function issueEmailOtp(prisma: PrismaClient, input: Parameters<Store["issueEmailOtp"]>[0]): ReturnType<Store["issueEmailOtp"]> {
  const otpId = randomUUID();
  const result = await withConflictRetry(async () => {
      try { return await prisma.$transaction(async (tx) => {
        const blocked: Date[] = [];
        for (const reservation of rateLimitReservations(input)) {
          const retryAt = await reserveRateLimit(tx, reservation, input.createdAt);
          if (retryAt) blocked.push(retryAt);
        }
        if (blocked.length > 0) throw new BlockedRateLimitsError(new Date(Math.max(...blocked.map((value) => value.getTime()))));
        await tx.emailOtp.updateMany({ where: { purpose: input.purpose, email: input.email, consumedAt: null }, data: { consumedAt: input.createdAt } });
        await tx.emailOtp.create({ data: { ...input, id: otpId, attempts: 0, consumedAt: null } });
        return { status: "issued", otpId } as const;
      }); } catch (error) { if (error instanceof BlockedRateLimitsError) return { status: "rate_limited", retryAt: error.retryAt } as const; throw error; }
  });
  return result;
}
export async function invalidateIssuedOtpAfterDeliveryFailure(prisma: PrismaClient, otpId: string, now: Date): Promise<void> { await prisma.emailOtp.updateMany({ where: { id: otpId, consumedAt: null }, data: { consumedAt: now } }); }

async function verifyOtp(tx: Prisma.TransactionClient, purpose: "desktop_login" | "admin_login", input: { email: string; state: string; codeHash: string; now: Date }): Promise<string | null> {
  const otp = await tx.emailOtp.findFirst({ where: { purpose, email: input.email, state: input.state, consumedAt: null, attempts: { lt: 5 }, expiresAt: { gt: input.now } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!otp) return null;
  const matches = equal(otp.codeHash, input.codeHash);
  const changed = await tx.emailOtp.updateMany({ where: { id: otp.id, consumedAt: null, attempts: { lt: 5 }, expiresAt: { gt: input.now } }, data: { attempts: { increment: 1 } } });
  return matches && changed.count === 1 ? otp.id : null;
}

async function consumeVerifiedOtp(tx: Prisma.TransactionClient, otpId: string, now: Date): Promise<boolean> {
  return (await tx.emailOtp.updateMany({ where: { id: otpId, consumedAt: null }, data: { consumedAt: now } })).count === 1;
}

export async function verifyDesktopOtpAndCreateTicket(prisma: PrismaClient, input: Parameters<Store["verifyDesktopOtpAndCreateTicket"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicket"]> {
  try {
  const result = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    const otpId = await verifyOtp(tx, "desktop_login", input); if (!otpId) return { status: "invalid" } as const;
    if (await tx.desktopLoginTicket.findUnique({ where: { ticketHash: input.ticketHash } })) return { status: "temporarily_unavailable" } as const;
    if (!await consumeVerifiedOtp(tx, otpId, input.now)) return { status: "invalid" } as const;
    const user = await tx.user.upsert({ where: { email: input.email }, update: { updatedAt: input.now }, create: { id: randomUUID(), email: input.email, createdAt: input.now, updatedAt: input.now } });
    const ticket = await tx.desktopLoginTicket.create({ data: { id: randomUUID(), ticketHash: input.ticketHash, state: input.state, userId: user.id, expiresAt: input.ticketExpiresAt, consumedAt: null, createdAt: input.now } }); return { status: "verified", user: user as UserRecord, ticket: ticket as DesktopLoginTicketRecord } as const;
  }));
  return result;
  } catch (error) { if (isUnique(error)) return { status: "temporarily_unavailable" }; throw error; }
}

export async function verifyAdminOtpAndCreateSession(prisma: PrismaClient, input: Parameters<Store["verifyAdminOtpAndCreateSession"]>[0]): ReturnType<Store["verifyAdminOtpAndCreateSession"]> {
  try {
  const result = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    const otpId = await verifyOtp(tx, "admin_login", input); if (!otpId) return { status: "invalid" } as const;
    if (await tx.adminSession.findUnique({ where: { tokenHash: input.sessionTokenHash } })) return { status: "temporarily_unavailable" } as const;
    if (!await consumeVerifiedOtp(tx, otpId, input.now)) return { status: "invalid" } as const;
    const session = await tx.adminSession.create({ data: { id: randomUUID(), email: input.email, tokenHash: input.sessionTokenHash, csrfTokenHash: input.csrfTokenHash, createdAt: input.now, expiresAt: input.sessionExpiresAt, revokedAt: null } });
    return { status: "verified", session: session as AdminSessionRecord } as const;
  }));
  return result;
  } catch (error) { if (isUnique(error)) return { status: "temporarily_unavailable" }; throw error; }
}

export async function exchangeDesktopTicketAndCreateSession(prisma: PrismaClient, input: Parameters<Store["exchangeDesktopTicketAndCreateSession"]>[0]): ReturnType<Store["exchangeDesktopTicketAndCreateSession"]> {
  try {
  const result = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    const ticket = await tx.desktopLoginTicket.findFirst({ where: { ticketHash: input.ticketHash, state: input.state, consumedAt: null, expiresAt: { gt: input.now } } });
    if (!ticket) return { status: "invalid" } as const;
    if (await tx.session.findUnique({ where: { tokenHash: input.sessionTokenHash } })) return { status: "temporarily_unavailable" } as const;
    const consumed = await tx.desktopLoginTicket.updateMany({ where: { id: ticket.id, consumedAt: null }, data: { consumedAt: input.now } });
    if (consumed.count !== 1) return { status: "invalid" } as const;
    const user = await tx.user.findUnique({ where: { id: ticket.userId } }); if (!user) return { status: "invalid" } as const;
    const session = await tx.session.create({ data: { id: randomUUID(), userId: user.id, tokenHash: input.sessionTokenHash, createdAt: input.now, expiresAt: input.sessionExpiresAt, revokedAt: null } });
    return { status: "exchanged", user: user as UserRecord, session: session as SessionRecord } as const;
  }));
  return result;
  } catch (error) { if (isUnique(error)) return { status: "temporarily_unavailable" }; throw error; }
}

export async function createSession(prisma: PrismaClient, input: Parameters<Store["createSession"]>[0]): ReturnType<Store["createSession"]> { try { return await prisma.session.create({ data: { ...input, id: randomUUID(), revokedAt: null } }); } catch (error) { if (isUnique(error)) throw new StoreConflictError("Session.tokenHash"); throw error; } }
export const findSessionByTokenHash = (prisma: PrismaClient, tokenHash: string, now: Date): ReturnType<Store["findSessionByTokenHash"]> => prisma.session.findFirst({ where: { tokenHash, revokedAt: null, expiresAt: { gt: now } } });
export async function revokeSession(prisma: PrismaClient, tokenHash: string, now: Date): Promise<void> { await prisma.session.updateMany({ where: { tokenHash }, data: { revokedAt: now } }); }
export const listUsers = (prisma: PrismaClient): ReturnType<Store["listUsers"]> => prisma.user.findMany({ orderBy: { email: "asc" } });
export async function createAdminSession(prisma: PrismaClient, input: Parameters<Store["createAdminSession"]>[0]): ReturnType<Store["createAdminSession"]> { try { return await prisma.adminSession.create({ data: { ...input, id: randomUUID(), revokedAt: null } }); } catch (error) { if (isUnique(error)) throw new StoreConflictError("AdminSession.tokenHash"); throw error; } }
export const findAdminSessionByTokenHash = (prisma: PrismaClient, tokenHash: string, now: Date): ReturnType<Store["findAdminSessionByTokenHash"]> => prisma.adminSession.findFirst({ where: { tokenHash, revokedAt: null, expiresAt: { gt: now } } });
export async function revokeAdminSession(prisma: PrismaClient, tokenHash: string, now: Date): Promise<void> { await prisma.adminSession.updateMany({ where: { tokenHash }, data: { revokedAt: now } }); }
export { consumeVerifiedOtp, verifyOtp };
