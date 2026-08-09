import { describe, expect, test } from "vitest";
import {
  deleteHistoryTask,
  getHistory,
  getHistoryDetail,
  historyItemToWorkerResult,
  type HistoryCommandRunner,
} from "./historyClient";
import { IpcProtocolError } from "./tauriIpcProtocol";
import type { WorkerResult } from "./workflow";

const FIRST_INSIGHT: WorkerResult["insights"][number] = {
  id: 1,
  topic: "第一个话题点",
  matchReason: "第一个匹配理由",
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
const FIRST_DISSECTION: NonNullable<WorkerResult["dissection"]> = {
  schemaVersion: 1,
  sourceTranscriptSha256: "a".repeat(64),
  sourceLanguage: null,
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

describe("history client", () => {
  test("deletes a history task through a task-id-only request", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: HistoryCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { task_id: "task-safe-1", deleted: true };
    };

    const result = await deleteHistoryTask("task-safe-1", runner);

    expect(calls).toEqual([
      {
        command: "delete_history_task",
        args: { request: { task_id: "task-safe-1" } },
      },
    ]);
    expect(result).toEqual({ taskId: "task-safe-1", deleted: true });
  });

  test("loads task history from Tauri and maps result fields", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: HistoryCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return [
        {
          task_id: "task-1",
          id: "task-1",
          created_at: "2026-06-17T10:00:00Z",
          source: {
            kind: "url",
            url: "https://www.douyin.com/video/7646789377271647540",
          },
          status: "completed",
          task_dir: "D:\\StudyMind\\outputs\\tasks\\task-1",
          output_dir: "D:\\StudyMind\\outputs",
          artifacts: {
            video: "media/video.mp4",
            audio: "media/audio.wav",
            transcript_txt: "transcript/transcript.txt",
            transcript_md: "transcript/transcript.md",
            summary: "ai/summary.md",
            mindmap: "ai/mindmap.mmd",
            insights: "ai/insights.json",
          },
          error: null,
          text_preview: "这是一段转写预览",
          insights_count: 2,
        },
      ];
    };

    const history = await getHistory(runner);

    expect(calls).toEqual([{ command: "get_history", args: {} }]);
    expect(history).toEqual([
      {
        taskId: "task-1",
        id: "task-1",
        createdAt: "2026-06-17T10:00:00Z",
        source: {
          kind: "url",
          url: "https://www.douyin.com/video/7646789377271647540",
        },
        status: "completed",
        taskDir: "D:\\StudyMind\\outputs\\tasks\\task-1",
        outputDir: "D:\\StudyMind\\outputs",
        artifacts: {
          video: "media/video.mp4",
          audio: "media/audio.wav",
          transcript_txt: "transcript/transcript.txt",
          transcript_md: "transcript/transcript.md",
          summary: "ai/summary.md",
          mindmap: "ai/mindmap.mmd",
          insights: "ai/insights.json",
        },
        error: null,
        textPreview: "这是一段转写预览",
        insightsCount: 2,
        title: null,
      },
    ]);
  });

  test("loads one history detail only after a task is selected", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner = async (command: string, args: unknown) => {
      calls.push({ command, args });
      return {
        task_id: "task-detail",
        source: {
          kind: "local_file",
          displayName: "Interview.wmv",
          mediaKind: "video",
        },
        status: "completed" as const,
        task_dir: "D:/StudyMind/outputs/tasks/task-detail",
        artifacts: { transcript_txt: "transcript/transcript.txt" },
        error: null,
        text: "selected transcript body",
        summary: "selected summary",
        transcript: null,
        insights: [FIRST_INSIGHT, SECOND_INSIGHT],
        dissection: FIRST_DISSECTION,
        dissection_source_status: "stale",
      };
    };

    const detail = await getHistoryDetail("task-detail", runner);

    expect(calls).toEqual([
      { command: "get_history_detail", args: { request: { task_id: "task-detail" } } },
    ]);
    expect(detail.text).toBe("selected transcript body");
    expect(detail.summary).toBe("selected summary");
    expect(detail.insights).toEqual([FIRST_INSIGHT, SECOND_INSIGHT]);
    expect(detail.dissection).toEqual(FIRST_DISSECTION);
    expect(detail.dissectionStale).toBe(true);
    expect(detail.source).toEqual({
      kind: "local_file",
      displayName: "Interview.wmv",
      mediaKind: "video",
    });
  });

  test("rejects open or unsafe History source variants with a fixed error", async () => {
    const sourcePath = "C:\\Users\\review-secret\\Interview.wmv";
    const runner: HistoryCommandRunner = async () => [
      {
        task_id: "unsafe-task",
        id: "unsafe-task",
        created_at: "2026-07-11T00:00:00Z",
        source: {
          kind: "local_file",
          displayName: "Interview.wmv",
          mediaKind: "video",
          sourcePath,
        },
        status: "completed",
        task_dir: "D:/StudyMind/tasks/unsafe-task",
        output_dir: "D:/StudyMind/outputs",
        artifacts: {},
        error: null,
        text_preview: "",
        insights_count: 0,
      },
    ];

    await expect(getHistory(runner)).rejects.toEqual(
      new IpcProtocolError("HISTORY_IPC_RESPONSE_INVALID"),
    );
  });

  test("rejects malformed History list containers and nested artifacts", async () => {
    await expect(getHistory(async () => ({ items: [] }))).rejects.toEqual(
      new IpcProtocolError("HISTORY_IPC_RESPONSE_INVALID"),
    );

    const secret = "C:\\Users\\private\\task\\transcript.txt";
    let getterCalls = 0;
    const artifacts = Object.defineProperty({}, "transcript_txt", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return secret;
      },
    });
    const runner: HistoryCommandRunner = async () => [
      {
        task_id: "task-unsafe",
        id: "task-unsafe",
        created_at: "2026-07-24T00:00:00Z",
        source: { kind: "url", url: "https://example.com/video/1" },
        status: "completed",
        task_dir: "D:/StudyMind/tasks/task-unsafe",
        output_dir: "D:/StudyMind/outputs",
        artifacts,
        error: null,
        text_preview: "",
        insights_count: 0,
      },
    ];

    await expect(getHistory(runner)).rejects.toEqual(
      new IpcProtocolError("HISTORY_IPC_RESPONSE_INVALID"),
    );
    expect(getterCalls).toBe(0);
    await expect(getHistory(runner)).rejects.not.toThrow(secret);
  });

  test("rejects malformed History detail identity and nested insight data", async () => {
    const detail = {
      task_id: "different-task",
      source: { kind: "url", url: "https://example.com/video/1" },
      status: "completed",
      task_dir: "D:/StudyMind/tasks/different-task",
      artifacts: {},
      error: null,
      text: "private transcript",
      summary: "",
      transcript: null,
      insights: [
        {
          ...FIRST_INSIGHT,
          followUpQuestions: "not-an-array",
        },
      ],
      dissection: null,
      dissection_source_status: null,
    };

    await expect(
      getHistoryDetail("expected-task", async () => detail),
    ).rejects.toEqual(
      new IpcProtocolError("HISTORY_IPC_RESPONSE_INVALID"),
    );
    await expect(
      getHistoryDetail("expected-task", async () => ({
        ...detail,
        task_id: "expected-task",
      })),
    ).rejects.toEqual(
      new IpcProtocolError("HISTORY_IPC_RESPONSE_INVALID"),
    );
  });

  test("rejects malformed History errors, transcripts, and delete results", async () => {
    const baseDetail = {
      task_id: "task-detail",
      source: { kind: "url", url: "https://example.com/video/1" },
      status: "failed",
      task_dir: "D:/StudyMind/tasks/task-detail",
      artifacts: {},
      error: {
        code: "FAILURE",
        message: "safe",
        stage: "not-a-stage",
      },
      text: "",
      summary: "",
      transcript: {
        source: "unknown",
        language: null,
        engine: null,
      },
      insights: [],
      dissection: null,
      dissection_source_status: null,
    };

    await expect(
      getHistoryDetail("task-detail", async () => baseDetail),
    ).rejects.toEqual(
      new IpcProtocolError("HISTORY_IPC_RESPONSE_INVALID"),
    );
    await expect(
      deleteHistoryTask("task-detail", async () => ({
        task_id: "different-task",
        deleted: true,
      })),
    ).rejects.toEqual(
      new IpcProtocolError("HISTORY_IPC_RESPONSE_INVALID"),
    );
  });

  test("converts a history item into a workflow worker result", () => {
    const result = historyItemToWorkerResult({
      taskId: "task-2",
      source: {
        kind: "url",
        url: "https://www.douyin.com/video/7646789377271647540",
      },
      status: "partial_completed",
      taskDir: "D:\\StudyMind\\outputs\\tasks\\task-2",
      artifacts: {
        transcript_txt: "transcript/transcript.txt",
        transcript_md: "transcript/transcript.md",
        summary: "ai/summary.md",
        mindmap: "ai/mindmap.mmd",
      },
      error: {
        code: "INSIGHTFLOW_CONFIG_MISSING",
        message: "LLM configuration is missing.",
        stage: "insights_generating",
      },
      text: "已经完成的文字稿",
      summary: "# 要点总结",
      transcript: {
        source: "asr",
        language: null,
        engine: "iic/SenseVoiceSmall",
      },
      insights: [],
      dissection: null,
      dissectionStale: false,
      title: null,
    });

    expect(result).toEqual({
      status: "partial_completed",
      task_id: "task-2",
      task_dir: "D:\\StudyMind\\outputs\\tasks\\task-2",
      artifacts: {
        transcript_txt: "transcript/transcript.txt",
        transcript_md: "transcript/transcript.md",
        summary: "ai/summary.md",
        mindmap: "ai/mindmap.mmd",
      },
      text: "已经完成的文字稿",
      summary: "# 要点总结",
      transcript: {
        source: "asr",
        language: null,
        engine: "iic/SenseVoiceSmall",
      },
      insights: [],
      dissection: null,
      dissection_source_status: null,
      error: {
        code: "INSIGHTFLOW_CONFIG_MISSING",
        message: "LLM configuration is missing.",
        stage: "insights_generating",
      },
    });
  });
});
