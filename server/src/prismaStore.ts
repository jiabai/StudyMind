import type { PrismaClient } from "@prisma/client";
import type { Store } from "./store/contracts.js";
import * as auth from "./prismaStore/auth.js";
import * as billing from "./prismaStore/billing.js";
import * as entitlements from "./prismaStore/entitlements.js";
import * as llm from "./prismaStore/llmConfig.js";
import * as web from "./prismaStore/userSession.js";
import { sanitizeStoreError } from "./prismaStore/concurrency.js";

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient) {}
  private protect<Value>(value: Promise<Value>): Promise<Value> { return value.catch(sanitizeStoreError); }
  upsertUserByEmail(email: string, now: Date): ReturnType<Store["upsertUserByEmail"]> { return auth.upsertUserByEmail(this.prisma, email, now); }
  getUserById(id: string): ReturnType<Store["getUserById"]> { return auth.getUserById(this.prisma, id); }
  issueEmailOtp(input: Parameters<Store["issueEmailOtp"]>[0]): ReturnType<Store["issueEmailOtp"]> { return this.protect(auth.issueEmailOtp(this.prisma, input)); }
  invalidateIssuedOtpAfterDeliveryFailure(id: string, now: Date): ReturnType<Store["invalidateIssuedOtpAfterDeliveryFailure"]> { return auth.invalidateIssuedOtpAfterDeliveryFailure(this.prisma, id, now); }
  verifyDesktopOtpAndCreateTicket(input: Parameters<Store["verifyDesktopOtpAndCreateTicket"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicket"]> { return this.protect(auth.verifyDesktopOtpAndCreateTicket(this.prisma, input)); }
  verifyDesktopOtpAndCreateTicketAndWebSession(input: Parameters<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]> { return this.protect(web.verifyDesktopOtpAndCreateTicketAndWebSession(this.prisma, input)); }
  verifyAdminOtpAndCreateSession(input: Parameters<Store["verifyAdminOtpAndCreateSession"]>[0]): ReturnType<Store["verifyAdminOtpAndCreateSession"]> { return this.protect(auth.verifyAdminOtpAndCreateSession(this.prisma, input)); }
  verifyUserOtpAndCreateWebSession(input: Parameters<Store["verifyUserOtpAndCreateWebSession"]>[0]): ReturnType<Store["verifyUserOtpAndCreateWebSession"]> { return this.protect(web.verifyUserOtpAndCreateWebSession(this.prisma, input)); }
  exchangeDesktopTicketAndCreateSession(input: Parameters<Store["exchangeDesktopTicketAndCreateSession"]>[0]): ReturnType<Store["exchangeDesktopTicketAndCreateSession"]> { return this.protect(auth.exchangeDesktopTicketAndCreateSession(this.prisma, input)); }
  createSession(input: Parameters<Store["createSession"]>[0]): ReturnType<Store["createSession"]> { return auth.createSession(this.prisma, input); }
  findSessionByTokenHash(hash: string, now: Date): ReturnType<Store["findSessionByTokenHash"]> { return auth.findSessionByTokenHash(this.prisma, hash, now); }
  revokeSession(hash: string, now: Date): ReturnType<Store["revokeSession"]> { return auth.revokeSession(this.prisma, hash, now); }
  createOrder(input: Parameters<Store["createOrder"]>[0]): ReturnType<Store["createOrder"]> { return billing.createOrder(this.prisma, input); }
  findOrderByOutTradeNo(value: string): ReturnType<Store["findOrderByOutTradeNo"]> { return billing.findOrderByOutTradeNo(this.prisma, value); }
  settlePaidOrder(input: Parameters<Store["settlePaidOrder"]>[0]): ReturnType<Store["settlePaidOrder"]> { return this.protect(billing.settlePaidOrder(this.prisma, input)); }
  getEntitlement(userId: string): ReturnType<Store["getEntitlement"]> { return entitlements.getEntitlement(this.prisma, userId); }
  upsertEntitlement(userId: string, expiresAt: Date, now: Date, quota?: Parameters<Store["upsertEntitlement"]>[3]): ReturnType<Store["upsertEntitlement"]> { return entitlements.upsertEntitlement(this.prisma, userId, expiresAt, now, quota); }
  consumeLlmQuota(userId: string, requestId: string, now: Date): ReturnType<Store["consumeLlmQuota"]> { return this.protect(entitlements.consumeLlmQuota(this.prisma, userId, requestId, now)); }
  getLlmConfig(): ReturnType<Store["getLlmConfig"]> { return llm.getLlmConfig(this.prisma); }
  upsertLlmConfig(input: Parameters<Store["upsertLlmConfig"]>[0], now: Date): ReturnType<Store["upsertLlmConfig"]> { return llm.upsertLlmConfig(this.prisma, input, now); }
  createActivationCode(input: Parameters<Store["createActivationCode"]>[0]): ReturnType<Store["createActivationCode"]> { return entitlements.createActivationCode(this.prisma, input); }
  findActivationCodeByHash(hash: string): ReturnType<Store["findActivationCodeByHash"]> { return entitlements.findActivationCodeByHash(this.prisma, hash); }
  redeemActivationCodeAndGrantEntitlement(input: Parameters<Store["redeemActivationCodeAndGrantEntitlement"]>[0]): ReturnType<Store["redeemActivationCodeAndGrantEntitlement"]> { return this.protect(entitlements.redeemActivationCodeAndGrantEntitlement(this.prisma, input)); }
  listActivationCodes(): ReturnType<Store["listActivationCodes"]> { return entitlements.listActivationCodes(this.prisma); }
  listUsers(): ReturnType<Store["listUsers"]> { return auth.listUsers(this.prisma); }
  createAdminSession(input: Parameters<Store["createAdminSession"]>[0]): ReturnType<Store["createAdminSession"]> { return auth.createAdminSession(this.prisma, input); }
  findAdminSessionByTokenHash(hash: string, now: Date): ReturnType<Store["findAdminSessionByTokenHash"]> { return auth.findAdminSessionByTokenHash(this.prisma, hash, now); }
  revokeAdminSession(hash: string, now: Date): ReturnType<Store["revokeAdminSession"]> { return auth.revokeAdminSession(this.prisma, hash, now); }
  createUserSession(input: Parameters<Store["createUserSession"]>[0]): ReturnType<Store["createUserSession"]> { return web.createUserSession(this.prisma, input); }
  findUserSessionByTokenHash(hash: string, now: Date): ReturnType<Store["findUserSessionByTokenHash"]> { return web.findUserSessionByTokenHash(this.prisma, hash, now); }
  revokeUserSession(hash: string, now: Date): ReturnType<Store["revokeUserSession"]> { return web.revokeUserSession(this.prisma, hash, now); }
  applyEntitlementAdjustmentWithAudit(input: Parameters<Store["applyEntitlementAdjustmentWithAudit"]>[0]): ReturnType<Store["applyEntitlementAdjustmentWithAudit"]> { return this.protect(entitlements.applyEntitlementAdjustmentWithAudit(this.prisma, input)); }
  listAdminEntitlementAdjustments(limit?: number): ReturnType<Store["listAdminEntitlementAdjustments"]> { return entitlements.listAdminEntitlementAdjustments(this.prisma, limit); }
}
