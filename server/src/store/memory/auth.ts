import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AdminSessionRecord, AuthRateLimitScope, DesktopLoginTicketRecord, EmailOtpRecord,
  OtpPurpose, SessionRecord, Store, UserRecord,
} from "../contracts.js";
import type { MemoryAtomicCoordinator, MemoryState } from "./atomic.js";

export type MemoryAuthContext = {
  state: MemoryState;
  atomic: MemoryAtomicCoordinator;
  allocateId(): string;
};

type RateLimitReservation = {
  keyHash: string; purpose: OtpPurpose; scope: AuthRateLimitScope; windowStartedAt: Date;
  nextAllowedAt: Date; maxCount: number;
};

export async function upsertUserByEmail(
  context: MemoryAuthContext, email: string, now: Date,
): ReturnType<Store["upsertUserByEmail"]> {
  const existing = context.state.users.find((user) => user.email === email);
  if (existing) { existing.updatedAt = now; return existing; }
  const user: UserRecord = { id: context.allocateId(), email, createdAt: now, updatedAt: now };
  context.state.users.push(user);
  return user;
}

export async function getUserById(
  context: MemoryAuthContext, userId: string,
): ReturnType<Store["getUserById"]> {
  return context.state.users.find((user) => user.id === userId) ?? null;
}

export async function issueEmailOtp(
  context: MemoryAuthContext, input: Parameters<Store["issueEmailOtp"]>[0],
): ReturnType<Store["issueEmailOtp"]> {
  return context.atomic.run(async () => {
    const reservations = rateLimitReservations(input);
    const blocked = reservations
      .map((reservation) => rateLimitDecision(context, reservation, input.createdAt))
      .filter((decision): decision is { allowed: false; retryAt: Date } => !decision.allowed);
    if (blocked.length > 0) {
      return { status: "rate_limited", retryAt: new Date(Math.max(...blocked.map(({ retryAt }) => retryAt.getTime()))) };
    }
    for (const reservation of reservations) reserveRateLimit(context, reservation, input.createdAt);
    for (const otp of context.state.emailOtps) {
      if (otp.purpose === input.purpose && otp.email === input.email && otp.state === input.state && otp.consumedAt === null) {
        otp.consumedAt = input.createdAt;
      }
    }
    const otp: EmailOtpRecord = { ...input, id: context.allocateId(), attempts: 0, consumedAt: null };
    context.state.emailOtps.push(otp);
    return { status: "issued", otpId: otp.id };
  });
}

export async function invalidateIssuedOtpAfterDeliveryFailure(
  context: MemoryAuthContext, otpId: string, now: Date,
): ReturnType<Store["invalidateIssuedOtpAfterDeliveryFailure"]> {
  return context.atomic.run(async () => {
    const otp = context.state.emailOtps.find(({ id }) => id === otpId);
    if (otp?.consumedAt === null) otp.consumedAt = now;
  });
}

export async function verifyDesktopOtpAndCreateTicket(
  context: MemoryAuthContext, input: Parameters<Store["verifyDesktopOtpAndCreateTicket"]>[0],
): ReturnType<Store["verifyDesktopOtpAndCreateTicket"]> {
  return context.atomic.run(async () => {
    const otp = usableOtp(context, "desktop_login", input.email, input.state, input.now);
    if (!otp) return { status: "invalid" };
    otp.attempts += 1;
    if (!constantTimeEqual(otp.codeHash, input.codeHash)) return { status: "invalid" };
    otp.consumedAt = input.now;
    const user = await upsertUserByEmail(context, input.email, input.now);
    const ticket = createTicket(context, {
      ticketHash: input.ticketHash, state: input.state, userId: user.id,
      expiresAt: input.ticketExpiresAt, createdAt: input.now,
    });
    return { status: "verified", user, ticket };
  });
}

export async function verifyAdminOtpAndCreateSession(
  context: MemoryAuthContext, input: Parameters<Store["verifyAdminOtpAndCreateSession"]>[0],
): ReturnType<Store["verifyAdminOtpAndCreateSession"]> {
  return context.atomic.run(async () => {
    const otp = usableOtp(context, "admin_login", input.email, input.state, input.now);
    if (!otp) return { status: "invalid" };
    otp.attempts += 1;
    if (!constantTimeEqual(otp.codeHash, input.codeHash)) return { status: "invalid" };
    otp.consumedAt = input.now;
    const session = createAdminSessionRecord(context, {
      email: input.email, tokenHash: input.sessionTokenHash, csrfTokenHash: input.csrfTokenHash,
      createdAt: input.now, expiresAt: input.sessionExpiresAt,
    });
    return { status: "verified", session };
  });
}

export async function exchangeDesktopTicketAndCreateSession(
  context: MemoryAuthContext, input: Parameters<Store["exchangeDesktopTicketAndCreateSession"]>[0],
): ReturnType<Store["exchangeDesktopTicketAndCreateSession"]> {
  return context.atomic.run(async () => {
    const ticket = context.state.desktopLoginTickets.find((record) =>
      record.ticketHash === input.ticketHash && record.state === input.state &&
      record.consumedAt === null && record.expiresAt > input.now,
    );
    if (!ticket) return { status: "invalid" };
    const user = await getUserById(context, ticket.userId);
    if (!user) return { status: "invalid" };
    ticket.consumedAt = input.now;
    const session = createSessionRecord(context, {
      userId: user.id, tokenHash: input.sessionTokenHash, createdAt: input.now,
      expiresAt: input.sessionExpiresAt,
    });
    return { status: "exchanged", user, session };
  });
}

