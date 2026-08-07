import {
  extractSafeTechnicalDetails,
  type SafeTechnicalDetails,
  type VideoDownloadReasonCode,
} from "./safeTechnicalDetails";
import type { WorkerErrorResult } from "./workflowState";

export const WORKER_ERROR_MESSAGE_CODES = {
  INVALID_REQUEST_JSON: "request.invalid",
  INVALID_REQUEST_PAYLOAD: "request.invalid",
  INVALID_RETRY_JSON: "request.invalid",
  INVALID_RETRY_PAYLOAD: "request.invalid",
  WORKER_STDIN_INVALID: "request.invalid",
  VIDEO_DOWNLOAD_FAILED: "video.downloadFailed",
  VIDEO_DOWNLOAD_OUTPUT_MISSING: "video.outputMissing",
  MEDIA_VALIDATION_FAILED: "video.validationFailed",
  AUDIO_EXTRACTION_FAILED: "audio.extractionFailed",
  ASR_MODEL_NOT_READY: "asr.modelNotReady",
  ASR_MODEL_NOT_DOWNLOADED: "asr.modelNotDownloaded",
  ASR_MODEL_CACHE_UNAVAILABLE: "asr.modelCacheUnavailable",
  ASR_DEPENDENCY_MISSING: "asr.dependencyMissing",
  ASR_EMPTY_TRANSCRIPT: "asr.emptyTranscript",
  ASR_ERROR: "asr.runtimeFailed",
  ASR_RUNTIME_ERROR: "asr.runtimeFailed",
  ASR_MODEL_UNSUPPORTED: "asr.modelUnsupported",
  SOURCE_IDENTITY_UNAVAILABLE: "source.identityUnavailable",
  TASK_STORAGE_UNAVAILABLE: "task.storageUnavailable",
  TASK_MANIFEST_NOT_FOUND: "task.manifestNotFound",
  TASK_ARTIFACT_COMMIT_FAILED: "task.artifactCommitFailed",
  TASK_ARTIFACT_RECOVERY_FAILED: "task.artifactRecoveryFailed",
  TRANSCRIPT_TEXT_PATH_INVALID: "transcript.pathInvalid",
  TRANSCRIPT_TEXT_NOT_FOUND: "transcript.notFound",
  TRANSCRIPT_MARKDOWN_NOT_FOUND: "transcript.notFound",
  INSIGHTFLOW_LLM_QUOTA_UNAVAILABLE: "insight.quotaUnavailable",
  INSIGHTFLOW_LLM_AUTH_REQUIRED: "insight.authRequired",
  INSIGHTFLOW_CONFIG_MISSING: "insight.configMissing",
  INSIGHTFLOW_LLM_CONFIG_MISSING: "insight.configMissing",
  LLM_CONFIG_MISSING: "insight.configMissing",
  INSIGHTFLOW_LLM_CHECKOUT_FAILED: "insight.checkoutFailed",
  INSIGHTFLOW_LLM_CHECKOUT_TIMEOUT: "insight.checkoutFailed",
  INSIGHTFLOW_LLM_CHECKOUT_INVALID_RESPONSE: "insight.checkoutFailed",
  INSIGHTFLOW_LLM_REQUEST_TIMEOUT: "insight.requestTimeout",
  INSIGHTFLOW_LLM_REQUEST_FAILED: "insight.requestFailed",
  INSIGHTFLOW_LLM_CONTENT_BLOCKED: "insight.contentBlocked",
  INSIGHTFLOW_LLM_INVALID_RESPONSE: "insight.invalidResponse",
  INSIGHTFLOW_EMPTY_RESULT: "insight.emptyResult",
  INSIGHTFLOW_EMPTY_SUMMARY: "insight.emptySummary",
  INSIGHTFLOW_INVALID_MINDMAP: "insight.invalidMindmap",
  INSIGHTFLOW_EMPTY_TRANSCRIPT: "insight.emptyTranscript",
  WORKER_CANCELLED: "worker.cancelled",
  WORKER_ALREADY_RUNNING: "worker.alreadyRunning",
  WORKER_IDLE_TIMEOUT: "worker.idleTimeout",
  WORKER_EXECUTION_TIMEOUT: "worker.executionTimeout",
  WORKER_REQUEST_TRANSPORT_FAILED: "worker.transportFailed",
  WORKER_PROCESS_FAILED: "worker.processFailed",
  WORKER_PROTOCOL_VIOLATION: "worker.processFailed",
  TAURI_COMMAND_FAILED: "worker.processFailed",
} as const;

