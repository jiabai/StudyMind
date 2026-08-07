import { describe, expect, test, vi } from "vitest";
import {
  WORKER_PROGRESS_EVENT,
  cancelProcess,
  processLocalMedia,
  processVideo,
  retryInsights,
  type CancelCommandRunner,
  type WorkerCommandRunner,
  type WorkerProgressListener,
} from "./workerClient";
import { buildPreferenceSnapshot } from "./insightPreferences";
import type { PreferenceSnapshot } from "./insightPreferences";
import type { WorkerResult } from "./workflow";

const TASK_ID = "20260705-153012-douyin-demo";
const TASK_DIR = "outputs/tasks/20260705-153012-douyin-demo";
const DEFAULT_INSIGHT: WorkerResult["insights"][number] = {
  id: 1,
  topic: "为什么流程编排可能比单点模型能力更关键？",
  matchReason: "文字稿强调流程编排与业务价值相关。",
  followUpQuestions: ["团队应该先改造哪条流程？"],
  suitableUse: "内容选题",
  sourceChunkId: 1,
};
const PREFERENCE_SNAPSHOT: PreferenceSnapshot = buildPreferenceSnapshot({
  profile: {
    role: "content_creator",
    domain: "content_media",
    stage: "experienced_professional",
    cityContext: "new_tier1_city",
    genderPerspective: "neutral_perspective",
    platforms: ["douyin"],
  },
  profileSkipped: false,
  generationPreferences: {
    goal: "content_creation",
    scenario: "short_video",
    angles: ["topic_angle"],
    audience: "fans_readers",
    styles: ["grounded"],
    avoid: ["clickbait"],
  },
});

function completedResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  const { artifacts, transcript, ...rest } = overrides;
  return {
    status: "completed",
    task_id: TASK_ID,
    task_dir: TASK_DIR,
    artifacts: {
      video: "media/video.mp4",
      audio: "media/audio.wav",
      transcript_txt: "transcript/transcript.txt",
      transcript_md: "transcript/transcript.md",
      summary: "ai/summary.md",
      mindmap: "ai/mindmap.mmd",
      insights: "ai/insights.json",
      ...(artifacts ?? {}),
    },
    text: "完整文字稿",
    summary: "# 要点总结",
    insights: [DEFAULT_INSIGHT],
    transcript: transcript ?? null,
    dissection: null,
    dissection_source_status: null,
    error: null,
    ...rest,
  };
}

