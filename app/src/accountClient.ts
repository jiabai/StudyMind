import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { AccountStatus } from "./accountState";
import {
  IpcProtocolError,
  readIpcDataObject,
} from "./tauriIpcProtocol";

export type AccountCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

export type BeginAuthFlow = {
  authUrl: string;
  state: string;
};

export type CompleteAuthFlow = {
  authenticated: boolean;
  email: string;
  canProcess: boolean;
  canGenerateAi: boolean;
};

export type WechatCheckout = {
  orderId: string;
  amountFen: number;
  currency: string;
  codeUrl: string;
  expiresAt: string;
  status: string;
};

export type CheckoutStatus = {
  orderId: string;
  status: string;
  entitlementExpiresAt: string | null;
};

type AccountStatusResponse = {
  authenticated: boolean;
  email: string | null;
  entitlement_status: string;
  entitlement_expires_at: string | null;
  llm_quota_limit: number;
  llm_quota_used: number;
  llm_quota_remaining: number;
  llm_quota_resets_at: string | null;
  llm_configured: boolean;
  last_verified_at: string | null;
  can_process: boolean;
  can_generate_ai: boolean;
  server_error: string | null;
};

type BeginAuthFlowResponse = {
  auth_url: string;
  state: string;
};

type CompleteAuthFlowResponse = {
  authenticated: boolean;
  email: string;
  can_process: boolean;
  can_generate_ai: boolean;
};

type WechatCheckoutResponse = {
  order_id: string;
  amount_fen: number;
  currency: string;
  code_url: string;
  expires_at: string;
  status: string;
};

type CheckoutStatusResponse = {
  order_id: string;
  status: string;
  entitlement_expires_at: string | null;
};

const defaultRunner: AccountCommandRunner = (command, args) => invoke(command, args);
const ACCOUNT_IPC_RESPONSE_INVALID = "ACCOUNT_IPC_RESPONSE_INVALID" as const;

export async function getAccountStatus(
  runner: AccountCommandRunner = defaultRunner,
): Promise<AccountStatus> {
  return mapAccountStatus(
    parseAccountStatusResponse(await runner("get_account_status", {})),
  );
}

export async function beginAuthFlow(
  runner: AccountCommandRunner = defaultRunner,
): Promise<BeginAuthFlow> {
  const response = parseBeginAuthFlowResponse(
    await runner("begin_auth_flow", {}),
  );
  return {
    authUrl: response.auth_url,
    state: response.state,
  };
}

export async function completeAuthFlow(
  callbackUrl: string,
  runner: AccountCommandRunner = defaultRunner,
): Promise<CompleteAuthFlow> {
  const response = parseCompleteAuthFlowResponse(
    await runner("complete_auth_flow", { callbackUrl }),
  );
  return {
    authenticated: response.authenticated,
    email: response.email,
    canProcess: response.can_process,
    canGenerateAi: response.can_generate_ai,
  };
}

export async function logoutAccount(
  runner: AccountCommandRunner = defaultRunner,
): Promise<void> {
  const response = await runner("logout_account", {});
  if (response !== null) {
    throwInvalidAccountResponse();
  }
}

export async function redeemActivationCode(
  code: string,
  runner: AccountCommandRunner = defaultRunner,
): Promise<AccountStatus> {
  return mapAccountStatus(
    parseAccountStatusResponse(
      await runner("redeem_activation_code", { code }),
    ),
  );
}

export async function createWechatCheckout(
  runner: AccountCommandRunner = defaultRunner,
): Promise<WechatCheckout> {
  return mapWechatCheckout(
    parseWechatCheckoutResponse(
      await runner("create_wechat_checkout", {}),
    ),
  );
}

export async function getCheckoutStatus(
  orderId: string,
  runner: AccountCommandRunner = defaultRunner,
): Promise<CheckoutStatus> {
  return mapCheckoutStatus(
    parseCheckoutStatusResponse(
      await runner("get_checkout_status", { orderId }),
      orderId,
    ),
  );
}

function parseAccountStatusResponse(value: unknown): AccountStatusResponse {
  const response = readIpcDataObject(
    value,
    [
      "authenticated",
      "email",
      "entitlement_status",
      "entitlement_expires_at",
      "llm_quota_limit",
      "llm_quota_used",
      "llm_quota_remaining",
      "llm_quota_resets_at",
      "llm_configured",
      "last_verified_at",
      "can_process",
      "can_generate_ai",
      "server_error",
    ],
    [],
    ACCOUNT_IPC_RESPONSE_INVALID,
  );
  if (
    typeof response.authenticated !== "boolean" ||
    !isNullableString(response.email) ||
    typeof response.entitlement_status !== "string" ||
    !isNullableString(response.entitlement_expires_at) ||
    !isNonNegativeInteger(response.llm_quota_limit) ||
    !isNonNegativeInteger(response.llm_quota_used) ||
    !isNonNegativeInteger(response.llm_quota_remaining) ||
    !isNullableString(response.llm_quota_resets_at) ||
    typeof response.llm_configured !== "boolean" ||
    !isNullableString(response.last_verified_at) ||
    typeof response.can_process !== "boolean" ||
    typeof response.can_generate_ai !== "boolean" ||
    !isNullableString(response.server_error)
  ) {
    throwInvalidAccountResponse();
  }
  return {
    authenticated: response.authenticated,
    email: response.email,
    entitlement_status: response.entitlement_status,
    entitlement_expires_at: response.entitlement_expires_at,
    llm_quota_limit: response.llm_quota_limit,
    llm_quota_used: response.llm_quota_used,
    llm_quota_remaining: response.llm_quota_remaining,
    llm_quota_resets_at: response.llm_quota_resets_at,
    llm_configured: response.llm_configured,
    last_verified_at: response.last_verified_at,
    can_process: response.can_process,
    can_generate_ai: response.can_generate_ai,
    server_error: response.server_error,
  };
}

