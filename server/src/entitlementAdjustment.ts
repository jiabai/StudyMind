import type { Store } from "./store.js";

type AdjustmentStore = Pick<Store, "applyEntitlementAdjustmentWithAudit">;

export class EntitlementAdjustmentService {
  private readonly now: () => Date;

  constructor(private readonly options: { store: AdjustmentStore; now?: () => Date }) {
    this.now = options.now ?? (() => new Date());
  }

  async apply(input: {
    adminEmail: string; userId: string; reason: string; note?: string;
    extendDays?: number; expiresAt?: Date; quotaAdd?: number;
  }) {
    const now = this.now();
    const reason = input.reason.trim();
    const validDays = input.extendDays === undefined || (Number.isInteger(input.extendDays) && input.extendDays > 0);
    const validCredits = input.quotaAdd === undefined || (Number.isInteger(input.quotaAdd) && input.quotaAdd > 0);
    const validExpiry = input.expiresAt === undefined || (!Number.isNaN(input.expiresAt.getTime()) && input.expiresAt > now);
    const hasExpiryAdjustment = input.extendDays !== undefined || input.expiresAt !== undefined;
    if (!input.adminEmail.trim() || !input.userId.trim() || !reason || reason.length > 160 ||
      !validDays || !validCredits || !validExpiry || (!hasExpiryAdjustment && input.quotaAdd === undefined) ||
      (input.extendDays !== undefined && input.expiresAt !== undefined)) {
      throw new Error("INVALID_ENTITLEMENT_ADJUSTMENT");
    }
    return this.options.store.applyEntitlementAdjustmentWithAudit({
      adminEmail: input.adminEmail.trim().toLowerCase(), userId: input.userId, reason,
      note: input.note?.trim() || null, extendDays: input.extendDays,
      expiresAt: input.expiresAt, quotaAdd: input.quotaAdd, now,
    });
  }
}
