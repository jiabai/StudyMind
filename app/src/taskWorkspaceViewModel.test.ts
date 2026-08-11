import { describe, expect, test } from "vitest";

import { createGuestAccountStatus, type AccountStatus } from "./accountState";
import {
  createInitialWorkflow,
  finishInsightRetry,
  mergeProgressEvent,
  requestProcessingCancellation,
  startInsightRetry,
  startProcessing,
  summarizeWorkerResult,
  type WorkerResult,
  type WorkflowState,
} from "./workflow";
import { createTaskWorkspaceViewModel } from "./taskWorkspaceViewModel";

const TASK_ID = "20260711-120000-local-lecture";
const LOCAL_SOURCE = {
  kind: "local_file",
  displayName: "Lecture.mp4",
  mediaKind: "video",
} as const;

function entitledAccount(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    ...createGuestAccountStatus(),
    authenticated: true,
    entitlementStatus: "active",
    llmConfigured: true,
    llmQuotaLimit: 20,
    llmQuotaUsed: 1,
    llmQuotaRemaining: 19,
    canProcess: true,
    canGenerateAi: true,
    ...overrides,
  };
}

function transcriptResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  const { dissection, dissection_source_status, ...rest } = overrides;
  return {
    status: "completed",
    task_id: TASK_ID,
    task_dir: `outputs/tasks/${TASK_ID}`,
    artifacts: {
      video: "media/video.mp4",
      audio: "media/audio.wav",
      transcript_txt: "transcript/transcript.txt",
      transcript_md: "transcript/transcript.md",
    },
    text: "已保存的正式文字稿",
    summary: "",
    insights: [],
    transcript: { source: "asr", language: "zh", engine: "SenseVoice" },
    dissection: dissection ?? null,
    dissection_source_status: dissection_source_status ?? null,
    error: null,
    ...rest,
  };
}

