import type { AdminEntitlementAdjustmentRecord, EntitlementRecord, Store } from "../contracts.js";
import type { MemoryAuthContext } from "./auth.js";

export type MemoryEntitlementContext = MemoryAuthContext;

export async function getEntitlement(
  context: MemoryEntitlementContext, userId: string,
): ReturnType<Store["getEntitlement"]> {
  return context.state.entitlements.find((entitlement) => entitlement.userId === userId) ?? null;
}

export async function upsertEntitlement(
  context: MemoryEntitlementContext, userId: string, expiresAt: Date, now: Date,
  quota: { llmQuotaLimit?: number; llmQuotaUsed?: number } = {},
): ReturnType<Store["upsertEntitlement"]> {
  const existing = await getEntitlement(context, userId);
  if (existing) {
    existing.status = expiresAt > now ? "active" : "inactive"; existing.expiresAt = expiresAt;
    if (quota.llmQuotaLimit !== undefined) existing.llmQuotaLimit = quota.llmQuotaLimit;
    if (quota.llmQuotaUsed !== undefined) existing.llmQuotaUsed = quota.llmQuotaUsed;
    existing.updatedAt = now;
    return existing;
  }
  const entitlement: EntitlementRecord = {
    id: context.allocateId(), userId, status: expiresAt > now ? "active" : "inactive", expiresAt,
    llmQuotaLimit: quota.llmQuotaLimit ?? 0, llmQuotaUsed: quota.llmQuotaUsed ?? 0, updatedAt: now,
  };
  context.state.entitlements.push(entitlement);
  return entitlement;
}

export async function consumeLlmQuota(
  context: MemoryEntitlementContext, userId: string, requestId: string, now: Date,
): ReturnType<Store["consumeLlmQuota"]> {
  return context.atomic.run(async () => {
    const entitlement = await getEntitlement(context, userId);
    if (!entitlement || entitlement.expiresAt <= now || entitlement.userId !== userId) return { status: "unavailable" };
    const reused = context.state.llmUsageEvents.some((event) =>
      event.userId === userId && event.requestId === requestId && event.entitlementId === entitlement.id,
    );
    if (reused) return { status: "reused", entitlement };
    if (entitlement.llmQuotaUsed >= entitlement.llmQuotaLimit) return { status: "unavailable" };
    entitlement.llmQuotaUsed += 1; entitlement.updatedAt = now;
    context.state.llmUsageEvents.push({
      id: context.allocateId(), userId: entitlement.userId, entitlementId: entitlement.id,
      requestId, createdAt: now,
    });
    return { status: "consumed", entitlement };
  });
}

export async function createActivationCode(
  context: MemoryEntitlementContext, input: Parameters<Store["createActivationCode"]>[0],
): ReturnType<Store["createActivationCode"]> {
  const code = { ...input, id: context.allocateId() };
  context.state.activationCodes.push(code);
  return code;
}

export async function findActivationCodeByHash(
  context: MemoryEntitlementContext, codeHash: string,
): ReturnType<Store["findActivationCodeByHash"]> {
  return context.state.activationCodes.find((code) => code.codeHash === codeHash) ?? null;
}

async function markActivationCodeRedeemed(
  context: MemoryEntitlementContext, codeHash: string, userId: string, redeemedAt: Date,
): Promise<(typeof context.state.activationCodes)[number] | null> {
  const code = await findActivationCodeByHash(context, codeHash);
  if (!code || code.status !== "active" || code.redeemedAt !== null) return null;
  code.status = "redeemed"; code.redeemedByUserId = userId; code.redeemedAt = redeemedAt;
  return code;
}

