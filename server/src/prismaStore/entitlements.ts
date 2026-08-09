import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ActivationCodeRecord, AdminEntitlementAdjustmentRecord, EntitlementRecord, Store } from "../store/contracts.js";
import { StoreConflictError } from "../store/contracts.js";
import { assertEntitlementAdjustmentResult, assertEntitlementResult } from "../entitlementAdjustment.js";
import { isUnique, withConflictRetry } from "./concurrency.js";

export async function getEntitlement(prisma: PrismaClient, userId: string): ReturnType<Store["getEntitlement"]> { return await prisma.entitlement.findUnique({ where: { userId } }) as EntitlementRecord | null; }
export async function upsertEntitlement(prisma: PrismaClient, userId: string, expiresAt: Date, now: Date, quota: Parameters<Store["upsertEntitlement"]>[3] = {}): ReturnType<Store["upsertEntitlement"]> {
  const updates = { ...(quota?.llmQuotaLimit !== undefined ? { llmQuotaLimit: quota.llmQuotaLimit } : {}), ...(quota?.llmQuotaUsed !== undefined ? { llmQuotaUsed: quota.llmQuotaUsed } : {}) };
  return await prisma.entitlement.upsert({ where: { userId }, update: { status: expiresAt > now ? "active" : "inactive", expiresAt, ...updates, updatedAt: now }, create: { id: randomUUID(), userId, status: expiresAt > now ? "active" : "inactive", expiresAt, llmQuotaLimit: quota?.llmQuotaLimit ?? 0, llmQuotaUsed: quota?.llmQuotaUsed ?? 0, updatedAt: now } }) as EntitlementRecord;
}

export async function consumeLlmQuota(prisma: PrismaClient, userId: string, requestId: string, now: Date): ReturnType<Store["consumeLlmQuota"]> {
  const result = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    const existing = await tx.llmUsageEvent.findUnique({ where: { userId_requestId: { userId, requestId } } });
    const current = await tx.entitlement.findUnique({ where: { userId } });
    if (!current || current.expiresAt <= now) return { status: "unavailable" } as const;
    if (existing) return { status: "reused", entitlement: current as EntitlementRecord } as const;
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`UPDATE "Entitlement" SET "llmQuotaUsed"="llmQuotaUsed"+1,"updatedAt"=${now} WHERE "userId"=${userId} AND "expiresAt">${now} AND "llmQuotaUsed"<"llmQuotaLimit" RETURNING "id"`);
    if (!rows[0]) return { status: "unavailable" } as const;
    const updated = await tx.entitlement.findUniqueOrThrow({ where: { id: rows[0].id } });
    try { await tx.llmUsageEvent.create({ data: { id: randomUUID(), userId: updated.userId, entitlementId: updated.id, requestId, createdAt: now } }); }
    catch (error) {
      if (!isUnique(error)) throw error;
      throw new Prisma.PrismaClientKnownRequestError("idempotency conflict", { code: "P2034", clientVersion: Prisma.prismaVersion.client });
    }
    return { status: "consumed", entitlement: updated as EntitlementRecord } as const;
  }));
  return result;
}

