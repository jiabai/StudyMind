import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import { TaskComposer } from "./TaskComposer";

function renderComposer(
  overrides: Partial<ComponentProps<typeof TaskComposer>> = {},
): string {
  const props: ComponentProps<typeof TaskComposer> = {
    source: { kind: "url", urlDraft: "https://example.test/video" },
    canSubmit: true,
    statusBody: "Ready",
    onUrlDraftChange: vi.fn(),
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
      <TaskComposer {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("en-US");
});

describe("TaskComposer", () => {
  test("renders one accessible attachment menu beside the retained URL composer", () => {
    const markup = renderComposer();

    expect(markup).toContain('class="attachment-trigger"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('id="video-url"');
    expect(markup).toContain('value="https://example.test/video"');
    expect(markup).not.toContain('role="menu"');
  });

  test("renders an audio selection as a removable safe chip with localized size", () => {
    const markup = renderComposer({
      source: {
        kind: "local_media",
        retainedUrlDraft: "https://example.test/retained",
        selection: {
          selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
          displayName: "Interview.mp3",
          mediaKind: "audio",
          extension: "mp3",
          sizeBytes: 1_572_864,
        },
      },
    });

    expect(markup).toContain('class="local-media-chip"');
    expect(markup).toContain('data-media-kind="audio"');
    expect(markup).toContain("Interview.mp3");
    expect(markup).toContain("Audio");
    expect(markup).toContain("1.5 MB");
    expect(markup).toContain('class="local-media-remove"');
    expect(markup).not.toContain('id="video-url"');
    expect(markup).not.toContain("https://example.test/retained");
    expect(markup).not.toContain("selectionToken");
  });
});
