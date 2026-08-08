import { randomInt } from "node:crypto";
import { sha256 } from "./security.js";
import type { ActivationCodeRecord, Store } from "./store.js";

type ActivationStore = Pick<Store, "createActivationCode" | "redeemActivationCodeAndGrantEntitlement">;

const ACTIVATION_CODE_DAYS = 31;
const DEFAULT_REDEEM_BY_DAYS = 30;
const LLM_CREDITS_PER_ACTIVATION = 20;
const CODE_PATTERN = /^SM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export type GeneratedActivationCode = {
  code: string;
  codePrefix: string;
  entitlementDays: number;
  llmCredits: number;
  redeemBy: Date;
  record: ActivationCodeRecord;
};

export class ActivationCodeService {
  private readonly now: () => Date;

  constructor(private readonly options: { store: ActivationStore; now?: () => Date }) {
    this.now = options.now ?? (() => new Date());
  }

  async generateCode(input: { redeemBy?: Date } = {}): Promise<GeneratedActivationCode> {
    const now = this.now();
    const code = generateActivationCode();
    const redeemBy = input.redeemBy ?? new Date(now.getTime() + DEFAULT_REDEEM_BY_DAYS * 86_400_000);
    const record = await this.options.store.createActivationCode({
      codeHash: sha256(code), codePrefix: code.slice(0, 7), status: "active",
      entitlementDays: ACTIVATION_CODE_DAYS, redeemBy, createdAt: now,
      redeemedAt: null, redeemedByUserId: null,
    });
    return {
      code, codePrefix: record.codePrefix, entitlementDays: record.entitlementDays,
      llmCredits: LLM_CREDITS_PER_ACTIVATION, redeemBy: record.redeemBy, record,
    };
  }

  async redeemCode(input: { sessionTokenHash: string; code: string }) {
    const normalized = normalizeActivationCode(input.code);
    if (!CODE_PATTERN.test(normalized)) throw invalidCode();
    const result = await this.options.store.redeemActivationCodeAndGrantEntitlement({
      sessionTokenHash: input.sessionTokenHash, codeHash: sha256(normalized), now: this.now(),
      llmQuotaPerActivation: LLM_CREDITS_PER_ACTIVATION,
    });
    if (result.status !== "redeemed") {
      if (result.status === "session_invalid") throw new Error("Desktop session is invalid or expired.");
      throw invalidCode();
    }
    return { entitlement: result.entitlement, entitlementExpiresAt: result.entitlement.expiresAt };
  }
}

export function normalizeActivationCode(code: string): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function generateActivationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `SM-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
}

function invalidCode(): Error { return new Error("Activation code is invalid or expired."); }

export const activationCodeDays = ACTIVATION_CODE_DAYS;
export const llmQuotaPerActivation = LLM_CREDITS_PER_ACTIVATION;