function parseBeginAuthFlowResponse(value: unknown): BeginAuthFlowResponse {
  const response = readIpcDataObject(
    value,
    ["auth_url", "state"],
    [],
    ACCOUNT_IPC_RESPONSE_INVALID,
  );
  if (
    typeof response.auth_url !== "string" ||
    typeof response.state !== "string"
  ) {
    throwInvalidAccountResponse();
  }
  return {
    auth_url: response.auth_url,
    state: response.state,
  };
}

function parseCompleteAuthFlowResponse(
  value: unknown,
): CompleteAuthFlowResponse {
  const response = readIpcDataObject(
    value,
    ["authenticated", "email", "can_process", "can_generate_ai"],
    [],
    ACCOUNT_IPC_RESPONSE_INVALID,
  );
  if (
    typeof response.authenticated !== "boolean" ||
    typeof response.email !== "string" ||
    typeof response.can_process !== "boolean" ||
    typeof response.can_generate_ai !== "boolean"
  ) {
    throwInvalidAccountResponse();
  }
  return {
    authenticated: response.authenticated,
    email: response.email,
    can_process: response.can_process,
    can_generate_ai: response.can_generate_ai,
  };
}

function parseWechatCheckoutResponse(value: unknown): WechatCheckoutResponse {
  const response = readIpcDataObject(
    value,
    [
      "order_id",
      "amount_fen",
      "currency",
      "code_url",
      "expires_at",
      "status",
    ],
    [],
    ACCOUNT_IPC_RESPONSE_INVALID,
  );
  if (
    typeof response.order_id !== "string" ||
    !isNonNegativeInteger(response.amount_fen) ||
    typeof response.currency !== "string" ||
    typeof response.code_url !== "string" ||
    typeof response.expires_at !== "string" ||
    typeof response.status !== "string"
  ) {
    throwInvalidAccountResponse();
  }
  return {
    order_id: response.order_id,
    amount_fen: response.amount_fen,
    currency: response.currency,
    code_url: response.code_url,
    expires_at: response.expires_at,
    status: response.status,
  };
}

function parseCheckoutStatusResponse(
  value: unknown,
  expectedOrderId: string,
): CheckoutStatusResponse {
  const response = readIpcDataObject(
    value,
    ["order_id", "status", "entitlement_expires_at"],
    [],
    ACCOUNT_IPC_RESPONSE_INVALID,
  );
  if (
    response.order_id !== expectedOrderId ||
    typeof response.status !== "string" ||
    !isNullableString(response.entitlement_expires_at)
  ) {
    throwInvalidAccountResponse();
  }
  return {
    order_id: response.order_id,
    status: response.status,
    entitlement_expires_at: response.entitlement_expires_at,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function throwInvalidAccountResponse(): never {
  throw new IpcProtocolError(ACCOUNT_IPC_RESPONSE_INVALID);
}

function mapAccountStatus(response: AccountStatusResponse): AccountStatus {
  return {
    authenticated: response.authenticated,
    email: response.email,
    entitlementStatus: response.entitlement_status,
    entitlementExpiresAt: response.entitlement_expires_at,
    llmQuotaLimit: response.llm_quota_limit,
    llmQuotaUsed: response.llm_quota_used,
    llmQuotaRemaining: response.llm_quota_remaining,
    llmQuotaResetsAt: response.llm_quota_resets_at,
    llmConfigured: response.llm_configured,
    lastVerifiedAt: response.last_verified_at,
    canProcess: response.can_process,
    canGenerateAi: response.can_generate_ai,
    serverError: response.server_error,
  };
}

function mapWechatCheckout(response: WechatCheckoutResponse): WechatCheckout {
  return {
    orderId: response.order_id,
    amountFen: response.amount_fen,
    currency: response.currency,
    codeUrl: response.code_url,
    expiresAt: response.expires_at,
    status: response.status,
  };
}

function mapCheckoutStatus(response: CheckoutStatusResponse): CheckoutStatus {
  return {
    orderId: response.order_id,
    status: response.status,
    entitlementExpiresAt: response.entitlement_expires_at,
  };
}
