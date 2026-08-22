import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test, vi } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { LocaleProvider } from "../../i18n/LocaleProvider";
import type { RecordingController } from "./useRecordingController";
import { RecordingCard } from "./RecordingCard";

function createController(
  overrides: Partial<RecordingController> = {},
): RecordingController {
  return {
    capability: {
      status: "ready",
      details: {
        platform: "windows",
        microphone: { available: true },
        systemAudio: { available: true },
        mixed: { available: true },
      },
    },
    mode: "mic",
    session: { status: "idle" },
    activeSessionId: null,
    elapsedMs: 0,
    discardConfirmationOpen: false,
    handoff: { status: "idle" },
    setMode: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    requestDiscard: vi.fn(),
    confirmDiscard: vi.fn(async () => undefined),
    closeDiscard: vi.fn(),
    retryHandoff: vi.fn(async () => undefined),
    isModeAvailable: vi.fn(() => true),
    modeSelectionDisabled: false,
    ...overrides,
  };
}

function renderCard(
  controller: RecordingController = createController(),
): string {
  const props: ComponentProps<typeof RecordingCard> = { controller };
  return renderToStaticMarkup(
    <LocaleProvider
      initialOutcome={{
        preference: "en-US",
        resolvedLocale: "en-US",
        persistedAnchor: "en-US",
        notice: null,
      }}
    >
      <RecordingCard {...props} />
    </LocaleProvider>,
  );
}

beforeAll(async () => {
  await initializeI18n("en-US");
});

describe("RecordingCard", () => {
  test("renders three native source options and explicit recording controls", () => {
    const markup = renderCard();

    expect(markup).toContain('class="recording-card"');
    expect(markup).toContain('class="recording-source-select"');
    expect(markup).toContain('value="mic"');
    expect(markup).toContain('value="system"');
    expect(markup).toContain('value="mixed"');
    expect(markup).toContain("recording-start-button");
    expect(markup).toContain("Start recording");
    expect(markup).not.toContain('role="button"');
  });

  test("shows only localized stable error copy without exposing error details", () => {
    const markup = renderCard({
      ...createController(),
      session: {
        status: "error",
        errorCode: "RECORDING_MIC_ACCESS_DENIED",
      },
    });

    expect(markup).toContain("Microphone access is unavailable");
    expect(markup).not.toContain("RECORDING_MIC_ACCESS_DENIED");
    expect(markup).not.toContain("C:\\");
  });

  test("renders an accessible discard confirmation and retryable handoff action", () => {
    const markup = renderCard({
      ...createController({
        session: { status: "recording" },
        activeSessionId: "session-1",
        elapsedMs: 65_000,
        discardConfirmationOpen: true,
        handoff: {
          status: "retryable",
          errorCode: "RECORDING_HANDOFF_FAILED",
        },
      }),
    });

    expect(markup).toContain("recording-stop-button");
    expect(markup).toContain("recording-discard-button");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("Discard recording");
    expect(markup).toContain("recording-retry-button");
    expect(markup).toContain("Retry handoff");
    expect(markup).toContain("01:05");
  });

  test("restores focus across recording and discard state transitions", () => {
    const source = readFileSync(new URL("./RecordingCard.tsx", import.meta.url), "utf8");

    expect(source).toContain("useEffect");
    expect(source).toContain("startButtonRef");
    expect(source).toContain("stopButtonRef");
    expect(source).toContain("discardButtonRef");
    expect(source).toContain("discardCancelRef");
    expect(source).toMatch(/discardConfirmationOpen[\s\S]*?discardCancelRef\.current\?\.focus/);
    expect(source).toMatch(/session\.status[\s\S]*?stopButtonRef\.current\?\.focus/);
    expect(source).toMatch(/startButtonRef\.current\?\.focus/);
  });

  test("does not surface system-audio-recovered warnings during active recording", () => {
    // macOS SCK 启动时普遍存在微小中断并自动恢复，该提示无用户可操作性，
    // 产品决定不展示（warning 数据仍保留在会话状态与 stop 结果中）。
    const markup = renderCard(
      createController({
        session: {
          status: "recording",
          warnings: [
            {
              warningCode: "RECORDING_SYSTEM_AUDIO_RECOVERED",
              source: "systemAudio",
              count: 1,
              totalGapMs: 800,
            },
          ],
          warningCode: "RECORDING_SYSTEM_AUDIO_RECOVERED",
        },
        activeSessionId: "session-1",
        elapsedMs: 5_000,
      }),
    );

    expect(markup).not.toContain("recovered");
    expect(markup).not.toContain("Try again");
    expect(markup).not.toContain("cannot continue right now");
    expect(markup).not.toContain("recording-error");
  });

  test("traps focus inside the discard confirmation with the shared modal hook", () => {
    const source = readFileSync(new URL("./RecordingCard.tsx", import.meta.url), "utf8");

    expect(source).toContain("useModalFocus");
    expect(source).toContain("discardModalRef");
    expect(source).toMatch(/ref=\{discardModalRef\}/);
  });
});
