-- StudyMind account server baseline. This migration intentionally contains no
-- legacy task-domain data conversion or dependency on another repository.

CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "EmailOtp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "EmailOtp_purpose_closed" CHECK ("purpose" IN ('desktop_login', 'admin_login')),
    CONSTRAINT "EmailOtp_attempts_bounded" CHECK ("attempts" >= 0 AND "attempts" <= 5)
);

CREATE TABLE "AuthRateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "windowStartedAt" DATETIME NOT NULL,
    "count" INTEGER NOT NULL,
    "nextAllowedAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AuthRateLimit_purpose_closed" CHECK ("purpose" IN ('desktop_login', 'admin_login')),
    CONSTRAINT "AuthRateLimit_scope_closed" CHECK ("scope" IN ('email_minute', 'email_hour', 'ip_hour')),
    CONSTRAINT "AuthRateLimit_count_nonnegative" CHECK ("count" >= 0)
);

CREATE TABLE "DesktopLoginTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "outTradeNo" TEXT NOT NULL,
    "amountFen" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "codeUrl" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "paidAt" DATETIME,
    "transactionId" TEXT,
    "providerPayload" TEXT NOT NULL,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "llmQuotaLimit" INTEGER NOT NULL DEFAULT 0,
    "llmQuotaUsed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Entitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Entitlement_quota_limit_nonnegative" CHECK ("llmQuotaLimit" >= 0),
    CONSTRAINT "Entitlement_quota_used_nonnegative" CHECK ("llmQuotaUsed" >= 0),
    CONSTRAINT "Entitlement_quota_within_limit" CHECK ("llmQuotaUsed" <= "llmQuotaLimit")
);

CREATE TABLE "LlmConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "apiKeyLast4" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "LlmUsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL
);

CREATE TABLE "ActivationCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "codeHash" TEXT NOT NULL,
    "codePrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entitlementDays" INTEGER NOT NULL,
    "redeemBy" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "redeemedAt" DATETIME,
    "redeemedByUserId" TEXT,
    CONSTRAINT "ActivationCode_redeemedByUserId_fkey" FOREIGN KEY ("redeemedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME
);

CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AdminEntitlementAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminEmail" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "beforeExpiresAt" DATETIME,
    "afterExpiresAt" DATETIME NOT NULL,
    "beforeLlmQuotaLimit" INTEGER NOT NULL,
    "afterLlmQuotaLimit" INTEGER NOT NULL,
    "beforeLlmQuotaUsed" INTEGER NOT NULL,
    "afterLlmQuotaUsed" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "AdminEntitlementAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "outTradeNo" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "EmailOtp_purpose_email_state_createdAt_idx" ON "EmailOtp"("purpose", "email", "state", "createdAt");
CREATE UNIQUE INDEX "AuthRateLimit_keyHash_key" ON "AuthRateLimit"("keyHash");
CREATE INDEX "AuthRateLimit_purpose_scope_nextAllowedAt_idx" ON "AuthRateLimit"("purpose", "scope", "nextAllowedAt");
CREATE UNIQUE INDEX "DesktopLoginTicket_ticketHash_key" ON "DesktopLoginTicket"("ticketHash");
CREATE INDEX "DesktopLoginTicket_state_idx" ON "DesktopLoginTicket"("state");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "Order_outTradeNo_key" ON "Order"("outTradeNo");
CREATE INDEX "Order_userId_idx" ON "Order"("userId");
CREATE UNIQUE INDEX "Entitlement_userId_key" ON "Entitlement"("userId");
CREATE INDEX "LlmUsageEvent_userId_idx" ON "LlmUsageEvent"("userId");
CREATE UNIQUE INDEX "LlmUsageEvent_userId_requestId_key" ON "LlmUsageEvent"("userId", "requestId");
CREATE UNIQUE INDEX "ActivationCode_codeHash_key" ON "ActivationCode"("codeHash");
CREATE INDEX "ActivationCode_status_idx" ON "ActivationCode"("status");
CREATE INDEX "ActivationCode_redeemedByUserId_idx" ON "ActivationCode"("redeemedByUserId");
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE INDEX "AdminSession_email_idx" ON "AdminSession"("email");
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");
CREATE INDEX "UserSession_email_idx" ON "UserSession"("email");
CREATE INDEX "AdminEntitlementAdjustment_userId_idx" ON "AdminEntitlementAdjustment"("userId");
CREATE INDEX "AdminEntitlementAdjustment_createdAt_idx" ON "AdminEntitlementAdjustment"("createdAt");
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");
