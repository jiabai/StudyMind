import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createWechatNativePayment, createWechatNotificationParser, type WechatConfig } from "../src/wechat.js";

const now = new Date("2026-08-09T08:00:00.000Z");

function encryptedResource(apiV3Key: string, value: unknown) {
  const nonce = Buffer.from("123456789012");
  const aad = "resource-aad";
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { algorithm: "AEAD_AES_256_GCM", ciphertext: ciphertext.toString("base64"), nonce: nonce.toString(), associated_data: aad };
}

describe("WeChat notification security", () => {
  test("verifies the exact raw body signature and decrypts a valid transaction", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = "12345678901234567890123456789012";
    const body = { id: "evt-1", resource: encryptedResource(key, { appid: "wx-app", mchid: "merchant", out_trade_no: "sm_order1", transaction_id: "tx-1", trade_state: "SUCCESS", success_time: now.toISOString(), amount: { total: 990, currency: "CNY" } }) };
    const rawBody = Buffer.from(JSON.stringify(body));
    const timestamp = "1786262400"; const nonce = "notify-nonce";
    const signature = sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${rawBody.toString()}\n`), keys.privateKey).toString("base64");
    const config: WechatConfig = { appId: "wx-app", mchId: "merchant", serialNo: "merchant-serial", privateKey: "unused", notifyUrl: "https://studymind.example/api/wechat/notify", apiV3Key: key, platformPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), platformSerialNo: "platform-serial", allowInsecureNotify: false, environment: "production" };
    const parse = createWechatNotificationParser(config, () => now);
    const parsed = await parse({ headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-signature": signature, "wechatpay-serial": "platform-serial" }, rawBody, body });
    expect(parsed).toMatchObject({ webhookId: "evt-1", outTradeNo: "sm_order1", transactionId: "tx-1", amountFen: 990, currency: "CNY" });
    await expect(parse({ headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-signature": signature, "wechatpay-serial": "platform-serial" }, rawBody: Buffer.from(`${rawBody.toString()} `), body })).rejects.toThrow("INVALID_WECHAT_NOTIFICATION");
    const staleTimestamp = String(Number(timestamp) - 301); const staleSignature = sign("RSA-SHA256", Buffer.from(`${staleTimestamp}\n${nonce}\n${rawBody.toString()}\n`), keys.privateKey).toString("base64");
    await expect(parse({ headers: { "wechatpay-timestamp": staleTimestamp, "wechatpay-nonce": nonce, "wechatpay-signature": staleSignature, "wechatpay-serial": "platform-serial" }, rawBody, body })).rejects.toThrow("INVALID_WECHAT_NOTIFICATION");
  });

  test("insecure notifications are explicit and never allowed in production", async () => {
    const base: WechatConfig = { appId: "wx-app", mchId: "merchant", serialNo: "serial", privateKey: "unused", notifyUrl: "https://studymind.example/api/wechat/notify", apiV3Key: "", platformPublicKey: "", platformSerialNo: "", allowInsecureNotify: true, environment: "development" };
    const parsed = await createWechatNotificationParser(base)({ headers: {}, rawBody: Buffer.from("{}"), body: { id: "dev-event", out_trade_no: "sm_dev123", transaction_id: "tx", success_time: now.toISOString(), amount: { total: 990, currency: "CNY" }, appid: "wx-app", mchid: "merchant", trade_state: "SUCCESS" } });
    expect(parsed.outTradeNo).toBe("sm_dev123");
    expect(() => createWechatNotificationParser({ ...base, environment: "production" })).toThrow("INSECURE_WECHAT_NOTIFY_FORBIDDEN");
  });

  test("rejects successful-looking notifications with mismatched merchant invariants", async () => {
    const base: WechatConfig = { appId: "wx-app", mchId: "merchant", serialNo: "serial", privateKey: "unused", notifyUrl: "https://studymind.example/api/wechat/notify", apiV3Key: "", platformPublicKey: "", platformSerialNo: "", allowInsecureNotify: true, environment: "test" };
    const valid = { id: "dev-event", out_trade_no: "sm_dev123", transaction_id: "tx", success_time: now.toISOString(), amount: { total: 990, currency: "CNY" }, appid: "wx-app", mchid: "merchant", trade_state: "SUCCESS" };
    for (const body of [{ ...valid, appid: "other" }, { ...valid, mchid: "other" }, { ...valid, trade_state: "NOTPAY" }, { ...valid, amount: { total: 991, currency: "CNY" } }, { ...valid, amount: { total: 990, currency: "USD" } }]) await expect(createWechatNotificationParser(base)({ headers: {}, rawBody: Buffer.from("{}"), body })).rejects.toThrow("INVALID_WECHAT_NOTIFICATION");
  });

  test("signs native order requests and verifies the platform response signature", async () => {
    const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 }); const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const config: WechatConfig = { appId: "wx-app", mchId: "merchant", serialNo: "merchant-serial", privateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), notifyUrl: "https://studymind.example/api/wechat/notify", apiV3Key: "12345678901234567890123456789012", platformPublicKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformSerialNo: "platform-serial", allowInsecureNotify: false, environment: "production" };
    const fetchMock: typeof fetch = async (_url, init) => { const requestBody = String(init?.body); expect(JSON.parse(requestBody)).toMatchObject({ appid: "wx-app", mchid: "merchant", description: "StudyMind monthly pass", out_trade_no: "sm_native1", amount: { total: 990, currency: "CNY" } }); expect(String((init?.headers as Record<string, string>).authorization)).toContain("WECHATPAY2-SHA256-RSA2048"); const raw = JSON.stringify({ code_url: "weixin://native" }); const timestamp = "1786262400"; const nonce = "response-nonce"; const signature = sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), platform.privateKey).toString("base64"); return new Response(raw, { status: 200, headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-signature": signature, "wechatpay-serial": "platform-serial" } }); };
    await expect(createWechatNativePayment(config, fetchMock, () => now, () => Buffer.alloc(16, 1))({ outTradeNo: "sm_native1", amountFen: 990, description: "StudyMind monthly pass" })).resolves.toMatchObject({ codeUrl: "weixin://native" });
  });
});
