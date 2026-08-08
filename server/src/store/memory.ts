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

  get users(): readonly UserRecord[] { return structuredClone(this.state.users); }
  get emailOtps(): readonly EmailOtpRecord[] { return structuredClone(this.state.emailOtps); }
  get desktopLoginTickets(): readonly DesktopLoginTicketRecord[] { return structuredClone(this.state.desktopLoginTickets); }
  get sessions(): readonly SessionRecord[] { return structuredClone(this.state.sessions); }
  get orders(): readonly OrderRecord[] { return structuredClone(this.state.orders); }
  get entitlements(): readonly EntitlementRecord[] { return structuredClone(this.state.entitlements); }
  get llmConfig(): Readonly<LlmConfigRecord> | null { return structuredClone(this.state.llmConfig); }
  get llmUsageEvents(): readonly LlmUsageEventRecord[] { return structuredClone(this.state.llmUsageEvents); }
  get activationCodes(): readonly ActivationCodeRecord[] { return structuredClone(this.state.activationCodes); }
  get adminSessions(): readonly AdminSessionRecord[] { return structuredClone(this.state.adminSessions); }
  get adminEntitlementAdjustments(): readonly AdminEntitlementAdjustmentRecord[] { return structuredClone(this.state.adminEntitlementAdjustments); }
  get webhookEvents(): readonly WebhookEventRecord[] { return structuredClone(this.state.webhookEvents); }
  get authRateLimits(): readonly AuthRateLimitRecord[] { return structuredClone(this.state.authRateLimits); }
  get userSessions(): readonly UserSessionRecord[] { return structuredClone(this.state.userSessions); }

  private context(): auth.MemoryAuthContext {
    return { state: this.state, atomic: this.atomic, allocateId: () => this.createId() };
  }

  private clone<Value>(value: Value): Value {
    return structuredClone(value);
  }

  private async detach<Result>(operation: Promise<Result>): Promise<Result> {
    return this.clone(await operation);
  }

  upsertUserByEmail(email: string, now: Date): ReturnType<Store["upsertUserByEmail"]> {
    return this.detach(auth.upsertUserByEmail(this.context(), email, this.clone(now)));
  }
  getUserById(userId: string): ReturnType<Store["getUserById"]> {
    return this.detach(auth.getUserById(this.context(), userId));
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
    return this.detach(auth.createSession(this.context(), this.clone(input)));
  }
  findSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findSessionByTokenHash"]> {
    return this.detach(auth.findSessionByTokenHash(this.context(), tokenHash, this.clone(now)));
  }
  revokeSession(tokenHash: string, now: Date): ReturnType<Store["revokeSession"]> {
    return this.detach(auth.revokeSession(this.context(), tokenHash, this.clone(now)));
  }
  createOrder(input: Parameters<Store["createOrder"]>[0]): ReturnType<Store["createOrder"]> {
    return this.detach(billing.createOrder(this.context(), this.clone(input)));
  }
  findOrderByOutTradeNo(outTradeNo: string): ReturnType<Store["findOrderByOutTradeNo"]> {
    return this.detach(billing.findOrderByOutTradeNo(this.context(), outTradeNo));
  }
  settlePaidOrder(input: Parameters<Store["settlePaidOrder"]>[0]): ReturnType<Store["settlePaidOrder"]> {
    return this.detach(billing.settlePaidOrder(this.context(), this.clone(input)));
  }
  getEntitlement(userId: string): ReturnType<Store["getEntitlement"]> {
    return this.detach(entitlements.getEntitlement(this.context(), userId));
  }
  upsertEntitlement(userId: string, expiresAt: Date, now: Date, quota?: { llmQuotaLimit?: number; llmQuotaUsed?: number }): ReturnType<Store["upsertEntitlement"]> {
    return this.detach(entitlements.upsertEntitlement(
      this.context(), userId, this.clone(expiresAt), this.clone(now), this.clone(quota),
    ));
  }
  consumeLlmQuota(userId: string, requestId: string, now: Date): ReturnType<Store["consumeLlmQuota"]> {
    return this.detach(entitlements.consumeLlmQuota(this.context(), userId, requestId, this.clone(now)));
  }
  getLlmConfig(): ReturnType<Store["getLlmConfig"]> {
    return this.detach(llmConfig.getLlmConfig(this.context()));
  }
  upsertLlmConfig(input: Parameters<Store["upsertLlmConfig"]>[0], now: Date): ReturnType<Store["upsertLlmConfig"]> {
    return this.detach(llmConfig.upsertLlmConfig(this.context(), this.clone(input), this.clone(now)));
  }
  createActivationCode(input: Parameters<Store["createActivationCode"]>[0]): ReturnType<Store["createActivationCode"]> {
    return this.detach(entitlements.createActivationCode(this.context(), this.clone(input)));
  }
  findActivationCodeByHash(codeHash: string): ReturnType<Store["findActivationCodeByHash"]> {
    return this.detach(entitlements.findActivationCodeByHash(this.context(), codeHash));
  }
  redeemActivationCodeAndGrantEntitlement(input: Parameters<Store["redeemActivationCodeAndGrantEntitlement"]>[0]): ReturnType<Store["redeemActivationCodeAndGrantEntitlement"]> {
    return this.detach(entitlements.redeemActivationCodeAndGrantEntitlement(this.context(), this.clone(input)));
  }
  listActivationCodes(): ReturnType<Store["listActivationCodes"]> {
    return this.detach(entitlements.listActivationCodes(this.context()));
  }
  listUsers(): ReturnType<Store["listUsers"]> {
    return this.detach(auth.listUsers(this.context()));
  }
  createAdminSession(input: Parameters<Store["createAdminSession"]>[0]): ReturnType<Store["createAdminSession"]> {
    return this.detach(auth.createAdminSession(this.context(), this.clone(input)));
  }
  findAdminSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findAdminSessionByTokenHash"]> {
    return this.detach(auth.findAdminSessionByTokenHash(this.context(), tokenHash, this.clone(now)));
  }
  revokeAdminSession(tokenHash: string, now: Date): ReturnType<Store["revokeAdminSession"]> {
    return this.detach(auth.revokeAdminSession(this.context(), tokenHash, this.clone(now)));
  }
  createUserSession(input: Parameters<Store["createUserSession"]>[0]): ReturnType<Store["createUserSession"]> {
    return this.detach(userSession.createUserSession(this.context(), this.clone(input)));
  }
  findUserSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findUserSessionByTokenHash"]> {
    return this.detach(userSession.findUserSessionByTokenHash(this.context(), tokenHash, this.clone(now)));
  }
  revokeUserSession(tokenHash: string, now: Date): ReturnType<Store["revokeUserSession"]> {
    return this.detach(userSession.revokeUserSession(this.context(), tokenHash, this.clone(now)));
  }
  applyEntitlementAdjustmentWithAudit(input: Parameters<Store["applyEntitlementAdjustmentWithAudit"]>[0]): ReturnType<Store["applyEntitlementAdjustmentWithAudit"]> {
    return this.detach(entitlements.applyEntitlementAdjustmentWithAudit(this.context(), this.clone(input)));
  }
  listAdminEntitlementAdjustments(limit?: number): ReturnType<Store["listAdminEntitlementAdjustments"]> {
    return this.detach(entitlements.listAdminEntitlementAdjustments(this.context(), limit));
  }
}
