import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type {
  RecordingCapabilities,
  RecordingClientErrorCode,
  RecordingMode,
  RecordingResult,
} from "../../recordingClient";
import type { LocalMediaSelectionView } from "../../localMediaContract";
import type { UiPreferencesView } from "../../settingsClient";

type StateUpdater<T> = T | ((current: T) => T);
type Effect = {
  callback: () => void | (() => void);
  deps?: readonly unknown[];
  previousDeps?: readonly unknown[];
  cleanup?: () => void;
};

type HookHarness = {
  resetRender: () => void;
  flushEffects: () => void;
  unmount: () => void;
  stateUpdateCount: () => number;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: (
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ) => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(
    initialValue: T | (() => T),
  ) => [T, (next: StateUpdater<T>) => void];
};

type TimerHarness = {
  timer: {
    setInterval: (callback: () => void, delayMs: number) => number;
    clearInterval: (id: number) => void;
  };
  tick: () => void;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
};

type WindowHarness = {
  window: Window;
  dispatch: (type: string, event?: Record<string, unknown>) => void;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};

type RecordingController = {
  capability: {
    status: "loading" | "unknown" | "ready" | "unsupported" | "unavailable";
    details?: RecordingCapabilities;
    errorCode?: string;
  };
  mode: RecordingMode;
  session: {
    status: "idle" | "starting" | "recording" | "stopping" | "error";
    errorCode?: string;
  };
  activeSessionId: string | null;
  elapsedMs: number;
  discardConfirmationOpen: boolean;
  handoff: { status: "idle" | "retryable"; errorCode?: string };
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

type ControllerDependencies = {
  recordingClient: {
    getRecordingCapabilities: () => Promise<RecordingCapabilities>;
    startRecording: (mode: RecordingMode) => Promise<{ sessionId: string }>;
    stopRecording: (sessionId: string) => Promise<RecordingResult>;
    cancelRecording: (sessionId: string) => Promise<void>;
  };
  readPreferences: () => Promise<UiPreferencesView>;
  saveAudioSourceMode: (mode: RecordingMode) => Promise<UiPreferencesView>;
  selectLocalMediaByPath: (path: string) => Promise<LocalMediaSelectionView>;
  onLocalMediaSelected: (selection: LocalMediaSelectionView) => void;
  onError: (errorCode: string) => void;
  clock: () => number;
  timer: TimerHarness["timer"];
};

const CAPABILITIES: RecordingCapabilities = {
  platform: "windows",
  microphone: { available: true },
  systemAudio: { available: true },
};

const MIC_ONLY_CAPABILITIES: RecordingCapabilities = {
  platform: "windows",
  microphone: { available: true },
  systemAudio: {
    available: false,
    reasonCode: "RECORDING_SYSTEM_AUDIO_UNAVAILABLE",
  },
};

const UNSUPPORTED_CAPABILITIES: RecordingCapabilities = {
  platform: "unsupported",
  microphone: { available: false },
  systemAudio: { available: false },
};

const UNAVAILABLE_CAPABILITIES: RecordingCapabilities = {
  platform: "windows",
  microphone: {
    available: false,
    reasonCode: "RECORDING_MIC_INIT_FAILED",
  },
  systemAudio: {
    available: false,
    reasonCode: "RECORDING_SYSTEM_AUDIO_UNAVAILABLE",
  },
};

const PREFERENCES: UiPreferencesView = {
  schemaVersion: 2,
  language: "en-US",
  recording: { audioSourceMode: "mic" },
  recovered: false,
};

const RESULT: RecordingResult = {
  path: "C:\\recordings\\lecture.wav",
  displayName: "lecture.wav",
  durationMs: 3_500,
  sizeBytes: 90_000,
};

const SELECTION: LocalMediaSelectionView = {
  selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
  displayName: "lecture.wav",
  mediaKind: "audio",
  extension: "wav",
  sizeBytes: 90_000,
};

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  const effects: Effect[] = [];
  let cursor = 0;
  let updates = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    flushEffects: () => {
      for (const effect of effects) {
        if (!effect) continue;
        const changed =
          effect.previousDeps === undefined ||
          effect.deps === undefined ||
          effect.deps.length !== effect.previousDeps.length ||
          effect.deps.some((value, index) => !Object.is(value, effect.previousDeps?.[index]));
        if (!changed) continue;
        effect.cleanup?.();
        effect.previousDeps = effect.deps;
        const cleanup = effect.callback();
        effect.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      }
    },
    unmount: () => {
      for (const effect of effects) effect?.cleanup?.();
    },
    stateUpdateCount: () => updates,
    useCallback: (callback) => callback,
    useEffect: (callback, deps) => {
      const effectIndex = cursor++;
      if (!effects[effectIndex]) {
        effects[effectIndex] = { callback, deps };
      } else {
        effects[effectIndex].callback = callback;
        effects[effectIndex].deps = deps;
      }
    },
    useRef: <T,>(initialValue: T) => {
      const stateIndex = cursor++;
      if (states.length <= stateIndex) states[stateIndex] = { current: initialValue };
      return states[stateIndex] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const stateIndex = cursor++;
      if (states.length <= stateIndex) {
        states[stateIndex] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      return [
        states[stateIndex] as T,
        (next: StateUpdater<T>) => {
          updates += 1;
          states[stateIndex] =
            typeof next === "function"
              ? (next as (current: T) => T)(states[stateIndex] as T)
              : next;
        },
      ];
    },
  };
}

