import { createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type WechatConfig = {
  appId: string; mchId: string; serialNo: string; privateKey: string; notifyUrl: string;
  apiV3Key: string; platformPublicKey: string; platformSerialNo: string;
  allowInsecureNotify: boolean; environment: "production" | "development" | "test";
};
export type ParsedWechatNotification = { webhookId: string; outTradeNo: string; transactionId: string; paidAt: Date; amountFen: number; currency: "CNY" };
export type WechatNotificationParser = (input: { headers: IncomingHttpHeaders; rawBody: Buffer; body: unknown }) => Promise<ParsedWechatNotification>;

export function createWechatNativePayment(config: WechatConfig, fetchImplementation: typeof fetch = fetch, now: () => Date = () => new Date(), random: (size: number) => Buffer = randomBytes) {
  return async (input: { outTradeNo: string; amountFen: number; description: string }) => {
    const path = "/v3/pay/transactions/native";
    const body = JSON.stringify({ appid: config.appId, mchid: config.mchId, description: input.description, out_trade_no: input.outTradeNo, notify_url: config.notifyUrl, amount: { total: input.amountFen, currency: "CNY" } });
    const timestamp = Math.floor(now().getTime() / 1000).toString(); const nonce = random(16).toString("hex");
    const signature = createSign("RSA-SHA256").update(`POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`).sign(config.privateKey, "base64");
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.serialNo}"`;
    const response = await fetchImplementation(`https://api.mch.weixin.qq.com${path}`, { method: "POST", headers: { authorization, accept: "application/json", "content-type": "application/json" }, body });
    const raw = await response.text();
    verifyProviderResponse(config, response.headers, raw, now());
    let payload: { code_url?: unknown }; try { payload = JSON.parse(raw) as { code_url?: unknown }; } catch { throw invalidProvider(); }
    if (!response.ok || typeof payload.code_url !== "string" || !payload.code_url.startsWith("weixin://")) throw invalidProvider();
    return { codeUrl: payload.code_url, providerPayload: payload };
  };
}

export function createWechatNotificationParser(config: WechatConfig, now: () => Date = () => new Date()): WechatNotificationParser {
  if (config.allowInsecureNotify && config.environment === "production") throw new Error("INSECURE_WECHAT_NOTIFY_FORBIDDEN");
  return async ({ headers, rawBody, body }) => {
    try {
      let resource: Record<string, unknown>; let webhookId: string;
      if (config.allowInsecureNotify) { resource = object(body); webhookId = stringValue(resource.id); }
      else {
        verifySignature(config, headers, rawBody, now());
        const envelope = object(body); webhookId = stringValue(envelope.id); const encrypted = object(envelope.resource);
        if (encrypted.algorithm !== "AEAD_AES_256_GCM") throw invalidNotify();
        resource = object(JSON.parse(decryptResource(config.apiV3Key, encrypted)) as unknown);
      }
      const amount = object(resource.amount);
      if (resource.appid !== config.appId || resource.mchid !== config.mchId || resource.trade_state !== "SUCCESS" || amount.total !== 990 || amount.currency !== "CNY") throw invalidNotify();
      const outTradeNo = stringValue(resource.out_trade_no); const transactionId = stringValue(resource.transaction_id); const success = stringValue(resource.success_time); const paidAt = new Date(success);
      if (!/^sm_[A-Za-z0-9_-]{6,48}$/.test(outTradeNo) || !Number.isFinite(paidAt.getTime())) throw invalidNotify();
      return { webhookId, outTradeNo, transactionId, paidAt, amountFen: 990, currency: "CNY" };
    } catch (error) { if (error instanceof Error && error.message === "INVALID_WECHAT_NOTIFICATION") throw error; throw invalidNotify(); }
  };
}

function verifyProviderResponse(config: WechatConfig, headers: Headers, body: string, now: Date) {
  const timestamp = headers.get("wechatpay-timestamp"); const nonce = headers.get("wechatpay-nonce"); const signature = headers.get("wechatpay-signature"); const serial = headers.get("wechatpay-serial");
  if (!timestamp || !freshTimestamp(timestamp, now) || !nonce || !signature || serial !== config.platformSerialNo || !createVerify("RSA-SHA256").update(`${timestamp}\n${nonce}\n${body}\n`).verify(config.platformPublicKey, signature, "base64")) throw invalidProvider();
}
function verifySignature(config: WechatConfig, headers: IncomingHttpHeaders, rawBody: Buffer, now: Date) {
  const timestamp = header(headers["wechatpay-timestamp"]); const nonce = header(headers["wechatpay-nonce"]); const signature = header(headers["wechatpay-signature"]); const serial = header(headers["wechatpay-serial"]);
  if (!timestamp || !freshTimestamp(timestamp, now) || !nonce || !signature || serial !== config.platformSerialNo || !createVerify("RSA-SHA256").update(Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), rawBody, Buffer.from("\n")])).verify(config.platformPublicKey, signature, "base64")) throw invalidNotify();
}
function decryptResource(keyText: string, input: Record<string, unknown>) {
  const key = Buffer.from(keyText); const nonce = Buffer.from(stringValue(input.nonce)); const encrypted = Buffer.from(stringValue(input.ciphertext), "base64"); if (key.length !== 32 || nonce.length !== 12 || encrypted.length <= 16) throw invalidNotify();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce); decipher.setAAD(Buffer.from(typeof input.associated_data === "string" ? input.associated_data : "")); decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString();
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidNotify(); return value as Record<string, unknown>; }
function stringValue(value: unknown): string { if (typeof value !== "string" || !value) throw invalidNotify(); return value; }
function header(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function freshTimestamp(value: string, now: Date) { return /^\d{10}$/.test(value) && Math.abs(Math.floor(now.getTime() / 1000) - Number(value)) <= 300; }
function invalidNotify() { return new Error("INVALID_WECHAT_NOTIFICATION"); }
function invalidProvider() { return new Error("PAYMENT_PROVIDER_UNAVAILABLE"); }
