import { secureToken } from "./security.js";
import type { OrderRecord, Store } from "./store.js";

type BillingStore = Pick<Store, "findSessionByTokenHash" | "createOrder" | "settlePaidOrder" | "findOrderByOutTradeNo">;
export type NativePaymentInput = { outTradeNo: string; amountFen: number; description: string };
export type NativePaymentResult = { codeUrl: string; providerPayload: unknown };
const AMOUNT_FEN = 990; const PASS_DAYS = 31; const TTL_MS = 30 * 60_000;

export class BillingAuthRequiredError extends Error {
  readonly name = "BillingAuthRequiredError";
  constructor() { super("Billing authentication is required."); }
}

export class BillingService {
  private readonly now: () => Date; private readonly randomId: () => string;
  constructor(private readonly options: { store: BillingStore; now?: () => Date; randomId?: () => string; createNativePayment: (input: NativePaymentInput) => Promise<NativePaymentResult> }) {
    this.now = options.now ?? (() => new Date()); this.randomId = options.randomId ?? (() => secureToken().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24));
  }
  async createWechatNativeOrder(input: { sessionTokenHash: string }): Promise<OrderRecord & { currency: "CNY" }> {
    const at = this.now(); const session = await this.options.store.findSessionByTokenHash(input.sessionTokenHash, at);
    if (!session) throw new BillingAuthRequiredError();
    const suffix = this.randomId();
    if (!/^[A-Za-z0-9_-]{6,48}$/.test(suffix)) throw new Error("INVALID_ORDER_ID_SOURCE");
    const outTradeNo = `sm_${suffix}`;
    const payment = await this.options.createNativePayment({ outTradeNo, amountFen: AMOUNT_FEN, description: "StudyMind monthly pass" });
    const order = await this.options.store.createOrder({ userId: session.userId, outTradeNo, amountFen: AMOUNT_FEN, status: "pending", codeUrl: payment.codeUrl, expiresAt: new Date(at.getTime() + TTL_MS), createdAt: at, providerPayload: JSON.stringify(payment.providerPayload) });
    return Object.assign(order, { currency: "CNY" as const });
  }
  async applyPaidOrder(input: { outTradeNo: string; transactionId: string; webhookId: string; paidAt: Date }) {
    const settled = await this.options.store.settlePaidOrder({ provider: "wechat", eventId: input.webhookId, outTradeNo: input.outTradeNo, transactionId: input.transactionId, paidAt: input.paidAt, now: this.now(), passDays: PASS_DAYS });
    if (settled.status === "settled") return { entitlementExpiresAt: settled.entitlement.expiresAt };
    throw new Error(settled.status.toUpperCase());
  }
  getOrderStatus(outTradeNo: string) { return this.options.store.findOrderByOutTradeNo(outTradeNo); }
}
export const monthlyPassAmountFen = AMOUNT_FEN;
export const monthlyPassDays = PASS_DAYS;
