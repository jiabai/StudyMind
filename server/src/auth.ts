import { otpCode, secureToken, sha256 } from "./security.js";
import type { Store } from "./store.js";

type AuthStore = Pick<Store,
  "issueEmailOtp" | "invalidateIssuedOtpAfterDeliveryFailure" |
  "verifyDesktopOtpAndCreateTicketAndWebSession" | "exchangeDesktopTicketAndCreateSession">;

const OTP_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;

export class AuthRateLimitError extends Error {
  constructor(readonly retryAt: Date) {
    super("Please wait before requesting another verification code.");
  }
}

export type AuthServiceOptions = {
  store: AuthStore;
  now?: () => Date;
  sendOtp: (email: string, code: string) => Promise<void>;
  createOtp?: () => string;
  createToken?: (prefix: string) => string;
  hash?: (value: string) => string;
};

export class AuthService {
  private readonly now: () => Date;
  private readonly createOtp: () => string;
  private readonly createToken: (prefix: string) => string;
  private readonly hash: (value: string) => string;

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createOtp = options.createOtp ?? otpCode;
    this.createToken = options.createToken ?? secureToken;
    this.hash = options.hash ?? sha256;
  }

  async startEmailLogin(input: { email: string; ip: string; state: string }): Promise<void> {
    const email = normalizeEmail(input.email);
    validateState(input.state);
    const now = this.now();
    const code = this.createOtp();
    const issued = await this.options.store.issueEmailOtp({
      purpose: "desktop_login", email, state: input.state, codeHash: this.hash(code), ip: input.ip,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS), createdAt: now,
    });
    if (issued.status === "rate_limited") throw new AuthRateLimitError(issued.retryAt);
    if (issued.status === "temporarily_unavailable") throw unavailable();
    try {
      await this.options.sendOtp(email, code);
    } catch {
      try { await this.options.store.invalidateIssuedOtpAfterDeliveryFailure(issued.otpId, now); }
      catch { throw unavailable(); }
      throw new Error("Could not send verification code. Please try again later.");
    }
  }

  async verifyEmailCode(input: { email: string; code: string; state: string }) {
    const email = normalizeEmail(input.email);
    validateState(input.state);
    if (!/^\d{6}$/.test(input.code)) throw invalidCode();
    const now = this.now();
    const ticket = this.createToken("smlt_");
    const webSessionToken = this.createToken("smus_");
    const webCsrfToken = this.createToken("smuc_");
    const result = await this.options.store.verifyDesktopOtpAndCreateTicketAndWebSession({
      email, state: input.state, codeHash: this.hash(input.code), ticketHash: this.hash(ticket),
      sessionTokenHash: this.hash(webSessionToken), csrfTokenHash: this.hash(webCsrfToken), now,
      ticketExpiresAt: new Date(now.getTime() + TICKET_TTL_MS),
      sessionExpiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    });
    if (result.status === "temporarily_unavailable") throw unavailable();
    if (result.status === "invalid") throw invalidCode();
    return {
      ticket, webSessionToken, webCsrfToken,
      redirectUrl: `studymind://auth/callback?ticket=${encodeURIComponent(ticket)}&state=${encodeURIComponent(input.state)}`,
    };
  }

  async verifyEmailCodeAndCreateWebSession(input: { email: string; code: string; state: string }) {
    const result = await this.verifyEmailCode(input);
    return { ...result, sessionToken: result.webSessionToken, csrfToken: result.webCsrfToken };
  }

  async exchangeDesktopTicket(input: { ticket: string; state: string }) {
    validateState(input.state);
    if (!/^smlt_[A-Za-z0-9_-]{10,200}$/.test(input.ticket)) throw invalidTicket();
    const now = this.now();
    const sessionToken = this.createToken("smds_");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    const result = await this.options.store.exchangeDesktopTicketAndCreateSession({
      ticketHash: this.hash(input.ticket), state: input.state, sessionTokenHash: this.hash(sessionToken),
      now, sessionExpiresAt: expiresAt,
    });
    if (result.status === "temporarily_unavailable") throw unavailable();
    if (result.status !== "exchanged") throw invalidTicket();
    return { sessionToken, email: result.user.email, expiresAt };
  }
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized))
    throw new Error("A valid email address is required.");
  return normalized;
}

export function validateState(state: string): void {
  if (!/^[A-Za-z0-9._~-]{8,160}$/.test(state)) throw new Error("Login state is invalid.");
}

function invalidCode() { return new Error("Verification code is invalid or expired."); }
function invalidTicket() { return new Error("Login ticket is invalid or expired."); }
function unavailable() { return new Error("SERVER_TEMPORARILY_UNAVAILABLE"); }
export const userSessionMaxAgeSeconds = SESSION_TTL_MS / 1000;
