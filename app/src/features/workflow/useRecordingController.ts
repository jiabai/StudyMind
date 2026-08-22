import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelRecording as defaultCancelRecording,
  getRecordingCapabilities as defaultGetRecordingCapabilities,
  getRecordingState as defaultGetRecordingState,
  listenRecordingWarnings as defaultListenRecordingWarnings,
  startRecording as defaultStartRecording,
  stopRecording as defaultStopRecording,
  type RecordingCapabilities,
  type RecordingClientErrorCode,
  type RecordingMode,
  type RecordingResult,
  type RecordingStateView,
  type RecordingWarningEvent,
  type RecordingWarningView,
  type StartRecordingWarning,
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
  | "unknown"
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
  warningCode?: RecordingControllerErrorCode;
  warnings?: RecordingWarningView[];
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
  listenRecordingWarnings?: (
    handler: (event: RecordingWarningEvent) => void,
  ) => Promise<() => void>;
  startRecording: (
    mode: RecordingMode,
  ) => Promise<{ sessionId: string; warnings: StartRecordingWarning[] }>;
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
  "RECORDING_SYSTEM_AUDIO_RECOVERED",
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
  if (!capabilities || capabilities.platform === "unsupported") return false;
  if (mode === "mic") return capabilities.microphone.available;
  if (mode === "system") return capabilities.systemAudio.available;
  return capabilities.mixed.available;
}

function hasUsableRecordingSource(
  capabilities: RecordingCapabilities,
): boolean {
  return (
    capabilities.platform !== "unsupported" &&
    (capabilities.microphone.available || capabilities.systemAudio.available)
  );
}

function selectAvailableRecordingMode(
  capabilities: RecordingCapabilities,
  preferredMode: RecordingMode,
): RecordingMode | null {
  const candidates: RecordingMode[] = [preferredMode, "mic", "system"];
  for (const candidate of candidates) {
    if (isModeAvailableFromCapabilities(capabilities, candidate)) {
      return candidate;
    }
  }
  return null;
}

function preferenceMode(value: unknown): RecordingMode {
  return isRecordingMode(value) ? value : "mic";
}

function warningIdentity(warning: RecordingWarningView): string {
  return `${warning.warningCode}:${warning.source ?? ""}`;
}

function mergeWarning(
  warnings: RecordingWarningView[],
  incoming: RecordingWarningView,
): RecordingWarningView[] {
  const next = [...warnings];
  const index = next.findIndex(
    (warning) => warningIdentity(warning) === warningIdentity(incoming),
  );
  if (index === -1) {
    next.push(incoming);
  } else {
    next[index] = incoming;
  }
  return next;
}

