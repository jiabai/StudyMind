import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelRecording as defaultCancelRecording,
  getRecordingCapabilities as defaultGetRecordingCapabilities,
  startRecording as defaultStartRecording,
  stopRecording as defaultStopRecording,
  type RecordingCapabilities,
  type RecordingClientErrorCode,
  type RecordingMode,
  type RecordingResult,
  type RecordingStateView,
} from "../../recordingClient";
import {
  getUiPreferences as defaultReadPreferences,
  saveRecordingAudioSourceMode as defaultSaveAudioSourceMode,
  type UiPreferencesView,
} from "../../settingsClient";
import {
  selectLocalMediaByPath as defaultSelectLocalMediaByPath,
} from "../../localMediaClient";
import type { LocalMediaSelectionView } from "../../localMediaContract";

export type RecordingCapabilityStatus =
  | "loading"
  | "ready"
  | "unsupported"
  | "unavailable";

export type RecordingSessionStatus =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "error";

export type RecordingControllerErrorCode =
  | RecordingClientErrorCode
  | "RECORDING_HANDOFF_FAILED"
  | "RECORDING_PREFERENCES_UNAVAILABLE"
  | "RECORDING_SOURCE_UNAVAILABLE"
  | "RECORDING_CANCEL_FAILED";

export type RecordingCapabilityView = {
  status: RecordingCapabilityStatus;
  details?: RecordingCapabilities;
  errorCode?: RecordingControllerErrorCode;
};

export type RecordingSessionView = {
  status: RecordingSessionStatus;
  errorCode?: RecordingControllerErrorCode;
};

export type RecordingHandoffView = {
  status: "idle" | "retryable";
  errorCode?: RecordingControllerErrorCode;
};

export type RecordingTimer = {
  setInterval: (callback: () => void, delayMs: number) => number;
  clearInterval: (handle: number) => void;
};

export type RecordingClientDependencies = {
  getRecordingCapabilities: () => Promise<RecordingCapabilities>;
  getRecordingState?: () => Promise<RecordingStateView | null>;
  startRecording: (mode: RecordingMode) => Promise<{ sessionId: string }>;
  stopRecording: (sessionId: string) => Promise<RecordingResult>;
  cancelRecording: (sessionId: string) => Promise<void>;
};

export type UseRecordingControllerOptions = {
  recordingClient?: RecordingClientDependencies;
  readPreferences?: () => Promise<UiPreferencesView>;
  saveAudioSourceMode?: (
    mode: RecordingMode,
  ) => Promise<UiPreferencesView>;
  selectLocalMediaByPath?: (
    path: string,
  ) => Promise<LocalMediaSelectionView>;
  onLocalMediaSelected?: (selection: LocalMediaSelectionView) => void;
  clock?: () => number;
  timer?: RecordingTimer;
  onError?: (errorCode: RecordingControllerErrorCode) => void;
};

export type RecordingController = {
  capability: RecordingCapabilityView;
  mode: RecordingMode;
  session: RecordingSessionView;
  activeSessionId: string | null;
  elapsedMs: number;
  discardConfirmationOpen: boolean;
  handoff: RecordingHandoffView;
  setMode: (mode: RecordingMode) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  requestDiscard: () => void;
  confirmDiscard: () => Promise<void>;
  closeDiscard: () => void;
  retryHandoff: () => Promise<void>;
  isModeAvailable: (mode: RecordingMode) => boolean;
  modeSelectionDisabled: boolean;
};

