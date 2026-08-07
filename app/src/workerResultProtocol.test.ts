import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  TASK_ARTIFACT_KEYS,
  TASK_INSIGHT_FIELDS,
  TASK_RESULT_FIELDS,
  TASK_TERMINAL_STATUSES,
  parseAsrModelDownloadResult,
  parseCancelProcessResult,
  parseWorkerResult,
} from "./workerResultProtocol";
import type { WorkerResult } from "./workflow";

const TASK_ID = "20260719-closed-result";

function validTask(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: "completed",
    task_id: TASK_ID,
    task_dir: "outputs/tasks/20260719-closed-result",
    artifacts: { transcript_txt: "transcript/transcript.txt" },
    text: "transcript",
    summary: "summary",
    insights: [
      {
        id: 1,
        topic: "topic",
        matchReason: "matched",
        followUpQuestions: ["next"],
        suitableUse: "planning",
        sourceChunkId: 0,
      },
    ],
    transcript: { source: "asr", language: "zh-CN", engine: "SenseVoice" },
    dissection: null,
    dissection_source_status: null,
    error: null,
    ...overrides,
  };
}

function invalidTaskFixtures(): unknown[] {
  const missingError = validTask() as unknown as Record<string, unknown>;
  delete missingError.error;

  class TaskEnvelope {
    constructor() {
      Object.assign(this, validTask());
    }
  }

  return [
    null,
    [],
    new Date("2026-07-19T00:00:00.000Z"),
    new TaskEnvelope(),
    missingError,
    { ...validTask(), secret: "top-level-secret" },
    { ...validTask(), status: "running" },
    { ...validTask(), task_id: 123 },
    { ...validTask(), task_dir: false },
    { ...validTask(), text: null },
    { ...validTask(), artifacts: { transcript_txt: "ok", secret: "artifact-secret" } },
    { ...validTask(), artifacts: { transcript_txt: 7 } },
    {
      ...validTask(),
      insights: [{ ...validTask().insights[0], extra: "insight-secret" }],
    },
    { ...validTask(), insights: [{ ...validTask().insights[0], id: -1 }] },
    { ...validTask(), insights: [{ ...validTask().insights[0], id: 1.5 }] },
    {
      ...validTask(),
      insights: [{ ...validTask().insights[0], id: Number.MAX_SAFE_INTEGER + 1 }],
    },
    {
      ...validTask(),
      insights: [{ ...validTask().insights[0], sourceChunkId: -1 }],
    },
    {
      ...validTask(),
      insights: [{ ...validTask().insights[0], followUpQuestions: ["ok", 2] }],
    },
    {
      ...validTask(),
      transcript: { source: "asr", language: null, engine: null, secret: "transcript-secret" },
    },
    { ...validTask(), transcript: { source: "generated", language: null, engine: null } },
    { ...validTask(), transcript: { source: "asr", language: null } },
    {
      ...validTask({ status: "failed" }),
      error: { code: "lowercase", message: "", stage: "failed" },
    },
    {
      ...validTask({ status: "failed" }),
      error: { code: `A${"B".repeat(64)}`, message: "", stage: "failed" },
    },
    {
      ...validTask({ status: "failed" }),
      error: { code: "SAFE_CODE", message: "", stage: "cancelling" },
    },
    {
      ...validTask({ status: "failed" }),
      error: { code: "SAFE_CODE", message: "", stage: "failed", secret: "error-secret" },
    },
    validTask({ status: "completed", error: { code: "SAFE_CODE", message: "", stage: "failed" } }),
    validTask({ status: "partial_completed", error: null }),
    validTask({ status: "failed", error: null }),
    { ...validTask(), dissection_source_status: "unknown" },
    { ...validTask(), dissection_source_status: 0 },
  ];
}