describe("task workspace view model", () => {
  test("local processing has only media and transcription progress while AI waits", () => {
    const workflow = startProcessing(
      createInitialWorkflow(),
      LOCAL_SOURCE,
    );

    const model = createTaskWorkspaceViewModel(workflow, entitledAccount());

    expect(model.local.phase).toBe("processing");
    expect(model.local.progressSteps.map((step) => step.id)).toEqual([
      "video_extracting",
      "video_transcribing",
    ]);
    expect(model.ai.phase).toBe("waiting_transcript");
    expect(model.ai.visible).toBe(false);
    expect(model.ai.summary.status).toBe("locked");
    expect(model.ai.insights.status).toBe("locked");
    expect(model.cancellationOwner).toBe("local");
  });

  test("projects cancellation controls into the workspace that owns the operation", () => {
    const processing = startProcessing(
      createInitialWorkflow(),
      LOCAL_SOURCE,
    );

    const runningModel = createTaskWorkspaceViewModel(
      processing,
      entitledAccount(),
    );

    expect(runningModel.local.cancellation).toEqual({
      visible: true,
      enabled: true,
      inProgress: false,
    });
    expect(runningModel.ai.cancellation).toEqual({
      visible: false,
      enabled: false,
      inProgress: false,
    });

    const cancellingModel = createTaskWorkspaceViewModel(
      requestProcessingCancellation(processing),
      entitledAccount(),
    );

    expect(cancellingModel.local.cancellation).toEqual({
      visible: true,
      enabled: false,
      inProgress: true,
    });
  });

  test("keeps semantic worker progress in the view model until render time", () => {
    const workflow = mergeProgressEvent(
      startProcessing(
        createInitialWorkflow(),
        LOCAL_SOURCE,
      ),
      {
        stage: "video_transcribing",
        progress: 60,
        message: { messageCode: "asr.transcribe.running", args: {} },
      },
    );

    const model = createTaskWorkspaceViewModel(workflow, entitledAccount());

    expect(model.banner.progressMessage).toEqual({
      messageCode: "asr.transcribe.running",
      args: {},
    });
    expect(model.banner.message).toBeNull();
  });

  test("a saved local transcript unlocks both independent AI targets for the same task", () => {
    const workflow = summarizeWorkerResult(transcriptResult());

    const model = createTaskWorkspaceViewModel(workflow, entitledAccount());

    expect(model.banner.kind).toBe("local_complete");
    expect(model.banner.message).toEqual({
      messageCode: "workflow.banner.localCompleteMessage",
    });
    expect(model.local.phase).toBe("ready");
    expect(model.local.taskId).toBe(TASK_ID);
    expect(model.local.readOnly).toBe(false);
    expect(model.ai.phase).toBe("ready");
    expect(model.ai.visible).toBe(true);
    expect(model.ai.taskId).toBe(TASK_ID);
    expect(model.ai.summary.status).toBe("available");
    expect(model.ai.insights.status).toBe("available");
  });

  test("uses audio-only completion copy and never offers a video action for a local audio task", () => {
    const workflow: WorkflowState = {
      ...summarizeWorkerResult(
        transcriptResult({
          artifacts: {
            audio: "media/audio.wav",
            transcript_txt: "transcript/transcript.txt",
            transcript_md: "transcript/transcript.md",
          },
        }),
      ),
      taskSource: {
        kind: "local_file",
        displayName: "Interview.mp3",
        mediaKind: "audio",
      },
    };

    const model = createTaskWorkspaceViewModel(workflow, entitledAccount());

    expect(model.banner.message).toEqual({
      messageCode: "workflow.banner.localAudioCompleteMessage",
    });
    expect(model.local.artifactActions).toEqual({
      locateVideo: { visible: false, enabled: false },
      locateAudio: { visible: true, enabled: true },
    });
  });

  test("projects source-aware artifact actions and transcript source without exposing workflow state", () => {
    const workflow = summarizeWorkerResult(
      transcriptResult({
        artifacts: {
          audio: "media/audio.wav",
          transcript_txt: "transcript/transcript.txt",
          transcript_md: "transcript/transcript.md",
        },
        transcript: { source: "subtitle", language: "en", engine: null },
      }),
    );

    const model = createTaskWorkspaceViewModel(workflow, entitledAccount());

    expect(model.local.artifactActions).toEqual({
      locateVideo: { visible: false, enabled: false },
      locateAudio: { visible: true, enabled: true },
    });
    expect(model.local.transcriptSource).toEqual({
      kind: "subtitle",
      language: "en",
    });
  });

  test.each([
    {
      label: "summary only",
      result: transcriptResult({
        summary: "# 已生成总结",
        artifacts: {
          ...transcriptResult().artifacts,
          summary: "ai/summary.md",
          mindmap: "ai/mindmap.mmd",
        },
      }),
      summaryStatus: "ready",
      insightsStatus: "available",
    },
    {
      label: "insights only",
      result: transcriptResult({
        insights: [
          {
            id: 1,
            topic: "独立灵感",
            matchReason: "匹配当前任务",
            followUpQuestions: ["下一步是什么？"],
            suitableUse: "复盘",
            sourceChunkId: null,
          },
        ],
        artifacts: {
          ...transcriptResult().artifacts,
          insights: "ai/insights.json",
          insights_md: "ai/insights.md",
        },
      }),
      summaryStatus: "available",
      insightsStatus: "ready",
    },
  ])(
    "projects $label without manufacturing the other AI target",
    ({ result, summaryStatus, insightsStatus }) => {
      const model = createTaskWorkspaceViewModel(
        summarizeWorkerResult(result),
        entitledAccount(),
      );

      expect(model.local.phase).toBe("ready");
      expect(model.ai.summary.status).toBe(summaryStatus);
      expect(model.ai.insights.status).toBe(insightsStatus);
      expect(model.local.taskId).toBe(model.ai.taskId);
    },
  );

  test("typed AI target keeps local results ready and read-only while generation runs", () => {
    const workflow = startInsightRetry(
      summarizeWorkerResult(transcriptResult()),
      "summary",
    );

    const model = createTaskWorkspaceViewModel(workflow, entitledAccount());

    expect(workflow.activeAiTarget).toBe("summary");
    expect(model.local.phase).toBe("ready");
    expect(model.local.canReview).toBe(true);
    expect(model.local.canEdit).toBe(false);
    expect(model.local.readOnly).toBe(true);
    expect(model.ai.summary.status).toBe("generating");
    expect(model.ai.insights.status).toBe("available");
    expect(model.cancellationOwner).toBe("ai");
  });

  test("AI cancellation remains owned by the active target during Cancelling", () => {
    const running = startInsightRetry(
      summarizeWorkerResult(transcriptResult()),
      "insights",
    );
    const cancelling = requestProcessingCancellation(running);

    const model = createTaskWorkspaceViewModel(cancelling, entitledAccount());

    expect(cancelling.activeAiTarget).toBe("insights");
    expect(model.local.phase).toBe("ready");
    expect(model.local.canEdit).toBe(false);
    expect(model.ai.insights.status).toBe("cancelling");
    expect(model.cancellationOwner).toBe("ai");
  });

  test("a failed target does not turn the usable local transcript or other target into an error", () => {
    const state = summarizeWorkerResult(
      transcriptResult({
        status: "partial_completed",
        summary: "# 已有总结",
        artifacts: {
          ...transcriptResult().artifacts,
          summary: "ai/summary.md",
          mindmap: "ai/mindmap.mmd",
        },
        error: {
          code: "INSIGHTFLOW_EMPTY_RESULT",
          message: "No insights returned.",
          stage: "insights_generating",
        },
      }),
      "insights",
    );

    const model = createTaskWorkspaceViewModel(state, entitledAccount());

    expect(state.aiErrorTarget).toBe("insights");
    expect(model.local.phase).toBe("ready");
    expect(model.local.error).toBeNull();
    expect(model.ai.summary.status).toBe("ready");
    expect(model.ai.insights.status).toBe("failed");
    expect(model.ai.insights.errorCode).toBe("INSIGHTFLOW_EMPTY_RESULT");
  });

  test("summary and inspiration retain independent failure states across retries", () => {
    const ready = summarizeWorkerResult(transcriptResult());
    const summaryFailed = finishInsightRetry(
      startInsightRetry(ready, "summary"),
      transcriptResult({
        status: "partial_completed",
        error: {
          code: "INSIGHTFLOW_EMPTY_SUMMARY",
          message: "No summary returned.",
          stage: "insights_generating",
        },
      }),
      "summary",
    );
    const bothFailed = finishInsightRetry(
      startInsightRetry(summaryFailed, "insights"),
      transcriptResult({
        status: "partial_completed",
        error: {
          code: "INSIGHTFLOW_EMPTY_RESULT",
          message: "No insights returned.",
          stage: "insights_generating",
        },
      }),
      "insights",
    );

    const model = createTaskWorkspaceViewModel(bothFailed, entitledAccount());

    expect(model.ai.summary.status).toBe("failed");
    expect(model.ai.summary.errorCode).toBe("INSIGHTFLOW_EMPTY_SUMMARY");
    expect(model.ai.insights.status).toBe("failed");
    expect(model.ai.insights.errorCode).toBe("INSIGHTFLOW_EMPTY_RESULT");
  });

  test("AI availability distinguishes service unavailability from exhausted quota", () => {
    const workflow = summarizeWorkerResult(transcriptResult());

    expect(
      createTaskWorkspaceViewModel(
        workflow,
        entitledAccount({ llmConfigured: false, canGenerateAi: false }),
      ).ai.availability,
    ).toBe("unavailable");
    expect(
      createTaskWorkspaceViewModel(
        workflow,
        entitledAccount({ llmQuotaRemaining: 0, canGenerateAi: false }),
      ).ai.availability,
    ).toBe("quota_exhausted");
  });

  test("a local failure has an explicit failed banner instead of a loading banner", () => {
    const state = summarizeWorkerResult(
      transcriptResult({
        status: "failed",
        task_id: null,
        task_dir: null,
        artifacts: {},
        text: "",
        error: {
          code: "VIDEO_DOWNLOAD_FAILED",
          message: "download failed",
          stage: "video_extracting",
        },
      }),
    );

    const model = createTaskWorkspaceViewModel(state, entitledAccount());

    expect(model.banner.kind).toBe("local_failed");
    expect(model.banner.message).toEqual({
      messageCode: "workflow.banner.localFailedWithCode",
      args: { code: "VIDEO_DOWNLOAD_FAILED" },
    });
    expect(model.local.phase).toBe("failed");
  });
});
