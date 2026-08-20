import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";

export type RecordingMode = "mic" | "system" | "mixed";

export type RecordingErrorCode =
  | "RECORDING_ALREADY_ACTIVE"
  | "RECORDING_PLATFORM_UNSUPPORTED"
  | "RECORDING_CAPABILITY_PROBE_FAILED"
  | "RECORDING_MIC_INIT_FAILED"
  | "RECORDING_MIC_ACCESS_DENIED"
  | "RECORDING_SYSTEM_LOOPBACK_INIT_FAILED"
  | "RECORDING_SYSTEM_AUDIO_UNAVAILABLE"
  | "RECORDING_STREAM_ERROR"
  | "RECORDING_MIX_FAILED"
  | "RECORDING_WRITE_FAILED"
  | "RECORDING_DISK_SPACE_LOW"
  | "RECORDING_EMPTY"
  | "RECORDING_SESSION_INVALID"
  | "RECORDING_FINALIZE_FAILED"
  | "RECORDING_STATE_UNAVAILABLE";

export type RecordingClientErrorCode =
  | RecordingErrorCode
  | "RECORDING_UNKNOWN_ERROR"
  | "RECORDING_IPC_RESPONSE_INVALID";

export type RecordingSourceCapability = {
  available: boolean;
  reasonCode?: RecordingErrorCode;
};

export type RecordingCapabilities = {
  platform: "windows" | "macos" | "unsupported";
  microphone: RecordingSourceCapability;
  systemAudio: RecordingSourceCapability;
};

export type RecordingResult = {
  path: string;
  displayName: string;
  durationMs: number;
  sizeBytes: number;
};

export type RecordingStateView = {
  sessionId: string;
  mode: RecordingMode;
  elapsedMs: number;
};

export type RecordingCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

export class RecordingClientError extends Error {
  readonly code: RecordingClientErrorCode;

  constructor(code: RecordingClientErrorCode) {
    super(code);
    this.name = "RecordingClientError";
    this.code = code;
  }
}

const RECORDING_IPC_RESPONSE_INVALID =
  "RECORDING_IPC_RESPONSE_INVALID" as const;
const RECORDING_UNKNOWN_ERROR = "RECORDING_UNKNOWN_ERROR" as const;
const MAX_STRING_LENGTH = 4096;
const MAX_REASON_CODE_LENGTH = 128;

const RECORDING_ERROR_CODES: readonly RecordingErrorCode[] = [
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
];

const defaultRecordingRunner: RecordingCommandRunner = (command, args) =>
  invoke(command, args);

export async function getRecordingCapabilities(
  runner: RecordingCommandRunner = defaultRecordingRunner,
): Promise<RecordingCapabilities> {
  return parseRecordingCapabilities(
    await runRecordingCommand(runner, "get_recording_capabilities", {}),
  );
}

export type StartRecordingWarning = RecordingErrorCode;

export async function startRecording(
  mode: RecordingMode,
  runner: RecordingCommandRunner = defaultRecordingRunner,
): Promise<{ sessionId: string; warnings: StartRecordingWarning[] }> {
  if (!isRecordingMode(mode)) {
    throwInvalidResponse();
  }
  return parseStartRecordingResponse(
    await runRecordingCommand(runner, "start_recording", { mode }),
  );
}

export async function stopRecording(
  sessionId: string,
  runner: RecordingCommandRunner = defaultRecordingRunner,
): Promise<RecordingResult> {
  assertSessionId(sessionId);
  return parseRecordingResult(
    await runRecordingCommand(runner, "stop_recording", { sessionId }),
  );
}

export async function cancelRecording(
  sessionId: string,
  runner: RecordingCommandRunner = defaultRecordingRunner,
): Promise<void> {
  assertSessionId(sessionId);
  const response = await runRecordingCommand(
    runner,
    "cancel_recording",
    { sessionId },
  );
  if (response !== null && response !== undefined) {
    throwInvalidResponse();
  }
}

export async function getRecordingState(
  runner: RecordingCommandRunner = defaultRecordingRunner,
): Promise<RecordingStateView | null> {
  const response = await runRecordingCommand(runner, "get_recording_state", {});
  if (response === null) {
    return null;
  }
  return parseRecordingState(response);
}

async function runRecordingCommand(
  runner: RecordingCommandRunner,
  command: string,
  args: InvokeArgs,
): Promise<unknown> {
  try {
    return await runner(command, args);
  } catch (error) {
    throw mapRecordingCommandError(error);
  }
}

function parseRecordingCapabilities(value: unknown): RecordingCapabilities {
  const response = readRecordingObject(
    value,
    ["platform", "microphone", "systemAudio"],
    [],
  );
  if (
    response.platform !== "windows" &&
    response.platform !== "macos" &&
    response.platform !== "unsupported"
  ) {
    throwInvalidResponse();
  }
  return {
    platform: response.platform,
    microphone: parseSourceCapability(response.microphone),
    systemAudio: parseSourceCapability(response.systemAudio),
  };
}