describe("worker result protocol", () => {
  test("accepts all terminal task statuses and a safe unknown error code", () => {
    const completed = parseWorkerResult(validTask());
    const partial = parseWorkerResult(
      validTask({
        status: "partial_completed",
        error: {
          code: "FUTURE_SAFE_CODE_2",
          message: "safe public detail",
          stage: "insights_generating",
        },
      }),
    );
    const failed = parseWorkerResult(
      validTask({
        status: "failed",
        error: { code: "WORKER_PROCESS_FAILED", message: "", stage: "failed" },
      }),
    );

    expect(completed?.status).toBe("completed");
    expect(partial?.error?.code).toBe("FUTURE_SAFE_CODE_2");
    expect(failed?.status).toBe("failed");
  });

  test.each(invalidTaskFixtures())("rejects malformed or open task result %#", (value) => {
    expect(parseWorkerResult(value)).toBeNull();
  });

  test("returns a clean task copy rather than the IPC object", () => {
    const value = validTask();
    const parsed = parseWorkerResult(value);

    expect(parsed).toEqual(value);
    expect(parsed).not.toBe(value);
    expect(parsed?.artifacts).not.toBe(value.artifacts);
    expect(parsed?.insights).not.toBe(value.insights);
    expect(parsed?.insights[0]).not.toBe(value.insights[0]);
    expect(parsed?.transcript).not.toBe(value.transcript);
  });

  test("parses dissection_source_status across current, stale, and omitted states", () => {
    const current = parseWorkerResult(
      validTask({ dissection_source_status: "current" }),
    );
    expect(current?.dissection_source_status).toBe("current");

    const stale = parseWorkerResult(
      validTask({ dissection_source_status: "stale" }),
    );
    expect(stale?.dissection_source_status).toBe("stale");

    // Worker stdout omits the field entirely; the parser must treat it as null.
    const omittedFixture = validTask() as unknown as Record<string, unknown>;
    delete omittedFixture.dissection_source_status;
    const omitted = parseWorkerResult(omittedFixture);
    expect(omitted?.dissection_source_status).toBeNull();
  });

  test("accepts and deeply copies a closed transcript dissection", () => {
    const dissection: NonNullable<WorkerResult["dissection"]> = {
      schemaVersion: 1,
      sourceTranscriptSha256: "a".repeat(64),
      sourceLanguage: "zh-CN",
      sourceChunks: [{ id: 1, startByte: 0, endByte: 6, sha256: "b".repeat(64) }],
      overallNarrative: {
        openingHook: "question",
        structureType: "problem-solution",
        turningPoint: null,
        closingType: "call-to-action",
      },
      segments: [{
        id: 1,
        title: "Opening",
        sourceChunkIds: [1],
        coreClaim: "A claim",
        supportingPoints: ["Evidence"],
        rhetoricalDevices: ["Question"],
        rhythmNote: "Fast",
        reusablePattern: "Question then answer",
        riskFlags: [],
      }],
      highlights: ["Source quote"],
      reusableTemplate: { name: "Template", skeleton: ["One", "Two", "Three"] },
      audienceFit: [{ audience: "Beginners", fit: "high", note: "Accessible" }],
      strengths: ["Clear"],
      weaknesses: ["Brief"],
    };

    const parsed = parseWorkerResult(validTask({ dissection }));

    expect(parsed?.dissection).toEqual(dissection);
    expect(parsed?.dissection).not.toBe(dissection);
    expect(parsed?.dissection?.sourceChunks).not.toBe(dissection.sourceChunks);
    expect(parsed?.dissection?.segments[0]).not.toBe(dissection.segments[0]);
  });

  test("rejects open or malformed transcript dissection payloads", () => {
    const base = {
      schemaVersion: 1,
      sourceTranscriptSha256: "a".repeat(64),
      sourceLanguage: null,
      sourceChunks: [{ id: 1, startByte: 0, endByte: 1, sha256: "b".repeat(64) }],
      overallNarrative: {
        openingHook: null,
        structureType: "linear",
        turningPoint: null,
        closingType: null,
      },
      segments: [{
        id: 1,
        title: "Segment",
        sourceChunkIds: [1],
        coreClaim: "Claim",
        supportingPoints: [],
        rhetoricalDevices: [],
        rhythmNote: "Even",
        reusablePattern: "State and support",
        riskFlags: [],
      }],
      highlights: [],
      reusableTemplate: { name: "Template", skeleton: ["One", "Two", "Three"] },
      audienceFit: [{ audience: "General", fit: "medium", note: "Neutral" }],
      strengths: [],
      weaknesses: [],
    };

    for (const invalid of [
      { ...base, secret: "hidden" },
      { ...base, sourceTranscriptSha256: "not-a-hash" },
      { ...base, highlights: Array.from({ length: 9 }, () => "quote") },
      { ...base, segments: [{ ...base.segments[0], sourceChunkIds: [] }] },
      { ...base, audienceFit: [{ audience: "General", fit: "unknown", note: "No" }] },
    ]) {
      expect(parseWorkerResult(validTask({ dissection: invalid as never }))).toBeNull();
    }
  });

  test("rejects accessors and symbols without evaluating rejected content", () => {
    const accessor = validTask() as unknown as Record<PropertyKey, unknown>;
    let getterRead = false;
    Object.defineProperty(accessor, "status", {
      enumerable: true,
      get() {
        getterRead = true;
        throw new Error("getter-secret");
      },
    });
    const symbolValue = validTask() as unknown as Record<PropertyKey, unknown>;
    symbolValue[Symbol("secret")] = "symbol-secret";

    expect(parseWorkerResult(accessor)).toBeNull();
    expect(getterRead).toBe(false);
    expect(parseWorkerResult(symbolValue)).toBeNull();
  });

  test("accepts only coherent ASR model download results", () => {
    expect(parseAsrModelDownloadResult({ started: true, status: "completed" })).toEqual({
      started: true,
      status: "completed",
    });
    expect(parseAsrModelDownloadResult({ started: false, status: "cancelled" })).toEqual({
      started: false,
      status: "cancelled",
    });
    expect(
      parseAsrModelDownloadResult({ started: false, status: "already_available" }),
    ).toEqual({ started: false, status: "already_available" });

    for (const invalid of [
      null,
      { started: false, status: "completed" },
      { started: true, status: "cancelled" },
      { started: true, status: "already_available" },
      { started: "true", status: "completed" },
      { started: true, status: "completed", model_dir: "C:\\private" },
    ]) {
      expect(parseAsrModelDownloadResult(invalid)).toBeNull();
    }
  });

  test("accepts only exact coherent cancellation results", () => {
    for (const valid of [
      { status: "cancelling", error: null },
      { status: "already_cancelling", error: null },
      { status: "not_running", error: null },
      { status: "failed", error: "Process termination failed." },
    ]) {
      expect(parseCancelProcessResult(valid)).toEqual(valid);
    }

    for (const invalid of [
      null,
      { status: "cancelling" },
      { status: "cancelling", error: "unexpected" },
      { status: "failed", error: null },
      { status: "failed", error: 7 },
      { status: "unknown", error: null },
      { status: "not_running", error: null, secret: "cancel-secret" },
    ]) {
      expect(parseCancelProcessResult(invalid)).toBeNull();
    }
  });

  test("keeps TypeScript task registries synchronized with the canonical contract", () => {
    const contract = JSON.parse(
      readFileSync(
        new URL("../../contracts/desktop-worker-contract.json", import.meta.url),
        "utf-8",
      ),
    ) as {
      terminalResults: {
        schemas: {
          task: {
            required: string[];
            properties: {
              status: { enum: string[] };
              artifacts: { properties: Record<string, unknown> };
              insights: { items: { properties: Record<string, unknown> } };
            };
          };
        };
      };
    };
    const task = contract.terminalResults.schemas.task;

    expect(TASK_RESULT_FIELDS).toEqual(task.required);
    expect(TASK_TERMINAL_STATUSES).toEqual(task.properties.status.enum);
    expect(TASK_ARTIFACT_KEYS).toEqual(Object.keys(task.properties.artifacts.properties));
    expect(TASK_INSIGHT_FIELDS).toEqual(
      Object.keys(task.properties.insights.items.properties),
    );
  });
});