const DEFAULT_TIMER: RecordingTimer = {
  setInterval: (callback, delayMs) =>
    globalThis.setInterval(callback, delayMs) as unknown as number,
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

const RECORDING_CLIENT_ERROR_CODES = new Set<string>([
  "RECORDING_ALREADY_ACTIVE",
  "RECORDING_PLATFORM_UNSUPPORTED",
  "RECORDING_CAPABILITY_PROBE_FAILED",
  "RECORDING_MIC_INIT_FAILED",
  "RECORDING_MIC_ACCESS_DENIED",
  "RECORDING_SYSTEM_LOOPBACK_INIT_FAILED",
  "RECORDING_SYSTEM_AUDIO_UNAVAILABLE",
  "RECORDING_STREAM_ERROR",
  "RECORDING_MIX_FAILED",
  "RECORDING_WRITE_FAILED",
  "RECORDING_DISK_SPACE_LOW",
  "RECORDING_EMPTY",
  "RECORDING_SESSION_INVALID",
  "RECORDING_FINALIZE_FAILED",
  "RECORDING_STATE_UNAVAILABLE",
  "RECORDING_UNKNOWN_ERROR",
  "RECORDING_IPC_RESPONSE_INVALID",
]);

function isRecordingMode(value: unknown): value is RecordingMode {
  return value === "mic" || value === "system" || value === "mixed";
}

function isStableRecordingErrorCode(
  value: unknown,
): value is RecordingControllerErrorCode {
  return (
    typeof value === "string" &&
    (RECORDING_CLIENT_ERROR_CODES.has(value) ||
      value === "RECORDING_HANDOFF_FAILED" ||
      value === "RECORDING_PREFERENCES_UNAVAILABLE" ||
      value === "RECORDING_SOURCE_UNAVAILABLE" ||
      value === "RECORDING_CANCEL_FAILED")
  );
}

function stableErrorCode(
  error: unknown,
  fallback: RecordingControllerErrorCode,
): RecordingControllerErrorCode {
  if (typeof error !== "object" || error === null) return fallback;
  const candidate = (error as { code?: unknown }).code;
  return isStableRecordingErrorCode(candidate) ? candidate : fallback;
}

function isModeAvailableFromCapabilities(
  capabilities: RecordingCapabilities | undefined,
  mode: RecordingMode,
): boolean {
  if (!capabilities || capabilities.platform !== "windows") return false;
  if (mode === "mic") return capabilities.microphone.available;
  if (mode === "system") return capabilities.systemAudio.available;
  return capabilities.microphone.available && capabilities.systemAudio.available;
}

function preferenceMode(value: unknown): RecordingMode {
  return isRecordingMode(value) ? value : "mic";
}

export function useRecordingController({
  recordingClient = {
    getRecordingCapabilities: defaultGetRecordingCapabilities,
    getRecordingState: undefined,
    startRecording: defaultStartRecording,
    stopRecording: defaultStopRecording,
    cancelRecording: defaultCancelRecording,
  },
  readPreferences = defaultReadPreferences,
  saveAudioSourceMode = defaultSaveAudioSourceMode,
  selectLocalMediaByPath = defaultSelectLocalMediaByPath,
  onLocalMediaSelected = () => undefined,
  clock = Date.now,
  timer = DEFAULT_TIMER,
  onError,
}: UseRecordingControllerOptions = {}): RecordingController {
  const [capability, setCapability] = useState<RecordingCapabilityView>({
    status: "loading",
  });
  const [mode, setModeState] = useState<RecordingMode>("mic");
  const [session, setSession] = useState<RecordingSessionView>({
    status: "idle",
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [handoff, setHandoff] = useState<RecordingHandoffView>({
    status: "idle",
  });

  const mountedRef = useRef(false);
  const capabilityRef = useRef(capability);
  const modeRef = useRef(mode);
  const sessionRef = useRef(session);
  const activeSessionIdRef = useRef(activeSessionId);
  const startedAtRef = useRef(startedAt);
  const discardConfirmationRef = useRef(discardConfirmationOpen);
  const preferenceModeRef = useRef<RecordingMode>("mic");
  const handoffResultRef = useRef<RecordingResult | null>(null);
  const capabilityRequestRef = useRef(0);
  const operationRef = useRef<"start" | "stop" | "cancel" | "handoff" | null>(null);

  capabilityRef.current = capability;
  modeRef.current = mode;
  sessionRef.current = session;
  activeSessionIdRef.current = activeSessionId;
  startedAtRef.current = startedAt;
  discardConfirmationRef.current = discardConfirmationOpen;

  const reportError = (errorCode: RecordingControllerErrorCode) => {
    onError?.(errorCode);
  };

  const updateSession = (next: RecordingSessionView) => {
    sessionRef.current = next;
    setSession(next);
  };

  const updateCapability = (next: RecordingCapabilityView) => {
    capabilityRef.current = next;
    setCapability(next);
  };

  const refreshCapabilities = async (): Promise<RecordingCapabilities | null> => {
    const requestId = capabilityRequestRef.current + 1;
    capabilityRequestRef.current = requestId;
    if (mountedRef.current) updateCapability({ status: "loading" });
    try {
      const details = await recordingClient.getRecordingCapabilities();
      if (!mountedRef.current || requestId !== capabilityRequestRef.current) return null;
      if (details.platform === "unsupported") {
        const errorCode = "RECORDING_PLATFORM_UNSUPPORTED" as const;
        updateCapability({ status: "unsupported", details, errorCode });
        reportError(errorCode);
        return details;
      }
      updateCapability({ status: "ready", details });
      const preferredMode = preferenceModeRef.current;
      const nextMode = isModeAvailableFromCapabilities(details, preferredMode)
        ? preferredMode
        : "mic";
      if (sessionRef.current.status === "idle") {
        modeRef.current = nextMode;
        setModeState(nextMode);
      }
      return details;
    } catch (error) {
      if (!mountedRef.current || requestId !== capabilityRequestRef.current) return null;
      const errorCode = stableErrorCode(error, "RECORDING_CAPABILITY_PROBE_FAILED");
      const status = errorCode === "RECORDING_PLATFORM_UNSUPPORTED"
        ? "unsupported"
        : "unavailable";
      updateCapability({ status, errorCode });
      reportError(errorCode);
      return null;
    }
  };

  const loadPreferences = async (): Promise<void> => {
    try {
      const preferences = await readPreferences();
      const nextPreferenceMode = preferenceMode(
        preferences && preferences.recording
          ? preferences.recording.audioSourceMode
          : undefined,
      );
      preferenceModeRef.current = nextPreferenceMode;
      if (!mountedRef.current || sessionRef.current.status !== "idle") return;
      const nextMode = isModeAvailableFromCapabilities(
        capabilityRef.current.details,
        nextPreferenceMode,
      )
        ? nextPreferenceMode
        : "mic";
      modeRef.current = nextMode;
      setModeState(nextMode);
    } catch {
      preferenceModeRef.current = "mic";
      if (mountedRef.current) reportError("RECORDING_PREFERENCES_UNAVAILABLE");
    }
  };

  const isModeAvailable = useCallback(
    (candidate: RecordingMode) =>
      isModeAvailableFromCapabilities(capabilityRef.current.details, candidate),
    [],
  );

  const setMode = useCallback((nextMode: RecordingMode) => {
    if (
      !isRecordingMode(nextMode) ||
      sessionRef.current.status !== "idle" ||
      !isModeAvailableFromCapabilities(capabilityRef.current.details, nextMode)
    ) {
      return;
    }
    preferenceModeRef.current = nextMode;
    modeRef.current = nextMode;
    setModeState(nextMode);
  }, []);

  const start = useCallback(async () => {
    if (
      operationRef.current ||
      (sessionRef.current.status !== "idle" &&
        sessionRef.current.status !== "error") ||
      !mountedRef.current
    ) {
      return;
    }
    operationRef.current = "start";
    updateSession({ status: "starting" });
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    setElapsedMs(0);
    try {
      const details = await refreshCapabilities();
      if (!details || !mountedRef.current) {
        if (mountedRef.current) {
          const errorCode = capabilityRef.current.errorCode ??
            "RECORDING_CAPABILITY_PROBE_FAILED";
          updateSession({ status: "error", errorCode });
        }
        return;
      }
      if (details.platform === "unsupported") {
        const errorCode = "RECORDING_PLATFORM_UNSUPPORTED" as const;
        updateSession({ status: "error", errorCode });
        return;
      }
      const requestedMode = modeRef.current;
      const actualMode = isModeAvailableFromCapabilities(details, requestedMode)
        ? requestedMode
        : isModeAvailableFromCapabilities(details, "mic")
          ? "mic"
          : null;
      if (!actualMode) {
        const errorCode = "RECORDING_SOURCE_UNAVAILABLE" as const;
        updateSession({ status: "error", errorCode });
        reportError(errorCode);
        return;
      }
      if (actualMode !== requestedMode) {
        modeRef.current = actualMode;
        setModeState(actualMode);
      }
      const started = await recordingClient.startRecording(actualMode);
      if (!mountedRef.current) return;
      const startedAtValue = clock();
      modeRef.current = actualMode;
      setModeState(actualMode);
      setActiveSessionId(started.sessionId);
      activeSessionIdRef.current = started.sessionId;
      setStartedAt(startedAtValue);
      startedAtRef.current = startedAtValue;
      setElapsedMs(0);
      updateSession({ status: "recording" });
      try {
        await saveAudioSourceMode(actualMode);
      } catch {
        reportError("RECORDING_PREFERENCES_UNAVAILABLE");
      }
    } catch (error) {
      if (mountedRef.current) {
        const errorCode = stableErrorCode(error, "RECORDING_UNKNOWN_ERROR");
        updateSession({ status: "error", errorCode });
        reportError(errorCode);
      }
    } finally {
      operationRef.current = null;
    }
  }, []);

  const completeHandoff = async (result: RecordingResult): Promise<boolean> => {
    try {
      const selection = await selectLocalMediaByPath(result.path);
      if (!mountedRef.current) return false;
      onLocalMediaSelected(selection);
      handoffResultRef.current = null;
      setHandoff({ status: "idle" });
      updateSession({ status: "idle" });
      return true;
    } catch {
      if (!mountedRef.current) return false;
      const errorCode = "RECORDING_HANDOFF_FAILED" as const;
      setHandoff({ status: "retryable", errorCode });
      updateSession({ status: "error", errorCode });
      reportError(errorCode);
      return false;
    }
  };

  const stop = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (
      operationRef.current ||
      sessionRef.current.status !== "recording" ||
      !sessionId ||
      !mountedRef.current
    ) {
      return;
    }
    operationRef.current = "stop";
    updateSession({ status: "stopping" });
    try {
      const result = await recordingClient.stopRecording(sessionId);
      if (!mountedRef.current) return;
      handoffResultRef.current = result;
      setActiveSessionId(null);
      activeSessionIdRef.current = null;
      setStartedAt(null);
      startedAtRef.current = null;
      setElapsedMs(0);
      await completeHandoff(result);
    } catch (error) {
      if (mountedRef.current) {
        const errorCode = stableErrorCode(error, "RECORDING_UNKNOWN_ERROR");
        setActiveSessionId(null);
        activeSessionIdRef.current = null;
        setStartedAt(null);
        startedAtRef.current = null;
        setElapsedMs(0);
        updateSession({ status: "error", errorCode });
        reportError(errorCode);
      }
    } finally {
      operationRef.current = null;
    }
  }, []);

  const requestDiscard = useCallback(() => {
    if (sessionRef.current.status !== "recording") return;
    discardConfirmationRef.current = true;
    setDiscardConfirmationOpen(true);
  }, []);

  const closeDiscard = useCallback(() => {
    discardConfirmationRef.current = false;
    setDiscardConfirmationOpen(false);
  }, []);

  const confirmDiscard = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (
      operationRef.current ||
      !discardConfirmationRef.current ||
      sessionRef.current.status !== "recording" ||
      !sessionId ||
      !mountedRef.current
    ) {
      return;
    }
    operationRef.current = "cancel";
    discardConfirmationRef.current = false;
    setDiscardConfirmationOpen(false);
    try {
      await recordingClient.cancelRecording(sessionId);
      if (!mountedRef.current) return;
      setActiveSessionId(null);
      activeSessionIdRef.current = null;
      setStartedAt(null);
      startedAtRef.current = null;
      setElapsedMs(0);
      updateSession({ status: "idle" });
    } catch (error) {
      if (mountedRef.current) {
        const errorCode = stableErrorCode(error, "RECORDING_CANCEL_FAILED");
        updateSession({ status: "recording", errorCode });
        reportError(errorCode);
      }
    } finally {
      operationRef.current = null;
    }
  }, []);

  const retryHandoff = useCallback(async () => {
    const result = handoffResultRef.current;
    if (
      operationRef.current ||
      handoff.status !== "retryable" ||
      !result ||
      !mountedRef.current
    ) {
      return;
    }
    operationRef.current = "handoff";
    await completeHandoff(result);
    operationRef.current = null;
  }, [handoff.status]);

  useEffect(() => {
    mountedRef.current = true;
    const onFocus = () => {
      void refreshCapabilities();
    };
    const onKeyDown = (event: Event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      if (discardConfirmationRef.current) {
        discardConfirmationRef.current = false;
        setDiscardConfirmationOpen(false);
        return;
      }
      if (sessionRef.current.status === "recording") {
        discardConfirmationRef.current = true;
        setDiscardConfirmationOpen(true);
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKeyDown);
    void refreshCapabilities();
    void loadPreferences();
    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (
      session.status !== "recording" ||
      activeSessionId === null ||
      startedAt === null
    ) {
      return undefined;
    }
    const handle = timer.setInterval(() => {
      if (!mountedRef.current || startedAtRef.current === null) return;
      setElapsedMs(Math.max(0, clock() - startedAtRef.current));
    }, 100);
    return () => timer.clearInterval(handle);
  }, [activeSessionId, clock, session.status, startedAt, timer]);

  return {
    capability,
    mode,
    session,
    activeSessionId,
    elapsedMs,
    discardConfirmationOpen,
    handoff,
    setMode,
    start,
    stop,
    requestDiscard,
    confirmDiscard,
    closeDiscard,
    retryHandoff,
    isModeAvailable,
    modeSelectionDisabled:
      capability.status !== "ready" || session.status !== "idle",
  };
}
