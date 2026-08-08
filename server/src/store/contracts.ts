export type OtpPurpose = "desktop_login" | "admin_login";
export type AuthRateLimitScope = "email_minute" | "email_hour" | "ip_hour";

export type UserRecord = { id: string; email: string; createdAt: Date; updatedAt: Date };
export type EmailOtpRecord = {
  id: string; purpose: OtpPurpose; email: string; state: string; codeHash: string; ip: string;
  attempts: number; expiresAt: Date; consumedAt: Date | null; createdAt: Date;
};
export type AuthRateLimitRecord = {
  id: string; keyHash: string; purpose: OtpPurpose; scope: AuthRateLimitScope;
  windowStartedAt: Date; count: number; nextAllowedAt: Date; updatedAt: Date;
};
export type DesktopLoginTicketRecord = {
  id: string; ticketHash: string; state: string; userId: string; expiresAt: Date;
  consumedAt: Date | null; createdAt: Date;
};
export type SessionRecord = {
  id: string; userId: string; tokenHash: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null;
};
export type OrderRecord = {
  id: string; userId: string; outTradeNo: string; amountFen: number;
  status: "pending" | "paid" | "expired" | "cancelled"; codeUrl: string; expiresAt: Date;
  createdAt: Date; paidAt: Date | null; transactionId: string | null; providerPayload: string;
};
export type EntitlementRecord = {
  id: string; userId: string; status: "active" | "inactive"; expiresAt: Date;
  llmQuotaLimit: number; llmQuotaUsed: number; updatedAt: Date;
};
export type LlmConfigRecord = {
  id: string; provider: string; baseUrl: string; model: string; encryptedApiKey: string;
  apiKeyLast4: string; timeoutSeconds: number; createdAt: Date; updatedAt: Date;
};
export type LlmUsageEventRecord = {
  id: string; userId: string; entitlementId: string; requestId: string; createdAt: Date;
};
export type ActivationCodeRecord = {
  id: string; codeHash: string; codePrefix: string;
  status: "active" | "redeemed" | "expired" | "disabled"; entitlementDays: number;
  redeemBy: Date; createdAt: Date; redeemedAt: Date | null; redeemedByUserId: string | null;
};
export type AdminSessionRecord = {
  id: string; email: string; tokenHash: string; csrfTokenHash: string; createdAt: Date;
  expiresAt: Date; revokedAt: Date | null;
};
export type UserSessionRecord = {
  id: string; userId: string; email: string; tokenHash: string; csrfTokenHash: string;
  createdAt: Date; expiresAt: Date; revokedAt: Date | null;
};
export type AdminEntitlementAdjustmentRecord = {
  id: string; adminEmail: string; userId: string; reason: string; note: string | null;
  beforeExpiresAt: Date | null; afterExpiresAt: Date; beforeLlmQuotaLimit: number;
  afterLlmQuotaLimit: number; beforeLlmQuotaUsed: number; afterLlmQuotaUsed: number; createdAt: Date;
};
export type WebhookEventRecord = {
  id: string; provider: string; eventId: string; outTradeNo: string; payload: string; createdAt: Date;
};

export type PaidOrderSettlement =
  | { status: "settled"; entitlement: EntitlementRecord }
  | { status: "order_not_found" | "order_state_conflict" | "webhook_order_mismatch" | "transaction_mismatch" };
export type ActivationRedemption =
  | { status: "redeemed"; entitlement: EntitlementRecord }
  | { status: "session_invalid" | "code_invalid" };
export type EntitlementAdjustmentApplication =
  | { status: "applied"; entitlement: EntitlementRecord; adjustment: AdminEntitlementAdjustmentRecord }
  | { status: "user_not_found" | "expiry_required" };
export type IssueEmailOtpResult =
  | { status: "issued"; otpId: string }
  | { status: "rate_limited"; retryAt: Date }
  | { status: "temporarily_unavailable" };
export type VerifyDesktopOtpResult =
  | { status: "verified"; user: UserRecord; ticket: DesktopLoginTicketRecord }
  | { status: "invalid" | "temporarily_unavailable" };
export type VerifyAdminOtpResult =
  | { status: "verified"; session: AdminSessionRecord }
  | { status: "invalid" | "temporarily_unavailable" };
export type VerifyUserOtpResult =
  | { status: "verified"; user: UserRecord; session: UserSessionRecord }
  | { status: "invalid" | "temporarily_unavailable" };
export type VerifyDesktopOtpAndWebSessionResult =
  | { status: "verified"; user: UserRecord; ticket: DesktopLoginTicketRecord; session: UserSessionRecord }
  | { status: "invalid" | "temporarily_unavailable" };
export type ExchangeDesktopTicketResult =
  | { status: "exchanged"; user: UserRecord; session: SessionRecord }
  | { status: "invalid" | "temporarily_unavailable" };
export type LlmQuotaCheckoutResult =
  | { status: "consumed" | "reused"; entitlement: EntitlementRecord }
  | { status: "unavailable" | "temporarily_unavailable" };