describe("worker client", () => {
  test("invokes the independent local-media command with a frozen model snapshot", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: WorkerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return completedResult({
        artifacts: {
          audio: "media/audio.wav",
          transcript_txt: "transcript/transcript.txt",
        },
      });
    };

    const result = await processLocalMedia(
      {
        selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
        asrModel: "iic/SenseVoiceSmall-onnx",
      },
      runner,
    );

    expect(calls).toEqual([
      {
        command: "process_local_media",
        args: {
          request: {
            selectionToken: "01234567-89ab-4def-8abc-0123456789ab",
            asrModel: "iic/SenseVoiceSmall-onnx",
          },
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("sourcePath");
    expect(result.status).toBe("completed");
  });

  test("rejects malformed local-media intent before invoking Tauri", async () => {
    const runner = vi.fn<WorkerCommandRunner>();

    const result = await processLocalMedia(
      {
        selectionToken: "review-secret",
        sourcePath: "C:\\Users\\review-secret\\Interview.wmv",
      } as never,
      runner,
    );

    expect(runner).not.toHaveBeenCalled();
    expect(result.error).toEqual({
      code: "LOCAL_MEDIA_SELECTION_INVALID",
      message: "",
      stage: "video_extracting",
    });
    expect(JSON.stringify(result)).not.toContain("review-secret");
  });

  test("invokes the Tauri process_video command with the submitted url", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: WorkerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return completedResult();
    };

    const result = await processVideo(
      "https://www.douyin.com/video/7524373044106677544",
      runner,
    );

    expect(calls).toEqual([
      {
        command: "process_video",
        args: {
          request: {
            url: "https://www.douyin.com/video/7524373044106677544",
            asrModel: "iic/SenseVoiceSmall",
          },
        },
      },
    ]);
    expect(calls[0]?.args).not.toHaveProperty("request.generate_insights");
    expect(calls[0]?.args).not.toHaveProperty("request.preference_snapshot");
    expect(result.status).toBe("completed");
  });

  test("maps thrown Tauri errors to structured failed worker result", async () => {
    const runner: WorkerCommandRunner = async () => {
      throw new Error("worker process could not start");
    };

    const result = await processVideo(
      "https://www.douyin.com/video/7524373044106677544",
      runner,
    );

    expect(result).toEqual({
      status: "failed",
      task_id: null,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      dissection_source_status: null,
      error: {
        code: "TAURI_COMMAND_FAILED",
        message: "worker process could not start",
        stage: "video_extracting",
      },
    });
  });

  test("subscribes to worker progress and unregisters after completion", async () => {
    const progressEvents: unknown[] = [];
    const unlistenCalls: string[] = [];
    const listener: WorkerProgressListener = async (eventName, handler) => {
      handler({
        event: eventName,
        id: 1,
        payload: {
          stage: "video_transcribing",
          progress: 68,
          message_code: "asr.transcribe.running",
        },
      });
      return async () => {
        unlistenCalls.push(eventName);
      };
    };
    const runner: WorkerCommandRunner = async () => completedResult({
      text: "完整文字稿",
      summary: "",
      insights: [],
      artifacts: {
        video: "media/video.mp4",
        audio: "media/audio.wav",
        transcript_txt: "transcript/transcript.txt",
        transcript_md: "transcript/transcript.md",
      },
    });

    await processVideo(
      "https://www.douyin.com/video/7524373044106677544",
      runner,
      (event) => progressEvents.push(event),
      listener,
    );

    expect(progressEvents).toEqual([
      {
        stage: "video_transcribing",
        progress: 68,
        message: { messageCode: "asr.transcribe.running", args: {} },
      },
    ]);
    expect(unlistenCalls).toEqual([WORKER_PROGRESS_EVENT]);
  });

  test("subscribes to retry progress and unregisters after completion", async () => {
    const progressEvents: unknown[] = [];
    const unlistenCalls: string[] = [];
    const listener: WorkerProgressListener = async (eventName, handler) => {
      handler({
        event: eventName,
        id: 1,
        payload: {
          stage: "insights_generating",
          progress: 76,
          message_code: "ai.generation.running",
          message_args: { attempt: 2, total: 3 },
        },
      });
      return async () => {
        unlistenCalls.push(eventName);
      };
    };

    await retryInsights(
      { taskId: TASK_ID, target: "dissection", outputLanguage: "zh-CN" },
      async () => completedResult(),
      (event) => progressEvents.push(event),
      listener,
    );

    expect(progressEvents).toEqual([
      {
        stage: "insights_generating",
        progress: 76,
        message: {
          messageCode: "ai.generation.running",
          args: { attempt: 2, total: 3 },
        },
      },
    ]);
    expect(unlistenCalls).toEqual([WORKER_PROGRESS_EVENT]);
  });

  test("drops invalid progress without exposing payload prose and records only a safe code", async () => {
    const progressEvents: unknown[] = [];
    const diagnostics: string[] = [];
    const listener: WorkerProgressListener = async (eventName, handler) => {
      for (const payload of [
        {
          stage: "video_extracting",
          progress: 20,
          message_code: "video.download.preparing",
          message: "raw https://secret.example/private",
        },
        {
          stage: "video_extracting",
          progress: 20,
          message_code: "https://secret.example/private",
        },
      ]) {
        handler({ event: eventName, id: 1, payload });
      }
      return () => undefined;
    };

    await processVideo(
      "https://www.douyin.com/video/7524373044106677544",
      async () => completedResult(),
      (event) => progressEvents.push(event),
      listener,
      (code) => diagnostics.push(code),
    );

    expect(progressEvents).toEqual([]);
    expect(diagnostics).toEqual(["video.download.preparing", "invalid"]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret.example");
  });

  test("applies a structurally safe unknown progress code with generic rendering data and records the code", async () => {
    const progressEvents: unknown[] = [];
    const diagnostics: string[] = [];
    const listener: WorkerProgressListener = async (eventName, handler) => {
      handler({
        event: eventName,
        id: 1,
        payload: {
          stage: "video_transcribing",
          progress: 72,
          message_code: "future.action.running",
        },
      });
      return () => undefined;
    };

    await processVideo(
      "https://www.douyin.com/video/7524373044106677544",
      async () => completedResult(),
      (event) => progressEvents.push(event),
      listener,
      (code) => diagnostics.push(code),
    );

    expect(progressEvents).toEqual([
      {
        stage: "video_transcribing",
        progress: 72,
        message: { messageCode: "future.action.running", args: {} },
      },
    ]);
    expect(diagnostics).toEqual(["future.action.running"]);
  });

  test("invokes the Tauri retry_insights command for summary generation", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: WorkerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return completedResult({
        text: "已经完成的文字稿。",
        summary: "# 要点总结",
        insights: [
          {
            ...DEFAULT_INSIGHT,
            topic: "为什么重试应该只重新生成话题点？",
          },
        ],
      });
    };

    const result = await retryInsights(
      { taskId: TASK_ID, target: "summary", outputLanguage: "zh-TW" },
      runner,
    );

    expect(calls).toEqual([
      {
        command: "retry_insights",
        args: {
          request: {
            task_id: TASK_ID,
            target: "summary",
            output_language: "zh-TW",
          },
        },
      },
    ]);
    expect(result.status).toBe("completed");
  });

  test("invokes the retry command with an optional preference snapshot", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: WorkerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return completedResult();
    };

    const result = await retryInsights(
      {
        taskId: TASK_ID,
        target: "insights",
        outputLanguage: "en-US",
        preferenceSnapshot: PREFERENCE_SNAPSHOT,
      },
      runner,
    );

    expect(calls).toEqual([
      {
        command: "retry_insights",
        args: {
          request: {
            task_id: TASK_ID,
            target: "insights",
            output_language: "en-US",
            preference_snapshot: PREFERENCE_SNAPSHOT,
          },
        },
      },
    ]);
    const request = (calls[0]?.args as {
      request: { preference_snapshot: PreferenceSnapshot };
    }).request;
    expect(Object.keys(request.preference_snapshot.profile ?? {}).sort()).toEqual([
      "cityContext",
      "domain",
      "genderPerspective",
      "platforms",
      "role",
      "stage",
    ]);
    expect(
      request.preference_snapshot.labelSnapshot.profile.map(({ field }) => field),
    ).toEqual([
      "role",
      "domain",
      "stage",
      "cityContext",
      "genderPerspective",
      "platforms",
    ]);
    expect(JSON.stringify(request)).not.toMatch(
      /defaultStyles|defaultAvoid|legacyGenerationPreferenceSeed/,
    );
    expect(result.status).toBe("completed");
  });

  test("invokes dissection without transcript paths or preference data", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: WorkerCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return completedResult();
    };

    const result = await retryInsights(
      { taskId: TASK_ID, target: "dissection", outputLanguage: "zh-CN" },
      runner,
    );

    expect(calls).toEqual([{
      command: "retry_insights",
      args: {
        request: {
          task_id: TASK_ID,
          target: "dissection",
          output_language: "zh-CN",
        },
      },
    }]);
    expect(result.status).toBe("completed");
  });

  test("preserves existing transcript when the retry command fails", async () => {
    const runner: WorkerCommandRunner = async () => {
      throw new Error("retry worker process could not start");
    };

    const result = await retryInsights(
      { taskId: TASK_ID, target: "summary", outputLanguage: "zh-CN" },
      runner,
    );

    expect(result).toEqual({
      status: "partial_completed",
      task_id: TASK_ID,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      dissection_source_status: null,
      error: {
        code: "TAURI_COMMAND_FAILED",
        message: "retry worker process could not start",
        stage: "insights_generating",
      },
    });
  });

  test("accepts exactly the three output languages without a compatibility default", async () => {
    const languages: string[] = [];
    const runner: WorkerCommandRunner = async (_command, args) => {
      languages.push(
        ((args as { request: { output_language: string } }).request).output_language,
      );
      return completedResult();
    };

    for (const outputLanguage of ["zh-CN", "zh-TW", "en-US"] as const) {
      await retryInsights({ taskId: TASK_ID, target: "summary", outputLanguage }, runner);
    }

    expect(languages).toEqual(["zh-CN", "zh-TW", "en-US"]);
  });

  test("rejects invalid retry payloads before invoking the runner with a fixed safe error", async () => {
    const runner = vi.fn<WorkerCommandRunner>();
    const invalidPayloads: unknown[] = [
      { taskId: TASK_ID, target: "summary" },
      { taskId: TASK_ID, target: "summary", outputLanguage: "system" },
      { taskId: TASK_ID, target: "summary", outputLanguage: "fr-FR" },
      { taskId: "../private", target: "summary", outputLanguage: "en-US" },
      {
        taskId: TASK_ID,
        target: "summary",
        outputLanguage: "en-US",
        preferenceSnapshot: PREFERENCE_SNAPSHOT,
      },
      {
        taskId: TASK_ID,
        target: "insights",
        outputLanguage: "en-US",
        preferenceSnapshot: null,
      },
      {
        taskId: TASK_ID,
        target: "insights",
        outputLanguage: "en-US",
        preferenceSnapshot: "prompt-secret-value",
      },
      {
        taskId: TASK_ID,
        target: "insights",
        outputLanguage: "en-US",
        preferenceSnapshot: new Date("2026-07-15T00:00:00.000Z"),
      },
      {
        taskId: TASK_ID,
        target: "summary",
        outputLanguage: "en-US",
        extra: "request-secret-value",
      },
    ];

    for (const payload of invalidPayloads) {
      const result = await retryInsights(payload as never, runner);
      expect(result.error).toEqual({
        code: "INVALID_RETRY_PAYLOAD",
        message: "",
        stage: "insights_generating",
      });
      expect(JSON.stringify(result)).not.toContain("secret-value");
    }

    expect(runner).not.toHaveBeenCalled();
  });

  test("invokes the Tauri cancel_process command", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: CancelCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { status: "cancelling", error: null };
    };

    const result = await cancelProcess(runner);

    expect(calls).toEqual([{ command: "cancel_process", args: {} }]);
    expect(result).toEqual({ status: "cancelling", error: null });
  });

  test("maps cancel command errors to a structured failed result", async () => {
    const runner: CancelCommandRunner = async () => {
      throw new Error("worker process could not be terminated");
    };

    const result = await cancelProcess(runner);

    expect(result).toEqual({
      status: "failed",
      error: "worker process could not be terminated",
    });
  });

  test("fails closed when process_video returns an open IPC result", async () => {
    const result = await processVideo(
      "https://www.douyin.com/video/7524373044106677544",
      async () => ({ ...completedResult(), secret: "process-result-secret" }),
    );

    expect(result).toEqual({
      status: "failed",
      task_id: null,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      dissection_source_status: null,
      error: {
        code: "WORKER_PROTOCOL_VIOLATION",
        message: "",
        stage: "video_extracting",
      },
    });
    expect(JSON.stringify(result)).not.toContain("process-result-secret");
  });

  test("fails closed with retry context when retry_insights returns an open IPC result", async () => {
    const result = await retryInsights(
      { taskId: TASK_ID, target: "summary", outputLanguage: "en-US" },
      async () => ({ ...completedResult(), secret: "retry-result-secret" }),
    );

    expect(result).toEqual({
      status: "partial_completed",
      task_id: TASK_ID,
      task_dir: null,
      artifacts: {},
      text: "",
      summary: "",
      insights: [],
      transcript: null,
      dissection: null,
      dissection_source_status: null,
      error: {
        code: "WORKER_PROTOCOL_VIOLATION",
        message: "",
        stage: "insights_generating",
      },
    });
    expect(JSON.stringify(result)).not.toContain("retry-result-secret");
  });

  test("fails closed when cancel_process returns an open IPC result", async () => {
    const result = await cancelProcess(async () => ({
      status: "cancelling",
      error: null,
      secret: "cancel-result-secret",
    }));

    expect(result).toEqual({
      status: "failed",
      error: "INVALID_CANCEL_PROCESS_RESPONSE",
    });
    expect(JSON.stringify(result)).not.toContain("cancel-result-secret");
  });
});
