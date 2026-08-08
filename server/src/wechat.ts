import { createDecipheriv, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { monthlyPassPlan } from "./billing.js";

export type WechatConfig = {
  appId: string; mchId: string; serialNo: string; privateKey: string; notifyUrl: string;
  apiV3Key: string; platformPublicKey: string; platformSerialNo: string;
  allowInsecureNotify: boolean; environment: "production" | "development" | "test";
  requestTimeoutMs?: number;
};
type ValidatedWechatConfig = WechatConfig & { requestTimeoutMs: number };
export type ParsedWechatNotification = { webhookId: string; outTradeNo: string; transactionId: string; paidAt: Date; amountFen: number; currency: "CNY" };
export type WechatNotificationParser = (input: { headers: IncomingHttpHeaders; rawBody: Buffer }) => Promise<ParsedWechatNotification>;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export class WechatConfigError extends Error { readonly name = "WechatConfigError"; constructor() { super("WeChat configuration is invalid."); } }
export class WechatProviderUnavailableError extends Error { readonly name = "WechatProviderUnavailableError"; constructor() { super("WeChat provider is unavailable."); } }

export function validateWechatConfig(config: WechatConfig, purpose: "client" | "notification" = "client"): ValidatedWechatConfig {
  try {
    if (!identifier(config.appId) || !identifier(config.mchId) || !identifier(config.serialNo) || !(config.environment === "production" || config.environment === "development" || config.environment === "test")) throw invalidConfig();
    const notifyUrl = new URL(config.notifyUrl);
    if (notifyUrl.protocol !== "https:" || !notifyUrl.hostname || notifyUrl.username || notifyUrl.password || notifyUrl.search || notifyUrl.hash) throw invalidConfig();
    const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30_000) throw invalidConfig();
    if (config.allowInsecureNotify) {
      if (purpose !== "notification" || config.environment === "production") throw invalidConfig();
    } else {
      if (Buffer.byteLength(config.apiV3Key, "utf8") !== 32 || !identifier(config.platformSerialNo)) throw invalidConfig();
      if (createPrivateKey(config.privateKey).asymmetricKeyType !== "rsa" || createPublicKey(config.platformPublicKey).asymmetricKeyType !== "rsa") throw invalidConfig();
    }
    return { ...config, notifyUrl: notifyUrl.href, requestTimeoutMs };
  } catch (error) { if (error instanceof WechatConfigError) throw error; throw invalidConfig(); }
}

export function createWechatNativePayment(config: WechatConfig, fetchImplementation: typeof fetch = fetch, now: () => Date = () => new Date(), random: (size: number) => Buffer = randomBytes) {
  const validated = validateWechatConfig(config, "client");
  return async (input: { outTradeNo: string; amountFen: number; description: string }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), validated.requestTimeoutMs);
    timeout.unref?.();
    try {
      const path = "/v3/pay/transactions/native";
      const body = JSON.stringify({ appid: validated.appId, mchid: validated.mchId, description: input.description, out_trade_no: input.outTradeNo, notify_url: validated.notifyUrl, amount: { total: input.amountFen, currency: monthlyPassPlan.currency } });
      const timestamp = Math.floor(now().getTime() / 1000).toString(); const nonce = random(16).toString("hex");
      const signature = createSign("RSA-SHA256").update(`POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`).sign(validated.privateKey, "base64");
      const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${validated.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${validated.serialNo}"`;
      const response = await withAbort(fetchImplementation(`https://api.mch.weixin.qq.com${path}`, { method: "POST", headers: { authorization, accept: "application/json", "content-type": "application/json" }, body, signal: controller.signal }), controller.signal);
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && !validContentLength(declaredLength)) { await cancelBody(response.body, controller); throw providerUnavailable(); }
      const bytes = await readBoundedBody(response.body, controller);
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      verifyProviderResponse(validated, response.headers, raw, now());
      const payload = object(JSON.parse(raw) as unknown);
      if (!response.ok || typeof payload.code_url !== "string" || !payload.code_url.startsWith("weixin://")) throw providerUnavailable();
      return { codeUrl: payload.code_url, providerPayload: payload };
    } catch (error) { if (error instanceof WechatProviderUnavailableError) throw error; throw providerUnavailable(); }
    finally { clearTimeout(timeout); }
  };
}