export type Store = {
  upsertUserByEmail(email: string, now: Date): Promise<UserRecord>;
  getUserById(userId: string): Promise<UserRecord | null>;
  issueEmailOtp(input: Omit<EmailOtpRecord, "id" | "attempts" | "consumedAt">): Promise<IssueEmailOtpResult>;
  invalidateIssuedOtpAfterDeliveryFailure(otpId: string, now: Date): Promise<void>;
  verifyDesktopOtpAndCreateTicket(input: {
    email: string; state: string; codeHash: string; ticketHash: string; now: Date; ticketExpiresAt: Date;
  }): Promise<VerifyDesktopOtpResult>;
  verifyDesktopOtpAndCreateTicketAndWebSession(input: {
    email: string; state: string; codeHash: string; ticketHash: string; sessionTokenHash: string;
    csrfTokenHash: string; now: Date; ticketExpiresAt: Date; sessionExpiresAt: Date;
  }): Promise<VerifyDesktopOtpAndWebSessionResult>;
  verifyAdminOtpAndCreateSession(input: {
    email: string; state: string; codeHash: string; sessionTokenHash: string; csrfTokenHash: string;
    now: Date; sessionExpiresAt: Date;
  }): Promise<VerifyAdminOtpResult>;
  verifyUserOtpAndCreateWebSession(input: {
    email: string; state: string; codeHash: string; sessionTokenHash: string; csrfTokenHash: string;
    now: Date; sessionExpiresAt: Date;
  }): Promise<VerifyUserOtpResult>;
  exchangeDesktopTicketAndCreateSession(input: {
    ticketHash: string; state: string; sessionTokenHash: string; now: Date; sessionExpiresAt: Date;
  }): Promise<ExchangeDesktopTicketResult>;
  createSession(input: Omit<SessionRecord, "id" | "revokedAt">): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  createOrder(input: Omit<OrderRecord, "id" | "paidAt" | "transactionId">): Promise<OrderRecord>;
  findOrderByOutTradeNo(outTradeNo: string): Promise<OrderRecord | null>;
  markOrderPaid(outTradeNo: string, transactionId: string, paidAt: Date): Promise<OrderRecord>;
  settlePaidOrder(input: {
    provider: string; eventId: string; outTradeNo: string; transactionId: string;
    paidAt: Date; now: Date; passDays: number;
  }): Promise<PaidOrderSettlement>;
  getEntitlement(userId: string): Promise<EntitlementRecord | null>;
  upsertEntitlement(userId: string, expiresAt: Date, now: Date, quota?: {
    llmQuotaLimit?: number; llmQuotaUsed?: number;
  }): Promise<EntitlementRecord>;
  consumeLlmQuota(userId: string, requestId: string, now: Date): Promise<LlmQuotaCheckoutResult>;
  getLlmConfig(): Promise<LlmConfigRecord | null>;
  upsertLlmConfig(input: Omit<LlmConfigRecord, "id" | "createdAt" | "updatedAt">, now: Date): Promise<LlmConfigRecord>;
  createActivationCode(input: Omit<ActivationCodeRecord, "id">): Promise<ActivationCodeRecord>;
  findActivationCodeByHash(codeHash: string): Promise<ActivationCodeRecord | null>;
  markActivationCodeRedeemed(codeHash: string, userId: string, redeemedAt: Date): Promise<ActivationCodeRecord | null>;
  redeemActivationCodeAndGrantEntitlement(input: {
    sessionTokenHash: string; codeHash: string; now: Date; llmQuotaPerActivation: number;
  }): Promise<ActivationRedemption>;
  listActivationCodes(): Promise<ActivationCodeRecord[]>;
  listUsers(): Promise<UserRecord[]>;
  createAdminSession(input: Omit<AdminSessionRecord, "id" | "revokedAt">): Promise<AdminSessionRecord>;
  findAdminSessionByTokenHash(tokenHash: string, now: Date): Promise<AdminSessionRecord | null>;
  revokeAdminSession(tokenHash: string, now: Date): Promise<void>;
  createUserSession(input: Omit<UserSessionRecord, "id" | "revokedAt">): Promise<UserSessionRecord>;
  findUserSessionByTokenHash(tokenHash: string, now: Date): Promise<UserSessionRecord | null>;
  revokeUserSession(tokenHash: string, now: Date): Promise<void>;
  createAdminEntitlementAdjustment(input: AdminEntitlementAdjustmentRecord): Promise<AdminEntitlementAdjustmentRecord>;
  applyEntitlementAdjustmentWithAudit(input: {
    adminEmail: string; userId: string; reason: string; note: string | null;
    extendDays?: number; expiresAt?: Date; quotaAdd?: number; now: Date;
  }): Promise<EntitlementAdjustmentApplication>;
  listAdminEntitlementAdjustments(limit?: number): Promise<AdminEntitlementAdjustmentRecord[]>;
  createWebhookEvent(input: Omit<WebhookEventRecord, "id">): Promise<boolean>;
};