function parseSourceCapability(value: unknown): RecordingSourceCapability {
  const response = readRecordingObject(value, ["available"], ["reasonCode"]);
  if (typeof response.available !== "boolean") {
    throwInvalidResponse();
  }

  if (!Object.prototype.hasOwnProperty.call(response, "reasonCode")) {
    return { available: response.available };
  }

  if (
    !isBoundedString(response.reasonCode, MAX_REASON_CODE_LENGTH) ||
    !isRecordingErrorCode(response.reasonCode)
  ) {
    throwInvalidResponse();
  }
  return {
    available: response.available,
    reasonCode: response.reasonCode,
  };
}

function parseStartRecordingResponse(value: unknown): {
  sessionId: string;
  warnings: StartRecordingWarning[];
} {
  const response = readRecordingObject(value, ["sessionId"], ["warnings"]);
  if (!isBoundedString(response.sessionId, MAX_STRING_LENGTH)) {
    throwInvalidResponse();
  }
  let warnings: StartRecordingWarning[] = [];
  if (Object.prototype.hasOwnProperty.call(response, "warnings")) {
    const candidate = response.warnings;
    if (
      !Array.isArray(candidate) ||
      candidate.some(
        (code) =>
          typeof code !== "string" ||
          !isBoundedString(code, MAX_REASON_CODE_LENGTH) ||
          !isRecordingErrorCode(code),
      )
    ) {
      throwInvalidResponse();
    }
    warnings = candidate as StartRecordingWarning[];
  }
  return { sessionId: response.sessionId, warnings };
}

function parseRecordingResult(value: unknown): RecordingResult {
  const response = readRecordingObject(
    value,
    ["path", "displayName", "durationMs", "sizeBytes"],
    [],
  );
  if (
    !isBoundedString(response.path, MAX_STRING_LENGTH) ||
    !isBoundedString(response.displayName, MAX_STRING_LENGTH) ||
    !isSafeUnsignedInteger(response.durationMs) ||
    !isSafeUnsignedInteger(response.sizeBytes)
  ) {
    throwInvalidResponse();
  }
  return {
    path: response.path,
    displayName: response.displayName,
    durationMs: response.durationMs,
    sizeBytes: response.sizeBytes,
  };
}

function parseRecordingState(value: unknown): RecordingStateView {
  const response = readRecordingObject(
    value,
    ["sessionId", "mode", "elapsedMs"],
    [],
  );
  if (
    !isBoundedString(response.sessionId, MAX_STRING_LENGTH) ||
    !isRecordingMode(response.mode) ||
    !isSafeUnsignedInteger(response.elapsedMs)
  ) {
    throwInvalidResponse();
  }
  return {
    sessionId: response.sessionId,
    mode: response.mode,
    elapsedMs: response.elapsedMs,
  };
}

function assertSessionId(value: unknown): asserts value is string {
  if (!isBoundedString(value, MAX_STRING_LENGTH)) {
    throw new RecordingClientError("RECORDING_SESSION_INVALID");
  }
}

function readRecordingObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throwInvalidResponse();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throwInvalidResponse();
    }

    const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
    if (allowedKeys.size !== requiredKeys.length + optionalKeys.length) {
      throwInvalidResponse();
    }

    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string") ||
      ownKeys.some(
        (key) => typeof key === "string" && !allowedKeys.has(key),
      ) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    ) {
      throwInvalidResponse();
    }

    const result: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== "string") {
        throwInvalidResponse();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throwInvalidResponse();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof RecordingClientError) {
      throw error;
    }
    throwInvalidResponse();
  }
}

function mapRecordingCommandError(error: unknown): RecordingClientError {
  try {
    if (error instanceof RecordingClientError) {
      const code = error.code;
      return new RecordingClientError(
        isRecordingClientErrorCode(code) ? code : RECORDING_UNKNOWN_ERROR,
      );
    }
  } catch {
    return new RecordingClientError(RECORDING_UNKNOWN_ERROR);
  }

  try {
    const response = readRecordingObject(error, ["code", "message"], []);
    if (
      isBoundedString(response.message, MAX_STRING_LENGTH) &&
      isRecordingErrorCode(response.code)
    ) {
      return new RecordingClientError(response.code);
    }
  } catch {
    // All malformed or non-structured runner errors intentionally collapse below.
  }
  return new RecordingClientError(RECORDING_UNKNOWN_ERROR);
}

function throwInvalidResponse(): never {
  throw new RecordingClientError(RECORDING_IPC_RESPONSE_INVALID);
}

function isRecordingMode(value: unknown): value is RecordingMode {
  return value === "mic" || value === "system" || value === "mixed";
}

function isRecordingErrorCode(value: unknown): value is RecordingErrorCode {
  return (
    typeof value === "string" &&
    value.length <= MAX_REASON_CODE_LENGTH &&
    RECORDING_ERROR_CODES.includes(value as RecordingErrorCode)
  );
}

function isRecordingClientErrorCode(
  value: unknown,
): value is RecordingClientErrorCode {
  return (
    value === RECORDING_UNKNOWN_ERROR ||
    value === RECORDING_IPC_RESPONSE_INVALID ||
    isRecordingErrorCode(value)
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}
