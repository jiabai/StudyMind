import { randomUUID } from "node:crypto";
import type {
  ActivationCodeRecord, AdminEntitlementAdjustmentRecord, AdminSessionRecord, AuthRateLimitRecord,
  DesktopLoginTicketRecord, EmailOtpRecord, EntitlementRecord, LlmConfigRecord, LlmUsageEventRecord,
  OrderRecord, SessionRecord, Store, UserRecord, UserSessionRecord, WebhookEventRecord,
} from "./contracts.js";
import { MemoryAtomicCoordinator, type MemoryState } from "./memory/atomic.js";
import * as auth from "./memory/auth.js";
import * as billing from "./memory/billing.js";
import * as entitlements from "./memory/entitlements.js";
import * as llmConfig from "./memory/llmConfig.js";
import * as userSession from "./memory/userSession.js";

export type MemoryStoreDependencies = { createId?: () => string };

export class MemoryStore implements Store {
  private readonly state: MemoryState = {
    users: [], emailOtps: [], desktopLoginTickets: [], sessions: [], orders: [], entitlements: [],
    llmConfig: null, llmUsageEvents: [], activationCodes: [], adminSessions: [],
    adminEntitlementAdjustments: [], webhookEvents: [], authRateLimits: [], userSessions: [],
  };
  private readonly atomic = new MemoryAtomicCoordinator(this.state);
  private readonly createId: () => string;

  constructor(dependencies: MemoryStoreDependencies = {}) {
    this.createId = dependencies.createId ?? randomUUID;
  }

  get users(): readonly UserRecord[] { return this.atomic.snapshot().users; }
  get emailOtps(): readonly EmailOtpRecord[] { return this.atomic.snapshot().emailOtps; }
  get desktopLoginTickets(): readonly DesktopLoginTicketRecord[] { return this.atomic.snapshot().desktopLoginTickets; }
  get sessions(): readonly SessionRecord[] { return this.atomic.snapshot().sessions; }
  get orders(): readonly OrderRecord[] { return this.atomic.snapshot().orders; }
  get entitlements(): readonly EntitlementRecord[] { return this.atomic.snapshot().entitlements; }
  get llmConfig(): Readonly<LlmConfigRecord> | null { return this.atomic.snapshot().llmConfig; }
  get llmUsageEvents(): readonly LlmUsageEventRecord[] { return this.atomic.snapshot().llmUsageEvents; }
  get activationCodes(): readonly ActivationCodeRecord[] { return this.atomic.snapshot().activationCodes; }
  get adminSessions(): readonly AdminSessionRecord[] { return this.atomic.snapshot().adminSessions; }
  get adminEntitlementAdjustments(): readonly AdminEntitlementAdjustmentRecord[] { return this.atomic.snapshot().adminEntitlementAdjustments; }
  get webhookEvents(): readonly WebhookEventRecord[] { return this.atomic.snapshot().webhookEvents; }
  get authRateLimits(): readonly AuthRateLimitRecord[] { return this.atomic.snapshot().authRateLimits; }
  get userSessions(): readonly UserSessionRecord[] { return this.atomic.snapshot().userSessions; }

  private context(): auth.MemoryAuthContext {
    return { state: this.state, atomic: this.atomic, allocateId: () => this.createId() };
  }

  private clone<Value>(value: Value): Value {
    return structuredClone(value);
  }

  private async detach<Result>(operation: Promise<Result>): Promise<Result> {
    return this.clone(await operation);
  }

