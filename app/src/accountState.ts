export type AccountStatus = {
  authenticated: boolean;
  email: string | null;
  entitlementStatus: string;
  entitlementExpiresAt: string | null;
  llmQuotaLimit: number;
  llmQuotaUsed: number;
  llmQuotaRemaining: number;
  llmQuotaResetsAt: string | null;
  llmConfigured: boolean;
  lastVerifiedAt: string | null;
  canProcess: boolean;
  canGenerateAi: boolean;
  serverError: string | null;
};

export function createGuestAccountStatus(): AccountStatus {
  return {
    authenticated: false,
    email: null,
    entitlementStatus: "inactive",
    entitlementExpiresAt: null,
    llmQuotaLimit: 0,
    llmQuotaUsed: 0,
    llmQuotaRemaining: 0,
    llmQuotaResetsAt: null,
    llmConfigured: false,
    lastVerifiedAt: null,
    canProcess: false,
    canGenerateAi: false,
    serverError: null,
  };
}

export function createAccountStatusFailure(serverError: string | null): AccountStatus {
  return {
    ...createGuestAccountStatus(),
    serverError,
  };
}

export function createBrowserPreviewAccountStatus(): AccountStatus {
  return {
    authenticated: true,
    email: "browser-preview@studymind.local",
    entitlementStatus: "active",
    entitlementExpiresAt: null,
    llmQuotaLimit: 20,
    llmQuotaUsed: 0,
    llmQuotaRemaining: 20,
    llmQuotaResetsAt: null,
    llmConfigured: true,
    lastVerifiedAt: null,
    canProcess: true,
    canGenerateAi: true,
    serverError: "Browser preview fallback",
  };
}

type RuntimeWindow = {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export function isBrowserPreviewRuntime(
  options: { dev?: boolean; runtimeWindow?: RuntimeWindow | null } = {},
): boolean {
  const dev = options.dev ?? import.meta.env.DEV;
  const runtimeWindow =
    options.runtimeWindow ?? (typeof window === "undefined" ? null : (window as RuntimeWindow));

  return Boolean(dev) && runtimeWindow !== null && !("__TAURI__" in runtimeWindow) && !("__TAURI_INTERNALS__" in runtimeWindow);
}

export function canProcessWithAccount(account: AccountStatus): boolean {
  return account.authenticated && account.entitlementStatus === "active" && account.canProcess;
}

export function canGenerateAiWithAccount(account: AccountStatus): boolean {
  return account.authenticated && account.entitlementStatus === "active" && account.canGenerateAi;
}
