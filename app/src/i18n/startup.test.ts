import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveStartupLocale,
  startLocalizedApplication,
} from "./startup";
import type { UiPreferencesView } from "../settingsClient";

function preferences(
  language: UiPreferencesView["language"],
  recovered = false,
): UiPreferencesView {
  return { schemaVersion: 1, language, recovered };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startup locale resolution", () => {
  test("uses a persisted explicit locale before the deadline", async () => {
    await expect(
      resolveStartupLocale({
        readPreferences: async () => preferences("zh-TW"),
        getSystemLanguages: () => ["en-US"],
      }),
    ).resolves.toEqual({
      preference: "zh-TW",
      resolvedLocale: "zh-TW",
      persistedAnchor: "zh-TW",
      notice: null,
    });
  });

  test("surfaces recovered preference files as a localized nonblocking notice", async () => {
    await expect(
      resolveStartupLocale({
        readPreferences: async () => preferences("system", true),
        getSystemLanguages: () => ["zh-Hant-HK"],
      }),
    ).resolves.toEqual({
      preference: "system",
      resolvedLocale: "zh-TW",
      persistedAnchor: "system",
      notice: { messageCode: "bootstrap.preferencesRecovered" },
    });
  });

  test("falls back to English on read failure", async () => {
    await expect(
      resolveStartupLocale({
        readPreferences: async () => {
          throw new Error("private path must not leak");
        },
        getSystemLanguages: () => ["zh-Hans-SG"],
      }),
    ).resolves.toEqual({
      preference: "en-US",
      resolvedLocale: "en-US",
      persistedAnchor: null,
      notice: { messageCode: "bootstrap.preferencesReadFailed" },
    });
  });

  test("uses the exact 1.5 second deadline and ignores a late result", async () => {
    vi.useFakeTimers();
    const pending = deferred<UiPreferencesView>();
    const resultPromise = resolveStartupLocale({
      readPreferences: () => pending.promise,
      getSystemLanguages: () => ["zh-CN"],
    });

    await vi.advanceTimersByTimeAsync(1499);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toEqual({
      preference: "en-US",
      resolvedLocale: "en-US",
      persistedAnchor: null,
      notice: { messageCode: "bootstrap.preferencesReadTimedOut" },
    });

    pending.resolve(preferences("zh-TW"));
    await Promise.resolve();
    await expect(resultPromise).resolves.toMatchObject({ resolvedLocale: "en-US" });
  });

  test("initializes localization and mounts React exactly once after a timeout", async () => {
    vi.useFakeTimers();
    const pending = deferred<UiPreferencesView>();
    const initialize = vi.fn(async () => undefined);
    const mount = vi.fn();
    const startPromise = startLocalizedApplication({
      readPreferences: () => pending.promise,
      getSystemLanguages: () => ["zh-CN"],
      initialize,
      mount,
    });

    await vi.advanceTimersByTimeAsync(1500);
    await startPromise;
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith("en-US");
    expect(mount).toHaveBeenCalledOnce();

    pending.resolve(preferences("en-US"));
    await Promise.resolve();
    expect(initialize).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
  });
});
