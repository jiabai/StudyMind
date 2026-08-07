import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test } from "vitest";

import { createGuestAccountStatus, type AccountStatus } from "../../accountState";
import { formatDateTime } from "../../i18n/formatters";
import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";
import { uiMessage } from "../../i18n/uiMessage";
import { AccountSheet } from "./AccountSheet";

function createAccount(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    ...createGuestAccountStatus(),
    authenticated: true,
    email: "member+原文@example.test",
    entitlementStatus: "active",
    llmQuotaLimit: 2000,
    llmQuotaRemaining: 1234,
    llmConfigured: true,
    canProcess: true,
    canGenerateAi: true,
    ...overrides,
  };
}

function createProps(
  overrides: Partial<ComponentProps<typeof AccountSheet>> = {},
): ComponentProps<typeof AccountSheet> {
  return {
    open: true,
    account: createAccount(),
    accountStatusText: "localized account status",
    accountNotice: null,
    accountLoading: false,
    activationCodeDraft: "",
    activationRedeeming: false,
    onClose: () => undefined,
    onActivationCodeChange: () => undefined,
    onRedeemActivationCode: () => undefined,
    onSignOut: () => undefined,
    onStartLogin: () => undefined,
    ...overrides,
  };
}

function renderAccountSheet(
  props: ComponentProps<typeof AccountSheet>,
  locale: SupportedLocale,
): string {
  return renderToStaticMarkup(
    <LocaleProvider
      initialOutcome={{
        preference: locale,
        resolvedLocale: locale,
        persistedAnchor: locale,
        notice: null,
      }}
    >
      <AccountSheet {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("zh-CN");
});

describe("AccountSheet localization", () => {
  test("renders dialog labels and controls in every supported locale", async () => {
    const props = createProps();

    await initializeI18n("zh-CN");
    const simplified = renderAccountSheet(props, "zh-CN");
    expect(simplified).toContain('aria-label="账号与授权"');
    expect(simplified).toContain("退出登录");

    await initializeI18n("zh-TW");
    const traditional = renderAccountSheet(props, "zh-TW");
    expect(traditional).toContain('aria-label="帳號與授權"');
    expect(traditional).toContain("登出");

    await initializeI18n("en-US");
    const english = renderAccountSheet(props, "en-US");
    expect(english).toContain('aria-label="Account and authorization"');
    expect(english).toContain("Sign out");
    expect(english).toContain("AI Credits: 1,234 / 2,000");
  });

  test("preserves the email while replacing server errors with generic localized guidance", async () => {
    const props = createProps({
      account: createAccount({ serverError: "D:/private/member-secret.txt" }),
    });

    await initializeI18n("en-US");
    const markup = renderAccountSheet(props, "en-US");
    expect(markup).toContain("member+原文@example.test");
    expect(markup).toContain("Account status is temporarily unavailable");
    expect(markup).not.toContain("member-secret");
  });

  test("renders one semantic notice in the current locale", async () => {
    const notice = uiMessage("account.notice.loginFailed");
    const props = createProps({ accountNotice: notice });

    await initializeI18n("zh-TW");
    expect(renderAccountSheet(props, "zh-TW")).toContain("登入失敗");
    await initializeI18n("en-US");
    const english = renderAccountSheet(props, "en-US");
    expect(english).toContain("Sign-in failed");
    expect(english).toContain('role="status"');
    expect(english).toContain('aria-live="polite"');
  });

  test("formats quota reset dates with the active locale", async () => {
    const resetAt = "2026-07-10T00:00:00.000Z";
    const props = createProps({
      account: createAccount({ llmQuotaResetsAt: resetAt }),
    });

    await initializeI18n("en-US");
    const markup = renderAccountSheet(props, "en-US");
    expect(markup).toContain(formatDateTime(new Date(resetAt), "en-US"));
  });
});
