import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import type { SupportedLocale } from "../../i18n/locale";
import { LoginGuide } from "./LoginGuide";

function createProps(
  overrides: Partial<ComponentProps<typeof LoginGuide>> = {},
): ComponentProps<typeof LoginGuide> {
  return {
    loginInProgress: false,
    onLogin: () => undefined,
    ...overrides,
  };
}

function renderLoginGuide(
  props: ComponentProps<typeof LoginGuide>,
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
      <LoginGuide {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("zh-CN");
});

describe("LoginGuide", () => {
  test("renders the guide copy in every supported locale", async () => {
    await initializeI18n("zh-CN");
    const simplified = renderLoginGuide(createProps(), "zh-CN");
    expect(simplified).toContain("StudyMind，我帮你");
    expect(simplified).toContain(">登录<");

    await initializeI18n("zh-TW");
    const traditional = renderLoginGuide(createProps(), "zh-TW");
    expect(traditional).toContain("StudyMind，我幫你");
    expect(traditional).toContain(">登入<");

    await initializeI18n("en-US");
    const english = renderLoginGuide(createProps(), "en-US");
    expect(english).toContain("StudyMind, I&#x27;m here to help");
    expect(english).toContain(">Sign in<");
  });

  test("keeps the primary login action disabled while a login is in progress", () => {
    const markup = renderLoginGuide(
      createProps({ loginInProgress: true }),
      "en-US",
    );

    expect(markup).toContain('class="primary-button login-guide-login"');
    expect(markup).toContain("Signing in");
    expect(markup).toContain("disabled");
  });

  test("exposes an accessible region with an inline mascot and privacy note", () => {
    const markup = renderLoginGuide(createProps(), "en-US");

    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Sign-in guide"');
    expect(markup).toContain('class="login-guide-mascot"');
    expect(markup).toContain("aria-hidden=\"true\"");
    expect(markup).toContain("<svg");
    expect(markup).toContain('class="login-guide-tagline"');
    expect(markup).toContain('class="login-guide-subtitle"');
    expect(markup).toContain('class="login-guide-privacy"');
    expect(markup).toContain("stay on this device");
    expect(markup).not.toContain('class="login-guide-links"');
  });

  test("renders configurable privacy and terms links when URLs are provided", async () => {
    await initializeI18n("zh-CN");
    const simplified = renderLoginGuide(
      createProps({
        footerLinks: {
          privacyUrl: "https://example.test/privacy",
          termsUrl: "https://example.test/terms",
        },
      }),
      "zh-CN",
    );
    expect(simplified).toContain('class="login-guide-links"');
    expect(simplified).toContain('aria-label="法律信息"');
    expect(simplified).toContain('href="https://example.test/privacy"');
    expect(simplified).toContain(">隐私政策<");
    expect(simplified).toContain('href="https://example.test/terms"');
    expect(simplified).toContain(">服务条款<");

    await initializeI18n("en-US");
    const english = renderLoginGuide(
      createProps({
        footerLinks: { privacyUrl: "https://example.test/privacy" },
      }),
      "en-US",
    );
    expect(english).toContain(">Privacy Policy<");
    expect(english).not.toContain("Terms of Service");
  });
});