export function createWechatNotificationParser(config: WechatConfig, now: () => Date = () => new Date()): WechatNotificationParser {
  const validated = validateWechatConfig(config, "notification");
  return async ({ headers, rawBody }) => {
    try {
      if (!Buffer.isBuffer(rawBody)) throw invalidNotify();
      if (!validated.allowInsecureNotify) verifySignature(validated, headers, rawBody, now());
      const body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown);
      let resource: Record<string, unknown>; let webhookId: string;
      if (validated.allowInsecureNotify) { resource = body; webhookId = stringValue(body.id); }
      else { webhookId = stringValue(body.id); const encrypted = object(body.resource); if (encrypted.algorithm !== "AEAD_AES_256_GCM") throw invalidNotify(); resource = object(JSON.parse(decryptResource(validated.apiV3Key, encrypted)) as unknown); }
      const amount = object(resource.amount);
      if (resource.appid !== validated.appId || resource.mchid !== validated.mchId || resource.trade_state !== "SUCCESS" || amount.total !== monthlyPassPlan.amountFen || amount.currency !== monthlyPassPlan.currency) throw invalidNotify();
      const outTradeNo = stringValue(resource.out_trade_no); const transactionId = stringValue(resource.transaction_id); const paidAt = new Date(stringValue(resource.success_time));
      if (!/^sm_[A-Za-z0-9_-]{6,48}$/.test(outTradeNo) || !Number.isFinite(paidAt.getTime())) throw invalidNotify();
      return { webhookId, outTradeNo, transactionId, paidAt, amountFen: monthlyPassPlan.amountFen, currency: monthlyPassPlan.currency };
    } catch (error) { if (error instanceof Error && error.message === "INVALID_WECHAT_NOTIFICATION") throw error; throw invalidNotify(); }
  };
}

function verifyProviderResponse(config: ValidatedWechatConfig, headers: Headers, body: string, now: Date) { const timestamp = headers.get("wechatpay-timestamp"); const nonce = headers.get("wechatpay-nonce"); const signature = headers.get("wechatpay-signature"); const serial = headers.get("wechatpay-serial"); if (!timestamp || !freshTimestamp(timestamp, now) || !nonce || !signature || serial !== config.platformSerialNo || !createVerify("RSA-SHA256").update(`${timestamp}\n${nonce}\n${body}\n`).verify(config.platformPublicKey, signature, "base64")) throw providerUnavailable(); }
function verifySignature(config: ValidatedWechatConfig, headers: IncomingHttpHeaders, rawBody: Buffer, now: Date) { const timestamp = header(headers["wechatpay-timestamp"]); const nonce = header(headers["wechatpay-nonce"]); const signature = header(headers["wechatpay-signature"]); const serial = header(headers["wechatpay-serial"]); if (!timestamp || !freshTimestamp(timestamp, now) || !nonce || !signature || serial !== config.platformSerialNo || !createVerify("RSA-SHA256").update(Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), rawBody, Buffer.from("\n")])).verify(config.platformPublicKey, signature, "base64")) throw invalidNotify(); }
function decryptResource(keyText: string, input: Record<string, unknown>) { const key = Buffer.from(keyText); const nonce = Buffer.from(stringValue(input.nonce)); const encrypted = Buffer.from(stringValue(input.ciphertext), "base64"); if (key.length !== 32 || nonce.length !== 12 || encrypted.length <= 16) throw invalidNotify(); const decipher = createDecipheriv("aes-256-gcm", key, nonce); decipher.setAAD(Buffer.from(typeof input.associated_data === "string" ? input.associated_data : "")); decipher.setAuthTag(encrypted.subarray(-16)); return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString(); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidNotify(); return value as Record<string, unknown>; }
function stringValue(value: unknown): string { if (typeof value !== "string" || !value) throw invalidNotify(); return value; }
function identifier(value: string): boolean { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function withAbort<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> { if (signal.aborted) return Promise.reject(providerUnavailable()); return new Promise<Value>((resolve, reject) => { const aborted = () => { cleanup(); reject(providerUnavailable()); }; const cleanup = () => signal.removeEventListener("abort", aborted); signal.addEventListener("abort", aborted, { once: true }); operation.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); }); }); }
function validContentLength(value: string): boolean { if (!/^\d+$/.test(value)) return false; const length = Number(value); return Number.isSafeInteger(length) && length >= 0 && length <= MAX_RESPONSE_BYTES; }
async function cancelBody(body: ReadableStream<Uint8Array> | null, controller: AbortController): Promise<void> { try { await body?.cancel(); } catch { /* best effort */ } finally { controller.abort(); } }
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController): Promise<void> { try { await reader.cancel(); } catch { /* best effort */ } finally { controller.abort(); } }
async function readBoundedBody(body: ReadableStream<Uint8Array> | null, controller: AbortController): Promise<Buffer> {
  if (!body) { controller.abort(); throw providerUnavailable(); }
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let completed = false; let cancelled = false;
  try {
    while (true) {
      const result = await withAbort(reader.read(), controller.signal);
      if (result.done) { completed = true; break; }
      const chunk = result.value; total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await cancelReader(reader, controller); cancelled = true; throw providerUnavailable(); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total);
  } catch (error) {
    if (!completed && !cancelled) await cancelReader(reader, controller);
    if (error instanceof WechatProviderUnavailableError) throw error;
    throw providerUnavailable();
  } finally { reader.releaseLock(); }
}
function header(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function freshTimestamp(value: string, now: Date) { return /^\d{10}$/.test(value) && Math.abs(Math.floor(now.getTime() / 1000) - Number(value)) <= 300; }
function invalidConfig() { return new WechatConfigError(); }
function providerUnavailable() { return new WechatProviderUnavailableError(); }
function invalidNotify() { return new Error("INVALID_WECHAT_NOTIFICATION"); }
