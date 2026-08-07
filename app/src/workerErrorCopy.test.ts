import { describe, expect, test } from "vitest";
import { formatWorkerError, presentWorkerError } from "./workerErrorCopy";
import type { WorkerErrorResult } from "./workflowState";

function workerError(
  code: string,
  message = "arbitrary provider prose",
  stage: WorkerErrorResult["stage"] = "failed",
): WorkerErrorResult {
  return { code, message, stage };
}

describe("worker error presentation", () => {
  test.each([
    ["ASR_MODEL_NOT_READY", "asr.modelNotReady"],
    ["ASR_MODEL_CACHE_UNAVAILABLE", "asr.modelCacheUnavailable"],
    ["ASR_MODEL_NOT_DOWNLOADED", "asr.modelNotDownloaded"],
    ["ASR_DEPENDENCY_MISSING", "asr.dependencyMissing"],
    ["ASR_EMPTY_TRANSCRIPT", "asr.emptyTranscript"],
    ["ASR_ERROR", "asr.runtimeFailed"],
    ["ASR_RUNTIME_ERROR", "asr.runtimeFailed"],
    ["ASR_MODEL_UNSUPPORTED", "asr.modelUnsupported"],
    ["VIDEO_DOWNLOAD_OUTPUT_MISSING", "video.outputMissing"],
    ["MEDIA_VALIDATION_FAILED", "video.validationFailed"],
    ["AUDIO_EXTRACTION_FAILED", "audio.extractionFailed"],
    ["SOURCE_IDENTITY_UNAVAILABLE", "source.identityUnavailable"],
    ["TASK_STORAGE_UNAVAILABLE", "task.storageUnavailable"],
    ["TASK_MANIFEST_NOT_FOUND", "task.manifestNotFound"],
    ["TASK_ARTIFACT_COMMIT_FAILED", "task.artifactCommitFailed"],
    ["TASK_ARTIFACT_RECOVERY_FAILED", "task.artifactRecoveryFailed"],
    ["TRANSCRIPT_TEXT_PATH_INVALID", "transcript.pathInvalid"],
    ["TRANSCRIPT_TEXT_NOT_FOUND", "transcript.notFound"],
    ["TRANSCRIPT_MARKDOWN_NOT_FOUND", "transcript.notFound"],
    ["INVALID_REQUEST_JSON", "request.invalid"],
    ["INVALID_REQUEST_PAYLOAD", "request.invalid"],
    ["INVALID_RETRY_JSON", "request.invalid"],
    ["INVALID_RETRY_PAYLOAD", "request.invalid"],
    ["WORKER_STDIN_INVALID", "request.invalid"],
    ["WORKER_CANCELLED", "worker.cancelled"],
    ["WORKER_ALREADY_RUNNING", "worker.alreadyRunning"],
    ["WORKER_IDLE_TIMEOUT", "worker.idleTimeout"],
    ["WORKER_EXECUTION_TIMEOUT", "worker.executionTimeout"],
    ["WORKER_REQUEST_TRANSPORT_FAILED", "worker.transportFailed"],
    ["WORKER_PROTOCOL_VIOLATION", "worker.processFailed"],
  ])("maps known worker code %s to %s", (code, messageCode) => {
    expect(presentWorkerError(workerError(code))).toMatchObject({
      messageCode: `errors.${messageCode}`,
    });
  });

  test.each([
    ["INSIGHTFLOW_LLM_QUOTA_UNAVAILABLE", "insight.quotaUnavailable"],
    ["INSIGHTFLOW_LLM_AUTH_REQUIRED", "insight.authRequired"],
    ["INSIGHTFLOW_CONFIG_MISSING", "insight.configMissing"],
    ["INSIGHTFLOW_LLM_CONFIG_MISSING", "insight.configMissing"],
    ["INSIGHTFLOW_LLM_CHECKOUT_FAILED", "insight.checkoutFailed"],
    ["INSIGHTFLOW_LLM_CHECKOUT_TIMEOUT", "insight.checkoutFailed"],
    ["INSIGHTFLOW_LLM_CHECKOUT_INVALID_RESPONSE", "insight.checkoutFailed"],
    ["INSIGHTFLOW_LLM_REQUEST_TIMEOUT", "insight.requestTimeout"],
    ["INSIGHTFLOW_LLM_REQUEST_FAILED", "insight.requestFailed"],
    ["INSIGHTFLOW_LLM_CONTENT_BLOCKED", "insight.contentBlocked"],
    ["INSIGHTFLOW_LLM_INVALID_RESPONSE", "insight.invalidResponse"],
    ["INSIGHTFLOW_EMPTY_RESULT", "insight.emptyResult"],
    ["INSIGHTFLOW_EMPTY_SUMMARY", "insight.emptySummary"],
    ["INSIGHTFLOW_INVALID_MINDMAP", "insight.invalidMindmap"],
    ["INSIGHTFLOW_EMPTY_TRANSCRIPT", "insight.emptyTranscript"],
    ["WORKER_PROCESS_FAILED", "worker.processFailed"],
    ["TAURI_COMMAND_FAILED", "worker.processFailed"],
  ])("maps known AI error code %s to %s", (code, messageCode) => {
    expect(
      presentWorkerError(workerError(code, "provider secret prose", "insights_generating")),
    ).toEqual({
      messageCode: `errors.${messageCode}`,
      technicalDetails: {
        errorCode: code,
        stageCode: "insights_generating",
      },
    });
  });

  test.each([
    ["YOUTUBE_LOGIN_REQUIRED", "video.youtube.loginRequired"],
    ["YOUTUBE_AGE_RESTRICTED", "video.youtube.ageRestricted"],
    ["YOUTUBE_PRIVATE_OR_UNAVAILABLE", "video.youtube.privateOrUnavailable"],
    ["YOUTUBE_NO_PLAYABLE_STREAM", "video.youtube.noPlayableStream"],
    ["BILIBILI_DRM_PROTECTED", "video.bilibili.drmProtected"],
    ["BILIBILI_FFMPEG_MERGE_FAILED", "video.bilibili.mergeFailed"],
    ["XHS_IMAGE_ONLY", "video.xiaohongshu.imageOnly"],
    ["XHS_RATE_LIMITED", "video.xiaohongshu.rateLimited"],
    ["XHS_DOWNLOAD_STALLED", "video.xiaohongshu.downloadStalled"],
    ["DOUYIN_NO_PLAYABLE_STREAM", "video.douyin.noPlayableStream"],
  ])("uses registered download cause %s for guidance", (reasonCode, messageCode) => {
    expect(
      presentWorkerError(
        workerError(
          "VIDEO_DOWNLOAD_FAILED",
          `${reasonCode}: arbitrary downloader prose`,
          "video_extracting",
        ),
      ),
    ).toEqual({
      messageCode: `errors.${messageCode}`,
      technicalDetails: {
        errorCode: "VIDEO_DOWNLOAD_FAILED",
        stageCode: "video_extracting",
        reasonCode,
      },
    });
  });

  test("does not derive guidance from unstructured lowercase downloader prose", () => {
    const presentation = presentWorkerError(
      workerError(
        "VIDEO_DOWNLOAD_FAILED",
        "sign in, use --cookies, network timeout, unsupported URL https://secret.example",
        "video_extracting",
      ),
    );

    expect(presentation).toEqual({
      messageCode: "errors.video.downloadFailed",
      technicalDetails: {
        errorCode: "VIDEO_DOWNLOAD_FAILED",
        stageCode: "video_extracting",
      },
    });
  });

  test("uses generic guidance for unknown codes while retaining only a safe code", () => {
    expect(
      presentWorkerError(
        workerError(
          "FUTURE_WORKER_FAILURE",
          "prompt=secret transcript=secret Cookie=session-secret https://secret.example",
          "failed",
        ),
      ),
    ).toEqual({
      messageCode: "errors.generic",
      technicalDetails: {
        errorCode: "FUTURE_WORKER_FAILURE",
        stageCode: "failed",
      },
    });
  });

  test("presentation serialization cannot contain malicious raw error fields", () => {
    const secrets = [
      "https://secret.example/private",
      "C:\\private\\config.json",
      "/private/transcript.txt",
      "session-secret",
      "api-key-secret",
      "prompt-secret",
      "transcript-secret",
    ];
    const presentation = presentWorkerError(
      workerError(
        "INSIGHTFLOW_LLM_REQUEST_FAILED",
        [
          `HTTP 401 ${secrets[0]} ${secrets[1]} ${secrets[2]}`,
          `Cookie=${secrets[3]} API key=${secrets[4]}`,
          `prompt=${secrets[5]} transcript=${secrets[6]}`,
        ].join(" "),
        "insights_generating",
      ),
    );
    const serialized = JSON.stringify(presentation);

    expect(presentation).toEqual({
      messageCode: "errors.insight.requestFailed",
      technicalDetails: {
        errorCode: "INSIGHTFLOW_LLM_REQUEST_FAILED",
        stageCode: "insights_generating",
        httpStatus: 401,
      },
    });
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("legacy formatter returns only the stable key, never raw prose", () => {
    const error = workerError(
      "UNKNOWN_SAFE_CODE",
      "secret raw error https://example.test?api_key=sk-secret",
    );

    expect(formatWorkerError(error)).toBe("errors.generic");
  });
});
