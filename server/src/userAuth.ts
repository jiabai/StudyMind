import { normalizeEmail, validateState } from "./auth.js";
import { constantTimeEqual, otpCode, secureToken, sha256 } from "./security.js";
import type { Store, UserSessionRecord } from "./store.js";

type UserStore = Pick<Store, "issueEmailOtp" | "invalidateIssuedOtpAfterDeliveryFailure" | "verifyUserOtpAndCreateWebSession" | "findUserSessionByTokenHash" | "revokeUserSession">;
const TTL = 90 * 24 * 60 * 60_000;
export const USER_SESSION_COOKIE = "studymind_user_session";
export const USER_CSRF_COOKIE = "studymind_user_csrf";
export const CSRF_HEADER = "x-studymind-csrf";

export class UserAuthService {
  private readonly now: () => Date;
  constructor(private readonly options: { store: UserStore; sendOtp: (email: string, code: string) => Promise<void>; now?: () => Date }) {
    this.now = options.now ?? (() => new Date());
  }
  async startEmailLogin(input: { email: string; state: string; ip: string }) {
    const email = normalizeEmail(input.email); validateState(input.state); const now = this.now(); const code = otpCode();
    const issued = await this.options.store.issueEmailOtp({ purpose: "desktop_login", email, state: input.state, ip: input.ip, codeHash: sha256(code), expiresAt: new Date(now.getTime() + 600_000), createdAt: now });
    if (issued.status !== "issued") throw new Error(issued.status === "rate_limited" ? "Please wait before requesting another verification code." : "SERVER_TEMPORARILY_UNAVAILABLE");
    try { await this.options.sendOtp(email, code); } catch { await this.options.store.invalidateIssuedOtpAfterDeliveryFailure(issued.otpId, now); throw new Error("Could not send verification code. Please try again later."); }
  }
  async verifyEmailCode(input: { email: string; state: string; code: string }) {
    const email = normalizeEmail(input.email); validateState(input.state); const now = this.now();
    const sessionToken = secureToken("smus_"); const csrfToken = secureToken("smuc_");
    const result = await this.options.store.verifyUserOtpAndCreateWebSession({ email, state: input.state, codeHash: sha256(input.code), sessionTokenHash: sha256(sessionToken), csrfTokenHash: sha256(csrfToken), now, sessionExpiresAt: new Date(now.getTime() + TTL) });
    if (result.status !== "verified") throw new Error(result.status === "invalid" ? "Verification code is invalid or expired." : "SERVER_TEMPORARILY_UNAVAILABLE");
    return { sessionToken, csrfToken, session: result.session };
  }
  async authenticate(token: string | null): Promise<UserSessionRecord | null> { return token ? this.options.store.findUserSessionByTokenHash(sha256(token), this.now()) : null; }
  validateCsrf(session: UserSessionRecord, token: string | null): boolean { return Boolean(token && constantTimeEqual(session.csrfTokenHash, sha256(token))); }
}
export const userSessionMaxAgeSeconds = TTL / 1000;
