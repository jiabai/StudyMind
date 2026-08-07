import { describe, expect, test } from "vitest";
import {
  cancelProcessing,
  confirmProcessingCancellation,
  finishInsightRetry,
  createInitialWorkflow,
  getDetailText,
  getExportPath,
  getTranscriptSourceLabel,
  getToolbarNewTaskButtonState,
  getVisibleWorkflowError,
  isProcessingStage,
  mergeProgressEvent,
  requestProcessingCancellation,
  restoreProcessingAfterCancellationFailure,
  startProcessing,
  startInsightRetry,
  summarizeWorkerResult,
  type WorkerResult,
} from "./workflow";

const TASK_ID = "20260705-153012-douyin-demo";
const TASK_DIR = "outputs/tasks/20260705-153012-douyin-demo";
const URL_SOURCE = {
  kind: "url",
  url: "https://www.douyin.com/video/7524373044106677544",
} as const;
const LOCAL_COMPOSER_SOURCE = {
  kind: "local_media",
  selection: {
    selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
    displayName: "Interview.wmv",
    mediaKind: "video",
    extension: "wmv",
    sizeBytes: 1024,
  },
} as const;
const DEFAULT_ARTIFACTS = {
  video: "media/video.mp4",
  audio: "media/audio.wav",
  transcript_txt: "transcript/transcript.txt",
  transcript_md: "transcript/transcript.md",
  summary: "ai/summary.md",
  mindmap: "ai/mindmap.mmd",
  insights: "ai/insights.json",
  insights_md: "ai/insights.md",
} satisfies WorkerResult["artifacts"];
const DEFAULT_INSIGHT: WorkerResult["insights"][number] = {
  id: 1,
  topic: "第一个话题点",
  matchReason: "匹配理由",
  followUpQuestions: ["第一个启发问题"],
  suitableUse: "内容选题",
  sourceChunkId: 1,
};
const SECOND_INSIGHT: WorkerResult["insights"][number] = {
  id: 2,
  topic: "第二个话题点",
  matchReason: "第二个匹配理由",
  followUpQuestions: ["第二个启发问题"],
  suitableUse: "团队分享",
  sourceChunkId: 2,
};
const DEFAULT_DISSECTION: NonNullable<WorkerResult["dissection"]> = {
  schemaVersion: 1,
  sourceTranscriptSha256: "a".repeat(64),
  sourceLanguage: "zh-CN",
  sourceChunks: [{ id: 1, startByte: 0, endByte: 3, sha256: "b".repeat(64) }],
  overallNarrative: {
    openingHook: null,
    structureType: "statement",
    turningPoint: null,
    closingType: null,
  },
  segments: [{
    id: 1,
    title: "Opening",
    sourceChunkIds: [1],
    coreClaim: "abc",
    supportingPoints: [],
    rhetoricalDevices: [],
    rhythmNote: "Brief",
    reusablePattern: "Direct",
    riskFlags: [],
  }],
  highlights: ["abc"],
  reusableTemplate: { name: "Direct", skeleton: ["A", "B", "C"] },
  audienceFit: [],
  strengths: ["Direct"],
  weaknesses: ["Brief"],
};

function workerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  const { artifacts, dissection, dissection_source_status, ...rest } = overrides;
  return {
    status: "completed",
    task_id: TASK_ID,
    task_dir: TASK_DIR,
    artifacts: artifacts ?? DEFAULT_ARTIFACTS,
    text: "完整文字稿",
    summary: "# 要点总结",
    insights: [DEFAULT_INSIGHT],
    transcript: null,
    dissection: dissection ?? null,
    dissection_source_status: dissection_source_status ?? null,
    error: null,
    ...rest,
  };
}

