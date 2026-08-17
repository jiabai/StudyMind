import { describe, expect, test, vi } from "vitest";

import {
  cancelRecording,
  getRecordingCapabilities,
  getRecordingState,
  RecordingClientError,
  startRecording,
  stopRecording,
  type RecordingCommandRunner,
} from "./recordingClient";

const VALID_CAPABILITIES = {
  platform: "windows",
  microphone: { available: true },
  systemAudio: {
    available: false,
    reasonCode: "RECORDING_SYSTEM_AUDIO_UNAVAILABLE",
  },
} as const;

const VALID_START = { sessionId: "session-123" } as const;

const VALID_STOP = {
  path: "C:\\Users\\demo\\Recordings\\lecture.wav",
  displayName: "lecture.wav",
  durationMs: 12_345,
  sizeBytes: 98_765,
} as const;

const VALID_STATE = {
  sessionId: "session-123",
  mode: "mixed",
  elapsedMs: 4_321,
} as const;

class CapabilityResponse {
  platform = "windows";
  microphone = { available: true };
  systemAudio = { available: true };
}

class StartResponse {
  sessionId = "session-123";
}

class StopResponse {
  path = "C:\\Users\\demo\\Recordings\\lecture.wav";
  displayName = "lecture.wav";
  durationMs = 12_345;
  sizeBytes = 98_765;
}

class StateResponse {
  sessionId = "session-123";
  mode = "mixed";
  elapsedMs = 4_321;
}

function expectRecordingError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(RecordingClientError);
  expect(error).toMatchObject({ code, message: code });
}

