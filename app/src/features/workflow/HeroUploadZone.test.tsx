import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import type { LocalMediaSelectionView } from "../../localMediaContract";
import { HeroUploadZone } from "./HeroUploadZone";

function renderHero(
  overrides: Partial<ComponentProps<typeof HeroUploadZone>> = {},
): string {
  const props: ComponentProps<typeof HeroUploadZone> = {
    source: { kind: "none" },
    canSubmit: false,
    statusBody: "Ready",
    onLocalMediaSelected: vi.fn(),
    onRemoveLocalMedia: vi.fn(async () => true),
    onSubmit: vi.fn(),
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
      <HeroUploadZone {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("en-US");
});

describe("HeroUploadZone", () => {
  test("renders as a reusable equal-weight upload card with its existing entry points", () => {
    const selection: LocalMediaSelectionView = {
      selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
      displayName: "Lecture.mp3",
      mediaKind: "audio",
      extension: "mp3",
      sizeBytes: 1024,
    };

    const markup = renderHero({
      source: { kind: "local_media", selection },
      canSubmit: true,
    });

    expect(markup).toContain('class="hero-upload-card"');
    expect(markup).toContain("Lecture.mp3");
    expect(markup).toContain("Replace file");
    expect(markup).toContain("Start processing");
    expect(markup).toContain("Topic title (optional)");
    expect(markup).not.toContain(selection.selectionToken);
  });

  test("can be disabled by the future recording entry integration", () => {
    const markup = renderHero({
      disabled: true,
      canSubmit: true,
      source: {
        kind: "local_media",
        selection: {
          selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
          displayName: "Lecture.mp3",
          mediaKind: "audio",
          extension: "mp3",
          sizeBytes: 1024,
        },
      },
    });

    expect(markup).toContain('class="hero-upload-card disabled"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('class="hero-upload-title-input"');
    expect(markup).toContain('class="hero-upload-replace"');
    expect(markup).toContain('class="primary-button hero-upload-submit"');
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
