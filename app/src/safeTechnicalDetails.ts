import { WORKFLOW_STAGES, type WorkflowStage } from "./desktopWorkerProtocol";

export const SAFE_ERRNOS = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOSPC",
] as const;

export const SAFE_TOOL_NAMES = ["FFmpeg", "yt-dlp", "ModelScope"] as const;

export const VIDEO_DOWNLOAD_REASON_CODES = [
  "YOUTUBE_LOGIN_REQUIRED",
  "YOUTUBE_AGE_RESTRICTED",
  "YOUTUBE_PRIVATE_OR_UNAVAILABLE",
  "YOUTUBE_NO_PLAYABLE_STREAM",
  "YOUTUBE_DOWNLOAD_FAILED",
  "BILIBILI_DRM_PROTECTED",
  "BILIBILI_FFMPEG_MERGE_FAILED",
  "BILIBILI_UNSUPPORTED_CONTENT",
  "BILIBILI_LOGIN_REQUIRED",
  "BILIBILI_ID_PARSE_FAILED",
  "BILIBILI_SHORT_LINK_RESOLVE_FAILED",
  "BILIBILI_VIDEO_INFO_UNAVAILABLE",
  "BILIBILI_PART_NOT_FOUND",
  "BILIBILI_NO_PLAYABLE_STREAM",
  "BILIBILI_DASH_DOWNLOAD_FAILED",
  "XHS_IMAGE_ONLY",
  "XHS_NOTE_BLOCKED",
  "XHS_NOTE_NOT_FOUND",
  "XHS_RATE_LIMITED",
  "XHS_NO_PLAYABLE_STREAM",
  "XHS_INITIAL_STATE_MISSING",
  "XHS_INITIAL_STATE_MALFORMED",
  "XHS_RESPONSE_DECODE_FAILED",
  "XHS_RESPONSE_TOO_LARGE",
  "XHS_VIDEO_TOO_LARGE",
  "XHS_DOWNLOAD_STALLED",
  "XHS_STREAM_DOWNLOAD_FAILED",
  "XHS_PAGE_UNAVAILABLE",
  "XHS_SHORT_LINK_RESOLUTION_FAILED",
  "XHS_ID_PARSE_FAILED",
  "XHS_URL_INVALID",
  "DOUYIN_NO_PLAYABLE_STREAM",
  "DOUYIN_STREAM_DOWNLOAD_FAILED",
  "DOUYIN_SHARE_PAGE_UNAVAILABLE",
  "DOUYIN_ROUTER_DATA_MISSING",
  "DOUYIN_ROUTER_DATA_MALFORMED",
  "DOUYIN_ID_PARSE_FAILED",
] as const;

export type SafeErrno = (typeof SAFE_ERRNOS)[number];
export type SafeToolName = (typeof SAFE_TOOL_NAMES)[number];
export type VideoDownloadReasonCode = (typeof VIDEO_DOWNLOAD_REASON_CODES)[number];

export type SafeTechnicalDetails = Readonly<{
  errorCode?: string;
  stageCode?: WorkflowStage;
  reasonCode?: VideoDownloadReasonCode;
  httpStatus?: number;
  exitCode?: number;
  errno?: SafeErrno;
  tools?: readonly SafeToolName[];
}>;

export type TechnicalDetailSource = Readonly<{
  errorCode?: unknown;
  stageCode?: unknown;
  message?: unknown;
}>;

