import { describe, expect, test, vi } from "vitest";
import {
  LanguagePreferenceQueue,
  type LanguagePreferencePersistence,
} from "./languagePreferenceQueue";
import type { LanguagePreference } from "./locale";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("serialized optimistic language preference saves", () => {
  test("applies immediately but sends writes one at a time", async () => {
    const first = deferred<LanguagePreference>();
    const second = deferred<LanguagePreference>();
    const save = vi
      .fn<LanguagePreferencePersistence["save"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const apply = vi.fn();
    const queue = new LanguagePreferenceQueue({
      persistedAnchor: "en-US",
      save,
      read: async () => "en-US",
      apply,
      onLatestSaveFailure: vi.fn(),
    });

    const firstOperation = queue.select("zh-CN");
    const secondOperation = queue.select("zh-TW");
    expect(apply.mock.calls).toEqual([["zh-CN"], ["zh-TW"]]);
    await Promise.resolve();
    expect(save.mock.calls).toEqual([["zh-CN"]]);
    expect(queue.operationSequence).toBe(2);

    first.resolve("zh-CN");
    await firstOperation;
    await Promise.resolve();
    expect(save.mock.calls).toEqual([["zh-CN"], ["zh-TW"]]);

    second.resolve("zh-TW");
    await secondOperation;
    expect(queue.persistedAnchor).toBe("zh-TW");
  });

  test("ignores a stale failure and rolls the latest failure back to the last success", async () => {
    const stale = deferred<LanguagePreference>();
    const latest = deferred<LanguagePreference>();
    const save = vi
      .fn<LanguagePreferencePersistence["save"]>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => latest.promise);
    const apply = vi.fn();
    const onLatestSaveFailure = vi.fn();
    const queue = new LanguagePreferenceQueue({
      persistedAnchor: "en-US",
      save,
      read: async () => "zh-TW",
      apply,
      onLatestSaveFailure,
    });

    const staleOperation = queue.select("zh-CN");
    const latestOperation = queue.select("zh-TW");
    stale.reject(new Error("stale failure"));
    await staleOperation;
    expect(apply).toHaveBeenLastCalledWith("zh-TW");
    expect(onLatestSaveFailure).not.toHaveBeenCalled();

    latest.reject(new Error("latest failure"));
    await latestOperation;
    expect(apply).toHaveBeenLastCalledWith("en-US");
    expect(onLatestSaveFailure).toHaveBeenCalledOnce();
    expect(onLatestSaveFailure).toHaveBeenCalledWith("en-US");
    expect(queue.persistedAnchor).toBe("en-US");
  });

  test("advances the persisted anchor on stale success before a latest failure", async () => {
    const first = deferred<LanguagePreference>();
    const second = deferred<LanguagePreference>();
    const queue = new LanguagePreferenceQueue({
      persistedAnchor: "en-US",
      save: vi
        .fn<LanguagePreferencePersistence["save"]>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      read: async () => "system",
      apply: vi.fn(),
      onLatestSaveFailure: vi.fn(),
    });
    const apply = queue.apply;

    const firstOperation = queue.select("zh-CN");
    const secondOperation = queue.select("zh-TW");
    first.resolve("zh-CN");
    await firstOperation;
    expect(queue.persistedAnchor).toBe("zh-CN");

    second.reject(new Error("latest failure"));
    await secondOperation;
    expect(apply).toHaveBeenLastCalledWith("zh-CN");
  });

  test("re-reads an unknown startup anchor before rolling back", async () => {
    const apply = vi.fn();
    const read = vi.fn(async () => "zh-TW" as const);
    const queue = new LanguagePreferenceQueue({
      persistedAnchor: null,
      save: async () => {
        throw new Error("write failed");
      },
      read,
      apply,
      onLatestSaveFailure: vi.fn(),
    });

    await queue.select("zh-CN");
    expect(read).toHaveBeenCalledOnce();
    expect(queue.persistedAnchor).toBe("zh-TW");
    expect(apply).toHaveBeenLastCalledWith("zh-TW");
  });

  test("falls back to system if re-reading an unknown anchor also fails", async () => {
    const apply = vi.fn();
    const queue = new LanguagePreferenceQueue({
      persistedAnchor: null,
      save: async () => {
        throw new Error("write failed");
      },
      read: async () => {
        throw new Error("read failed");
      },
      apply,
      onLatestSaveFailure: vi.fn(),
    });

    await queue.select("zh-CN");
    expect(queue.persistedAnchor).toBeNull();
    expect(apply).toHaveBeenLastCalledWith("system");
  });

  test("does not apply an obsolete rollback if a newer selection arrives during re-read", async () => {
    const read = deferred<LanguagePreference>();
    const save = vi
      .fn<LanguagePreferencePersistence["save"]>()
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce("en-US");
    const apply = vi.fn();
    const queue = new LanguagePreferenceQueue({
      persistedAnchor: null,
      save,
      read: () => read.promise,
      apply,
      onLatestSaveFailure: vi.fn(),
    });

    const failedOperation = queue.select("zh-CN");
    await Promise.resolve();
    await Promise.resolve();
    const newestOperation = queue.select("en-US");
    read.resolve("zh-TW");
    await failedOperation;
    expect(apply).toHaveBeenLastCalledWith("en-US");
    await newestOperation;
  });
});