describe("recording client", () => {
  test("starts mixed recording with the exact Tauri envelope", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: RecordingCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return VALID_START;
    };

    await expect(startRecording("mixed", runner)).resolves.toEqual({
      sessionId: "session-123",
    });
    expect(calls).toEqual([
      { command: "start_recording", args: { mode: "mixed" } },
    ]);
  });

  test("maps capabilities, start, stop, and state responses", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: RecordingCommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "get_recording_capabilities") return VALID_CAPABILITIES;
      if (command === "start_recording") return VALID_START;
      if (command === "stop_recording") return VALID_STOP;
      return VALID_STATE;
    };

    await expect(getRecordingCapabilities(runner)).resolves.toEqual({
      platform: "windows",
      microphone: { available: true },
      systemAudio: {
        available: false,
        reasonCode: "RECORDING_SYSTEM_AUDIO_UNAVAILABLE",
      },
    });
    await expect(startRecording("mic", runner)).resolves.toEqual({
      sessionId: "session-123",
    });
    await expect(stopRecording("session-123", runner)).resolves.toEqual({
      path: "C:\\Users\\demo\\Recordings\\lecture.wav",
      displayName: "lecture.wav",
      durationMs: 12_345,
      sizeBytes: 98_765,
    });
    await expect(getRecordingState(runner)).resolves.toEqual({
      sessionId: "session-123",
      mode: "mixed",
      elapsedMs: 4_321,
    });
    expect(calls).toEqual([
      { command: "get_recording_capabilities", args: {} },
      { command: "start_recording", args: { mode: "mic" } },
      { command: "stop_recording", args: { sessionId: "session-123" } },
      { command: "get_recording_state", args: {} },
    ]);
  });

  test("cancels with the exact envelope and accepts only nullish success", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: RecordingCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return undefined;
    };

    await expect(cancelRecording("session-123", runner)).resolves.toBeUndefined();
    expect(calls).toEqual([
      { command: "cancel_recording", args: { sessionId: "session-123" } },
    ]);

    await expect(
      cancelRecording("session-123", async () => ({ cancelled: true })),
    ).rejects.toSatisfy((error: unknown) => {
      expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
      return true;
    });
  });

  test("accepts null for an idle recording state", async () => {
    await expect(getRecordingState(async () => null)).resolves.toBeNull();
  });

  test.each([
    null,
    [],
    new Date("2026-08-18T00:00:00.000Z"),
    new CapabilityResponse(),
    {},
    { platform: "windows", microphone: { available: true } },
    { ...VALID_CAPABILITIES, platform: "linux" },
    { ...VALID_CAPABILITIES, unexpected: true },
    {
      ...VALID_CAPABILITIES,
      microphone: { available: "true" },
    },
    {
      ...VALID_CAPABILITIES,
      systemAudio: {
        available: false,
        reasonCode: "RECORDING_NOT_A_REAL_CODE",
      },
    },
  ])("rejects malformed capability responses: %j", async (payload) => {
    await expect(getRecordingCapabilities(async () => payload)).rejects.toSatisfy(
      (error: unknown) => {
        expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
        return true;
      },
    );
  });

  test.each([
    [],
    new Date("2026-08-18T00:00:00.000Z"),
    new StartResponse(),
    {},
    { sessionId: "" },
    { sessionId: 42 },
    { sessionId: "session-123", extra: true },
  ])("rejects malformed start responses: %j", async (payload) => {
    await expect(startRecording("mic", async () => payload)).rejects.toSatisfy(
      (error: unknown) => {
        expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
        return true;
      },
    );
  });

  test.each([
    [],
    new Date("2026-08-18T00:00:00.000Z"),
    new StopResponse(),
    {},
    { ...VALID_STOP, displayName: "" },
    { ...VALID_STOP, durationMs: -1 },
    { ...VALID_STOP, durationMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...VALID_STOP, sizeBytes: "98765" },
    { ...VALID_STOP, extra: "not allowed" },
  ])("rejects malformed stop responses: %j", async (payload) => {
    await expect(stopRecording("session-123", async () => payload)).rejects.toSatisfy(
      (error: unknown) => {
        expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
        return true;
      },
    );
  });

  test("rejects unsafe integer state responses and unknown modes", async () => {
    await expect(
      getRecordingState(async () => []),
    ).rejects.toSatisfy((error: unknown) => {
      expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
      return true;
    });

    await expect(
      getRecordingState(async () => new Date("2026-08-18T00:00:00.000Z")),
    ).rejects.toSatisfy((error: unknown) => {
      expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
      return true;
    });

    await expect(
      getRecordingState(async () => new StateResponse()),
    ).rejects.toSatisfy((error: unknown) => {
      expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
      return true;
    });

    await expect(
      getRecordingState(async () => ({
        ...VALID_STATE,
        elapsedMs: Number.MAX_SAFE_INTEGER + 1,
      })),
    ).rejects.toSatisfy((error: unknown) => {
      expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
      return true;
    });

    await expect(
      getRecordingState(async () => ({ ...VALID_STATE, mode: "other" })),
    ).rejects.toSatisfy((error: unknown) => {
      expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
      return true;
    });
  });

  test("rejects accessor-backed payloads without evaluating their getters", async () => {
    let getterCalls = 0;
    const payload = Object.defineProperty(
      {
        platform: "windows",
        microphone: { available: true },
        systemAudio: { available: true },
      },
      "platform",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "windows";
        },
      },
    );

    await expect(getRecordingCapabilities(async () => payload)).rejects.toSatisfy(
      (error: unknown) => {
        expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
        return true;
      },
    );
    expect(getterCalls).toBe(0);
  });

  test("maps structured backend errors to stable codes without leaking raw details", async () => {
    const secret = "C:\\Users\\private\\recordings\\session-token-secret.wav";
    const runner: RecordingCommandRunner = async () => {
      throw {
        code: "RECORDING_MIC_ACCESS_DENIED",
        message: `failed at ${secret}`,
      };
    };

    let captured: unknown;
    try {
      await startRecording("mic", runner);
    } catch (error) {
      captured = error;
    }

    expectRecordingError(captured, "RECORDING_MIC_ACCESS_DENIED");
    expect(String(captured)).not.toContain(secret);
    expect(JSON.stringify(captured)).not.toContain(secret);
  });

  test("maps unknown and non-structured backend errors to one stable code", async () => {
    await expect(
      startRecording("mic", async () => {
        throw new Error("private path");
      }),
    ).rejects.toSatisfy(
      (error: unknown) => {
        expectRecordingError(error, "RECORDING_UNKNOWN_ERROR");
        expect(String(error)).not.toContain("private path");
        return true;
      },
    );
  });

  test.each(["", "x".repeat(4097), 42, null])(
    "rejects invalid session input before invoking Tauri: %j",
    async (sessionId) => {
      const runner = vi.fn<RecordingCommandRunner>();

      await expect(stopRecording(sessionId as never, runner)).rejects.toSatisfy(
        (error: unknown) => {
          expectRecordingError(error, "RECORDING_SESSION_INVALID");
          return true;
        },
      );
      expect(runner).not.toHaveBeenCalled();
    },
  );

  test.each(["", "x".repeat(4097), "desktop", 42, null])(
    "rejects invalid start mode before invoking Tauri: %j",
    async (mode) => {
      const runner = vi.fn<RecordingCommandRunner>();

      await expect(startRecording(mode as never, runner)).rejects.toSatisfy(
        (error: unknown) => {
          expectRecordingError(error, "RECORDING_IPC_RESPONSE_INVALID");
          return true;
        },
      );
      expect(runner).not.toHaveBeenCalled();
    },
  );

  test.each(["", "x".repeat(4097), 42, null])(
    "rejects invalid cancel session input before invoking Tauri: %j",
    async (sessionId) => {
      const runner = vi.fn<RecordingCommandRunner>();

      await expect(
        cancelRecording(sessionId as never, runner),
      ).rejects.toSatisfy((error: unknown) => {
        expectRecordingError(error, "RECORDING_SESSION_INVALID");
        return true;
      });
      expect(runner).not.toHaveBeenCalled();
    },
  );
});