export function useRecordingController({
  recordingClient = {
    getRecordingCapabilities: defaultGetRecordingCapabilities,
    getRecordingState: defaultGetRecordingState,
    listenRecordingWarnings: defaultListenRecordingWarnings,
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
    status: "unknown",
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
  const startCapabilityRequestRef = useRef(0);
  const preferenceRequestRef = useRef(0);
  const preferenceSaveQueueRef = useRef(Promise.resolve());
  const operationRef = useRef<"start" | "stop" | "cancel" | "handoff" | null>(null);
  const recordingClientRef = useRef(recordingClient);
  const readPreferencesRef = useRef(readPreferences);
  const saveAudioSourceModeRef = useRef(saveAudioSourceMode);
  const selectLocalMediaByPathRef = useRef(selectLocalMediaByPath);
  const onLocalMediaSelectedRef = useRef(onLocalMediaSelected);
  const onErrorRef = useRef(onError);
  const clockRef = useRef(clock);

  capabilityRef.current = capability;
  modeRef.current = mode;
  sessionRef.current = session;
  activeSessionIdRef.current = activeSessionId;
  startedAtRef.current = startedAt;
  discardConfirmationRef.current = discardConfirmationOpen;
  recordingClientRef.current = recordingClient;
  readPreferencesRef.current = readPreferences;
  saveAudioSourceModeRef.current = saveAudioSourceMode;
  selectLocalMediaByPathRef.current = selectLocalMediaByPath;
  onLocalMediaSelectedRef.current = onLocalMediaSelected;
  onErrorRef.current = onError;
  clockRef.current = clock;

  const reportError = (errorCode: RecordingControllerErrorCode) => {
    onErrorRef.current?.(errorCode);
  };

  const updateSession = (next: RecordingSessionView) => {
    sessionRef.current = next;
    setSession(next);
  };

  const updateCapability = (next: RecordingCapabilityView) => {
    capabilityRef.current = next;
    setCapability(next);
  };

  const updateSessionWarnings = (warnings: RecordingWarningView[]) => {
    const next: RecordingSessionView = { ...sessionRef.current };
    if (warnings.length > 0) {
      next.warnings = warnings;
      next.warningCode = warnings[0].warningCode;
    } else {
      delete next.warnings;
    }
    updateSession(next);
  };

  const handleRecordingWarning = (event: RecordingWarningEvent) => {
    if (
      !activeSessionIdRef.current ||
      event.sessionId !== activeSessionIdRef.current
    ) {
      return;
    }
    const warning: RecordingWarningView = {
      warningCode: event.warningCode,
      source: event.source,
      count: event.count,
      totalGapMs: event.totalGapMs,
    };
    updateSessionWarnings(
      mergeWarning(sessionRef.current.warnings ?? [], warning),
    );
  };

  const hydrateRecordingState = async () => {
    const getState = recordingClientRef.current.getRecordingState;
    if (!getState) return;
    try {
      const state = await getState();
      if (
        !mountedRef.current ||
        !state ||
        operationRef.current ||
        sessionRef.current.status === "recording" ||
        sessionRef.current.status === "stopping"
      ) {
        return;
      }
      const startedAtValue = clockRef.current() - state.elapsedMs;
      modeRef.current = state.mode;
      setModeState(state.mode);
      setActiveSessionId(state.sessionId);
      activeSessionIdRef.current = state.sessionId;
      setStartedAt(startedAtValue);
      startedAtRef.current = startedAtValue;
      setElapsedMs(state.elapsedMs);
      const nextSession: RecordingSessionView = {
        status: "recording",
      };
      if (state.warnings.length > 0) {
        nextSession.warnings = state.warnings;
        nextSession.warningCode = state.warnings[0].warningCode;
      }
      updateSession(nextSession);
    } catch {
      // State hydration is best-effort; capability loading remains authoritative.
    }
  };

  const invalidatePreferenceLoad = () => {
    preferenceRequestRef.current += 1;
  };

  const refreshCapabilities = async (
    requestRef: { current: number } = capabilityRequestRef,
  ): Promise<RecordingCapabilities | null> => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (mountedRef.current) updateCapability({ status: "loading" });
    try {
      const details = await recordingClientRef.current.getRecordingCapabilities();
      if (!mountedRef.current || requestId !== requestRef.current) return null;
      if (details.platform === "unsupported") {
        const errorCode = "RECORDING_PLATFORM_UNSUPPORTED" as const;
        updateCapability({ status: "unsupported", details, errorCode });
        if (sessionRef.current.status === "idle") {
          modeRef.current = "mic";
          setModeState("mic");
        }
        reportError(errorCode);
        return details;
      }
      if (!hasUsableRecordingSource(details)) {
        const errorCode = "RECORDING_SOURCE_UNAVAILABLE" as const;
        updateCapability({ status: "unavailable", details, errorCode });
        if (sessionRef.current.status === "idle") {
          modeRef.current = "mic";
          setModeState("mic");
        }
        reportError(errorCode);
        return details;
      }
      updateCapability({ status: "ready", details });
      const preferredMode = preferenceModeRef.current;
      const nextMode = selectAvailableRecordingMode(details, preferredMode) ?? "mic";
      if (sessionRef.current.status === "idle") {
        modeRef.current = nextMode;
        setModeState(nextMode);
      }
      return details;
    } catch (error) {
      if (!mountedRef.current || requestId !== requestRef.current) return null;
      const errorCode = stableErrorCode(error, "RECORDING_CAPABILITY_PROBE_FAILED");
      const status = errorCode === "RECORDING_PLATFORM_UNSUPPORTED"
        ? "unsupported"
        : "unavailable";
      updateCapability({ status, errorCode });
      if (sessionRef.current.status === "idle") {
        modeRef.current = "mic";
        setModeState("mic");
      }
      reportError(errorCode);
      return null;
    }
  };

  const loadPreferences = async (): Promise<void> => {
    const requestId = preferenceRequestRef.current + 1;
    preferenceRequestRef.current = requestId;
    try {
      const preferences = await readPreferencesRef.current();
      const nextPreferenceMode = preferenceMode(
        preferences && preferences.recording
          ? preferences.recording.audioSourceMode
          : undefined,
      );
      if (
        !mountedRef.current ||
        requestId !== preferenceRequestRef.current ||
        sessionRef.current.status !== "idle"
      ) {
        return;
      }
      preferenceModeRef.current = nextPreferenceMode;
      const nextMode = isModeAvailableFromCapabilities(
        capabilityRef.current.details,
        nextPreferenceMode,
      )
        ? nextPreferenceMode
        : capabilityRef.current.details
          ? selectAvailableRecordingMode(
              capabilityRef.current.details,
              nextPreferenceMode,
            ) ?? "mic"
          : "mic";
      modeRef.current = nextMode;
      setModeState(nextMode);
    } catch {
      if (
        !mountedRef.current ||
        requestId !== preferenceRequestRef.current ||
        sessionRef.current.status !== "idle"
      ) {
        return;
      }
      preferenceModeRef.current = "mic";
      reportError("RECORDING_PREFERENCES_UNAVAILABLE");
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
      (sessionRef.current.status !== "idle" &&
        sessionRef.current.status !== "error") ||
      !isModeAvailableFromCapabilities(capabilityRef.current.details, nextMode)
    ) {
      return;
    }
    invalidatePreferenceLoad();
    preferenceModeRef.current = nextMode;
    modeRef.current = nextMode;
    setModeState(nextMode);
  }, []);

  const saveAudioSourceModeBestEffort = (nextMode: RecordingMode) => {
    const save = preferenceSaveQueueRef.current.then(async () => {
      try {
        await saveAudioSourceModeRef.current(nextMode);
      } catch {
        reportError("RECORDING_PREFERENCES_UNAVAILABLE");
      }
    });
    preferenceSaveQueueRef.current = save.catch(() => undefined);
  };

  const start = useCallback(async () => {
    if (
      operationRef.current ||
      (sessionRef.current.status !== "idle" &&
        sessionRef.current.status !== "error") ||
      !mountedRef.current
    ) {
      return;
    }
    invalidatePreferenceLoad();
    operationRef.current = "start";
    handoffResultRef.current = null;
    setHandoff({ status: "idle" });
    updateSession({ status: "starting" });
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    setElapsedMs(0);
    try {
      const details = await refreshCapabilities(startCapabilityRequestRef);
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
      const actualMode = selectAvailableRecordingMode(details, requestedMode);
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
      const started = await recordingClientRef.current.startRecording(actualMode);
      if (!mountedRef.current) return;
      const startedAtValue = clockRef.current();
      preferenceModeRef.current = actualMode;
      modeRef.current = actualMode;
      setModeState(actualMode);
      setActiveSessionId(started.sessionId);
      activeSessionIdRef.current = started.sessionId;
      setStartedAt(startedAtValue);
      startedAtRef.current = startedAtValue;
      setElapsedMs(0);
      const startupWarnings = started.warnings.filter(
        (w) => w !== "RECORDING_SYSTEM_AUDIO_RECOVERED",
      );
      updateSession({
        status: "recording",
        warningCode: startupWarnings[0],
      });
      if (startupWarnings[0]) {
        reportError(startupWarnings[0]);
      }
      saveAudioSourceModeBestEffort(actualMode);
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
      const selection = await selectLocalMediaByPathRef.current(result.path);
      if (!mountedRef.current) return false;
      onLocalMediaSelectedRef.current(selection);
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
      const result = await recordingClientRef.current.stopRecording(sessionId);
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
    if (
      operationRef.current === "cancel" ||
      sessionRef.current.status !== "recording"
    ) {
      return;
    }
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
      await recordingClientRef.current.cancelRecording(sessionId);
      if (!mountedRef.current) return;
      discardConfirmationRef.current = false;
      setDiscardConfirmationOpen(false);
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
    let disposed = false;
    let unlistenWarnings: (() => void) | undefined;
    const subscribeToWarnings = async () => {
      const listenWarnings = recordingClientRef.current.listenRecordingWarnings;
      if (!listenWarnings) return;
      try {
        const cleanup = await listenWarnings(handleRecordingWarning);
        if (disposed) {
          cleanup();
        } else {
          unlistenWarnings = cleanup;
        }
      } catch {
        // Event subscription is advisory; IPC polling remains available.
      }
    };
    const onFocus = () => {
      void refreshCapabilities();
      void hydrateRecordingState();
    };
    const onKeyDown = (event: Event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      if (operationRef.current === "cancel") return;
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
    void hydrateRecordingState();
    void subscribeToWarnings();
    return () => {
      disposed = true;
      unlistenWarnings?.();
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
      capability.status !== "ready" ||
      session.status === "starting" ||
      session.status === "recording" ||
      session.status === "stopping",
  };
}