export async function createActivationCode(prisma: PrismaClient, input: Parameters<Store["createActivationCode"]>[0]): ReturnType<Store["createActivationCode"]> { try { return await prisma.activationCode.create({ data: { ...input, id: randomUUID() } }) as ActivationCodeRecord; } catch (error) { if (isUnique(error)) throw new StoreConflictError("ActivationCode.codeHash"); throw error; } }
export async function findActivationCodeByHash(prisma: PrismaClient, codeHash: string): ReturnType<Store["findActivationCodeByHash"]> { return await prisma.activationCode.findUnique({ where: { codeHash } }) as ActivationCodeRecord | null; }
export async function redeemActivationCodeAndGrantEntitlement(prisma: PrismaClient, input: Parameters<Store["redeemActivationCodeAndGrantEntitlement"]>[0]): ReturnType<Store["redeemActivationCodeAndGrantEntitlement"]> {
  const result = await withConflictRetry(() => prisma.$transaction(async (tx) => {
    const session = await tx.session.findFirst({ where: { tokenHash: input.sessionTokenHash, revokedAt: null, expiresAt: { gt: input.now } } });
    if (!session) return { status: "session_invalid" } as const;
    const code = await tx.activationCode.findFirst({ where: { codeHash: input.codeHash, status: "active", redeemedAt: null, redeemBy: { gt: input.now } } });
    if (!code) return { status: "code_invalid" } as const;
    const before = await tx.entitlement.findUnique({ where: { userId: session.userId } });
    const active = Boolean(before && before.expiresAt > input.now); const base = active && before ? before.expiresAt : input.now;
    const expiresAt = new Date(base.getTime() + code.entitlementDays * 86_400_000);
    const llmQuotaLimit = active && before ? before.llmQuotaLimit + input.llmQuotaPerActivation : input.llmQuotaPerActivation;
    const llmQuotaUsed = active && before ? before.llmQuotaUsed : 0;
    assertEntitlementResult({ expiresAt, llmQuotaLimit, llmQuotaUsed });
    const claim = await tx.activationCode.updateMany({ where: { id: code.id, status: "active", redeemedAt: null }, data: { status: "redeemed", redeemedAt: input.now, redeemedByUserId: session.userId } });
    if (claim.count !== 1) return { status: "code_invalid" } as const;
    const entitlement = await tx.entitlement.upsert({ where: { userId: session.userId }, update: { status: "active", expiresAt, llmQuotaLimit, llmQuotaUsed, updatedAt: input.now }, create: { id: randomUUID(), userId: session.userId, status: "active", expiresAt, llmQuotaLimit, llmQuotaUsed, updatedAt: input.now } });
    return { status: "redeemed", entitlement: entitlement as EntitlementRecord } as const;
  }));
  return result;
}
export async function listActivationCodes(prisma: PrismaClient): ReturnType<Store["listActivationCodes"]> { return await prisma.activationCode.findMany({ orderBy: { createdAt: "desc" } }) as ActivationCodeRecord[]; }

export async function applyEntitlementAdjustmentWithAudit(prisma: PrismaClient, input: Parameters<Store["applyEntitlementAdjustmentWithAudit"]>[0]): ReturnType<Store["applyEntitlementAdjustmentWithAudit"]> {
  return prisma.$transaction(async (tx) => {
    if (!await tx.user.findUnique({ where: { id: input.userId } })) return { status: "user_not_found" };
    const before = await tx.entitlement.findUnique({ where: { userId: input.userId } }); const beforeExpiresAt = before?.expiresAt ?? null;
    const base = beforeExpiresAt && beforeExpiresAt > input.now ? beforeExpiresAt : input.now;
    const afterExpiresAt = input.expiresAt ?? (input.extendDays !== undefined ? new Date(base.getTime() + input.extendDays * 86_400_000) : beforeExpiresAt);
    if (!afterExpiresAt) return { status: "expiry_required" };
    const beforeLimit = before?.llmQuotaLimit ?? 0; const beforeUsed = before?.llmQuotaUsed ?? 0;
    const afterLimit = beforeLimit + (input.quotaAdd ?? 0);
    assertEntitlementAdjustmentResult({ afterExpiresAt, afterLlmQuotaLimit: afterLimit, beforeLlmQuotaUsed: beforeUsed });
    const entitlement = await tx.entitlement.upsert({ where: { userId: input.userId }, update: { status: afterExpiresAt > input.now ? "active" : "inactive", expiresAt: afterExpiresAt, llmQuotaLimit: afterLimit, llmQuotaUsed: beforeUsed, updatedAt: input.now }, create: { id: randomUUID(), userId: input.userId, status: afterExpiresAt > input.now ? "active" : "inactive", expiresAt: afterExpiresAt, llmQuotaLimit: afterLimit, llmQuotaUsed: beforeUsed, updatedAt: input.now } });
    const adjustment = await tx.adminEntitlementAdjustment.create({ data: { id: randomUUID(), adminEmail: input.adminEmail, userId: input.userId, reason: input.reason, note: input.note, beforeExpiresAt, afterExpiresAt, beforeLlmQuotaLimit: beforeLimit, afterLlmQuotaLimit: entitlement.llmQuotaLimit, beforeLlmQuotaUsed: beforeUsed, afterLlmQuotaUsed: entitlement.llmQuotaUsed, createdAt: input.now } });
    return { status: "applied", entitlement: entitlement as EntitlementRecord, adjustment: adjustment as AdminEntitlementAdjustmentRecord };
  });
}
export async function listAdminEntitlementAdjustments(prisma: PrismaClient, limit = 50): ReturnType<Store["listAdminEntitlementAdjustments"]> { return await prisma.adminEntitlementAdjustment.findMany({ orderBy: { createdAt: "desc" }, take: limit }) as AdminEntitlementAdjustmentRecord[]; }
