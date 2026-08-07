export const LOCAL_MEDIA_CONTRACT_VERSION = 4 as const;

export const LOCAL_MEDIA_EXTENSIONS = {
  video: ["mp4", "m4v", "mov", "mkv", "avi", "wmv", "webm"],
  audio: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"],
} as const;

export type LocalMediaKind = keyof typeof LOCAL_MEDIA_EXTENSIONS;

export type LocalMediaSelectionView = {
  selectionToken: string;
  displayName: string;
  mediaKind: LocalMediaKind;
  extension: string;
  sizeBytes: number;
};

export type ProcessLocalMediaRequest = {
  selectionToken: string;
  asrModel: "iic/SenseVoiceSmall" | "iic/SenseVoiceSmall-onnx";
};

export type LocalMediaParseResult<T> =
  | { kind: "valid"; value: T }
  | { kind: "invalid"; errorCode: "LOCAL_MEDIA_SELECTION_INVALID" };

const INVALID_SELECTION = {
  kind: "invalid",
  errorCode: "LOCAL_MEDIA_SELECTION_INVALID",
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSAFE_BASENAME_CHARACTER_PATTERN =
  /[\/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const DESKTOP_ASR_MODELS = [
  "iic/SenseVoiceSmall",
  "iic/SenseVoiceSmall-onnx",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function isSelectionToken(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isLocalMediaKind(value: unknown): value is LocalMediaKind {
  return value === "video" || value === "audio";
}

function isSafeDisplayName(value: unknown, extension: string): value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Array.from(value).length > 160 ||
    value === "." ||
    value === ".." ||
    UNSAFE_BASENAME_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }
  return value.toLocaleLowerCase("en-US").endsWith(`.${extension}`);
}

function extensionMatchesKind(
  extension: unknown,
  mediaKind: LocalMediaKind,
): extension is string {
  return (
    typeof extension === "string" &&
    (LOCAL_MEDIA_EXTENSIONS[mediaKind] as readonly string[]).includes(extension)
  );
}

export function parseLocalMediaSelectionView(
  value: unknown,
): LocalMediaParseResult<LocalMediaSelectionView> {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "selectionToken",
      "displayName",
      "mediaKind",
      "extension",
      "sizeBytes",
    ]) ||
    !isSelectionToken(value.selectionToken) ||
    !isLocalMediaKind(value.mediaKind) ||
    !extensionMatchesKind(value.extension, value.mediaKind) ||
    !isSafeDisplayName(value.displayName, value.extension) ||
    typeof value.sizeBytes !== "number" ||
    !Number.isInteger(value.sizeBytes) ||
    value.sizeBytes <= 0
  ) {
    return INVALID_SELECTION;
  }

  return {
    kind: "valid",
    value: {
      selectionToken: value.selectionToken,
      displayName: value.displayName,
      mediaKind: value.mediaKind,
      extension: value.extension,
      sizeBytes: value.sizeBytes,
    },
  };
}

export function parseProcessLocalMediaRequest(
  value: unknown,
): LocalMediaParseResult<ProcessLocalMediaRequest> {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["selectionToken", "asrModel"]) ||
    !isSelectionToken(value.selectionToken) ||
    !DESKTOP_ASR_MODELS.includes(value.asrModel as (typeof DESKTOP_ASR_MODELS)[number])
  ) {
    return INVALID_SELECTION;
  }

  return {
    kind: "valid",
    value: {
      selectionToken: value.selectionToken,
      asrModel: value.asrModel as ProcessLocalMediaRequest["asrModel"],
    },
  };
}
