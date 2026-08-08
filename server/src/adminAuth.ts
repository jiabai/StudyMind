import { normalizeEmail, validateState } from "./auth.js";
import { assertEmailOtpHmacKey, constantTimeEqual, hashEmailOtp, normalizeAuthIp, otpCode, secureToken, sha256 } from "./security.js";
import type { AdminSessionRecord, Store } from "./store.js";

type AdminStore = Pick<Store, "issueEmailOtp" | "invalidateIssuedOtpAfterDeliveryFailure" | "verifyAdminOtpAndCreateSession" | "findAdminSessionByTokenHash">;
const TTL = 12 * 60 * 60_000;
export const ADMIN_SESSION_COOKIE = "studymind_admin_session";
export const ADMIN_CSRF_COOKIE = "studymind_admin_csrf";
export const ADMIN_CSRF_HEADER = "x-studymind-csrf";

export class AdminAuthService {
  private readonly now: () => Date; private readonly adminEmail: string;
  constructor(private readonly options: { store: AdminStore; sendOtp: (email: string, code: string) => Promise<void>; otpHmacKey: string; adminEmail?: string; now?: () => Date }) {
    assertEmailOtpHmacKey(options.otpHmacKey);
    this.now = options.now ?? (() => new Date()); this.adminEmail = normalizeEmail(options.adminEmail ?? "admin@studymind.local");
  }
  async startEmailLogin(input: { email: string; state: string; ip: string }) {
    const email = normalizeEmail(input.email); validateState(input.state); if (!constantTimeEqual(email, this.adminEmail)) return { accepted: true } as const;
    const now = this.now(); const code = otpCode();
    const issued = await this.options.store.issueEmailOtp({ purpose: "admin_login", email, state: input.state, ip: normalizeAuthIp(input.ip), codeHash: hashEmailOtp({ key: this.options.otpHmacKey, purpose: "admin_login", email, state: input.state, code }), expiresAt: new Date(now.getTime() + 600_000), createdAt: now });
    if (issued.status !== "issued") throw new Error(issued.status === "rate_limited" ? "Please wait before requesting another verification code." : "SERVER_TEMPORARILY_UNAVAILABLE");
    try { await this.options.sendOtp(email, code); } catch { try { await this.options.store.invalidateIssuedOtpAfterDeliveryFailure(issued.otpId, now); } catch { /* preserve fixed public error */ } throw new Error("SERVER_TEMPORARILY_UNAVAILABLE"); }
    return { accepted: true } as const;
  }
  async verifyEmailCode(input: { email: string; state: string; code: string }) {
    const email = normalizeEmail(input.email); validateState(input.state); if (!constantTimeEqual(email, this.adminEmail)) throw new Error("Verification code is invalid or expired.");
    const now = this.now(); const sessionToken = secureToken("smas_"); const csrfToken = secureToken("smac_");
    const result = await this.options.store.verifyAdminOtpAndCreateSession({ email, state: input.state, codeHash: hashEmailOtp({ key: this.options.otpHmacKey, purpose: "admin_login", email, state: input.state, code: input.code }), sessionTokenHash: sha256(sessionToken), csrfTokenHash: sha256(csrfToken), now, sessionExpiresAt: new Date(now.getTime() + TTL) });
    if (result.status !== "verified") throw new Error(result.status === "invalid" ? "Verification code is invalid or expired." : "SERVER_TEMPORARILY_UNAVAILABLE");
    return { sessionToken, csrfToken, session: result.session };
  }
  async authenticate(token: string | null): Promise<AdminSessionRecord | null> { return token ? this.options.store.findAdminSessionByTokenHash(sha256(token), this.now()) : null; }
  validateCsrf(session: AdminSessionRecord, token: string | null): boolean { return Boolean(token && constantTimeEqual(session.csrfTokenHash, sha256(token))); }
}
export const adminSessionMaxAgeSeconds = TTL / 1000;
