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

  upsertUserByEmail(email: string, now: Date): ReturnType<Store["upsertUserByEmail"]> {
    return auth.upsertUserByEmail(this.context(), email, now);
  }
  getUserById(userId: string): ReturnType<Store["getUserById"]> { return auth.getUserById(this.context(), userId); }
  issueEmailOtp(input: Parameters<Store["issueEmailOtp"]>[0]): ReturnType<Store["issueEmailOtp"]> {
    return auth.issueEmailOtp(this.context(), input);
  }
  invalidateIssuedOtpAfterDeliveryFailure(otpId: string, now: Date): ReturnType<Store["invalidateIssuedOtpAfterDeliveryFailure"]> {
    return auth.invalidateIssuedOtpAfterDeliveryFailure(this.context(), otpId, now);
  }
  verifyDesktopOtpAndCreateTicket(input: Parameters<Store["verifyDesktopOtpAndCreateTicket"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicket"]> {
    return auth.verifyDesktopOtpAndCreateTicket(this.context(), input);
  }
  verifyDesktopOtpAndCreateTicketAndWebSession(input: Parameters<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]> {
    return userSession.verifyDesktopOtpAndCreateTicketAndWebSession(this.context(), input);
  }
  verifyAdminOtpAndCreateSession(input: Parameters<Store["verifyAdminOtpAndCreateSession"]>[0]): ReturnType<Store["verifyAdminOtpAndCreateSession"]> {
    return auth.verifyAdminOtpAndCreateSession(this.context(), input);
  }
  verifyUserOtpAndCreateWebSession(input: Parameters<Store["verifyUserOtpAndCreateWebSession"]>[0]): ReturnType<Store["verifyUserOtpAndCreateWebSession"]> {
    return userSession.verifyUserOtpAndCreateWebSession(this.context(), input);
  }
  exchangeDesktopTicketAndCreateSession(input: Parameters<Store["exchangeDesktopTicketAndCreateSession"]>[0]): ReturnType<Store["exchangeDesktopTicketAndCreateSession"]> {
    return auth.exchangeDesktopTicketAndCreateSession(this.context(), input);
  }
  createSession(input: Parameters<Store["createSession"]>[0]): ReturnType<Store["createSession"]> { return auth.createSession(this.context(), input); }
  findSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findSessionByTokenHash"]> {
    return auth.findSessionByTokenHash(this.context(), tokenHash, now);
  }
  revokeSession(tokenHash: string, now: Date): ReturnType<Store["revokeSession"]> { return auth.revokeSession(this.context(), tokenHash, now); }
  createOrder(input: Parameters<Store["createOrder"]>[0]): ReturnType<Store["createOrder"]> { return billing.createOrder(this.context(), input); }
  findOrderByOutTradeNo(outTradeNo: string): ReturnType<Store["findOrderByOutTradeNo"]> { return billing.findOrderByOutTradeNo(this.context(), outTradeNo); }
  settlePaidOrder(input: Parameters<Store["settlePaidOrder"]>[0]): ReturnType<Store["settlePaidOrder"]> { return billing.settlePaidOrder(this.context(), input); }
  getEntitlement(userId: string): ReturnType<Store["getEntitlement"]> { return entitlements.getEntitlement(this.context(), userId); }
  upsertEntitlement(userId: string, expiresAt: Date, now: Date, quota?: { llmQuotaLimit?: number; llmQuotaUsed?: number }): ReturnType<Store["upsertEntitlement"]> {
    return entitlements.upsertEntitlement(this.context(), userId, expiresAt, now, quota);
  }
  consumeLlmQuota(userId: string, requestId: string, now: Date): ReturnType<Store["consumeLlmQuota"]> {
    return entitlements.consumeLlmQuota(this.context(), userId, requestId, now);
  }
  getLlmConfig(): ReturnType<Store["getLlmConfig"]> { return llmConfig.getLlmConfig(this.context()); }
  upsertLlmConfig(input: Parameters<Store["upsertLlmConfig"]>[0], now: Date): ReturnType<Store["upsertLlmConfig"]> {
    return llmConfig.upsertLlmConfig(this.context(), input, now);
  }
  createActivationCode(input: Parameters<Store["createActivationCode"]>[0]): ReturnType<Store["createActivationCode"]> {
    return entitlements.createActivationCode(this.context(), input);
  }
  findActivationCodeByHash(codeHash: string): ReturnType<Store["findActivationCodeByHash"]> {
    return entitlements.findActivationCodeByHash(this.context(), codeHash);
  }
  redeemActivationCodeAndGrantEntitlement(input: Parameters<Store["redeemActivationCodeAndGrantEntitlement"]>[0]): ReturnType<Store["redeemActivationCodeAndGrantEntitlement"]> {
    return entitlements.redeemActivationCodeAndGrantEntitlement(this.context(), input);
  }
  listActivationCodes(): ReturnType<Store["listActivationCodes"]> { return entitlements.listActivationCodes(this.context()); }
  listUsers(): ReturnType<Store["listUsers"]> { return auth.listUsers(this.context()); }
  createAdminSession(input: Parameters<Store["createAdminSession"]>[0]): ReturnType<Store["createAdminSession"]> {
    return auth.createAdminSession(this.context(), input);
  }
  findAdminSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findAdminSessionByTokenHash"]> {
    return auth.findAdminSessionByTokenHash(this.context(), tokenHash, now);
  }
  revokeAdminSession(tokenHash: string, now: Date): ReturnType<Store["revokeAdminSession"]> {
    return auth.revokeAdminSession(this.context(), tokenHash, now);
  }
  createUserSession(input: Parameters<Store["createUserSession"]>[0]): ReturnType<Store["createUserSession"]> {
    return userSession.createUserSession(this.context(), input);
  }
  findUserSessionByTokenHash(tokenHash: string, now: Date): ReturnType<Store["findUserSessionByTokenHash"]> {
    return userSession.findUserSessionByTokenHash(this.context(), tokenHash, now);
  }
  revokeUserSession(tokenHash: string, now: Date): ReturnType<Store["revokeUserSession"]> {
    return userSession.revokeUserSession(this.context(), tokenHash, now);
  }
  applyEntitlementAdjustmentWithAudit(input: Parameters<Store["applyEntitlementAdjustmentWithAudit"]>[0]): ReturnType<Store["applyEntitlementAdjustmentWithAudit"]> {
    return entitlements.applyEntitlementAdjustmentWithAudit(this.context(), input);
  }
  listAdminEntitlementAdjustments(limit?: number): ReturnType<Store["listAdminEntitlementAdjustments"]> {
    return entitlements.listAdminEntitlementAdjustments(this.context(), limit);
  }
}
