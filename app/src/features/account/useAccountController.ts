import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  beginAuthFlow,
  completeAuthFlow,
  getAccountStatus,
  logoutAccount,
  redeemActivationCode,
} from "../../accountClient";
import {
  canProcessWithAccount,
  createAccountStatusFailure,
  createBrowserPreviewAccountStatus,
  createGuestAccountStatus,
  isBrowserPreviewRuntime,
  type AccountStatus,
} from "../../accountState";
import { formatDateTime } from "../../i18n/formatters";
import { useLocale } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";
import { renderUiMessage, uiMessage, type UiMessage } from "../../i18n/uiMessage";

type UseAccountControllerOptions = {
  onSignedOut: () => void;
};

export const ACCOUNT_STATUS_UNAVAILABLE_CODE = "ACCOUNT_STATUS_UNAVAILABLE";

export type AccountNotice = UiMessage | null;

function sanitizeAccountStatus(status: AccountStatus): AccountStatus {
  return status.serverError
    ? { ...status, serverError: ACCOUNT_STATUS_UNAVAILABLE_CODE }
    : status;
}

function formatAccountDate(
  value: string | null,
  locale: SupportedLocale,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatDateTime(date, locale);
}

function getAccountChipMessage(account: AccountStatus): UiMessage {
  const hasActiveEntitlement =
    account.authenticated && account.entitlementStatus === "active";
  if (canProcessWithAccount(account)) {
    return uiMessage("account.chip.authorized");
  }
  if (!account.authenticated) {
    return uiMessage("account.chip.signIn");
  }
  if (!hasActiveEntitlement) {
    return uiMessage("account.chip.activationRequired");
  }
  return uiMessage(
    account.llmConfigured
      ? "account.chip.quotaInsufficient"
      : "account.chip.configurationPending",
  );
}

function getAccountStatusMessage(
  account: AccountStatus,
  locale: SupportedLocale,
): UiMessage {
  const hasActiveEntitlement =
    account.authenticated && account.entitlementStatus === "active";
  if (canProcessWithAccount(account)) {
    const expiresAt = formatAccountDate(account.entitlementExpiresAt, locale);
    return expiresAt
      ? uiMessage("account.status.authorizationActiveUntil", { date: expiresAt })
      : uiMessage("account.status.authorizationActive");
  }
  if (!account.authenticated) {
    return uiMessage("account.status.signedOut");
  }
  if (!hasActiveEntitlement) {
    return uiMessage("account.status.notActivated");
  }
  return uiMessage(
    account.llmConfigured
      ? "account.status.quotaInsufficient"
      : "account.status.configurationPending",
  );
}

