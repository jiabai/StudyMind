import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { DesktopLoginTicketRecord, Store, UserRecord, UserSessionRecord } from "../store/contracts.js";
import { isUnique, withConflictRetry } from "./concurrency.js";
import { StoreConflictError } from "../store/contracts.js";
import { consumeVerifiedOtp, verifyOtp } from "./auth.js";

async function verifiedUser(prisma: PrismaClient, input: Parameters<Store["verifyUserOtpAndCreateWebSession"]>[0], withTicket?: { ticketHash: string; ticketExpiresAt: Date }): Promise<{ status: "verified"; user: UserRecord; session: UserSessionRecord; ticket?: DesktopLoginTicketRecord } | { status: "invalid" | "temporarily_unavailable" }> {
  try {
  const result = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    const otpId = await verifyOtp(tx, "desktop_login", input); if (!otpId) return { status: "invalid" } as const;
    if (await tx.userSession.findUnique({ where: { tokenHash: input.sessionTokenHash } })) return { status: "temporarily_unavailable" } as const;
    if (withTicket && await tx.desktopLoginTicket.findUnique({ where: { ticketHash: withTicket.ticketHash } })) return { status: "temporarily_unavailable" } as const;
    if (!await consumeVerifiedOtp(tx, otpId, input.now)) return { status: "invalid" } as const;
    const user = await tx.user.upsert({ where: { email: input.email }, update: { updatedAt: input.now }, create: { id: randomUUID(), email: input.email, createdAt: input.now, updatedAt: input.now } });
    const ticket = withTicket ? await tx.desktopLoginTicket.create({ data: { id: randomUUID(), ticketHash: withTicket.ticketHash, state: input.state, userId: user.id, expiresAt: withTicket.ticketExpiresAt, consumedAt: null, createdAt: input.now } }) : undefined;
    const session = await tx.userSession.create({ data: { id: randomUUID(), userId: user.id, email: input.email, tokenHash: input.sessionTokenHash, csrfTokenHash: input.csrfTokenHash, createdAt: input.now, expiresAt: input.sessionExpiresAt, revokedAt: null } });
    return { status: "verified", user: user as UserRecord, session: session as UserSessionRecord, ...(ticket ? { ticket: ticket as DesktopLoginTicketRecord } : {}) } as const;
  }));
  return result;
  } catch (error) { if (isUnique(error)) return { status: "temporarily_unavailable" }; throw error; }
}
export const verifyUserOtpAndCreateWebSession = (prisma: PrismaClient, input: Parameters<Store["verifyUserOtpAndCreateWebSession"]>[0]): ReturnType<Store["verifyUserOtpAndCreateWebSession"]> => verifiedUser(prisma, input);
export const verifyDesktopOtpAndCreateTicketAndWebSession = (prisma: PrismaClient, input: Parameters<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]> => verifiedUser(prisma, input, { ticketHash: input.ticketHash, ticketExpiresAt: input.ticketExpiresAt }) as ReturnType<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]>;
export async function createUserSession(prisma: PrismaClient, input: Parameters<Store["createUserSession"]>[0]): ReturnType<Store["createUserSession"]> { try { return await prisma.userSession.create({ data: { ...input, id: randomUUID(), revokedAt: null } }) as UserSessionRecord; } catch (error) { if (isUnique(error)) throw new StoreConflictError("UserSession.tokenHash"); throw error; } }
export const findUserSessionByTokenHash = (prisma: PrismaClient, tokenHash: string, now: Date): ReturnType<Store["findUserSessionByTokenHash"]> => prisma.userSession.findFirst({ where: { tokenHash, revokedAt: null, expiresAt: { gt: now } } }) as ReturnType<Store["findUserSessionByTokenHash"]>;
export async function revokeUserSession(prisma: PrismaClient, tokenHash: string, now: Date): Promise<void> { await prisma.userSession.updateMany({ where: { tokenHash }, data: { revokedAt: now } }); }
