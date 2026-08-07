import type { WorkerResult } from "./workflow";

export const TASK_RESULT_FIELDS = [
  "status",
  "task_id",
  "task_dir",
  "artifacts",
  "text",
  "summary",
  "insights",
  "transcript",
  "dissection",
  "error",
] as const;

const TASK_RESULT_OPTIONAL_FIELDS = ["dissection_source_status"] as const;

export const TASK_ARTIFACT_KEYS = [
  "video",
  "audio",
  "transcript_txt",
  "transcript_md",
  "segments",
  "summary",
  "mindmap",
  "insights",
  "insights_md",
  "preference_snapshot",
  "dissection",
  "dissection_md",
] as const;

export const TASK_INSIGHT_FIELDS = [
  "id",
  "topic",
  "matchReason",
  "followUpQuestions",
  "suitableUse",
  "sourceChunkId",
] as const;

export const TASK_TERMINAL_STATUSES = [
  "completed",
  "partial_completed",
  "failed",
] as const;

const TASK_ERROR_STAGES = [
  "waiting_input",
  "video_extracting",
  "video_transcribing",
  "insights_generating",
  "completed",
  "partial_completed",
  "failed",
] as const;
const TRANSCRIPT_SOURCES = ["asr", "subtitle"] as const;
const CANCEL_STATUSES = [
  "cancelling",
  "already_cancelling",
  "not_running",
  "failed",
] as const;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const DISSECTION_SOURCE_STATUSES = ["current", "stale"] as const;
type DissectionSourceStatus = (typeof DISSECTION_SOURCE_STATUSES)[number];

type TaskArtifactKey = (typeof TASK_ARTIFACT_KEYS)[number];

export type AsrModelDownloadResult = {
  started: boolean;
  status: "completed" | "cancelled" | "already_available";
};

export type CancelProcessResult = {
  status: (typeof CANCEL_STATUSES)[number];
  error: string | null;
};

type DataObject = {
  keys: string[];
  values: Record<string, unknown>;
};

export function parseWorkerResult(value: unknown): WorkerResult | null {
  try {
    return parseWorkerResultUnchecked(value);
  } catch {
    return null;
  }
}