  private isolate<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.detach(this.atomic.run(operation));
  }

  upsertUserByEmail(email: string, now: Date): ReturnType<Store["upsertUserByEmail"]> {
    const detachedNow = this.clone(now);
    return this.isolate(() => auth.upsertUserByEmail(this.context(), email, detachedNow));
  }
  getUserById(userId: string): ReturnType<Store["getUserById"]> {
    return this.isolate(() => auth.getUserById(this.context(), userId));
  }
  issueEmailOtp(input: Parameters<Store["issueEmailOtp"]>[0]): ReturnType<Store["issueEmailOtp"]> {
    return this.detach(auth.issueEmailOtp(this.context(), this.clone(input)));
  }
  invalidateIssuedOtpAfterDeliveryFailure(otpId: string, now: Date): ReturnType<Store["invalidateIssuedOtpAfterDeliveryFailure"]> {
    return this.detach(auth.invalidateIssuedOtpAfterDeliveryFailure(this.context(), otpId, this.clone(now)));
  }
  verifyDesktopOtpAndCreateTicket(input: Parameters<Store["verifyDesktopOtpAndCreateTicket"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicket"]> {
    return this.detach(auth.verifyDesktopOtpAndCreateTicket(this.context(), this.clone(input)));
  }
  verifyDesktopOtpAndCreateTicketAndWebSession(input: Parameters<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]> {
    return this.detach(userSession.verifyDesktopOtpAndCreateTicketAndWebSession(this.context(), this.clone(input)));
  }
  verifyAdminOtpAndCreateSession(input: Parameters<Store["verifyAdminOtpAndCreateSession"]>[0]): ReturnType<Store["verifyAdminOtpAndCreateSession"]> {
    return this.detach(auth.verifyAdminOtpAndCreateSession(this.context(), this.clone(input)));
  }
  verifyUserOtpAndCreateWebSession(input: Parameters<Store["verifyUserOtpAndCreateWebSession"]>[0]): ReturnType<Store["verifyUserOtpAndCreateWebSession"]> {
    return this.detach(userSession.verifyUserOtpAndCreateWebSession(this.context(), this.clone(input)));
  }
  exchangeDesktopTicketAndCreateSession(input: Parameters<Store["exchangeDesktopTicketAndCreateSession"]>[0]): ReturnType<Store["exchangeDesktopTicketAndCreateSession"]> {
    return this.detach(auth.exchangeDesktopTicketAndCreateSession(this.context(), this.clone(input)));
  }
  createSession(input: Parameters<Store["createSession"]>[0]): ReturnType<Store["createSession"]> {
    const detachedInput = this.clone(input);
    return this.isolate(() => auth.createSession(this.context(), detachedInput));
  }
  findSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findSessionByTokenHash"]> {
    const detachedNow = this.clone(now);
    return this.isolate(() => auth.findSessionByTokenHash(this.context(), tokenHash, detachedNow));
  }
  revokeSession(tokenHash: string, now: Date): ReturnType<Store["revokeSession"]> {
    const detachedNow = this.clone(now);
    return this.isolate(() => auth.revokeSession(this.context(), tokenHash, detachedNow));
  }
  createOrder(input: Parameters<Store["createOrder"]>[0]): ReturnType<Store["createOrder"]> {
    const detachedInput = this.clone(input);
    return this.isolate(() => billing.createOrder(this.context(), detachedInput));
  }
  findOrderByOutTradeNo(outTradeNo: string): ReturnType<Store["findOrderByOutTradeNo"]> {
    return this.isolate(() => billing.findOrderByOutTradeNo(this.context(), outTradeNo));
  }
  settlePaidOrder(input: Parameters<Store["settlePaidOrder"]>[0]): ReturnType<Store["settlePaidOrder"]> {
    return this.detach(billing.settlePaidOrder(this.context(), this.clone(input)));
  }
  getEntitlement(userId: string): ReturnType<Store["getEntitlement"]> {
    return this.isolate(() => entitlements.getEntitlement(this.context(), userId));
  }
  upsertEntitlement(userId: string, expiresAt: Date, now: Date, quota?: { llmQuotaLimit?: number; llmQuotaUsed?: number }): ReturnType<Store["upsertEntitlement"]> {
    const detachedExpiresAt = this.clone(expiresAt);
    const detachedNow = this.clone(now);
    const detachedQuota = this.clone(quota);
    return this.isolate(() => entitlements.upsertEntitlement(
      this.context(), userId, detachedExpiresAt, detachedNow, detachedQuota,
    ));
  }
  consumeLlmQuota(userId: string, requestId: string, now: Date): ReturnType<Store["consumeLlmQuota"]> {
    return this.detach(entitlements.consumeLlmQuota(this.context(), userId, requestId, this.clone(now)));
  }
  getLlmConfig(): ReturnType<Store["getLlmConfig"]> {
    return this.isolate(() => llmConfig.getLlmConfig(this.context()));
  }
  upsertLlmConfig(input: Parameters<Store["upsertLlmConfig"]>[0], now: Date): ReturnType<Store["upsertLlmConfig"]> {
    const detachedInput = this.clone(input);
    const detachedNow = this.clone(now);
    return this.isolate(() => llmConfig.upsertLlmConfig(this.context(), detachedInput, detachedNow));
  }
  createActivationCode(input: Parameters<Store["createActivationCode"]>[0]): ReturnType<Store["createActivationCode"]> {
    const detachedInput = this.clone(input);
    return this.isolate(() => entitlements.createActivationCode(this.context(), detachedInput));
  }
  findActivationCodeByHash(codeHash: string): ReturnType<Store["findActivationCodeByHash"]> {
    return this.isolate(() => entitlements.findActivationCodeByHash(this.context(), codeHash));
  }
  redeemActivationCodeAndGrantEntitlement(input: Parameters<Store["redeemActivationCodeAndGrantEntitlement"]>[0]): ReturnType<Store["redeemActivationCodeAndGrantEntitlement"]> {
    return this.detach(entitlements.redeemActivationCodeAndGrantEntitlement(this.context(), this.clone(input)));
  }
  listActivationCodes(): ReturnType<Store["listActivationCodes"]> {
    return this.isolate(() => entitlements.listActivationCodes(this.context()));
  }
  listUsers(): ReturnType<Store["listUsers"]> {
    return this.isolate(() => auth.listUsers(this.context()));
  }
  createAdminSession(input: Parameters<Store["createAdminSession"]>[0]): ReturnType<Store["createAdminSession"]> {
    const detachedInput = this.clone(input);
    return this.isolate(() => auth.createAdminSession(this.context(), detachedInput));
  }
  findAdminSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findAdminSessionByTokenHash"]> {
    const detachedNow = this.clone(now);
    return this.isolate(() => auth.findAdminSessionByTokenHash(this.context(), tokenHash, detachedNow));
  }
  revokeAdminSession(tokenHash: string, now: Date): ReturnType<Store["revokeAdminSession"]> {
    const detachedNow = this.clone(now);
    return this.isolate(() => auth.revokeAdminSession(this.context(), tokenHash, detachedNow));
  }
  createUserSession(input: Parameters<Store["createUserSession"]>[0]): ReturnType<Store["createUserSession"]> {
    const detachedInput = this.clone(input);
    return this.isolate(() => userSession.createUserSession(this.context(), detachedInput));
  }
  findUserSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findUserSessionByTokenHash"]> {
    const detachedNow = this.clone(now);
    return this.isolate(() => userSession.findUserSessionByTokenHash(this.context(), tokenHash, detachedNow));
  }
  revokeUserSession(tokenHash: string, now: Date): ReturnType<Store["revokeUserSession"]> {
    const detachedNow = this.clone(now);
    return this.isolate(() => userSession.revokeUserSession(this.context(), tokenHash, detachedNow));
  }
  applyEntitlementAdjustmentWithAudit(input: Parameters<Store["applyEntitlementAdjustmentWithAudit"]>[0]): ReturnType<Store["applyEntitlementAdjustmentWithAudit"]> {
    return this.detach(entitlements.applyEntitlementAdjustmentWithAudit(this.context(), this.clone(input)));
  }
  listAdminEntitlementAdjustments(limit?: number): ReturnType<Store["listAdminEntitlementAdjustments"]> {
    return this.isolate(() => entitlements.listAdminEntitlementAdjustments(this.context(), limit));
  }
}