export const VIDEO_DOWNLOAD_REASON_MESSAGE_CODES = {
  YOUTUBE_LOGIN_REQUIRED: "video.youtube.loginRequired",
  YOUTUBE_AGE_RESTRICTED: "video.youtube.ageRestricted",
  YOUTUBE_PRIVATE_OR_UNAVAILABLE: "video.youtube.privateOrUnavailable",
  YOUTUBE_NO_PLAYABLE_STREAM: "video.youtube.noPlayableStream",
  YOUTUBE_DOWNLOAD_FAILED: "video.youtube.downloadFailed",
  BILIBILI_DRM_PROTECTED: "video.bilibili.drmProtected",
  BILIBILI_FFMPEG_MERGE_FAILED: "video.bilibili.mergeFailed",
  BILIBILI_UNSUPPORTED_CONTENT: "video.bilibili.unsupportedContent",
  BILIBILI_LOGIN_REQUIRED: "video.bilibili.unsupportedContent",
  BILIBILI_ID_PARSE_FAILED: "video.bilibili.invalidLink",
  BILIBILI_SHORT_LINK_RESOLVE_FAILED: "video.bilibili.invalidLink",
  BILIBILI_VIDEO_INFO_UNAVAILABLE: "video.bilibili.unavailable",
  BILIBILI_PART_NOT_FOUND: "video.bilibili.unavailable",
  BILIBILI_NO_PLAYABLE_STREAM: "video.bilibili.noPlayableStream",
  BILIBILI_DASH_DOWNLOAD_FAILED: "video.bilibili.noPlayableStream",
  XHS_IMAGE_ONLY: "video.xiaohongshu.imageOnly",
  XHS_NOTE_BLOCKED: "video.xiaohongshu.unavailable",
  XHS_NOTE_NOT_FOUND: "video.xiaohongshu.unavailable",
  XHS_RATE_LIMITED: "video.xiaohongshu.rateLimited",
  XHS_NO_PLAYABLE_STREAM: "video.xiaohongshu.noPlayableStream",
  XHS_INITIAL_STATE_MISSING: "video.xiaohongshu.parseFailed",
  XHS_INITIAL_STATE_MALFORMED: "video.xiaohongshu.parseFailed",
  XHS_RESPONSE_DECODE_FAILED: "video.xiaohongshu.parseFailed",
  XHS_RESPONSE_TOO_LARGE: "video.xiaohongshu.parseFailed",
  XHS_VIDEO_TOO_LARGE: "video.xiaohongshu.videoTooLarge",
  XHS_DOWNLOAD_STALLED: "video.xiaohongshu.downloadStalled",
  XHS_STREAM_DOWNLOAD_FAILED: "video.xiaohongshu.downloadFailed",
  XHS_PAGE_UNAVAILABLE: "video.xiaohongshu.downloadFailed",
  XHS_SHORT_LINK_RESOLUTION_FAILED: "video.xiaohongshu.downloadFailed",
  XHS_ID_PARSE_FAILED: "video.xiaohongshu.downloadFailed",
  XHS_URL_INVALID: "video.xiaohongshu.downloadFailed",
  DOUYIN_NO_PLAYABLE_STREAM: "video.douyin.noPlayableStream",
  DOUYIN_STREAM_DOWNLOAD_FAILED: "video.douyin.noPlayableStream",
  DOUYIN_SHARE_PAGE_UNAVAILABLE: "video.douyin.noPlayableStream",
  DOUYIN_ROUTER_DATA_MISSING: "video.douyin.noPlayableStream",
  DOUYIN_ROUTER_DATA_MALFORMED: "video.douyin.noPlayableStream",
  DOUYIN_ID_PARSE_FAILED: "video.douyin.invalidLink",
} as const satisfies Record<VideoDownloadReasonCode, string>;

type KnownWorkerMessageCode =
  (typeof WORKER_ERROR_MESSAGE_CODES)[keyof typeof WORKER_ERROR_MESSAGE_CODES];
type VideoReasonMessageCode =
  (typeof VIDEO_DOWNLOAD_REASON_MESSAGE_CODES)[keyof typeof VIDEO_DOWNLOAD_REASON_MESSAGE_CODES];

type WorkerErrorMessageKey =
  | "generic"
  | KnownWorkerMessageCode
  | VideoReasonMessageCode;

export type WorkerErrorMessageCode = `errors.${WorkerErrorMessageKey}`;

export type WorkerErrorPresentation = Readonly<{
  messageCode: WorkerErrorMessageCode;
  technicalDetails: SafeTechnicalDetails;
}>;

export function presentWorkerError(error: WorkerErrorResult): WorkerErrorPresentation {
  const technicalDetails = extractSafeTechnicalDetails({
    errorCode: error.code,
    stageCode: error.stage,
    message: error.message,
  });
  const messageCode = resolveWorkerErrorMessageCode(error.code, technicalDetails.reasonCode);
  return { messageCode, technicalDetails };
}

export function formatWorkerError(error: WorkerErrorResult): WorkerErrorMessageCode {
  return presentWorkerError(error).messageCode;
}

function resolveWorkerErrorMessageCode(
  errorCode: string,
  reasonCode: VideoDownloadReasonCode | undefined,
): WorkerErrorMessageCode {
  if (errorCode === "VIDEO_DOWNLOAD_FAILED" && reasonCode) {
    return qualifyErrorMessageCode(VIDEO_DOWNLOAD_REASON_MESSAGE_CODES[reasonCode]);
  }
  if (Object.prototype.hasOwnProperty.call(WORKER_ERROR_MESSAGE_CODES, errorCode)) {
    return qualifyErrorMessageCode(
      WORKER_ERROR_MESSAGE_CODES[
        errorCode as keyof typeof WORKER_ERROR_MESSAGE_CODES
      ],
    );
  }
  return "errors.generic";
}

function qualifyErrorMessageCode(key: WorkerErrorMessageKey): WorkerErrorMessageCode {
  return `errors.${key}`;
}