export function useAccountController({
  onSignedOut,
}: UseAccountControllerOptions) {
  const { resolvedLocale } = useLocale();
  const [account, setAccount] = useState<AccountStatus>(createGuestAccountStatus);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountNotice, setAccountNotice] = useState<AccountNotice>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [activationCodeDraft, setActivationCodeDraft] = useState("");
  const [activationRedeeming, setActivationRedeeming] = useState(false);
  const [accountStatusPending, setAccountStatusPending] = useState(true);
  const refreshRequestIdRef = useRef(0);
  const activeOperationIdRef = useRef(0);
  const activeOperationPendingRef = useRef<number | null>(null);
  const lastCallbackUrlRef = useRef<string | null>(null);
  const onSignedOutRef = useRef(onSignedOut);
  onSignedOutRef.current = onSignedOut;

  const beginActiveOperation = useCallback(() => {
    const operationId = activeOperationIdRef.current + 1;
    activeOperationIdRef.current = operationId;
    activeOperationPendingRef.current = operationId;
    refreshRequestIdRef.current += 1;
    return operationId;
  }, []);

  const finishActiveOperation = useCallback((operationId: number) => {
    if (activeOperationPendingRef.current !== operationId) {
      return false;
    }
    activeOperationPendingRef.current = null;
    return true;
  }, []);

  const runAccountStatusRefresh = useCallback(async (
    activeOperationId: number | null,
  ) => {
    if (
      activeOperationId === null
        ? activeOperationPendingRef.current !== null
        : activeOperationPendingRef.current !== activeOperationId
    ) {
      return;
    }

    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    const canCommit = () =>
      refreshRequestIdRef.current === requestId &&
      (activeOperationId === null
        ? activeOperationPendingRef.current === null
        : activeOperationPendingRef.current === activeOperationId);

    setAccountLoading(true);
    try {
      const status = await getAccountStatus();
      if (!canCommit()) {
        return;
      }
      setAccount(sanitizeAccountStatus(status));
      setAccountNotice(
        status.serverError
          ? uiMessage("account.notice.statusRefreshFailed")
          : null,
      );
    } catch {
      if (!canCommit()) {
        return;
      }
      if (isBrowserPreviewRuntime()) {
        setAccount({
          ...createBrowserPreviewAccountStatus(),
          serverError: null,
        });
        setAccountNotice(uiMessage("account.notice.browserPreview"));
        return;
      }

      setAccount(
        createAccountStatusFailure(ACCOUNT_STATUS_UNAVAILABLE_CODE),
      );
      setAccountNotice(uiMessage("account.notice.statusRefreshFailed"));
    } finally {
      setAccountStatusPending(false);
      if (canCommit()) {
        setAccountLoading(false);
      }
    }
  }, []);

  const refreshAccountStatus = useCallback(
    () => runAccountStatusRefresh(null),
    [runAccountStatusRefresh],
  );

  const handleAuthCallback = useCallback(
    async (callbackUrl: string) => {
      console.log("[studymind] handleAuthCallback called with", callbackUrl);
      if (!callbackUrl.startsWith("studymind://auth/callback")) {
        console.log("[studymind] handleAuthCallback rejected: doesn't start with studymind://auth/callback");
        return;
      }
      // Deduplicate: skip if this exact URL is already being processed.
      if (lastCallbackUrlRef.current === callbackUrl) {
        console.log("[studymind] handleAuthCallback skipped: duplicate URL");
        return;
      }
      lastCallbackUrlRef.current = callbackUrl;
      const operationId = beginActiveOperation();
      setActivationRedeeming(false);
      setAccountOpen(true);
      setAccountLoading(true);
      setAccountNotice(uiMessage("account.notice.loginCompleting"));
      try {
        console.log("[studymind] calling completeAuthFlow with", callbackUrl);
        await completeAuthFlow(callbackUrl);
        console.log("[studymind] completeAuthFlow succeeded");
        if (activeOperationPendingRef.current === operationId) {
          await runAccountStatusRefresh(operationId);
        }
        if (activeOperationPendingRef.current === operationId) {
          setAccountNotice(uiMessage("account.notice.loginComplete"));
        }
      } catch (err) {
        console.error("[studymind] completeAuthFlow failed:", err);
        if (activeOperationPendingRef.current === operationId) {
          setAccountNotice(uiMessage("account.notice.loginFailed"));
        }
      } finally {
        if (finishActiveOperation(operationId)) {
          setAccountLoading(false);
        }
      }
    },
    [beginActiveOperation, finishActiveOperation, runAccountStatusRefresh],
  );

  const openAccountPanel = useCallback(
    (notice?: UiMessage) => {
      setAccountOpen(true);
      setAccountNotice(notice ?? null);
      void refreshAccountStatus();
    },
    [refreshAccountStatus],
  );

  const closeAccountPanel = useCallback(() => {
    setAccountOpen(false);
  }, []);

  const startLoginFlow = useCallback(async () => {
    const operationId = beginActiveOperation();
    setActivationRedeeming(false);
    setAccountLoading(true);
    setAccountNotice(uiMessage("account.notice.loginOpening"));
    try {
      const auth = await beginAuthFlow();
      await openUrl(auth.authUrl);
      if (activeOperationPendingRef.current === operationId) {
        setAccountNotice(uiMessage("account.notice.loginOpened"));
      }
    } catch {
      if (activeOperationPendingRef.current === operationId) {
        setAccountNotice(uiMessage("account.notice.loginStartFailed"));
      }
    } finally {
      if (finishActiveOperation(operationId)) {
        setAccountLoading(false);
      }
    }
  }, [beginActiveOperation, finishActiveOperation]);

  const redeemActivationCodeFromInput = useCallback(async () => {
    const code = activationCodeDraft.trim();
    if (!code) {
      setAccountNotice(uiMessage("account.notice.activationRequired"));
      return;
    }
    const operationId = beginActiveOperation();
    setAccountLoading(false);
    setActivationRedeeming(true);
    setAccountNotice(null);
    try {
      const status = await redeemActivationCode(code);
      if (activeOperationPendingRef.current === operationId) {
        setAccount(sanitizeAccountStatus(status));
        setActivationCodeDraft("");
        setAccountNotice(uiMessage("account.notice.activationSuccess"));
      }
    } catch {
      if (activeOperationPendingRef.current === operationId) {
        setAccountNotice(uiMessage("account.notice.activationFailed"));
      }
    } finally {
      if (finishActiveOperation(operationId)) {
        setActivationRedeeming(false);
      }
    }
  }, [activationCodeDraft, beginActiveOperation, finishActiveOperation]);

  const signOutAccount = useCallback(async () => {
    const operationId = beginActiveOperation();
    setActivationRedeeming(false);
    setAccountLoading(true);
    try {
      await logoutAccount();
      if (activeOperationPendingRef.current === operationId) {
        onSignedOutRef.current();
        setAccount(createGuestAccountStatus());
        setActivationCodeDraft("");
        setAccountNotice(null);
        setAccountOpen(false);
      }
    } catch {
      if (activeOperationPendingRef.current === operationId) {
        setAccountNotice(uiMessage("account.notice.signOutFailed"));
      }
    } finally {
      if (finishActiveOperation(operationId)) {
        setAccountLoading(false);
      }
    }
  }, [beginActiveOperation, finishActiveOperation]);

  useEffect(() => {
    void refreshAccountStatus();
  }, [refreshAccountStatus]);

  const { accountChipLabel, accountStatusText } = useMemo(
    () => ({
      accountChipLabel: renderUiMessage(
        resolvedLocale,
        getAccountChipMessage(account),
      ),
      accountStatusText: renderUiMessage(
        resolvedLocale,
        getAccountStatusMessage(account, resolvedLocale),
      ),
    }),
    [account, resolvedLocale],
  );

  return {
    account,
    accountOpen,
    accountNotice,
    accountLoading,
    accountStatusPending,
    activationCodeDraft,
    activationRedeeming,
    accountChipLabel,
    accountStatusText,
    closeAccountPanel,
    handleAuthCallback,
    openAccountPanel,
    redeemActivationCodeFromInput,
    refreshAccountStatus,
    setActivationCodeDraft,
    signOutAccount,
    startLoginFlow,
  };
}
