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
  private call<Value>(value: Promise<Value>): Promise<Value> { return value.catch(sanitizeStoreError); }
  upsertUserByEmail(email: string, now: Date): ReturnType<Store["upsertUserByEmail"]> { return this.call(auth.upsertUserByEmail(this.prisma, email, now)); }
  getUserById(id: string): ReturnType<Store["getUserById"]> { return this.call(auth.getUserById(this.prisma, id)); }
  issueEmailOtp(input: Parameters<Store["issueEmailOtp"]>[0]): ReturnType<Store["issueEmailOtp"]> { return this.call(auth.issueEmailOtp(this.prisma, input)); }
  invalidateIssuedOtpAfterDeliveryFailure(id: string, now: Date): ReturnType<Store["invalidateIssuedOtpAfterDeliveryFailure"]> { return this.call(auth.invalidateIssuedOtpAfterDeliveryFailure(this.prisma, id, now)); }
  verifyDesktopOtpAndCreateTicket(input: Parameters<Store["verifyDesktopOtpAndCreateTicket"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicket"]> { return this.call(auth.verifyDesktopOtpAndCreateTicket(this.prisma, input)); }
  verifyDesktopOtpAndCreateTicketAndWebSession(input: Parameters<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]>[0]): ReturnType<Store["verifyDesktopOtpAndCreateTicketAndWebSession"]> { return this.call(web.verifyDesktopOtpAndCreateTicketAndWebSession(this.prisma, input)); }
  verifyAdminOtpAndCreateSession(input: Parameters<Store["verifyAdminOtpAndCreateSession"]>[0]): ReturnType<Store["verifyAdminOtpAndCreateSession"]> { return this.call(auth.verifyAdminOtpAndCreateSession(this.prisma, input)); }
  verifyUserOtpAndCreateWebSession(input: Parameters<Store["verifyUserOtpAndCreateWebSession"]>[0]): ReturnType<Store["verifyUserOtpAndCreateWebSession"]> { return this.call(web.verifyUserOtpAndCreateWebSession(this.prisma, input)); }
  exchangeDesktopTicketAndCreateSession(input: Parameters<Store["exchangeDesktopTicketAndCreateSession"]>[0]): ReturnType<Store["exchangeDesktopTicketAndCreateSession"]> { return this.call(auth.exchangeDesktopTicketAndCreateSession(this.prisma, input)); }
  createSession(input: Parameters<Store["createSession"]>[0]): ReturnType<Store["createSession"]> { return this.call(auth.createSession(this.prisma, input)); }
  findSessionByTokenHash(hash: string, now: Date): ReturnType<Store["findSessionByTokenHash"]> { return this.call(auth.findSessionByTokenHash(this.prisma, hash, now)); }
  revokeSession(hash: string, now: Date): ReturnType<Store["revokeSession"]> { return this.call(auth.revokeSession(this.prisma, hash, now)); }
  createOrder(input: Parameters<Store["createOrder"]>[0]): ReturnType<Store["createOrder"]> { return this.call(billing.createOrder(this.prisma, input)); }
  findOrderByOutTradeNo(value: string): ReturnType<Store["findOrderByOutTradeNo"]> { return this.call(billing.findOrderByOutTradeNo(this.prisma, value)); }
  settlePaidOrder(input: Parameters<Store["settlePaidOrder"]>[0]): ReturnType<Store["settlePaidOrder"]> { return this.call(billing.settlePaidOrder(this.prisma, input)); }
  getEntitlement(userId: string): ReturnType<Store["getEntitlement"]> { return this.call(entitlements.getEntitlement(this.prisma, userId)); }
  upsertEntitlement(userId: string, expiresAt: Date, now: Date, quota?: Parameters<Store["upsertEntitlement"]>[3]): ReturnType<Store["upsertEntitlement"]> { return this.call(entitlements.upsertEntitlement(this.prisma, userId, expiresAt, now, quota)); }
  consumeLlmQuota(userId: string, requestId: string, now: Date): ReturnType<Store["consumeLlmQuota"]> { return this.call(entitlements.consumeLlmQuota(this.prisma, userId, requestId, now)); }
  getLlmConfig(): ReturnType<Store["getLlmConfig"]> { return this.call(llm.getLlmConfig(this.prisma)); }
  upsertLlmConfig(input: Parameters<Store["upsertLlmConfig"]>[0], now: Date): ReturnType<Store["upsertLlmConfig"]> { return this.call(llm.upsertLlmConfig(this.prisma, input, now)); }
  createActivationCode(input: Parameters<Store["createActivationCode"]>[0]): ReturnType<Store["createActivationCode"]> { return this.call(entitlements.createActivationCode(this.prisma, input)); }
  findActivationCodeByHash(hash: string): ReturnType<Store["findActivationCodeByHash"]> { return this.call(entitlements.findActivationCodeByHash(this.prisma, hash)); }
  redeemActivationCodeAndGrantEntitlement(input: Parameters<Store["redeemActivationCodeAndGrantEntitlement"]>[0]): ReturnType<Store["redeemActivationCodeAndGrantEntitlement"]> { return this.call(entitlements.redeemActivationCodeAndGrantEntitlement(this.prisma, input)); }
  listActivationCodes(): ReturnType<Store["listActivationCodes"]> { return this.call(entitlements.listActivationCodes(this.prisma)); }
  listUsers(): ReturnType<Store["listUsers"]> { return this.call(auth.listUsers(this.prisma)); }
  createAdminSession(input: Parameters<Store["createAdminSession"]>[0]): ReturnType<Store["createAdminSession"]> { return this.call(auth.createAdminSession(this.prisma, input)); }
  findAdminSessionByTokenHash(hash: string, now: Date): ReturnType<Store["findAdminSessionByTokenHash"]> { return this.call(auth.findAdminSessionByTokenHash(this.prisma, hash, now)); }
  revokeAdminSession(hash: string, now: Date): ReturnType<Store["revokeAdminSession"]> { return this.call(auth.revokeAdminSession(this.prisma, hash, now)); }
  createUserSession(input: Parameters<Store["createUserSession"]>[0]): ReturnType<Store["createUserSession"]> { return this.call(web.createUserSession(this.prisma, input)); }
  findUserSessionByTokenHash(hash: string, now: Date): ReturnType<Store["findUserSessionByTokenHash"]> { return this.call(web.findUserSessionByTokenHash(this.prisma, hash, now)); }
  revokeUserSession(hash: string, now: Date): ReturnType<Store["revokeUserSession"]> { return this.call(web.revokeUserSession(this.prisma, hash, now)); }
  applyEntitlementAdjustmentWithAudit(input: Parameters<Store["applyEntitlementAdjustmentWithAudit"]>[0]): ReturnType<Store["applyEntitlementAdjustmentWithAudit"]> { return this.call(entitlements.applyEntitlementAdjustmentWithAudit(this.prisma, input)); }
  listAdminEntitlementAdjustments(limit?: number): ReturnType<Store["listAdminEntitlementAdjustments"]> { return this.call(entitlements.listAdminEntitlementAdjustments(this.prisma, limit)); }
}
