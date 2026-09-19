import { describe, expect, test } from "vitest";

import {
  listLocalRecordings,
  RecordingClientError,
  type RecordingCommandRunner,
} from "./recordingClient";

const VALID_ENTRY = {
  recordingId: "recording_1789197320039.wav",
  path: "C:\\Users\\demo\\AppData\\Local\\com.studymind.desktop\\recordings\\recording_1789197320039.wav",
  displayName: "recording_1789197320039.wav",
  sizeBytes: 102_400,
  durationMs: 3_200,
  createdAtMs: 1_789_197_320_039,
};

const VALID_LIBRARY = {
  contractVersion: 1,
  entries: [VALID_ENTRY],
  totalBytes: 102_400,
};

function runnerReturning(value: unknown): RecordingCommandRunner {
  return async () => value;
}

function runnerThrowing(error: unknown): RecordingCommandRunner {
  return async () => {
    throw error;
  };
}

describe("listLocalRecordings", () => {
  test("parses a well formed library view", async () => {
    const view = await listLocalRecordings(runnerReturning(VALID_LIBRARY));

    expect(view).toEqual(VALID_LIBRARY);
  });

  test("accepts an empty library", async () => {
    const empty = { contractVersion: 1, entries: [], totalBytes: 0 };

    const view = await listLocalRecordings(runnerReturning(empty));

    expect(view.entries).toEqual([]);
    expect(view.totalBytes).toBe(0);
  });

  test("keeps entries in the order the backend returned", async () => {
    const newer = { ...VALID_ENTRY, recordingId: "recording_2000.wav" };
    const view = await listLocalRecordings(
      runnerReturning({ ...VALID_LIBRARY, entries: [newer, VALID_ENTRY] }),
    );

    expect(view.entries.map((entry) => entry.recordingId)).toEqual([
      "recording_2000.wav",
      "recording_1789197320039.wav",
    ]);
  });

  test("rejects a payload missing the contract version", async () => {
    const { contractVersion, ...withoutVersion } = VALID_LIBRARY;

    await expect(
      listLocalRecordings(runnerReturning(withoutVersion)),
    ).rejects.toMatchObject({
      code: "RECORDING_IPC_RESPONSE_INVALID",
    });
  });

  test("rejects an unknown contract version", async () => {
    await expect(
      listLocalRecordings(runnerReturning({ ...VALID_LIBRARY, contractVersion: 2 })),
    ).rejects.toMatchObject({ code: "RECORDING_IPC_RESPONSE_INVALID" });
  });

  test("rejects a non object payload", async () => {
    await expect(
      listLocalRecordings(runnerReturning("not-a-library")),
    ).rejects.toBeInstanceOf(RecordingClientError);
  });

  test("rejects an entry with a missing field", async () => {
    const { durationMs, ...withoutDuration } = VALID_ENTRY;
    expect(durationMs).toBe(3_200);

    await expect(
      listLocalRecordings(
        runnerReturning({ ...VALID_LIBRARY, entries: [withoutDuration] }),
      ),
    ).rejects.toMatchObject({ code: "RECORDING_IPC_RESPONSE_INVALID" });
  });

  test("rejects an entry with a wrongly typed field", async () => {
    await expect(
      listLocalRecordings(
        runnerReturning({
          ...VALID_LIBRARY,
          entries: [{ ...VALID_ENTRY, sizeBytes: "102400" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "RECORDING_IPC_RESPONSE_INVALID" });
  });

  test("rejects a negative duration", async () => {
    await expect(
      listLocalRecordings(
        runnerReturning({
          ...VALID_LIBRARY,
          entries: [{ ...VALID_ENTRY, durationMs: -1 }],
        }),
      ),
    ).rejects.toMatchObject({ code: "RECORDING_IPC_RESPONSE_INVALID" });
  });

  test("rejects entries that are not an array", async () => {
    await expect(
      listLocalRecordings(runnerReturning({ ...VALID_LIBRARY, entries: {} })),
    ).rejects.toMatchObject({ code: "RECORDING_IPC_RESPONSE_INVALID" });
  });

  test("surfaces the library unavailable error from the backend", async () => {
    await expect(
      listLocalRecordings(
        runnerThrowing({ code: "RECORDING_LIBRARY_UNAVAILABLE", message: "nope" }),
      ),
    ).rejects.toMatchObject({ code: "RECORDING_LIBRARY_UNAVAILABLE" });
  });

  test("maps an unrecognised backend error to unknown", async () => {
    await expect(
      listLocalRecordings(runnerThrowing({ code: "SOMETHING_ELSE", message: "x" })),
    ).rejects.toMatchObject({ code: "RECORDING_UNKNOWN_ERROR" });
  });

  test("maps a string rejection to unknown", async () => {
    await expect(listLocalRecordings(runnerThrowing("boom"))).rejects.toMatchObject(
      { code: "RECORDING_UNKNOWN_ERROR" },
    );
  });
});