export function parseAsrModelDownloadResult(
  value: unknown,
): AsrModelDownloadResult | null {
  try {
    const object = readExactObject(value, ["started", "status"]);
    if (!object || typeof object.started !== "boolean") {
      return null;
    }
    const status = object.status;
    if (
      (status === "completed" && object.started === true) ||
      (status === "cancelled" && object.started === false) ||
      (status === "already_available" && object.started === false)
    ) {
      return { started: object.started, status };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseCancelProcessResult(value: unknown): CancelProcessResult | null {
  try {
    const object = readExactObject(value, ["status", "error"]);
    if (!object || !isOneOf(object.status, CANCEL_STATUSES)) {
      return null;
    }
    if (object.status === "failed") {
      return typeof object.error === "string"
        ? { status: object.status, error: object.error }
        : null;
    }
    return object.error === null ? { status: object.status, error: null } : null;
  } catch {
    return null;
  }
}

function parseWorkerResultUnchecked(value: unknown): WorkerResult | null {
  const object = readObjectWithOptional(
    value,
    TASK_RESULT_FIELDS,
    TASK_RESULT_OPTIONAL_FIELDS,
  );
  if (!object || !isOneOf(object.status, TASK_TERMINAL_STATUSES)) {
    return null;
  }
  const taskId = nullableString(object.task_id);
  const taskDir = nullableString(object.task_dir);
  const artifacts = parseArtifacts(object.artifacts);
  const insights = parseInsights(object.insights);
  const transcript = parseTranscript(object.transcript);
  const dissection = parseDissection(object.dissection);
  const dissectionSourceStatus = parseDissectionSourceStatus(
    object.dissection_source_status,
  );
  const error = parseTaskError(object.error);
  if (
    taskId === undefined ||
    taskDir === undefined ||
    artifacts === null ||
    typeof object.text !== "string" ||
    typeof object.summary !== "string" ||
    insights === null ||
    transcript === undefined ||
    dissection === undefined ||
    dissectionSourceStatus === undefined ||
    error === undefined
  ) {
    return null;
  }
  if (
    (object.status === "completed" && error !== null) ||
    (object.status !== "completed" && error === null)
  ) {
    return null;
  }
  return {
    status: object.status,
    task_id: taskId,
    task_dir: taskDir,
    artifacts,
    text: object.text,
    summary: object.summary,
    insights,
    transcript,
    dissection,
    dissection_source_status: dissectionSourceStatus,
    error,
  };
}

function parseDissectionSourceStatus(
  value: unknown,
): DissectionSourceStatus | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  return isOneOf(value, DISSECTION_SOURCE_STATUSES) ? value : undefined;
}

export function parseDissection(value: unknown): WorkerResult["dissection"] | undefined {
  if (value === null) {
    return null;
  }
  const object = readExactObject(value, [
    "schemaVersion",
    "sourceTranscriptSha256",
    "sourceLanguage",
    "sourceChunks",
    "overallNarrative",
    "segments",
    "highlights",
    "reusableTemplate",
    "audienceFit",
    "strengths",
    "weaknesses",
  ]);
  if (
    !object ||
    object.schemaVersion !== 1 ||
    typeof object.sourceTranscriptSha256 !== "string" ||
    !SHA256.test(object.sourceTranscriptSha256) ||
    !isSourceLanguage(object.sourceLanguage)
  ) {
    return undefined;
  }

  const sourceChunksRaw = readDataArray(object.sourceChunks);
  const segmentsRaw = readDataArray(object.segments);
  const highlights = readStringArray(object.highlights, 8);
  const strengths = readStringArray(object.strengths, 6);
  const weaknesses = readStringArray(object.weaknesses, 6);
  const narrative = parseNarrative(object.overallNarrative);
  const template = parseReusableTemplate(object.reusableTemplate);
  const audienceFit = parseAudienceFit(object.audienceFit);
  if (
    !sourceChunksRaw ||
    sourceChunksRaw.length === 0 ||
    !segmentsRaw ||
    segmentsRaw.length === 0 ||
    !highlights ||
    !strengths ||
    !weaknesses ||
    !narrative ||
    !template ||
    !audienceFit
  ) {
    return undefined;
  }

  const sourceChunks: NonNullable<WorkerResult["dissection"]>["sourceChunks"] = [];
  let previousEnd = 0;
  for (const [index, item] of sourceChunksRaw.entries()) {
    const chunk = readExactObject(item, ["id", "startByte", "endByte", "sha256"]);
    if (
      !chunk ||
      chunk.id !== index + 1 ||
      !isSafeUnsignedInteger(chunk.startByte) ||
      !isSafeUnsignedInteger(chunk.endByte) ||
      chunk.startByte < previousEnd ||
      chunk.endByte <= chunk.startByte ||
      typeof chunk.sha256 !== "string" ||
      !SHA256.test(chunk.sha256)
    ) {
      return undefined;
    }
    sourceChunks.push({
      id: chunk.id,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
      sha256: chunk.sha256,
    });
    previousEnd = chunk.endByte;
  }

  const segments: NonNullable<WorkerResult["dissection"]>["segments"] = [];
  for (const [index, item] of segmentsRaw.entries()) {
    const segment = parseDissectionSegment(item, index + 1, sourceChunks.length);
    if (!segment) {
      return undefined;
    }
    segments.push(segment);
  }

  return {
    schemaVersion: 1,
    sourceTranscriptSha256: object.sourceTranscriptSha256,
    sourceLanguage: object.sourceLanguage,
    sourceChunks,
    overallNarrative: narrative,
    segments,
    highlights,
    reusableTemplate: template,
    audienceFit,
    strengths,
    weaknesses,
  };
}

function parseNarrative(
  value: unknown,
): NonNullable<WorkerResult["dissection"]>["overallNarrative"] | null {
  const object = readExactObject(value, [
    "openingHook",
    "structureType",
    "turningPoint",
    "closingType",
  ]);
  const openingHook = object ? nullableNonBlankString(object.openingHook) : undefined;
  const turningPoint = object ? nullableNonBlankString(object.turningPoint) : undefined;
  const closingType = object ? nullableNonBlankString(object.closingType) : undefined;
  if (
    !object ||
    openingHook === undefined ||
    turningPoint === undefined ||
    closingType === undefined ||
    !isNonBlankString(object.structureType)
  ) {
    return null;
  }
  return { openingHook, structureType: object.structureType, turningPoint, closingType };
}

function parseDissectionSegment(
  value: unknown,
  expectedId: number,
  sourceChunkCount: number,
): NonNullable<WorkerResult["dissection"]>["segments"][number] | null {
  const object = readExactObject(value, [
    "id",
    "title",
    "sourceChunkIds",
    "coreClaim",
    "supportingPoints",
    "rhetoricalDevices",
    "rhythmNote",
    "reusablePattern",
    "riskFlags",
  ]);
  const sourceChunkIds = object ? readDataArray(object.sourceChunkIds) : null;
  const supportingPoints = object ? readStringArray(object.supportingPoints) : null;
  const rhetoricalDevices = object ? readStringArray(object.rhetoricalDevices) : null;
  const riskFlags = object ? readStringArray(object.riskFlags) : null;
  if (
    !object ||
    object.id !== expectedId ||
    !isNonBlankString(object.title) ||
    !isNonBlankString(object.coreClaim) ||
    !isNonBlankString(object.rhythmNote) ||
    !isNonBlankString(object.reusablePattern) ||
    !sourceChunkIds ||
    sourceChunkIds.length === 0 ||
    !supportingPoints ||
    !rhetoricalDevices ||
    !riskFlags
  ) {
    return null;
  }
  let previousId = 0;
  const safeSourceChunkIds: number[] = [];
  for (const id of sourceChunkIds) {
    if (!isSafeUnsignedInteger(id) || id <= previousId || id > sourceChunkCount) {
      return null;
    }
    safeSourceChunkIds.push(id);
    previousId = id;
  }
  return {
    id: object.id,
    title: object.title,
    sourceChunkIds: safeSourceChunkIds,
    coreClaim: object.coreClaim,
    supportingPoints,
    rhetoricalDevices,
    rhythmNote: object.rhythmNote,
    reusablePattern: object.reusablePattern,
    riskFlags,
  };
}

function parseReusableTemplate(
  value: unknown,
): NonNullable<WorkerResult["dissection"]>["reusableTemplate"] | null {
  const object = readExactObject(value, ["name", "skeleton"]);
  const skeleton = object ? readStringArray(object.skeleton, 7) : null;
  return object && isNonBlankString(object.name) && skeleton && skeleton.length >= 3
    ? { name: object.name, skeleton }
    : null;
}

function parseAudienceFit(
  value: unknown,
): NonNullable<WorkerResult["dissection"]>["audienceFit"] | null {
  const items = readDataArray(value);
  if (!items) {
    return null;
  }
  const result: NonNullable<WorkerResult["dissection"]>["audienceFit"] = [];
  for (const item of items) {
    const object = readExactObject(item, ["audience", "fit", "note"]);
    if (
      !object ||
      !isNonBlankString(object.audience) ||
      !isOneOf(object.fit, ["high", "medium", "low"] as const) ||
      !isNonBlankString(object.note)
    ) {
      return null;
    }
    result.push({ audience: object.audience, fit: object.fit, note: object.note });
  }
  return result;
}

function readStringArray(value: unknown, maximum = 32): string[] | null {
  const items = readDataArray(value);
  return items && items.length <= maximum && items.every(isNonBlankString)
    ? (items as string[])
    : null;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableNonBlankString(value: unknown): string | null | undefined {
  return value === null ? null : isNonBlankString(value) ? value : undefined;
}

function isSourceLanguage(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SOURCE_LANGUAGE.test(value));
}

function parseArtifacts(value: unknown): WorkerResult["artifacts"] | null {
  const object = readDataObject(value);
  if (!object) {
    return null;
  }
  const artifacts: WorkerResult["artifacts"] = {};
  for (const key of object.keys) {
    if (!isOneOf(key, TASK_ARTIFACT_KEYS) || typeof object.values[key] !== "string") {
      return null;
    }
    artifacts[key as TaskArtifactKey] = object.values[key] as string;
  }
  return artifacts;
}

function parseInsights(value: unknown): WorkerResult["insights"] | null {
  const items = readDataArray(value);
  if (!items) {
    return null;
  }
  const insights: WorkerResult["insights"] = [];
  for (const item of items) {
    const object = readExactObject(item, TASK_INSIGHT_FIELDS);
    const followUpQuestions = object ? readDataArray(object.followUpQuestions) : null;
    if (
      !object ||
      !isSafeUnsignedInteger(object.id) ||
      typeof object.topic !== "string" ||
      typeof object.matchReason !== "string" ||
      !followUpQuestions ||
      !followUpQuestions.every((question) => typeof question === "string") ||
      typeof object.suitableUse !== "string" ||
      !isNullableSafeUnsignedInteger(object.sourceChunkId)
    ) {
      return null;
    }
    insights.push({
      id: object.id,
      topic: object.topic,
      matchReason: object.matchReason,
      followUpQuestions: followUpQuestions as string[],
      suitableUse: object.suitableUse,
      sourceChunkId: object.sourceChunkId,
    });
  }
  return insights;
}

function parseTranscript(value: unknown): WorkerResult["transcript"] | undefined {
  if (value === null) {
    return null;
  }
  const object = readExactObject(value, ["source", "language", "engine"]);
  if (!object || !isOneOf(object.source, TRANSCRIPT_SOURCES)) {
    return undefined;
  }
  const language = nullableString(object.language);
  const engine = nullableString(object.engine);
  if (language === undefined || engine === undefined) {
    return undefined;
  }
  return { source: object.source, language, engine };
}

function parseTaskError(value: unknown): WorkerResult["error"] | undefined {
  if (value === null) {
    return null;
  }
  const object = readExactObject(value, ["code", "message", "stage"]);
  if (
    !object ||
    typeof object.code !== "string" ||
    !SAFE_ERROR_CODE.test(object.code) ||
    typeof object.message !== "string" ||
    !isOneOf(object.stage, TASK_ERROR_STAGES)
  ) {
    return undefined;
  }
  return { code: object.code, message: object.message, stage: object.stage };
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableSafeUnsignedInteger(value: unknown): value is number | null {
  return value === null || isSafeUnsignedInteger(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.includes(value as Values[number]);
}

function readExactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  const object = readDataObject(value);
  if (
    !object ||
    object.keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(object.values, key))
  ) {
    return null;
  }
  return object.values;
}

function readObjectWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | null {
  const object = readDataObject(value);
  if (!object) {
    return null;
  }
  const allowed = new Set<string>([...requiredKeys, ...optionalKeys]);
  if (!object.keys.every((key) => allowed.has(key))) {
    return null;
  }
  if (
    !requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(object.values, key),
    )
  ) {
    return null;
  }
  return object.values;
}

function readDataObject(value: unknown): DataObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (!ownKeys.every((key): key is string => typeof key === "string")) {
    return null;
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      return null;
    }
    values[key] = descriptor.value;
  }
  return { keys: ownKeys, values };
}

function readDataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys[value.length] !== "length") {
    return null;
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (ownKeys[index] !== String(index)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      return null;
    }
    items.push(descriptor.value);
  }
  return items;
}
