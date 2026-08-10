import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { createBrowserPreviewAccountStatus, createGuestAccountStatus } from "../../accountState";
import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import { deriveUserName, SidebarUserMenu, SidebarUserMenuItems } from "./SidebarUserMenu";

function renderUserMenu(
  overrides: Partial<ComponentProps<typeof SidebarUserMenu>> = {},
): string {
  const props: ComponentProps<typeof SidebarUserMenu> = {
    account: createBrowserPreviewAccountStatus(),
    onOpenAccount: vi.fn(),
    onOpenSettings: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };

  return renderToStaticMarkup(
    <LocaleProvider
      initialOutcome={{
        preference: "en-US",
        resolvedLocale: "en-US",
        persistedAnchor: "en-US",
        notice: null,
      }}
    >
      <SidebarUserMenu {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("en-US");
});

describe("SidebarUserMenu", () => {
  test("renders a username trigger with an accessible menu button while closed", () => {
    const markup = renderUserMenu();

    expect(markup).toContain('class="sidebar-user-trigger"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("browser-preview");
    expect(markup).toContain("B");
    expect(markup).not.toContain('role="menu"');
  });

  test("shows the guest label and an icon avatar when signed out", () => {
    const markup = renderUserMenu({ account: createGuestAccountStatus() });

    expect(markup).toContain("Guest");
    expect(markup).toContain('class="sidebar-user-avatar"');
    expect(markup).not.toContain("browser-preview");
  });
});

describe("SidebarUserMenuItems", () => {
  function renderItems(
    overrides: Partial<ComponentProps<typeof SidebarUserMenuItems>> = {},
  ): string {
    const props: ComponentProps<typeof SidebarUserMenuItems> = {
      signedIn: true,
      userName: "browser-preview",
      quotaRemaining: 8,
      onOpenAccount: vi.fn(),
      onOpenSettings: vi.fn(),
      onSignOut: vi.fn(),
      ...overrides,
    };

    return renderToStaticMarkup(
      <LocaleProvider
        initialOutcome={{
          preference: "en-US",
          resolvedLocale: "en-US",
          persistedAnchor: "en-US",
          notice: null,
        }}
      >
        <div role="menu">{<SidebarUserMenuItems {...props} />}</div>
      </LocaleProvider>,
    );
  }

  test("lists credits with the remaining quota, settings, and sign out", () => {
    const markup = renderItems();

    expect(markup).toContain("Credits");
    expect(markup).toContain('class="sidebar-user-menu-value"');
    expect(markup).toContain(">8<");
    expect(markup).toContain("Settings");
    expect(markup).toContain("Sign out");
  });

  test("disables sign out for guests", () => {
    const markup = renderItems({
      signedIn: false,
      userName: "Guest",
      quotaRemaining: 0,
    });

    expect(markup).toContain('class="sidebar-user-menu-item danger"');
    expect(markup).toContain("disabled");
  });
});

describe("deriveUserName", () => {
  test("uses the email prefix for signed-in accounts", () => {
    expect(deriveUserName(createBrowserPreviewAccountStatus(), "Guest")).toBe(
      "browser-preview",
    );
  });

  test("falls back to the guest label when signed out", () => {
    expect(deriveUserName(createGuestAccountStatus(), "Guest")).toBe("Guest");
  });
});