export async function createSession(
  context: MemoryAuthContext, input: Parameters<Store["createSession"]>[0],
): ReturnType<Store["createSession"]> { return createSessionRecord(context, input); }

export async function findSessionByTokenHash(
  context: MemoryAuthContext, tokenHash: string, now: Date,
): ReturnType<Store["findSessionByTokenHash"]> {
  return context.state.sessions.find((session) =>
    session.tokenHash === tokenHash && session.revokedAt === null && session.expiresAt > now,
  ) ?? null;
}

export async function revokeSession(
  context: MemoryAuthContext, tokenHash: string, now: Date,
): ReturnType<Store["revokeSession"]> {
  const session = context.state.sessions.find((record) => record.tokenHash === tokenHash);
  if (session) session.revokedAt = now;
}

export async function listUsers(context: MemoryAuthContext): ReturnType<Store["listUsers"]> {
  return [...context.state.users].sort((left, right) => left.email.localeCompare(right.email));
}

export async function createAdminSession(
  context: MemoryAuthContext, input: Parameters<Store["createAdminSession"]>[0],
): ReturnType<Store["createAdminSession"]> { return createAdminSessionRecord(context, input); }

export async function findAdminSessionByTokenHash(
  context: MemoryAuthContext, tokenHash: string, now: Date,
): ReturnType<Store["findAdminSessionByTokenHash"]> {
  return context.state.adminSessions.find((session) =>
    session.tokenHash === tokenHash && session.revokedAt === null && session.expiresAt > now,
  ) ?? null;
}

export async function revokeAdminSession(
  context: MemoryAuthContext, tokenHash: string, now: Date,
): ReturnType<Store["revokeAdminSession"]> {
  const session = context.state.adminSessions.find((record) => record.tokenHash === tokenHash);
  if (session) session.revokedAt = now;
}

export function usableOtp(
  context: MemoryAuthContext, purpose: OtpPurpose, email: string, state: string, now: Date,
): EmailOtpRecord | null {
  return [...context.state.emailOtps].reverse().find((otp) =>
    otp.purpose === purpose && otp.email === email && otp.state === state &&
    otp.consumedAt === null && otp.attempts < 5 && otp.expiresAt > now,
  ) ?? null;
}

export function createTicket(
  context: MemoryAuthContext, input: Omit<DesktopLoginTicketRecord, "id" | "consumedAt">,
): DesktopLoginTicketRecord {
  const ticket = { ...input, id: context.allocateId(), consumedAt: null };
  context.state.desktopLoginTickets.push(ticket);
  return ticket;
}

function createSessionRecord(
  context: MemoryAuthContext, input: Omit<SessionRecord, "id" | "revokedAt">,
): SessionRecord {
  const session = { ...input, id: context.allocateId(), revokedAt: null };
  context.state.sessions.push(session);
  return session;
}

function createAdminSessionRecord(
  context: MemoryAuthContext, input: Omit<AdminSessionRecord, "id" | "revokedAt">,
): AdminSessionRecord {
  const session = { ...input, id: context.allocateId(), revokedAt: null };
  context.state.adminSessions.push(session);
  return session;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left); const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function rateKey(scope: AuthRateLimitScope, purpose: OtpPurpose, value: string): string {
  return createHash("sha256").update(`studymind:auth-rate-limit:v1:${scope}:${purpose}:${value}`).digest("hex");
}

function rateLimitReservations(input: Parameters<Store["issueEmailOtp"]>[0]): RateLimitReservation[] {
  const hourStart = new Date(Math.floor(input.createdAt.getTime() / 3_600_000) * 3_600_000);
  const hourEnd = new Date(hourStart.getTime() + 3_600_000);
  const make = (scope: AuthRateLimitScope, value: string, windowStartedAt: Date, nextAllowedAt: Date, maxCount: number) => ({
    keyHash: rateKey(scope, input.purpose, value), purpose: input.purpose, scope,
    windowStartedAt, nextAllowedAt, maxCount,
  });
  return [
    make("email_minute", input.email, input.createdAt, new Date(input.createdAt.getTime() + 60_000), 1),
    make("email_hour", input.email, hourStart, hourEnd, 5),
    make("ip_hour", input.ip, hourStart, hourEnd, 20),
  ];
}

function rateLimitDecision(context: MemoryAuthContext, reservation: RateLimitReservation, now: Date) {
  const existing = context.state.authRateLimits.find(({ keyHash }) => keyHash === reservation.keyHash);
  if (!existing) return { allowed: true } as const;
  if (reservation.scope === "email_minute") {
    return existing.nextAllowedAt > now ? { allowed: false, retryAt: existing.nextAllowedAt } as const : { allowed: true } as const;
  }
  return existing.windowStartedAt.getTime() === reservation.windowStartedAt.getTime() && existing.count >= reservation.maxCount
    ? { allowed: false, retryAt: existing.nextAllowedAt } as const : { allowed: true } as const;
}

function reserveRateLimit(context: MemoryAuthContext, reservation: RateLimitReservation, now: Date): void {
  const existing = context.state.authRateLimits.find(({ keyHash }) => keyHash === reservation.keyHash);
  if (!existing) {
    context.state.authRateLimits.push({ id: context.allocateId(), ...reservation, count: 1, updatedAt: now });
    return;
  }
  const sameWindow = existing.windowStartedAt.getTime() === reservation.windowStartedAt.getTime();
  existing.windowStartedAt = reservation.windowStartedAt; existing.count = sameWindow ? existing.count + 1 : 1;
  existing.nextAllowedAt = reservation.nextAllowedAt; existing.updatedAt = now;
}