function createTimerHarness(): TimerHarness {
  let nextId = 1;
  let callback: (() => void) | undefined;
  const setInterval = vi.fn((next: () => void) => {
    callback = next;
    return nextId++;
  });
  const clearInterval = vi.fn(() => undefined);
  return {
    timer: { setInterval, clearInterval },
    tick: () => callback?.(),
    setInterval,
    clearInterval,
  };
}

function createWindowHarness(): WindowHarness {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    const callbacks = listeners.get(type) ?? new Set();
    callbacks.add(listener as (event: Event) => void);
    listeners.set(type, callbacks);
  });
  const removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.get(type)?.delete(listener as (event: Event) => void);
  });
  const dispatch = (type: string, event: Record<string, unknown> = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(event as unknown as Event);
  };
  const fakeWindow = { addEventListener, removeEventListener } as unknown as Window;
  return { window: fakeWindow, dispatch, addEventListener, removeEventListener };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function createController(
  overrides: Partial<ControllerDependencies> = {},
): Promise<{
  deps: ControllerDependencies;
  harness: HookHarness;
  windowHarness: WindowHarness;
  render: () => RecordingController;
}> {
  const harness = createHookHarness();
  const timer = createTimerHarness();
  const fakeWindow = createWindowHarness();
  vi.stubGlobal("window", fakeWindow.window);

  const deps: ControllerDependencies = {
    recordingClient: {
      getRecordingCapabilities: vi
        .fn<() => Promise<RecordingCapabilities>>()
        .mockResolvedValue(CAPABILITIES),
      startRecording: vi
        .fn<(mode: RecordingMode) => Promise<{ sessionId: string }>>()
        .mockResolvedValue({ sessionId: "session-1" }),
      stopRecording: vi
        .fn<(sessionId: string) => Promise<RecordingResult>>()
        .mockResolvedValue(RESULT),
      cancelRecording: vi
        .fn<(sessionId: string) => Promise<void>>()
        .mockResolvedValue(undefined),
    },
    readPreferences: vi
      .fn<() => Promise<UiPreferencesView>>()
      .mockResolvedValue(PREFERENCES),
    saveAudioSourceMode: vi
      .fn<(mode: RecordingMode) => Promise<UiPreferencesView>>()
      .mockResolvedValue(PREFERENCES),
    selectLocalMediaByPath: vi
      .fn<(path: string) => Promise<LocalMediaSelectionView>>()
      .mockResolvedValue(SELECTION),
    onLocalMediaSelected: vi.fn<(selection: LocalMediaSelectionView) => void>(),
    onError: vi.fn<(errorCode: string) => void>(),
    clock: () => 1_000,
    timer: timer.timer,
    ...overrides,
  };

  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  const { useRecordingController } = await import("./useRecordingController");

  const render = () => {
    harness.resetRender();
    const controller = useRecordingController({
      recordingClient: deps.recordingClient,
      readPreferences: deps.readPreferences,
      saveAudioSourceMode: deps.saveAudioSourceMode,
      selectLocalMediaByPath: deps.selectLocalMediaByPath,
      onLocalMediaSelected: deps.onLocalMediaSelected,
      onError: deps.onError,
      clock: deps.clock,
      timer: deps.timer,
    }) as RecordingController;
    harness.flushEffects();
    return controller;
  };

  return { deps, harness, windowHarness: fakeWindow, render };
}

