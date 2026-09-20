import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  RecordingClientError,
  type RecordingLibraryEntry,
  type RecordingLibraryView,
  type RecordingResult,
} from "../../recordingClient";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useEffect: (effect: () => void | (() => void)) => void;
  useRef: <T>(initialValue: T) => { current: T };
  useState: <T>(
    initialValue: T | (() => T),
  ) => [T, (next: StateUpdater<T>) => void];
  runEffects: () => void;
  runCleanups: () => void;
};

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const cleanups: (() => void)[] = [];
  let effects: (() => void | (() => void))[] = [];
  let cursor = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    useCallback: (callback) => callback,
    useEffect: (effect) => {
      effects.push(effect);
    },
    useRef: <T,>(initialValue: T) => {
      const index = cursor;
      cursor += 1;
      if (refs.length <= index) {
        refs[index] = { current: initialValue };
      }
      return refs[index] as { current: T };
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = cursor;
      cursor += 1;
      if (states.length <= index) {
        states[index] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      return [
        states[index] as T,
        (next: StateUpdater<T>) => {
          states[index] =
            typeof next === "function"
              ? (next as (current: T) => T)(states[index] as T)
              : next;
        },
      ];
    },
    runEffects: () => {
      const pending = effects;
      effects = [];
      for (const effect of pending) {
        const cleanup = effect();
        if (typeof cleanup === "function") {
          cleanups.push(cleanup);
        }
      }
    },
    runCleanups: () => {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
    },
  };
}

function entry(recordingId: string): RecordingLibraryEntry {
  return {
    recordingId,
    path: `C:\\recordings\\${recordingId}`,
    displayName: recordingId,
    sizeBytes: 1_024,
    durationMs: 1_000,
    createdAtMs: 1_000,
  };
}

function view(entries: RecordingLibraryEntry[]): RecordingLibraryView {
  return {
    contractVersion: 1,
    entries,
    totalBytes: entries.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

const SAVED_RESULT: RecordingResult = {
  path: "C:\\recordings\\recording_4000.wav",
  displayName: "recording_4000.wav",
  durationMs: 20_000,
  sizeBytes: 640_000,
  warnings: [],
};

type Deferred = {
  promise: Promise<RecordingLibraryView>;
  resolve: (value: RecordingLibraryView) => void;
  reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: (value: RecordingLibraryView) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<RecordingLibraryView>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function createLibrary(
  listRecordings: () => Promise<RecordingLibraryView>,
  options: {
    now?: () => number;
    scheduleTimeout?: (run: () => void, delayMs: number) => () => void;
  } = {},
) {
  const harness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
    useRef: harness.useRef,
    useState: harness.useState,
  }));
  vi.doMock("../../recordingClient", () => ({
    listLocalRecordings: () => Promise.reject(new Error("unused default")),
    RecordingClientError,
  }));
  const { useRecordingLibrary: loadHook } = await import("./useRecordingLibrary");
  return {
    render: () => {
      harness.resetRender();
      return loadHook({ listRecordings, ...options });
    },
    runEffects: harness.runEffects,
    runCleanups: harness.runCleanups,
  };
}