const SAFE_DIAGNOSTIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}$/;
const HTTP_STATUS_PATTERN =
  /(?:\bHTTP(?:\s+(?:status|error))?(?:\s+code)?|\bstatus\s+code)\s*[:=#]?\s*(\d{3})\b/i;
const EXIT_CODE_PATTERN =
  /\b(?:exit(?:ed)?(?:\s+with)?\s+(?:code|status)|return(?:ed)?(?:\s+with)?\s+(?:code|status)|returncode)\s*[:=#]?\s*(-?\d{1,6})\b/i;
const ERRNO_PATTERN = new RegExp(
  `(?:^|[^A-Za-z0-9_])(${SAFE_ERRNOS.join("|")})(?=$|[^A-Za-z0-9_])`,
);
const REASON_CODE_PATTERN = /^\s*([A-Z][A-Z0-9_]{2,95})\s*:(?:\s|$)/;

const WORKFLOW_STAGE_SET = new Set<string>(WORKFLOW_STAGES);
const VIDEO_DOWNLOAD_REASON_CODE_SET = new Set<string>(VIDEO_DOWNLOAD_REASON_CODES);

export function extractSafeTechnicalDetails(
  source: TechnicalDetailSource,
): SafeTechnicalDetails {
  const details: {
    errorCode?: string;
    stageCode?: WorkflowStage;
    reasonCode?: VideoDownloadReasonCode;
    httpStatus?: number;
    exitCode?: number;
    errno?: SafeErrno;
    tools?: readonly SafeToolName[];
  } = {};

  if (isSafeDiagnosticCode(source.errorCode)) {
    details.errorCode = source.errorCode;
  }
  if (isWorkflowStage(source.stageCode)) {
    details.stageCode = source.stageCode;
  }
  if (typeof source.message !== "string") {
    return details;
  }

  const reasonCode = extractRegisteredReasonCode(source.message);
  if (reasonCode) {
    details.reasonCode = reasonCode;
  }

  const httpStatus = extractHttpStatus(source.message);
  if (httpStatus !== undefined) {
    details.httpStatus = httpStatus;
  }

  const exitCode = extractExitCode(source.message);
  if (exitCode !== undefined) {
    details.exitCode = exitCode;
  }

  const errno = extractErrno(source.message);
  if (errno) {
    details.errno = errno;
  }

  const tools = extractToolNames(source.message);
  if (tools.length > 0) {
    details.tools = tools;
  }

  return details;
}

export function isSafeDiagnosticCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_DIAGNOSTIC_CODE_PATTERN.test(value);
}

function isWorkflowStage(value: unknown): value is WorkflowStage {
  return typeof value === "string" && WORKFLOW_STAGE_SET.has(value);
}

function extractRegisteredReasonCode(message: string): VideoDownloadReasonCode | undefined {
  const candidate = REASON_CODE_PATTERN.exec(message)?.[1];
  return candidate && VIDEO_DOWNLOAD_REASON_CODE_SET.has(candidate)
    ? (candidate as VideoDownloadReasonCode)
    : undefined;
}

function extractHttpStatus(message: string): number | undefined {
  const candidate = parseMatchedInteger(HTTP_STATUS_PATTERN, message);
  return candidate !== undefined && candidate >= 400 && candidate <= 599
    ? candidate
    : undefined;
}

function extractExitCode(message: string): number | undefined {
  const candidate = parseMatchedInteger(EXIT_CODE_PATTERN, message);
  return candidate !== undefined && candidate >= -255 && candidate <= 255
    ? candidate
    : undefined;
}

function parseMatchedInteger(pattern: RegExp, message: string): number | undefined {
  const rawValue = pattern.exec(message)?.[1];
  if (rawValue === undefined) {
    return undefined;
  }
  const value = Number(rawValue);
  return Number.isSafeInteger(value) ? value : undefined;
}

function extractErrno(message: string): SafeErrno | undefined {
  const candidate = ERRNO_PATTERN.exec(message)?.[1];
  return candidate as SafeErrno | undefined;
}

function extractToolNames(message: string): readonly SafeToolName[] {
  const tools: SafeToolName[] = [];
  if (/(?:^|[^A-Za-z0-9_])ffmpeg(?=$|[^A-Za-z0-9_])/i.test(message)) {
    tools.push("FFmpeg");
  }
  if (/(?:^|[^A-Za-z0-9_-])yt-dlp(?=$|[^A-Za-z0-9_-])/i.test(message)) {
    tools.push("yt-dlp");
  }
  if (/(?:^|[^A-Za-z0-9_])modelscope(?=$|[^A-Za-z0-9_])/i.test(message)) {
    tools.push("ModelScope");
  }
  return tools;
}