describe("workflow state model", () => {
  test("keeps a previous dissection and stale state across a failed redissection", () => {
    const previous = workerResult({
      dissection: DEFAULT_DISSECTION,
    });
    const state = { ...summarizeWorkerResult(previous), dissectionStale: true };
    const failed = workerResult({
      status: "partial_completed",
      dissection: null,
      error: {
        code: "INSIGHTFLOW_LLM_REQUEST_FAILED",
        message: "safe failure",
        stage: "insights_generating",
      },
    });

    const next = finishInsightRetry(state, failed, "dissection");

    expect(next.dissection).toEqual(previous.dissection);
    expect(next.dissectionStale).toBe(true);
    expect(next.aiTargetErrors.dissection?.code).toBe("INSIGHTFLOW_LLM_REQUEST_FAILED");
  });

  test("propagates stale dissection_source_status from a cached worker result", () => {
    const cached = workerResult({
      dissection: DEFAULT_DISSECTION,
      dissection_source_status: "stale",
    });

    const state = summarizeWorkerResult(cached);

    expect(state.dissection).toEqual(DEFAULT_DISSECTION);
    expect(state.dissectionStale).toBe(true);
  });

  test("treats a current dissection_source_status from a cached worker result as not stale", () => {
    const cached = workerResult({
      dissection: DEFAULT_DISSECTION,
      dissection_source_status: "current",
    });

    const state = summarizeWorkerResult(cached);

    expect(state.dissectionStale).toBe(false);
  });

  test("preserves an existing stale marker when retrying a non-dissection target", () => {
    const previous = workerResult({
      dissection: DEFAULT_DISSECTION,
      dissection_source_status: "stale",
    });
    const state = summarizeWorkerResult(previous);
    expect(state.dissectionStale).toBe(true);

    // The caller (useTaskProcessingController) carries forward the prior
    // dissection object when the worker result omits it; only the stale
    // marker must survive without the worker echoing source_status.
    const summaryRetry = workerResult({
      summary: "# new summary",
      dissection: DEFAULT_DISSECTION,
    });

    const next = finishInsightRetry(state, summaryRetry, "summary");

    expect(next.dissection).toEqual(DEFAULT_DISSECTION);
    expect(next.dissectionStale).toBe(true);
  });
  test("starts with no composer selection and no task source", () => {
    const state = createInitialWorkflow();

    expect(state.composerSource).toEqual({ kind: "none" });
    expect(state.taskSource).toBeNull();
    expect(state).not.toHaveProperty("url");
    expect(state).not.toHaveProperty("submittedUrl");
    expect(state).not.toHaveProperty("showUrlInput");
  });

  test("starts processing by freezing the closed task source", () => {
    const state = startProcessing(createInitialWorkflow(), URL_SOURCE);

    expect(state.stage).toBe("video_extracting");
    expect(state.taskSource).toEqual(URL_SOURCE);
    expect(state.composerSource).toEqual({ kind: "none" });
    expect(state.statusMessage).toBeNull();
    expect(state.progressMessage).toEqual({
      messageCode: "video.download.preparing",
      args: {},
    });
  });

  test("starts a local task with local validation progress instead of video download progress", () => {
    const state = startProcessing(createInitialWorkflow(), {
      kind: "local_file",
      displayName: "Interview.mp3",
      mediaKind: "audio",
    });

    expect(state.taskSource).toEqual({
      kind: "local_file",
      displayName: "Interview.mp3",
      mediaKind: "audio",
    });
    expect(state.progressMessage).toEqual({
      messageCode: "local.media.validating",
      args: {},
    });
  });

  test("summarizes transcript source metadata for platform subtitles", () => {
    const state = summarizeWorkerResult(workerResult({
      transcript: {
        source: "subtitle",
        language: "zh-Hans",
        engine: null,
      },
    }));

    expect(state.transcript).toEqual({
      source: "subtitle",
      language: "zh-Hans",
      engine: null,
    });
    expect(getTranscriptSourceLabel(state)).toEqual({
      messageCode: "transcript.review.source.subtitleWithLanguage",
      args: { language: "zh-Hans" },
    });
  });

  test("partial insight failure exposes a visible workflow error", () => {
    const state = summarizeWorkerResult(workerResult({
      status: "partial_completed",
      text: "已经完成的文字稿",
      summary: "# 要点总结\n\n## 总览\n已生成总结。",
      insights: [],
      artifacts: {
        video: DEFAULT_ARTIFACTS.video,
        audio: DEFAULT_ARTIFACTS.audio,
        transcript_txt: DEFAULT_ARTIFACTS.transcript_txt,
        transcript_md: DEFAULT_ARTIFACTS.transcript_md,
        summary: DEFAULT_ARTIFACTS.summary,
        mindmap: DEFAULT_ARTIFACTS.mindmap,
      },
      error: {
        code: "INSIGHTFLOW_LLM_REQUEST_FAILED",
        message: "LLM request failed with HTTP 400.",
        stage: "insights_generating",
      },
    }));

    expect(getVisibleWorkflowError(state)).toEqual({
      code: "INSIGHTFLOW_LLM_REQUEST_FAILED",
      message: "LLM request failed with HTTP 400.",
      stage: "insights_generating",
    });
    expect(getVisibleWorkflowError(createInitialWorkflow())).toBeNull();
  });

  test("cancel controls are only shown for active processing stages", () => {
    expect(isProcessingStage("video_extracting")).toBe(true);
    expect(isProcessingStage("video_transcribing")).toBe(true);
    expect(isProcessingStage("insights_generating")).toBe(true);
    expect(isProcessingStage("failed")).toBe(false);
    expect(isProcessingStage("completed")).toBe(false);
    expect(isProcessingStage("partial_completed")).toBe(false);
    expect(isProcessingStage("waiting_input")).toBe(false);
  });

  test("toolbar new-task action is disabled only while processing", () => {
    for (const stage of ["video_extracting", "video_transcribing", "insights_generating"] as const) {
      expect(getToolbarNewTaskButtonState(stage)).toEqual({
        disabled: true,
        ariaLabel: { messageCode: "workflow.toolbar.newTaskUnavailable" },
        title: { messageCode: "workflow.toolbar.newTaskUnavailable" },
      });
    }

    for (const stage of ["waiting_input", "completed", "partial_completed", "failed"] as const) {
      expect(getToolbarNewTaskButtonState(stage)).toEqual({
        disabled: false,
        ariaLabel: { messageCode: "workflow.toolbar.newTask" },
        title: { messageCode: "workflow.toolbar.newTask" },
      });
    }
  });

  test("formats detail text for clipboard copying", () => {
    const state = summarizeWorkerResult(workerResult({
      text: "完整文字稿",
      summary: "# 要点总结\n\n- 第一个要点",
      insights: [DEFAULT_INSIGHT, SECOND_INSIGHT],
    }));

    expect(getDetailText("transcript", state, "zh-CN")).toBe("完整文字稿");
    expect(getDetailText("summary", state, "zh-CN")).toBe("# 要点总结\n\n- 第一个要点");
    expect(getDetailText("insights", state, "zh-CN")).toBe(
      [
        "1. 第一个话题点",
        "匹配理由：匹配理由",
        "启发问题：第一个启发问题",
        "适合用途：内容选题",
        "来源片段：1",
        "",
        "2. 第二个话题点",
        "匹配理由：第二个匹配理由",
        "启发问题：第二个启发问题",
        "适合用途：团队分享",
        "来源片段：2",
      ].join("\n"),
    );

    const englishCopy = getDetailText("insights", state, "en-US");
    expect(englishCopy).toContain("Why it matches: 匹配理由");
    expect(englishCopy).toContain("Questions to explore: 第一个启发问题");
    expect(englishCopy).toContain("Best use: 内容选题");
    expect(englishCopy).toContain("Source segment: 1");
  });

  test("selects generated export path for each detail tab", () => {
    const state = summarizeWorkerResult(workerResult({
      text: "完整文字稿",
      summary: "# 要点总结",
      insights: [DEFAULT_INSIGHT],
    }));

    expect(getExportPath("video", state)).toBe(`${TASK_DIR}/media/video.mp4`);
    expect(getExportPath("audio", state)).toBe(`${TASK_DIR}/media/audio.wav`);
    expect(getExportPath("transcript", state)).toBe(`${TASK_DIR}/transcript/transcript.txt`);
    expect(getExportPath("summary", state)).toBe(`${TASK_DIR}/ai/summary.md`);
    expect(getExportPath("insights", state)).toBe(`${TASK_DIR}/ai/insights.md`);
    expect(getExportPath("insights", createInitialWorkflow())).toBeNull();
    expect(getExportPath("summary", createInitialWorkflow())).toBeNull();
  });

  test("merges worker progress events into the visible workflow state", () => {
    const state = startProcessing(createInitialWorkflow(), URL_SOURCE);

    const updated = mergeProgressEvent(state, {
      stage: "video_transcribing",
      progress: 68,
      message: {
        messageCode: "asr.transcribe.running",
        args: {},
      },
    });

    expect(updated.stage).toBe("video_transcribing");
    expect(updated.progressMessage).toEqual({
      messageCode: "asr.transcribe.running",
      args: {},
    });
    expect(updated.statusMessage).toBeNull();
    expect(updated.progressPercent).toBe(68);
    expect(updated.taskSource).toEqual(URL_SOURCE);
  });

  test("starts summary generation without discarding the existing transcript", () => {
    const state = summarizeWorkerResult(workerResult({
      status: "completed",
      text: "已经完成的文字稿。",
      summary: "",
      insights: [DEFAULT_INSIGHT],
      artifacts: {
        video: DEFAULT_ARTIFACTS.video,
        audio: DEFAULT_ARTIFACTS.audio,
        transcript_txt: DEFAULT_ARTIFACTS.transcript_txt,
        transcript_md: DEFAULT_ARTIFACTS.transcript_md,
        insights: DEFAULT_ARTIFACTS.insights,
        insights_md: DEFAULT_ARTIFACTS.insights_md,
      },
    }));

    const retrying = startInsightRetry(state, "summary");

    expect(retrying.stage).toBe("insights_generating");
    expect(retrying.statusMessage).toBeNull();
    expect(retrying.progressMessage).toEqual({
      messageCode: "insights.summary.generating",
      args: {},
    });
    expect(retrying.progressPercent).toBe(88);
    expect(retrying.text).toBe("已经完成的文字稿。");
    expect(retrying.insights).toEqual([DEFAULT_INSIGHT]);
    expect(retrying.taskId).toBe(TASK_ID);
    expect(retrying.taskDir).toBe(TASK_DIR);
    expect(retrying.artifacts.insights).toBe("ai/insights.json");
    expect(retrying.error).toBeNull();
  });

  test("starts insight generation without discarding the existing transcript", () => {
    const state = summarizeWorkerResult(workerResult({
      status: "partial_completed",
      text: "已经完成的文字稿。",
      summary: "# 要点总结\n\n## 总览\n旧总结会保留。",
      insights: [],
      artifacts: {
        video: DEFAULT_ARTIFACTS.video,
        audio: DEFAULT_ARTIFACTS.audio,
        transcript_txt: DEFAULT_ARTIFACTS.transcript_txt,
        transcript_md: DEFAULT_ARTIFACTS.transcript_md,
        summary: DEFAULT_ARTIFACTS.summary,
        mindmap: DEFAULT_ARTIFACTS.mindmap,
      },
      error: {
        code: "INSIGHTFLOW_CONFIG_MISSING",
        message: "InsightFlow LLM client is not configured.",
        stage: "insights_generating",
      },
    }));

    const retrying = startInsightRetry(state, "insights");

    expect(retrying.stage).toBe("insights_generating");
    expect(retrying.statusMessage).toBeNull();
    expect(retrying.progressMessage).toEqual({
      messageCode: "insights.topics.generating",
      args: {},
    });
    expect(retrying.progressPercent).toBe(88);
    expect(retrying.text).toBe("已经完成的文字稿。");
    expect(retrying.summary).toBe("# 要点总结\n\n## 总览\n旧总结会保留。");
    expect(retrying.taskId).toBe(TASK_ID);
    expect(retrying.taskDir).toBe(TASK_DIR);
    expect(retrying.artifacts.video).toBe("media/video.mp4");
    expect(retrying.artifacts.audio).toBe("media/audio.wav");
    expect(retrying.artifacts.transcript_txt).toBe("transcript/transcript.txt");
    expect(retrying.artifacts.summary).toBe("ai/summary.md");
    expect(retrying.artifacts.mindmap).toBe("ai/mindmap.mmd");
    expect(retrying.error).toBeNull();
  });

  test("cancels active processing and preserves the existing composer selection", () => {
    const state = startProcessing(
      {
        ...createInitialWorkflow(),
        composerSource: LOCAL_COMPOSER_SOURCE,
      },
      URL_SOURCE,
    );

    const cancelled = cancelProcessing(state);

    expect(cancelled.stage).toBe("waiting_input");
    expect(cancelled.composerSource).toEqual(LOCAL_COMPOSER_SOURCE);
    expect(cancelled.taskSource).toBeNull();
    expect(cancelled.statusMessage).toBeNull();
    expect(cancelled.error).toBeNull();
  });

  test("keeps the workflow active while cancellation is pending and restores it when signalling fails", () => {
    const running = startProcessing(createInitialWorkflow(), URL_SOURCE);

    const cancelling = requestProcessingCancellation(running);

    expect(cancelling.stage).toBe("cancelling");
    expect(cancelling.cancellingFromStage).toBe("video_extracting");
    expect(cancelling.taskSource).toEqual(URL_SOURCE);
    expect(isProcessingStage(cancelling.stage)).toBe(true);
    expect(cancelling.statusMessage).toBeNull();
    expect(cancelling.progressMessage).toEqual({
      messageCode: "task.cancel.requested",
      args: {},
    });

    const restored = restoreProcessingAfterCancellationFailure(cancelling);
    expect(restored.stage).toBe("video_extracting");
    expect(restored.statusMessage).toEqual({
      messageCode: "workflow.cancellation.failed",
    });
    expect(restored.taskSource).toEqual(URL_SOURCE);
  });

  test("returns to input only after cancellation is confirmed", () => {
    const cancelling = requestProcessingCancellation(
      startProcessing(
        createInitialWorkflow(),
        URL_SOURCE,
      ),
    );

    const cancelled = confirmProcessingCancellation(cancelling);
    expect(cancelled.stage).toBe("waiting_input");
    expect(cancelled.composerSource).toEqual({ kind: "none" });
    expect(cancelled.taskSource).toBeNull();
  });

  test("keeps the completed task and prior report when redissection cancellation is confirmed", () => {
    const completed = summarizeWorkerResult(workerResult({
      dissection: DEFAULT_DISSECTION,
    }));
    const cancelling = requestProcessingCancellation(
      startInsightRetry(completed, "dissection"),
    );

    const cancelled = confirmProcessingCancellation(cancelling);

    expect(cancelled.stage).toBe("completed");
    expect(cancelled.taskId).toBe(TASK_ID);
    expect(cancelled.dissection).toEqual(DEFAULT_DISSECTION);
    expect(cancelled.activeAiTarget).toBeNull();
  });

  test("retains a local selection after cancellation while clearing the running source", () => {
    const running = startProcessing(
      {
        ...createInitialWorkflow(),
        composerSource: LOCAL_COMPOSER_SOURCE,
      },
      {
        kind: "local_file",
        displayName: "Interview.wmv",
        mediaKind: "video",
      },
    );

    const cancelled = confirmProcessingCancellation(
      requestProcessingCancellation(running),
    );

    expect(cancelled.composerSource).toEqual(LOCAL_COMPOSER_SOURCE);
    expect(cancelled.taskSource).toBeNull();
  });
});
