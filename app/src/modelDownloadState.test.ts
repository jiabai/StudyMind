import { describe, expect, test } from "vitest";
import {
  MODEL_DOWNLOAD_STALLED_MS,
  isModelDownloadStalled,
  shouldApplyModelDownloadUpdate,
} from "./modelDownloadState";

describe("model download operation state", () => {
  test("applies updates for the active running operation", () => {
    expect(
      shouldApplyModelDownloadUpdate({
        operationId: 2,
        activeOperationId: 2,
        phase: "running",
      }),
    ).toBe(true);
  });

  test("ignores stale operation updates", () => {
    expect(
      shouldApplyModelDownloadUpdate({
        operationId: 1,
        activeOperationId: 2,
        phase: "running",
      }),
    ).toBe(false);
  });

  test("keeps applying matching terminal updates while cancellation is pending", () => {
    expect(
      shouldApplyModelDownloadUpdate({
        operationId: 2,
        activeOperationId: 2,
        phase: "cancelling",
      }),
    ).toBe(true);
  });

  test("ignores updates after a terminal outcome is confirmed", () => {
    expect(
      shouldApplyModelDownloadUpdate({
        operationId: 2,
        activeOperationId: 2,
        phase: "finished",
      }),
    ).toBe(false);
  });

  test("detects active downloads with no recent progress updates", () => {
    expect(
      isModelDownloadStalled({
        active: true,
        lastProgressAtMs: 1_000,
        nowMs: 1_000 + MODEL_DOWNLOAD_STALLED_MS,
      }),
    ).toBe(true);

    expect(
      isModelDownloadStalled({
        active: true,
        lastProgressAtMs: 1_000,
        nowMs: 1_000 + MODEL_DOWNLOAD_STALLED_MS - 1,
      }),
    ).toBe(false);
  });

  test("never reports inactive downloads as stalled", () => {
    expect(
      isModelDownloadStalled({
        active: false,
        lastProgressAtMs: 1_000,
        nowMs: 1_000 + MODEL_DOWNLOAD_STALLED_MS * 2,
      }),
    ).toBe(false);
  });
});
