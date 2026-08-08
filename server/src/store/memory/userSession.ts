import type { Store, UserSessionRecord } from "../contracts.js";
import type { MemoryAuthContext } from "./auth.js";
import { createTicket, upsertUserByEmail, usableOtp } from "./auth.js";
import { assertUnique, constantTimeEqual } from "./atomic.js";

function createRecord(
  context: MemoryAuthContext, input: Omit<UserSessionRecord, "id" | "revokedAt">,
): UserSessionRecord {
  assertUnique(
    context.state.userSessions,
    ({ tokenHash }) => tokenHash === input.tokenHash,
    "UserSession.tokenHash",
  );
  const session = { ...input, id: context.allocateId(), revokedAt: null };
  context.state.userSessions.push(session);
  return session;
}

export async function verifyUserOtpAndCreateWebSession(
  context: MemoryAuthContext, input: Parameters<Store["verifyUserOtpAndCreateWebSession"]>[0],
): ReturnType<Store["verifyUserOtpAndCreateWebSession"]> {
  return context.atomic.run(async () => {
    const otp = usableOtp(context, "desktop_login", input.email, input.state, input.now);
    if (!otp) return { status: "invalid" };
    otp.attempts += 1;
    if (!constantTimeEqual(otp.codeHash, input.codeHash)) return { status: "invalid" };
    if (context.state.userSessions.some(({ tokenHash }) => tokenHash === input.sessionTokenHash)) {
      return { status: "temporarily_unavailable" };
    }
    otp.consumedAt = input.now;
    const user = await upsertUserByEmail(context, input.email, input.now);
    const session = createRecord(context, {
      userId: user.id, email: input.email, tokenHash: input.sessionTokenHash,
      csrfTokenHash: input.csrfTokenHash, createdAt: input.now, expiresAt: input.sessionExpiresAt,
    });
    return { status: "verified", user, session };
  });
}

export async function verifyDesktopOtpAndCreateTicketAndWebSession(
  context: MemoryAuthContext, input: Parameters<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]>[0],
): ReturnType<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]> {
  return context.atomic.run(async () => {
    const otp = usableOtp(context, "desktop_login", input.email, input.state, input.now);
    if (!otp) return { status: "invalid" };
    otp.attempts += 1;
    if (!constantTimeEqual(otp.codeHash, input.codeHash)) return { status: "invalid" };
    if (
      context.state.desktopLoginTickets.some(({ ticketHash }) => ticketHash === input.ticketHash) ||
      context.state.userSessions.some(({ tokenHash }) => tokenHash === input.sessionTokenHash)
    ) {
      return { status: "temporarily_unavailable" };
    }
    otp.consumedAt = input.now;
    const user = await upsertUserByEmail(context, input.email, input.now);
    const ticket = createTicket(context, {
      ticketHash: input.ticketHash, state: input.state, userId: user.id,
      expiresAt: input.ticketExpiresAt, createdAt: input.now,
    });
    const session = createRecord(context, {
      userId: user.id, email: input.email, tokenHash: input.sessionTokenHash,
      csrfTokenHash: input.csrfTokenHash, createdAt: input.now, expiresAt: input.sessionExpiresAt,
    });
    return { status: "verified", user, ticket, session };
  });
}

export async function createUserSession(
  context: MemoryAuthContext, input: Parameters<Store["createUserSession"]>[0],
): ReturnType<Store["createUserSession"]> { return createRecord(context, input); }

export async function findUserSessionByTokenHash(
  context: MemoryAuthContext, tokenHash: string, now: Date,
): ReturnType<Store["findUserSessionByTokenHash"]> {
  return context.state.userSessions.find((session) =>
    session.tokenHash === tokenHash && session.revokedAt === null && session.expiresAt > now,
  ) ?? null;
}

export async function revokeUserSession(
  context: MemoryAuthContext, tokenHash: string, now: Date,
): ReturnType<Store["revokeUserSession"]> {
  const session = context.state.userSessions.find((record) => record.tokenHash === tokenHash);
  if (session) session.revokedAt = now;
}
