import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import type { RecordingLibraryEntry } from "../../recordingClient";
import { RecordingLibraryPanel } from "./RecordingLibraryPanel";
import type {
  RecordingEntryState,
  RecordingLibraryController,
} from "./useRecordingLibrary";

function entry(recordingId: string): RecordingLibraryEntry {
  return {
    recordingId,
    path: `C:\\recordings\\${recordingId}`,
    displayName: recordingId,
    sizeBytes: 1_024_000,
    durationMs: 65_000,
    createdAtMs: 1_789_197_320_039,
  };
}

function createController(
  overrides: Partial<RecordingLibraryController> = {},
): RecordingLibraryController {
  return {
    status: "ready",
    entries: [],
    totalBytes: 0,
    highlightedId: null,
    savedNotice: false,
    entryStates: {},
    refresh: vi.fn(async () => undefined),
    applySaved: vi.fn(),
    importEntry: vi.fn(async () => true),
    ...overrides,
  };
}

function renderPanel(
  controller: RecordingLibraryController,
  props: Partial<ComponentProps<typeof RecordingLibraryPanel>> = {},
): string {
  return renderToStaticMarkup(
    <LocaleProvider
      initialOutcome={{
        preference: "en-US",
        resolvedLocale: "en-US",
        persistedAnchor: "en-US",
        notice: null,
      }}
    >
      <RecordingLibraryPanel controller={controller} {...props} />
    </LocaleProvider>,
  );
}

function statesFor(
  recordingId: string,
  state: RecordingEntryState,
): Record<string, RecordingEntryState> {
  return { [recordingId]: state };
}

beforeAll(async () => {
  await initializeI18n("en-US");
});

describe("RecordingLibraryPanel", () => {
  test("gives every saved recording an import action named after the entry", () => {
    const controller = createController({
      entries: [entry("recording_2000.wav")],
      totalBytes: 1_024_000,
    });

    const markup = renderPanel(controller);

    expect(markup).toContain("recording-library-import");
    expect(markup).toContain("Import");
    expect(markup).toMatch(/aria-label="Import recording_2000\.wav[^"]*"/);
  });

  test("expresses the not-yet-imported state with text, not colour alone", () => {
    const markup = renderPanel(
      createController({ entries: [entry("recording_2000.wav")] }),
    );

    expect(markup).toContain("recording-library-item-status is-saved");
    expect(markup).toContain("Not imported");
  });

  test("blocks the importing button without dropping it from the tab order", () => {
    const markup = renderPanel(
      createController({
        entries: [entry("recording_2000.wav")],
        entryStates: statesFor("recording_2000.wav", { status: "importing" }),
      }),
    );

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toContain("disabled=\"\"");
    expect(markup).toContain("Importing");
  });

  test("marks an imported recording and still offers the import action again", () => {
    const markup = renderPanel(
      createController({
        entries: [entry("recording_2000.wav")],
        entryStates: statesFor("recording_2000.wav", { status: "imported" }),
      }),
    );

    expect(markup).toContain("recording-library-item-status is-imported");
    expect(markup).toContain("Imported");
    expect(markup).toContain("recording-library-import");
    expect(markup).toMatch(/>Import</);
  });

  test("turns the failed entry into a retry that names the underlying code", () => {
    const markup = renderPanel(
      createController({
        entries: [entry("recording_2000.wav")],
        entryStates: statesFor("recording_2000.wav", {
          status: "importFailed",
          errorCode: "LOCAL_MEDIA_UNAVAILABLE",
        }),
      }),
    );

    expect(markup).toContain("recording-library-item-status is-import-failed");
    expect(markup).toContain("Import failed");
    expect(markup).toContain("LOCAL_MEDIA_UNAVAILABLE");
    expect(markup).toMatch(/>Try again</);
  });

  test("warns about the replacement next to the button only when media is selected", () => {
    const controller = createController({ entries: [entry("recording_2000.wav")] });

    const withoutSelection = renderPanel(controller);
    expect(withoutSelection).not.toContain("recording-library-replace-hint");

    const withSelection = renderPanel(controller, {
      selectedMediaName: "lecture.mp3",
    });
    expect(withSelection).toContain("recording-library-replace-hint");
    expect(withSelection).toContain("lecture.mp3");
  });

  test("does not warn about replacing a recording with itself", () => {
    const markup = renderPanel(
      createController({
        entries: [entry("recording_2000.wav")],
        entryStates: statesFor("recording_2000.wav", { status: "imported" }),
      }),
      { selectedMediaName: "recording_2000.wav" },
    );

    expect(markup).not.toContain("recording-library-replace-hint");
  });

  test("locks every import action while recording owns the input area", () => {
    const markup = renderPanel(
      createController({ entries: [entry("recording_2000.wav")] }),
      { disabled: true },
    );

    expect(markup).toMatch(/<button[^>]*class="recording-library-import"[^>]*disabled/);
  });
});
