import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AccountStatus } from "../../accountState";
import type { SupportedLocale } from "../../i18n/locale";
import type { UiMessage } from "../../i18n/uiMessage";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: () => void;
  useMemo: <T>(factory: () => T) => T;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

const beginAuthFlowMock = vi.fn<() => Promise<{ authUrl: string }>>();
const completeAuthFlowMock = vi.fn<(callbackUrl: string) => Promise<void>>();
const getAccountStatusMock = vi.fn<() => Promise<AccountStatus>>();
const logoutAccountMock = vi.fn<() => Promise<void>>();
const redeemActivationCodeMock = vi.fn<(code: string) => Promise<AccountStatus>>();
const openUrlMock = vi.fn<(url: string) => Promise<void>>();
let currentLocale: SupportedLocale = "en-US";

vi.mock("../../accountClient", () => ({
  beginAuthFlow: beginAuthFlowMock,
  completeAuthFlow: completeAuthFlowMock,
  getAccountStatus: getAccountStatusMock,
  logoutAccount: logoutAccountMock,
  redeemActivationCode: redeemActivationCodeMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

vi.mock("../../i18n/LocaleProvider", () => ({
  useLocale: () => ({
    preference: currentLocale,
    resolvedLocale: currentLocale,
    setLanguagePreference: vi.fn(),
  }),
}));

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  let cursor = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    useCallback: (callback) => callback,
    useEffect: () => undefined,
    useMemo: (factory) => factory(),
    useRef: <T,>(initialValue: T) => {
      const stateIndex = cursor;
      cursor += 1;
      if (states.length <= stateIndex) {
        states[stateIndex] = { current: initialValue };
      }
      return states[stateIndex] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const stateIndex = cursor;
      cursor += 1;
      if (states.length <= stateIndex) {
        states[stateIndex] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setState = (next: StateUpdater<T>) => {
        states[stateIndex] =
          typeof next === "function"
            ? (next as (current: T) => T)(states[stateIndex] as T)
            : next;
      };
      return [states[stateIndex] as T, setState];
    },
  };
}

async function createController() {
  const harness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useMemo: harness.useMemo,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  const { initializeI18n } = await import("../../i18n/i18n");
  await initializeI18n(currentLocale);
  const { useAccountController } = await import("./useAccountController");
  const onSignedOut = vi.fn();

  return {
    render: () => {
      harness.resetRender();
      return useAccountController({ onSignedOut });
    },
    onSignedOut,
  };
}

function expectSafeMessage(
  notice: UiMessage | null,
  messageCode: string,
  secret: string,
): void {
  expect(notice).toEqual({ messageCode });
  expect(JSON.stringify(notice)).not.toContain(secret);
}

function createAccountStatus(
  email: string,
  overrides: Partial<AccountStatus> = {},
): AccountStatus {
  return {
    authenticated: true,
    email,
    entitlementStatus: "active",
    entitlementExpiresAt: null,
    llmQuotaLimit: 10,
    llmQuotaUsed: 1,
    llmQuotaRemaining: 9,
    llmQuotaResetsAt: null,
    llmConfigured: true,
    lastVerifiedAt: null,
    canProcess: true,
    canGenerateAi: true,
    serverError: null,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useAccountController semantic notices", () => {
  beforeEach(() => {
    vi.resetModules();
    currentLocale = "en-US";
    beginAuthFlowMock.mockReset();
    completeAuthFlowMock.mockReset();
    getAccountStatusMock.mockReset();
    logoutAccountMock.mockReset();
    redeemActivationCodeMock.mockReset();
    openUrlMock.mockReset();
  });

  test("does not retain raw account refresh failures", async () => {
    const secret = "D:/private/account-refresh-secret.txt";
    getAccountStatusMock.mockRejectedValueOnce(new Error(secret));
    const { render } = await createController();

    let controller = render();
    await controller.refreshAccountStatus();
    controller = render();

    expectSafeMessage(controller.accountNotice, "account.notice.statusRefreshFailed", secret);
    expect(controller.account.serverError).toBe("ACCOUNT_STATUS_UNAVAILABLE");
  });

  test("replaces server-provided error prose with a stable status code", async () => {
    const secret = "D:/private/backend-account-secret.txt";
    getAccountStatusMock.mockResolvedValueOnce(
      createAccountStatus("member@example.test", { serverError: secret }),
    );
    const { render } = await createController();

    let controller = render();
    await controller.refreshAccountStatus();
    controller = render();

    expect(controller.account.serverError).toBe("ACCOUNT_STATUS_UNAVAILABLE");
    expect(JSON.stringify(controller.account)).not.toContain(secret);
    expectSafeMessage(
      controller.accountNotice,
      "account.notice.statusRefreshFailed",
      secret,
    );
  });

  test("keeps the newest account refresh when an older request resolves last", async () => {
    const first = deferred<AccountStatus>();
    const second = deferred<AccountStatus>();
    getAccountStatusMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { render } = await createController();

    let controller = render();
    const firstRefresh = controller.refreshAccountStatus();
    controller = render();
    const secondRefresh = controller.refreshAccountStatus();

    second.resolve(createAccountStatus("newest@example.test"));
    await secondRefresh;
    controller = render();
    expect(controller.account.email).toBe("newest@example.test");
    expect(controller.accountLoading).toBe(false);

    first.resolve(createAccountStatus("stale@example.test"));
    await firstRefresh;
    controller = render();
    expect(controller.account.email).toBe("newest@example.test");
    expect(controller.accountLoading).toBe(false);
  });

  test("does not let a passive refresh overwrite a later activation", async () => {
    const passiveRefresh = deferred<AccountStatus>();
    getAccountStatusMock.mockImplementationOnce(() => passiveRefresh.promise);
    redeemActivationCodeMock.mockResolvedValueOnce(
      createAccountStatus("activated@example.test"),
    );
    const { render } = await createController();

    let controller = render();
    const refresh = controller.refreshAccountStatus();
    controller.setActivationCodeDraft("FQ-TEST");
    controller = render();
    await controller.redeemActivationCodeFromInput();
    controller = render();
    expect(controller.account.email).toBe("activated@example.test");
    expect(controller.accountLoading).toBe(false);

    passiveRefresh.resolve(createAccountStatus("stale@example.test"));
    await refresh;
    controller = render();
    expect(controller.account.email).toBe("activated@example.test");
    expect(controller.accountNotice).toEqual({
      messageCode: "account.notice.activationSuccess",
    });
  });

  test("uses fixed semantic failures for login, activation, and sign-out", async () => {
    const secret = "private-auth-token";
    beginAuthFlowMock.mockRejectedValueOnce(new Error(secret));
    const { render } = await createController();

    let controller = render();
    await controller.startLoginFlow();
    controller = render();
    expectSafeMessage(controller.accountNotice, "account.notice.loginStartFailed", secret);

    controller.setActivationCodeDraft("FQ-TEST");
    controller = render();
    redeemActivationCodeMock.mockRejectedValueOnce(new Error(secret));
    await controller.redeemActivationCodeFromInput();
    controller = render();
    expectSafeMessage(controller.accountNotice, "account.notice.activationFailed", secret);

    logoutAccountMock.mockRejectedValueOnce(new Error(secret));
    await controller.signOutAccount();
    controller = render();
    expectSafeMessage(controller.accountNotice, "account.notice.signOutFailed", secret);
  });

  test("derives account chip and status copy from the current locale", async () => {
    const activeAccount = createAccountStatus("member@example.test");
    getAccountStatusMock.mockResolvedValueOnce(activeAccount);
    const { render } = await createController();

    let controller = render();
    await controller.refreshAccountStatus();
    controller = render();
    expect(controller.accountChipLabel).toBe("Authorized");
    expect(controller.accountStatusText).toBe("Authorization active");

    currentLocale = "zh-TW";
    controller = render();
    expect(controller.accountChipLabel).toBe("授權有效");
    expect(controller.accountStatusText).toBe("授權有效");
  });
});