describe("useRecordingLibrary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test("starts in loading before the first response arrives", async () => {
    const pending = deferred();
    const { render, runEffects } = await createLibrary(() => pending.promise);

    const controller = render();
    runEffects();

    expect(controller.status).toBe("loading");
    expect(controller.entries).toEqual([]);
    pending.resolve(view([]));
  });

  test("loads the saved recordings once on mount", async () => {
    const { render, runEffects } = await createLibrary(async () =>
      view([entry("recording_2000.wav"), entry("recording_1000.wav")]),
    );

    render();
    runEffects();
    await flush();

    const controller = render();
    expect(controller.status).toBe("ready");
    expect(controller.entries.map((item) => item.recordingId)).toEqual([
      "recording_2000.wav",
      "recording_1000.wav",
    ]);
    expect(controller.totalBytes).toBe(2_048);
  });

  test("enters the error state when the backend refuses to list", async () => {
    const { render, runEffects } = await createLibrary(async () => {
      throw new RecordingClientError("RECORDING_LIBRARY_UNAVAILABLE");
    });

    render();
    runEffects();
    await flush();

    const controller = render();
    expect(controller.status).toBe("error");
    expect(controller.errorCode).toBe("RECORDING_LIBRARY_UNAVAILABLE");
  });

  test("collapses an unrecognised failure to the unknown error code", async () => {
    const { render, runEffects } = await createLibrary(async () => {
      throw new Error("boom");
    });

    render();
    runEffects();
    await flush();

    const controller = render();
    expect(controller.status).toBe("error");
    expect(controller.errorCode).toBe("RECORDING_UNKNOWN_ERROR");
  });

  test("refresh replaces the entries with a fresh listing", async () => {
    let call = 0;
    const { render, runEffects } = await createLibrary(async () => {
      call += 1;
      return call === 1
        ? view([entry("recording_1000.wav")])
        : view([entry("recording_3000.wav"), entry("recording_2000.wav")]);
    });

    render();
    runEffects();
    await flush();
    const controller = render();
    expect(controller.entries.map((item) => item.recordingId)).toEqual([
      "recording_1000.wav",
    ]);

    await controller.refresh();

    expect(render().entries.map((item) => item.recordingId)).toEqual([
      "recording_3000.wav",
      "recording_2000.wav",
    ]);
  });

  test("ignores a response that arrives after unmount", async () => {
    const pending = deferred();
    const { render, runEffects, runCleanups } = await createLibrary(
      () => pending.promise,
    );

    render();
    runEffects();
    runCleanups();

    pending.resolve(view([entry("recording_1000.wav")]));
    await flush();

    expect(render().status).toBe("loading");
    expect(render().entries).toEqual([]);
  });

  test("keeps only the newest response when refreshes overlap", async () => {
    const first = deferred();
    const second = deferred();
    const calls: Deferred[] = [first, second];
    let index = 0;
    const { render, runEffects } = await createLibrary(() => {
      const next = calls[index];
      index += 1;
      return next.promise;
    });

    render();
    runEffects();
    const stale = render().refresh();

    second.resolve(view([entry("recording_2000.wav")]));
    await stale;
    first.resolve(view([entry("recording_1000.wav")]));
    await flush();

    expect(render().entries.map((item) => item.recordingId)).toEqual([
      "recording_2000.wav",
    ]);
  });

  test("recovers from the error state after a successful refresh", async () => {
    let shouldFail = true;
    const { render, runEffects } = await createLibrary(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new RecordingClientError("RECORDING_LIBRARY_UNAVAILABLE");
      }
      return view([entry("recording_1000.wav")]);
    });

    render();
    runEffects();
    await flush();
    expect(render().status).toBe("error");

    await render().refresh();

    expect(render().status).toBe("ready");
    expect(render().errorCode).toBeUndefined();
  });

  test("inserts a saved recording at the top before the listing lands", async () => {
    const pending = deferred();
    const { render, runEffects } = await createLibrary(() => pending.promise, {
      now: () => 5_000,
    });

    render();
    runEffects();
    render().applySaved(SAVED_RESULT);

    const controller = render();
    expect(controller.status).toBe("ready");
    expect(controller.entries).toEqual([
      {
        recordingId: "recording_4000.wav",
        path: "C:\\recordings\\recording_4000.wav",
        displayName: "recording_4000.wav",
        sizeBytes: 640_000,
        durationMs: 20_000,
        createdAtMs: 5_000,
      },
    ]);
    expect(controller.totalBytes).toBe(640_000);
    pending.resolve(view([]));
  });

  test("keeps one entry when the same recording is saved twice", async () => {
    const { render, runEffects } = await createLibrary(async () => view([]), {
      now: () => 5_000,
    });

    render();
    runEffects();
    await flush();
    render().applySaved(SAVED_RESULT);
    render().applySaved(SAVED_RESULT);

    expect(render().entries.map((item) => item.recordingId)).toEqual([
      "recording_4000.wav",
    ]);
    expect(render().totalBytes).toBe(640_000);
  });

  test("calibrates the top entry with the authoritative listing", async () => {
    let call = 0;
    const { render, runEffects } = await createLibrary(
      async () => {
        call += 1;
        return call === 1
          ? view([])
          : view([entry("recording_4000.wav"), entry("recording_3000.wav")]);
      },
      { now: () => 5_000 },
    );

    render();
    runEffects();
    await flush();
    render().applySaved(SAVED_RESULT);
    await flush();

    const controller = render();
    expect(controller.entries.map((item) => item.recordingId)).toEqual([
      "recording_4000.wav",
      "recording_3000.wav",
    ]);
    expect(controller.entries[0].durationMs).toBe(1_000);
    expect(controller.highlightedId).toBe("recording_4000.wav");
  });

  test("highlights the saved recording and clears both notices after their windows", async () => {
    const scheduled: { run: () => void; delayMs: number }[] = [];
    const { render, runEffects } = await createLibrary(async () => view([]), {
      now: () => 5_000,
      scheduleTimeout: (run, delayMs) => {
        scheduled.push({ run, delayMs });
        return () => undefined;
      },
    });

    render();
    runEffects();
    await flush();
    expect(render().highlightedId).toBeNull();
    expect(render().savedNotice).toBe(false);

    render().applySaved(SAVED_RESULT);
    const controller = render();
    expect(controller.highlightedId).toBe("recording_4000.wav");
    expect(controller.savedNotice).toBe(true);
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([2_300, 4_000]);

    for (const entry of scheduled) entry.run();
    const cleared = render();
    expect(cleared.highlightedId).toBeNull();
    expect(cleared.savedNotice).toBe(false);
  });

  test("restarts both notice windows when a later recording is saved", async () => {
    const cancelled: number[] = [];
    const scheduled: { run: () => void; delayMs: number }[] = [];
    const { render, runEffects } = await createLibrary(async () => view([]), {
      now: () => 5_000,
      scheduleTimeout: (run, delayMs) => {
        const handle = scheduled.length;
        scheduled.push({ run, delayMs });
        return () => cancelled.push(handle);
      },
    });

    render();
    runEffects();
    await flush();
    render().applySaved(SAVED_RESULT);
    render().applySaved(SAVED_RESULT);

    expect(cancelled).toEqual([0, 1]);
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([
      2_300,
      4_000,
      2_300,
      4_000,
    ]);
    expect(render().savedNotice).toBe(true);
  });

  test("keeps the saved entry when the calibrating refresh fails", async () => {
    let call = 0;
    const { render, runEffects } = await createLibrary(async () => {
      call += 1;
      if (call === 1) return view([entry("recording_1000.wav")]);
      throw new RecordingClientError("RECORDING_LIBRARY_UNAVAILABLE");
    }, { now: () => 5_000 });

    render();
    runEffects();
    await flush();
    render().applySaved(SAVED_RESULT);
    await flush();

    const controller = render();
    expect(controller.status).toBe("error");
    expect(controller.errorCode).toBe("RECORDING_LIBRARY_UNAVAILABLE");
    expect(controller.entries).toEqual([
      {
        recordingId: "recording_4000.wav",
        path: "C:\\recordings\\recording_4000.wav",
        displayName: "recording_4000.wav",
        sizeBytes: 640_000,
        durationMs: 20_000,
        createdAtMs: 5_000,
      },
      entry("recording_1000.wav"),
    ]);
  });
});
