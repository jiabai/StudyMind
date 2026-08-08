import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { LlmConfigRecord, Store } from "./store.js";

type LlmConfigStore = Pick<Store, "getLlmConfig" | "upsertLlmConfig">;
type Provider = "openai" | "openai_compatible";
const CONFIG_KEY_ERROR = "STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY is required.";
const DOMAIN = "studymind:llm-config-encryption:v1";

export type PublicLlmConfig = {
  configured: boolean; apiKeyLast4: string;
};
export type DecryptedLlmConfig = {
  provider: string; baseUrl: string; model: string; apiKey: string; timeoutSeconds: number;
};

export class LlmConfigMissingError extends Error {
  readonly name = "LlmConfigMissingError";
  constructor() { super("LLM configuration is missing."); }
}

export class LlmConfigInvalidError extends Error {
  readonly name = "LlmConfigInvalidError";
  constructor() { super("Stored LLM configuration is invalid."); }
}

export class LlmConfigService {
  private readonly key: Buffer;
  private readonly now: () => Date;

  constructor(private readonly options: { store: LlmConfigStore; encryptionKey?: string; now?: () => Date }) {
    this.key = deriveEncryptionKey(options.encryptionKey);
    this.now = options.now ?? (() => new Date());
  }

  async save(input: { provider: string; baseUrl: string; model: string; apiKey: string; timeoutSeconds: number }): Promise<PublicLlmConfig> {
    const normalized = validateConfig(input);
    const saved = await this.options.store.upsertLlmConfig({
      provider: normalized.provider, baseUrl: normalized.baseUrl, model: normalized.model,
      encryptedApiKey: encryptSecret(normalized.apiKey, this.key), apiKeyLast4: normalized.apiKey.slice(-4),
      timeoutSeconds: normalized.timeoutSeconds,
    }, this.now());
    return toPublic(saved, true);
  }

  async getPublic(): Promise<PublicLlmConfig> {
    const config = await this.options.store.getLlmConfig();
    return config ? toPublic(config, this.isUsable(config)) : { configured: false, apiKeyLast4: "" };
  }

  async isConfigured(): Promise<boolean> {
    const config = await this.options.store.getLlmConfig();
    return config ? this.isUsable(config) : false;
  }

  async getDecrypted(): Promise<DecryptedLlmConfig> {
    const config = await this.options.store.getLlmConfig();
    if (!config) throw new LlmConfigMissingError();
    if (!config.encryptedApiKey || !config.baseUrl || !config.model) throw new LlmConfigInvalidError();
    try { return this.decryptAndValidate(config); }
    catch { throw new LlmConfigInvalidError(); }
  }

  // Compatibility aliases for route/admin callers without exposing plaintext.
  async saveConfig(input: Parameters<LlmConfigService["save"]>[0]) { return this.save(input); }
  async getPublicConfig() { return this.getPublic(); }
  async getDesktopConfig() { return this.getDecrypted(); }

  private decryptAndValidate(config: LlmConfigRecord): DecryptedLlmConfig {
    const validated = validateConfig({
      provider: config.provider, baseUrl: config.baseUrl, model: config.model,
      apiKey: decryptSecret(config.encryptedApiKey, this.key), timeoutSeconds: config.timeoutSeconds,
    });
    return validated;
  }

  private isUsable(config: LlmConfigRecord): boolean {
    if (!config.encryptedApiKey || !config.baseUrl || !config.model) return false;
    try { this.decryptAndValidate(config); return true; } catch { return false; }
  }
}

function validateConfig(input: { provider: string; baseUrl: string; model: string; apiKey: string; timeoutSeconds: number }) {
  const provider = input.provider?.trim().toLowerCase() as Provider;
  const model = input.model?.trim();
  const apiKey = input.apiKey?.trim();
  if (!(["openai", "openai_compatible"] as string[]).includes(provider) || !model || model.length > 256 ||
    !apiKey || apiKey.length < 8 || apiKey.length > 4096 || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 600) {
    throw new Error("INVALID_LLM_CONFIG");
  }
  const rawBaseUrl = input.baseUrl.trim();
  if (rawBaseUrl.includes("\\") || /%5c/i.test(rawBaseUrl)) throw new Error("INVALID_LLM_CONFIG");
  let url: URL;
  try { url = new URL(rawBaseUrl); } catch { throw new Error("INVALID_LLM_CONFIG"); }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || !url.hostname || url.username || url.password ||
    input.baseUrl.length > 2048 || url.search || url.hash) throw new Error("INVALID_LLM_CONFIG");
  return { provider, baseUrl: url.href.replace(/\/+$/, ""), model, apiKey, timeoutSeconds: input.timeoutSeconds };
}

function toPublic(config: LlmConfigRecord, configured: boolean): PublicLlmConfig {
  return { configured, apiKeyLast4: config.apiKeyLast4 };
}

function deriveEncryptionKey(secret: string | undefined): Buffer {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error(CONFIG_KEY_ERROR);
  return createHash("sha256").update(DOMAIN, "utf8").update(Buffer.from([0])).update(secret, "utf8").digest();
}

export function encryptSecret(secret: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(DOMAIN, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("LLM_CONFIG_UNAVAILABLE");
  const nonce = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ciphertext = Buffer.from(parts[3]!, "base64url");
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length === 0 ||
    nonce.toString("base64url") !== parts[1] || tag.toString("base64url") !== parts[2] ||
    ciphertext.toString("base64url") !== parts[3]) throw new Error("LLM_CONFIG_UNAVAILABLE");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(DOMAIN, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