async function startRecordingSession(
  overrides: Partial<ControllerDependencies> = {},
): Promise<{
  deps: ControllerDependencies;
  harness: HookHarness;
  windowHarness: WindowHarness;
  render: () => RecordingController;
  controller: RecordingController;
}> {
  const created = await createController(overrides);
  let controller = created.render();
  await settle();
  controller = created.render();
  await controller.start();
  await settle();
  controller = created.render();
  return { ...created, controller };
}

describe("useRecordingController", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("react");
  });

  test("loads capabilities on mount and foreground without starting or requesting permission", async () => {
    const { deps, render, windowHarness } = await createController();
    let controller = render();

    expect(deps.recordingClient.getRecordingCapabilities).toHaveBeenCalledTimes(1);
    expect(deps.recordingClient.startRecording).not.toHaveBeenCalled();
    expect(controller.capability.status).toBe("unknown");

    await settle();
    controller = render();
    expect(controller.capability).toEqual({ status: "ready", details: CAPABILITIES });

    windowHarness.dispatch("focus");
    expect(deps.recordingClient.getRecordingCapabilities).toHaveBeenCalledTimes(2);
    expect(deps.recordingClient.startRecording).not.toHaveBeenCalled();
  });

  test("keeps capability loading while the initial probe is pending", async () => {
    const capabilities = createDeferred<RecordingCapabilities>();
    const { render } = await createController({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockReturnValue(capabilities.promise),
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        cancelRecording: vi.fn(),
      },
    });

    let controller = render();
    expect(controller.capability.status).toBe("unknown");
    expect(controller.modeSelectionDisabled).toBe(true);

    controller = render();
    expect(controller.capability.status).toBe("loading");

    capabilities.resolve(CAPABILITIES);
    await settle();
    controller = render();
    expect(controller.capability.status).toBe("ready");
    expect(controller.modeSelectionDisabled).toBe(false);
  });

  test.each([
    ["unsupported", "RECORDING_PLATFORM_UNSUPPORTED"],
    ["unavailable", "RECORDING_CAPABILITY_PROBE_FAILED"],
  ] as const)("maps capability probe %s to a stable view", async (status, code) => {
    const error = {
      code: code as RecordingClientErrorCode,
      message: "private path and token must not escape",
    };
    const { deps, render } = await createController({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockRejectedValue(error),
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        cancelRecording: vi.fn(),
      },
      readPreferences: vi.fn().mockResolvedValue(PREFERENCES),
      saveAudioSourceMode: vi.fn(),
      selectLocalMediaByPath: vi.fn(),
      onLocalMediaSelected: vi.fn(),
      onError: vi.fn(),
      clock: () => 1_000,
      timer: createTimerHarness().timer,
    });

    let controller = render();
    await settle();
    controller = render();

    expect(controller.capability.status).toBe(status);
    expect(controller.capability.errorCode).toBe(code);
    expect(JSON.stringify(controller)).not.toContain("private path");
    expect(deps.onError).toHaveBeenCalledWith(code);
  });

  test("falls back unavailable or invalid preference modes to mic", async () => {
    const { render } = await createController({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockResolvedValue(MIC_ONLY_CAPABILITIES),
        startRecording: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording: vi.fn(),
      },
      readPreferences: vi.fn().mockResolvedValue({
        ...PREFERENCES,
        recording: { audioSourceMode: "system" },
      } as never),
    });

    let controller = render();
    await settle();
    controller = render();
    expect(controller.mode).toBe("mic");
    expect(controller.isModeAvailable("mic")).toBe(true);
    expect(controller.isModeAvailable("system")).toBe(false);
    expect(controller.isModeAvailable("mixed")).toBe(false);
  });

  test("falls back an illegal preference value to mic", async () => {
    const { render } = await createController({
      readPreferences: vi.fn().mockResolvedValue({
        ...PREFERENCES,
        recording: { audioSourceMode: "speaker" },
      } as never),
    });

    let controller = render();
    await settle();
    controller = render();

    expect(controller.mode).toBe("mic");
  });

  test("falls back to mic when preference loading fails", async () => {
    const { deps, render } = await createController({
      readPreferences: vi.fn().mockRejectedValue(new Error("private settings path")),
    });
    let controller = render();
    await settle();
    controller = render();

    expect(controller.mode).toBe("mic");
    expect(deps.onError).toHaveBeenCalledWith("RECORDING_PREFERENCES_UNAVAILABLE");
    expect(JSON.stringify(controller)).not.toContain("private settings path");
  });

  test("rechecks availability before start and starts mic without prematurely saving fallback", async () => {
    const getCapabilities = vi
      .fn()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce(MIC_ONLY_CAPABILITIES);
    const startRecording = vi.fn().mockResolvedValue({ sessionId: "session-2" });
    const saveAudioSourceMode = vi.fn().mockResolvedValue(PREFERENCES);
    const { deps, render } = await createController({
      recordingClient: {
        getRecordingCapabilities: getCapabilities,
        startRecording,
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording: vi.fn(),
      },
      readPreferences: vi.fn().mockResolvedValue({
        ...PREFERENCES,
        recording: { audioSourceMode: "system" },
      }),
      saveAudioSourceMode,
    });

    let controller = render();
    await settle();
    controller = render();
    expect(controller.mode).toBe("system");

    const startPromise = controller.start();
    controller = render();
    expect(controller.session.status).toBe("starting");
    expect(saveAudioSourceMode).not.toHaveBeenCalled();
    await startPromise;
    controller = render();

    expect(startRecording).toHaveBeenCalledWith("mic");
    expect(saveAudioSourceMode).toHaveBeenCalledWith("mic");
    expect(controller.mode).toBe("mic");
    expect(controller.session.status).toBe("recording");
    expect(controller.activeSessionId).toBe("session-2");
    expect(deps.recordingClient.getRecordingCapabilities).toHaveBeenCalledTimes(2);
  });

  test("falls back the visible mode to mic when foreground capabilities become unsupported", async () => {
    const getCapabilities = vi
      .fn()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce(UNSUPPORTED_CAPABILITIES);
    const { render, windowHarness } = await createController({
      recordingClient: {
        getRecordingCapabilities: getCapabilities,
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        cancelRecording: vi.fn(),
      },
      readPreferences: vi.fn().mockResolvedValue({
        ...PREFERENCES,
        recording: { audioSourceMode: "system" },
      }),
    });

    let controller = render();
    await settle();
    controller = render();
    expect(controller.mode).toBe("system");

    windowHarness.dispatch("focus");
    await settle();
    controller = render();

    expect(controller.capability.status).toBe("unsupported");
    expect(controller.mode).toBe("mic");
  });

  test.each([
    ["unavailable", "RECORDING_CAPABILITY_PROBE_FAILED"],
    ["unsupported", "RECORDING_PLATFORM_UNSUPPORTED"],
  ] as const)(
    "falls back visible mode to mic while foreground probe is %s and restores the preference after recovery",
    async (status, code) => {
      const getCapabilities = vi
        .fn<() => Promise<RecordingCapabilities>>()
        .mockResolvedValueOnce(CAPABILITIES)
        .mockRejectedValueOnce({ code })
        .mockResolvedValueOnce(CAPABILITIES);
      const { render, windowHarness } = await createController({
        recordingClient: {
          getRecordingCapabilities: getCapabilities,
          startRecording: vi.fn(),
          stopRecording: vi.fn(),
          cancelRecording: vi.fn(),
        },
        readPreferences: vi.fn().mockResolvedValue({
          ...PREFERENCES,
          recording: { audioSourceMode: "system" },
        }),
      });

      let controller = render();
      await settle();
      controller = render();
      expect(controller.mode).toBe("system");

      windowHarness.dispatch("focus");
      await settle();
      controller = render();

      expect(controller.capability.status).toBe(status);
      expect(controller.mode).toBe("mic");

      windowHarness.dispatch("focus");
      await settle();
      controller = render();
      expect(controller.capability.status).toBe("ready");
      expect(controller.mode).toBe("system");
    },
  );

  test("marks a successful Windows probe unavailable when no source is usable and preserves the preference", async () => {
    const getCapabilities = vi
      .fn<() => Promise<RecordingCapabilities>>()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce(UNAVAILABLE_CAPABILITIES)
      .mockResolvedValueOnce(CAPABILITIES);
    const { render, windowHarness } = await createController({
      recordingClient: {
        getRecordingCapabilities: getCapabilities,
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        cancelRecording: vi.fn(),
      },
      readPreferences: vi.fn().mockResolvedValue({
        ...PREFERENCES,
        recording: { audioSourceMode: "system" },
      }),
    });

    let controller = render();
    await settle();
    controller = render();
    expect(controller.mode).toBe("system");

    windowHarness.dispatch("focus");
    await settle();
    controller = render();

    expect(controller.capability.status).toBe("unavailable");
    expect(controller.mode).toBe("mic");

    windowHarness.dispatch("focus");
    await settle();
    controller = render();
    expect(controller.capability.status).toBe("ready");
    expect(controller.mode).toBe("system");
  });

  test("saves a successful mic fallback and keeps it after a later foreground refresh", async () => {
    const getCapabilities = vi
      .fn()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockResolvedValueOnce(MIC_ONLY_CAPABILITIES)
      .mockResolvedValueOnce(CAPABILITIES);
    const { deps, render, windowHarness } = await createController({
      recordingClient: {
        getRecordingCapabilities: getCapabilities,
        startRecording: vi.fn().mockResolvedValue({ sessionId: "session-fallback" }),
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording: vi.fn(),
      },
      readPreferences: vi.fn().mockResolvedValue({
        ...PREFERENCES,
        recording: { audioSourceMode: "system" },
      }),
    });

    let controller = render();
    await settle();
    controller = render();
    await controller.start();
    controller = render();
    expect(controller.mode).toBe("mic");
    expect(deps.saveAudioSourceMode).toHaveBeenCalledWith("mic");

    await controller.stop();
    controller = render();
    windowHarness.dispatch("focus");
    await settle();
    controller = render();

    expect(controller.session.status).toBe("idle");
    expect(controller.mode).toBe("mic");
  });

  test("ignores a stale preference that resolves after start succeeds", async () => {
    const preferences = createDeferred<UiPreferencesView>();
    const { render, windowHarness } = await createController({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockResolvedValue(CAPABILITIES),
        startRecording: vi.fn().mockResolvedValue({ sessionId: "session-stale-start" }),
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording: vi.fn(),
      },
      readPreferences: vi.fn().mockReturnValue(preferences.promise),
    });

    let controller = render();
    await settle();
    controller = render();
    await controller.start();
    controller = render();
    expect(controller.mode).toBe("mic");

    preferences.resolve({
      ...PREFERENCES,
      recording: { audioSourceMode: "system" },
    });
    await settle();
    controller = render();
    await controller.stop();
    controller = render();
    windowHarness.dispatch("focus");
    await settle();
    controller = render();

    expect(controller.mode).toBe("mic");
  });

  test("ignores a stale preference after a newer explicit mode selection", async () => {
    const preferences = createDeferred<UiPreferencesView>();
    const { render, windowHarness } = await createController({
      readPreferences: vi.fn().mockReturnValue(preferences.promise),
    });

    let controller = render();
    await settle();
    controller = render();
    await settle();
    controller = render();
    expect(controller.capability.status).toBe("ready");
    expect(controller.isModeAvailable("system")).toBe(true);
    controller.setMode("system");
    controller = render();
    expect(controller.mode).toBe("system");

    preferences.resolve({
      ...PREFERENCES,
      recording: { audioSourceMode: "mic" },
    });
    await settle();
    controller = render();
    expect(controller.mode).toBe("system");

    windowHarness.dispatch("focus");
    await settle();
    controller = render();
    expect(controller.mode).toBe("system");
  });

  test("surfaces a stable error when the start-time capability recheck fails", async () => {
    const getCapabilities = vi
      .fn<() => Promise<RecordingCapabilities>>()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockRejectedValueOnce({
        code: "RECORDING_CAPABILITY_PROBE_FAILED",
        message: "private probe detail",
      });
    const { render } = await createController({
      recordingClient: {
        getRecordingCapabilities: getCapabilities,
        startRecording: vi.fn(),
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording: vi.fn().mockResolvedValue(undefined),
      },
    });
    let controller = render();
    await settle();
    controller = render();

    await controller.start();
    controller = render();
    expect(controller.session).toEqual({
      status: "error",
      errorCode: "RECORDING_CAPABILITY_PROBE_FAILED",
    });
    expect(JSON.stringify(controller)).not.toContain("private probe detail");
  });

  test("does not let a foreground refresh cancel the start-time capability probe", async () => {
    const startProbe = createDeferred<RecordingCapabilities>();
    const foregroundProbe = createDeferred<RecordingCapabilities>();
    const getCapabilities = vi
      .fn<() => Promise<RecordingCapabilities>>()
      .mockResolvedValueOnce(CAPABILITIES)
      .mockReturnValueOnce(startProbe.promise)
      .mockReturnValueOnce(foregroundProbe.promise);
    const startRecording = vi
      .fn<(mode: RecordingMode) => Promise<{ sessionId: string }>>()
      .mockResolvedValue({ sessionId: "session-concurrent-start" });
    const { deps, render, windowHarness } = await createController({
      recordingClient: {
        getRecordingCapabilities: getCapabilities,
        startRecording,
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording: vi.fn().mockResolvedValue(undefined),
      },
    });

    let controller = render();
    await settle();
    controller = render();

    const startPromise = controller.start();
    await settle();
    windowHarness.dispatch("focus");
    startProbe.resolve(CAPABILITIES);

    await startPromise;
    expect(startRecording).toHaveBeenCalledWith("mic");
    expect(deps.saveAudioSourceMode).toHaveBeenCalledWith("mic");

    foregroundProbe.resolve(CAPABILITIES);
    await settle();
  });

  test("allows stop while the post-start preference save is pending", async () => {
    const pendingSave = createDeferred<UiPreferencesView>();
    const saveAudioSourceMode = vi.fn().mockReturnValue(pendingSave.promise);
    const { deps, render } = await createController({ saveAudioSourceMode });

    let controller = render();
    await settle();
    controller = render();

    const startPromise = controller.start();
    await settle();
    controller = render();
    expect(controller.session.status).toBe("recording");

    const stopPromise = controller.stop();
    await settle();
    expect(deps.recordingClient.stopRecording).toHaveBeenCalledWith("session-1");

    pendingSave.resolve(PREFERENCES);
    await Promise.all([startPromise, stopPromise]);
  });

  test("allows discard confirmation while the post-start preference save is pending", async () => {
    const pendingSave = createDeferred<UiPreferencesView>();
    const saveAudioSourceMode = vi.fn().mockReturnValue(pendingSave.promise);
    const { deps, render } = await createController({ saveAudioSourceMode });

    let controller = render();
    await settle();
    controller = render();

    const startPromise = controller.start();
    await settle();
    controller = render();
    expect(controller.session.status).toBe("recording");

    controller.requestDiscard();
    controller = render();
    const discardPromise = controller.confirmDiscard();
    await settle();
    expect(deps.recordingClient.cancelRecording).toHaveBeenCalledWith("session-1");

    pendingSave.resolve(PREFERENCES);
    await Promise.all([startPromise, discardPromise]);
  });

  test("enters recording and saves only after a successful start", async () => {
    const { deps, render } = await createController();
    let controller = render();
    await settle();
    controller = render();

    await controller.start();
    await settle();
    controller = render();

    expect(controller.session).toEqual({ status: "recording" });
    expect(controller.activeSessionId).toBe("session-1");
    expect(deps.saveAudioSourceMode).toHaveBeenCalledWith("mic");
  });

  test("does not issue duplicate starts while the first start is pending", async () => {
    const pendingStart = createDeferred<{ sessionId: string }>();
    const startRecording = vi.fn().mockReturnValue(pendingStart.promise);
    const { deps, render } = await createController({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockResolvedValue(CAPABILITIES),
        startRecording,
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording: vi.fn().mockResolvedValue(undefined),
      },
    });
    let controller = render();
    await settle();
    controller = render();

    const firstStart = controller.start();
    const secondStart = controller.start();
    expect(startRecording).toHaveBeenCalledTimes(0);
    await settle();
    expect(startRecording).toHaveBeenCalledTimes(1);

    pendingStart.resolve({ sessionId: "session-duplicate-proof" });
    await Promise.all([firstStart, secondStart]);
    expect(deps.saveAudioSourceMode).toHaveBeenCalledTimes(1);
  });

  test("keeps a stable start error and does not save a failed mode", async () => {
    const startRecording = vi.fn().mockRejectedValue({
      code: "RECORDING_MIC_ACCESS_DENIED",
      message: "C:\\private\\token.wav",
    });
    const { deps, render } = await createController({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockResolvedValue(CAPABILITIES),
        startRecording,
        stopRecording: vi.fn(),
        cancelRecording: vi.fn(),
      },
    });
    let controller = render();
    await settle();
    controller = render();

    await controller.start();
    controller = render();
    expect(controller.session).toEqual({
      status: "error",
      errorCode: "RECORDING_MIC_ACCESS_DENIED",
    });
    expect(deps.saveAudioSourceMode).not.toHaveBeenCalled();
    expect(JSON.stringify(controller)).not.toContain("token.wav");
  });

  test("updates elapsed time from the injected clock and fixes mode during recording", async () => {
    let now = 1_000;
    const timer = createTimerHarness();
    const { render } = await createController({ clock: () => now, timer: timer.timer });
    let controller = render();
    await settle();
    controller = render();
    await controller.start();
    await settle();
    controller = render();

    expect(controller.elapsedMs).toBe(0);
    expect(timer.setInterval).toHaveBeenCalled();
    controller.setMode("system");
    now = 3_750;
    timer.tick();
    controller = render();
    expect(controller.elapsedMs).toBe(2_750);
    expect(controller.mode).toBe("mic");
  });

  test("stops once, hands off the local media, and never submits automatically", async () => {
    const { deps, render, harness } = await startRecordingSession();
    let controller = render();

    await controller.stop();
    controller = render();

    expect(deps.recordingClient.stopRecording).toHaveBeenCalledTimes(1);
    expect(deps.recordingClient.stopRecording).toHaveBeenCalledWith("session-1");
    expect(deps.selectLocalMediaByPath).toHaveBeenCalledWith(RESULT.path);
    expect(deps.onLocalMediaSelected).toHaveBeenCalledWith(SELECTION);
    expect(controller.session.status).toBe("idle");
    expect(controller.handoff).toEqual({ status: "idle" });
    expect(harness.stateUpdateCount()).toBeGreaterThan(0);
  });

  test("keeps a trusted stop result for handoff retry without repeating stop", async () => {
    const selectLocalMediaByPath = vi
      .fn()
      .mockRejectedValueOnce(new Error("C:\\private\\session-token.wav"))
      .mockResolvedValueOnce(SELECTION);
    const { deps, render } = await startRecordingSession({ selectLocalMediaByPath });
    let controller = render();

    await controller.stop();
    controller = render();
    expect(controller.session).toEqual({
      status: "error",
      errorCode: "RECORDING_HANDOFF_FAILED",
    });
    expect(controller.handoff).toEqual({
      status: "retryable",
      errorCode: "RECORDING_HANDOFF_FAILED",
    });
    expect(JSON.stringify(controller)).not.toContain("session-token");

    await controller.retryHandoff();
    controller = render();
    expect(deps.recordingClient.stopRecording).toHaveBeenCalledTimes(1);
    expect(selectLocalMediaByPath).toHaveBeenCalledTimes(2);
    expect(deps.onLocalMediaSelected).toHaveBeenCalledWith(SELECTION);
    expect(controller.session.status).toBe("idle");
    expect(controller.handoff).toEqual({ status: "idle" });
  });

  test("clears stale handoff state and result when a new start begins", async () => {
    const selectLocalMediaByPath = vi
      .fn()
      .mockRejectedValueOnce(new Error("handoff failed"));
    const { deps, render } = await startRecordingSession({
      selectLocalMediaByPath,
    });
    let controller = render();

    await controller.stop();
    controller = render();
    expect(controller.handoff.status).toBe("retryable");
    expect(selectLocalMediaByPath).toHaveBeenCalledTimes(1);

    await controller.start();
    controller = render();
    expect(controller.session.status).toBe("recording");
    expect(controller.handoff).toEqual({ status: "idle" });

    await controller.retryHandoff();
    expect(selectLocalMediaByPath).toHaveBeenCalledTimes(1);
    expect(deps.recordingClient.startRecording).toHaveBeenCalledTimes(2);
  });

  test("clears a failed stop operation and allows a fresh start", async () => {
    const stopRecording = vi.fn().mockRejectedValueOnce({
      code: "RECORDING_FINALIZE_FAILED",
    });
    const { deps, render } = await startRecordingSession({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockResolvedValue(CAPABILITIES),
        startRecording: vi.fn().mockResolvedValue({ sessionId: "session-retry" }),
        stopRecording,
        cancelRecording: vi.fn(),
      },
    });
    let controller = render();

    await controller.stop();
    controller = render();
    expect(controller.session).toEqual({
      status: "error",
      errorCode: "RECORDING_FINALIZE_FAILED",
    });
    expect(controller.activeSessionId).toBeNull();

    await controller.start();
    controller = render();
    expect(deps.recordingClient.startRecording).toHaveBeenCalledTimes(2);
    expect(controller.session.status).toBe("recording");
  });

  test("requires explicit discard confirmation and supports close without cancelling", async () => {
    const { deps, render } = await startRecordingSession();
    let controller = render();

    controller.requestDiscard();
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(true);
    expect(deps.recordingClient.cancelRecording).not.toHaveBeenCalled();

    controller.closeDiscard();
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(false);
    expect(deps.recordingClient.cancelRecording).not.toHaveBeenCalled();

    controller.requestDiscard();
    controller = render();
    await controller.confirmDiscard();
    controller = render();
    expect(deps.recordingClient.cancelRecording).toHaveBeenCalledWith("session-1");
    expect(controller.session.status).toBe("idle");
    expect(controller.activeSessionId).toBeNull();
  });

  test("ignores discard requests while cancel is pending and closes confirmation on success", async () => {
    const pendingCancel = createDeferred<void>();
    const cancelRecording = vi.fn().mockReturnValue(pendingCancel.promise);
    const { deps, render, windowHarness } = await startRecordingSession({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockResolvedValue(CAPABILITIES),
        startRecording: vi.fn().mockResolvedValue({ sessionId: "pending-cancel" }),
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording,
      },
    });
    let controller = render();

    controller.requestDiscard();
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(true);

    const confirmPromise = controller.confirmDiscard();
    controller = render();
    expect(deps.recordingClient.cancelRecording).toHaveBeenCalledWith("pending-cancel");
    expect(controller.discardConfirmationOpen).toBe(false);

    controller.requestDiscard();
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(false);

    windowHarness.dispatch("keydown", { key: "Escape" });
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(false);

    pendingCancel.resolve();
    await confirmPromise;
    controller = render();
    expect(controller.session.status).toBe("idle");
    expect(controller.discardConfirmationOpen).toBe(false);
    expect(controller.activeSessionId).toBeNull();
  });

  test("restores recording after a failed cancel and permits retry", async () => {
    const cancelRecording = vi
      .fn()
      .mockRejectedValueOnce({ code: "RECORDING_CANCEL_FAILED" })
      .mockResolvedValueOnce(undefined);
    const { deps, render } = await startRecordingSession({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockResolvedValue(CAPABILITIES),
        startRecording: vi.fn().mockResolvedValue({ sessionId: "session-cancel-retry" }),
        stopRecording: vi.fn().mockResolvedValue(RESULT),
        cancelRecording,
      },
    });
    let controller = render();

    controller.requestDiscard();
    await controller.confirmDiscard();
    controller = render();
    expect(controller.session).toEqual({
      status: "recording",
      errorCode: "RECORDING_CANCEL_FAILED",
    });
    expect(controller.activeSessionId).toBe("session-cancel-retry");

    controller.requestDiscard();
    await controller.confirmDiscard();
    controller = render();
    expect(deps.recordingClient.cancelRecording).toHaveBeenCalledTimes(2);
    expect(controller.session.status).toBe("idle");
    expect(controller.activeSessionId).toBeNull();
  });

  test("uses Escape to open discard, then close it, and never cancels implicitly", async () => {
    const { deps, render, windowHarness } = await startRecordingSession();
    let controller = render();

    windowHarness.dispatch("keydown", { key: "Escape" });
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(true);
    expect(deps.recordingClient.cancelRecording).not.toHaveBeenCalled();

    windowHarness.dispatch("keydown", { key: "Escape" });
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(false);
    expect(deps.recordingClient.cancelRecording).not.toHaveBeenCalled();

    windowHarness.dispatch("keydown", { key: "Escape" });
    controller = render();
    expect(controller.discardConfirmationOpen).toBe(true);
    controller.confirmDiscard();
    await settle();
    expect(deps.recordingClient.cancelRecording).toHaveBeenCalledTimes(1);
  });

  test("cleans timers and listeners and ignores stale capability results after unmount", async () => {
    const capability = createDeferred<RecordingCapabilities>();
    const timer = createTimerHarness();
    const { harness, windowHarness, render } = await createController({
      recordingClient: {
        getRecordingCapabilities: vi.fn().mockReturnValue(capability.promise),
        startRecording: vi.fn(),
        stopRecording: vi.fn(),
        cancelRecording: vi.fn(),
      },
      timer: timer.timer,
    });
    render();
    const updatesBeforeUnmount = harness.stateUpdateCount();
    harness.unmount();
    capability.resolve(CAPABILITIES);
    await settle();

    expect(harness.stateUpdateCount()).toBe(updatesBeforeUnmount);
    expect(timer.clearInterval).not.toHaveBeenCalled();
    expect(windowHarness.removeEventListener).toHaveBeenCalled();
  });

  test("cleans the elapsed timer and foreground listeners on recording unmount", async () => {
    const timer = createTimerHarness();
    const created = await createController({ timer: timer.timer });
    let controller = created.render();
    await settle();
    controller = created.render();
    await controller.start();
    await settle();
    created.render();

    created.harness.unmount();

    expect(timer.clearInterval).toHaveBeenCalledTimes(1);
    expect(created.windowHarness.removeEventListener).toHaveBeenCalledTimes(2);
  });
});