export async function redeemActivationCodeAndGrantEntitlement(
  context: MemoryEntitlementContext,
  input: Parameters<Store["redeemActivationCodeAndGrantEntitlement"]>[0],
): ReturnType<Store["redeemActivationCodeAndGrantEntitlement"]> {
  return context.atomic.run(async () => {
    const session = context.state.sessions.find((record) =>
      record.tokenHash === input.sessionTokenHash && record.revokedAt === null && record.expiresAt > input.now,
    );
    if (!session) return { status: "session_invalid" };
    const code = await findActivationCodeByHash(context, input.codeHash);
    if (!code || code.status !== "active" || code.redeemedAt !== null || code.redeemBy <= input.now) {
      return { status: "code_invalid" };
    }
    const redeemed = await markActivationCodeRedeemed(context, input.codeHash, session.userId, input.now);
    if (!redeemed) return { status: "code_invalid" };
    const existing = await getEntitlement(context, session.userId);
    const active = Boolean(existing && existing.expiresAt > input.now);
    const base = active && existing ? existing.expiresAt : input.now;
    const quota = active && existing
      ? { llmQuotaLimit: existing.llmQuotaLimit + input.llmQuotaPerActivation, llmQuotaUsed: existing.llmQuotaUsed }
      : { llmQuotaLimit: input.llmQuotaPerActivation, llmQuotaUsed: 0 };
    const entitlement = await upsertEntitlement(
      context, session.userId, new Date(base.getTime() + redeemed.entitlementDays * 86_400_000), input.now, quota,
    );
    return { status: "redeemed", entitlement };
  });
}

export async function listActivationCodes(
  context: MemoryEntitlementContext,
): ReturnType<Store["listActivationCodes"]> {
  return [...context.state.activationCodes].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

async function createAdminEntitlementAdjustment(
  context: MemoryEntitlementContext, input: AdminEntitlementAdjustmentRecord,
): Promise<AdminEntitlementAdjustmentRecord> {
  context.state.adminEntitlementAdjustments.push(input);
  return input;
}

export async function applyEntitlementAdjustmentWithAudit(
  context: MemoryEntitlementContext,
  input: Parameters<Store["applyEntitlementAdjustmentWithAudit"]>[0],
): ReturnType<Store["applyEntitlementAdjustmentWithAudit"]> {
  return context.atomic.run(async () => {
    if (!context.state.users.some(({ id }) => id === input.userId)) return { status: "user_not_found" };
    const before = await getEntitlement(context, input.userId);
    const beforeExpiresAt = before ? new Date(before.expiresAt) : null;
    const beforeLlmQuotaLimit = before?.llmQuotaLimit ?? 0;
    const beforeLlmQuotaUsed = before?.llmQuotaUsed ?? 0;
    const base = beforeExpiresAt && beforeExpiresAt > input.now ? beforeExpiresAt : input.now;
    const extended = input.extendDays === undefined ? null : new Date(base.getTime() + input.extendDays * 86_400_000);
    const afterExpiresAt = input.expiresAt ?? extended ?? beforeExpiresAt;
    if (!afterExpiresAt) return { status: "expiry_required" };
    const entitlement = await upsertEntitlement(context, input.userId, afterExpiresAt, input.now, {
      llmQuotaLimit: beforeLlmQuotaLimit + (input.quotaAdd ?? 0), llmQuotaUsed: beforeLlmQuotaUsed,
    });
    const adjustment: AdminEntitlementAdjustmentRecord = {
      id: `adj_${context.allocateId()}`, adminEmail: input.adminEmail, userId: input.userId,
      reason: input.reason, note: input.note, beforeExpiresAt, afterExpiresAt: entitlement.expiresAt,
      beforeLlmQuotaLimit, afterLlmQuotaLimit: entitlement.llmQuotaLimit,
      beforeLlmQuotaUsed, afterLlmQuotaUsed: entitlement.llmQuotaUsed, createdAt: input.now,
    };
    await createAdminEntitlementAdjustment(context, adjustment);
    return { status: "applied", entitlement, adjustment };
  });
}

export async function listAdminEntitlementAdjustments(
  context: MemoryEntitlementContext, limit = 50,
): ReturnType<Store["listAdminEntitlementAdjustments"]> {
  return [...context.state.adminEntitlementAdjustments]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).slice(0, limit);
}
