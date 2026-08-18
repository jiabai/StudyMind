import {
  CircleAlert,
  Layers,
  LoaderCircle,
  Mic,
  RefreshCw,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type {
  RecordingController,
  RecordingControllerErrorCode,
} from "./useRecordingController";
import type { RecordingMode } from "../../recordingClient";

export type RecordingCardProps = {
  controller: RecordingController;
};

const SOURCE_MODES: readonly RecordingMode[] = ["mic", "system", "mixed"];

type RecordingErrorCopyKey =
  | "input.recording.error.generic"
  | "input.recording.error.platformUnsupported"
  | "input.recording.error.capabilityProbeFailed"
  | "input.recording.error.microphoneAccess"
  | "input.recording.error.microphoneUnavailable"
  | "input.recording.error.systemUnavailable"
  | "input.recording.error.mixedUnavailable"
  | "input.recording.error.sourceUnavailable"
  | "input.recording.error.handoff"
  | "input.recording.error.preferences"
  | "input.recording.error.cancel"
  | "input.recording.error.empty"
  | "input.recording.error.diskSpace"
  | "input.recording.error.write"
  | "input.recording.error.finalize"
  | "input.recording.error.stream"
  | "input.recording.error.alreadyActive";

function isRecordingMode(value: string): value is RecordingMode {
  return value === "mic" || value === "system" || value === "mixed";
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

function errorCopyKey(
  errorCode: RecordingControllerErrorCode,
): RecordingErrorCopyKey {
  switch (errorCode) {
    case "RECORDING_PLATFORM_UNSUPPORTED":
      return "input.recording.error.platformUnsupported";
    case "RECORDING_CAPABILITY_PROBE_FAILED":
    case "RECORDING_STATE_UNAVAILABLE":
    case "RECORDING_IPC_RESPONSE_INVALID":
      return "input.recording.error.capabilityProbeFailed";
    case "RECORDING_MIC_ACCESS_DENIED":
      return "input.recording.error.microphoneAccess";
    case "RECORDING_MIC_INIT_FAILED":
      return "input.recording.error.microphoneUnavailable";
    case "RECORDING_SYSTEM_LOOPBACK_INIT_FAILED":
    case "RECORDING_SYSTEM_AUDIO_UNAVAILABLE":
      return "input.recording.error.systemUnavailable";
    case "RECORDING_MIX_FAILED":
      return "input.recording.error.mixedUnavailable";
    case "RECORDING_SOURCE_UNAVAILABLE":
      return "input.recording.error.sourceUnavailable";
    case "RECORDING_HANDOFF_FAILED":
      return "input.recording.error.handoff";
    case "RECORDING_PREFERENCES_UNAVAILABLE":
      return "input.recording.error.preferences";
    case "RECORDING_CANCEL_FAILED":
      return "input.recording.error.cancel";
    case "RECORDING_EMPTY":
      return "input.recording.error.empty";
    case "RECORDING_DISK_SPACE_LOW":
      return "input.recording.error.diskSpace";
    case "RECORDING_WRITE_FAILED":
      return "input.recording.error.write";
    case "RECORDING_FINALIZE_FAILED":
      return "input.recording.error.finalize";
    case "RECORDING_STREAM_ERROR":
      return "input.recording.error.stream";
    case "RECORDING_ALREADY_ACTIVE":
      return "input.recording.error.alreadyActive";
    case "RECORDING_UNKNOWN_ERROR":
    default:
      return "input.recording.error.generic";
  }
}

function CapabilityNotice({ controller }: RecordingCardProps) {
  const { t } = useTranslation("workflow");
  const details = controller.capability.details;

  if (controller.capability.status === "loading") {
    return <p className="recording-capability-notice">{t("input.recording.capability.loading")}</p>;
  }
  if (controller.capability.status === "unknown") {
    return <p className="recording-capability-notice">{t("input.recording.capability.unknown")}</p>;
  }
  if (controller.capability.status === "unsupported") {
    return (
      <p className="recording-capability-notice recording-capability-notice-warning" role="status">
        {t("input.recording.capability.unsupported")}
      </p>
    );
  }
  if (controller.capability.status === "unavailable") {
    return (
      <p className="recording-capability-notice recording-capability-notice-warning" role="status">
        {t("input.recording.capability.unavailable")}
      </p>
    );
  }
  if (details && !details.microphone.available && !details.systemAudio.available) {
    return <p className="recording-capability-notice recording-capability-notice-warning" role="status">{t("input.recording.capability.unavailable")}</p>;
  }
  if (details && !details.microphone.available) {
    return <p className="recording-capability-notice" role="status">{t("input.recording.capability.microphoneUnavailable")}</p>;
  }
  if (details && !details.systemAudio.available) {
    return <p className="recording-capability-notice" role="status">{t("input.recording.capability.systemUnavailable")}</p>;
  }
  return <p className="recording-capability-notice" role="status">{t("input.recording.capability.ready")}</p>;
}

export function RecordingCard({ controller }: RecordingCardProps) {
  const { t } = useTranslation("workflow");
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);
  const discardCancelRef = useRef<HTMLButtonElement>(null);
  const previousStatusRef = useRef(controller.session.status);
  const previousDiscardConfirmationRef = useRef(false);
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);
  const sessionBusy =
    controller.session.status === "starting" ||
    controller.session.status === "stopping";
  const recording =
    controller.session.status === "recording" ||
    controller.session.status === "stopping";
  const errorCode =
    controller.handoff.errorCode ??
    controller.session.errorCode ??
    controller.capability.errorCode;
  const showError = Boolean(
    errorCode &&
      (controller.session.status === "error" ||
        controller.handoff.status === "retryable" ||
        controller.capability.status === "unsupported" ||
        controller.capability.status === "unavailable"),
  );
  const canStart =
    controller.capability.status === "ready" &&
    controller.isModeAvailable(controller.mode) &&
    !sessionBusy &&
    !recording;

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    const nextStatus = controller.session.status;
    const wasDiscardConfirmationOpen = previousDiscardConfirmationRef.current;
    const isDiscardConfirmationOpen = controller.discardConfirmationOpen;
    previousStatusRef.current = nextStatus;
    previousDiscardConfirmationRef.current = isDiscardConfirmationOpen;

    if (isDiscardConfirmationOpen && !wasDiscardConfirmationOpen) {
      requestAnimationFrame(() => discardCancelRef.current?.focus());
      return;
    }

    if (!isDiscardConfirmationOpen && wasDiscardConfirmationOpen) {
      requestAnimationFrame(() => {
        const returnTarget = discardReturnFocusRef.current;
        if (returnTarget?.isConnected) {
          returnTarget.focus();
        } else {
          startButtonRef.current?.focus() ?? stopButtonRef.current?.focus();
        }
        discardReturnFocusRef.current = null;
      });
      return;
    }

    if (previousStatus === nextStatus) {
      return;
    }

    if (nextStatus === "recording") {
      requestAnimationFrame(() => stopButtonRef.current?.focus());
      return;
    }

    if (
      (nextStatus === "idle" || nextStatus === "error") &&
      (previousStatus === "starting" ||
        previousStatus === "recording" ||
        previousStatus === "stopping")
    ) {
      requestAnimationFrame(() => startButtonRef.current?.focus());
    }
  }, [controller.discardConfirmationOpen, controller.session.status]);

  const handleRequestDiscard = () => {
    discardReturnFocusRef.current = discardButtonRef.current;
    controller.requestDiscard();
  };

  return (
    <section className="recording-card" aria-labelledby="recording-card-title">
      <div className="recording-card-header">
        <div className="recording-card-icon" aria-hidden="true">
          <Mic size={24} strokeWidth={1.8} />
        </div>
        <div>
          <p className="section-label">{t("input.sectionLabel")}</p>
          <h2 id="recording-card-title">{t("input.recording.title")}</h2>
          <p className="recording-card-subtitle">{t("input.recording.subtitle")}</p>
        </div>
      </div>

      <div className="recording-card-body">
        <label className="recording-source-field">
          <span className="recording-source-label">{t("input.recording.sourceLabel")}</span>
          <span className="recording-source-control">
            <select
              className="recording-source-select"
              value={controller.mode}
              disabled={controller.modeSelectionDisabled}
              aria-describedby="recording-capability-notice"
              onChange={(event) => {
                if (isRecordingMode(event.currentTarget.value)) {
                  controller.setMode(event.currentTarget.value);
                }
              }}
            >
              {SOURCE_MODES.map((mode) => (
                <option key={mode} value={mode} disabled={!controller.isModeAvailable(mode)}>
                  {t(`input.recording.source.${mode}`)}
                </option>
              ))}
            </select>
            {controller.mode === "mic" ? <Mic size={17} aria-hidden="true" /> : null}
            {controller.mode === "system" ? <Volume2 size={17} aria-hidden="true" /> : null}
            {controller.mode === "mixed" ? <Layers size={17} aria-hidden="true" /> : null}
          </span>
        </label>

        <div id="recording-capability-notice">
          <CapabilityNotice controller={controller} />
        </div>

        <div className="recording-elapsed" aria-live="polite">
          <span className="recording-elapsed-label">{t("input.recording.elapsedAria")}</span>
          <time className="recording-elapsed-value">{formatElapsed(controller.elapsedMs)}</time>
        </div>

        {showError && errorCode ? (
          <p className="recording-error" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{t(errorCopyKey(errorCode))}</span>
          </p>
        ) : null}

        <div className="recording-card-actions">
          {recording ? (
            <>
              <button
                ref={stopButtonRef}
                className="primary-button recording-stop-button"
                type="button"
                onClick={() => void controller.stop()}
                disabled={controller.session.status === "stopping"}
                aria-busy={controller.session.status === "stopping"}
              >
                {controller.session.status === "stopping" ? (
                  <LoaderCircle className="spin" size={17} aria-hidden="true" />
                ) : (
                  <Square size={16} fill="currentColor" aria-hidden="true" />
                )}
                <span>
                  {controller.session.status === "stopping"
                    ? t("input.recording.stopping")
                    : t("input.recording.stop")}
                </span>
              </button>
              <button
                ref={discardButtonRef}
                className="recording-discard-button"
                type="button"
                onClick={handleRequestDiscard}
                disabled={controller.session.status === "stopping"}
              >
                <Trash2 size={16} aria-hidden="true" />
                <span>{t("input.recording.discard")}</span>
              </button>
            </>
          ) : (
            <button
              ref={startButtonRef}
              className="primary-button recording-start-button"
              type="button"
              onClick={() => void controller.start()}
              disabled={!canStart}
              aria-busy={controller.session.status === "starting"}
            >
              {controller.session.status === "starting" ? (
                <LoaderCircle className="spin" size={17} aria-hidden="true" />
              ) : (
                <Mic size={17} aria-hidden="true" />
              )}
              <span>
                {controller.session.status === "starting"
                  ? t("input.recording.starting")
                  : t("input.recording.start")}
              </span>
            </button>
          )}
        </div>

        {controller.handoff.status === "retryable" ? (
          <button
            className="recording-retry-button"
            type="button"
            onClick={() => void controller.retryHandoff()}
          >
            <RefreshCw size={15} aria-hidden="true" />
            <span>{t("input.recording.retryHandoff")}</span>
          </button>
        ) : null}
      </div>

      {controller.discardConfirmationOpen ? (
        <div
          className="recording-discard-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recording-discard-title"
          aria-describedby="recording-discard-body"
        >
          <div className="recording-discard-dialog-icon" aria-hidden="true">
            <Trash2 size={20} />
          </div>
          <div className="recording-discard-dialog-copy">
            <h3 id="recording-discard-title">{t("input.recording.discardDialog.title")}</h3>
            <p id="recording-discard-body">{t("input.recording.discardDialog.body")}</p>
          </div>
          <div className="recording-discard-dialog-actions">
            <button ref={discardCancelRef} type="button" onClick={controller.closeDiscard}>
              {t("input.recording.discardDialog.cancel")}
            </button>
            <button
              className="danger-soft"
              type="button"
              onClick={() => void controller.confirmDiscard()}
            >
              {t("input.recording.discardDialog.confirm")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
