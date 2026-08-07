import { describe, expect, test } from "vitest";

import {
  VIDEO_DOWNLOAD_REASON_MESSAGE_CODES,
  WORKER_ERROR_MESSAGE_CODES,
} from "../workerErrorCopy";
import { errorResources } from "./errorResources";
import { SUPPORTED_LOCALES } from "./locale";

function lookup(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    return (value as Record<string, unknown>)[segment];
  }, tree);
}

describe("localized worker error resources", () => {
  test("covers every registered presentation code in every locale", () => {
    const keys = new Set([
      "generic",
      ...Object.values(WORKER_ERROR_MESSAGE_CODES),
      ...Object.values(VIDEO_DOWNLOAD_REASON_MESSAGE_CODES),
    ]);

    for (const locale of SUPPORTED_LOCALES) {
      for (const key of keys) {
        expect(lookup(errorResources[locale], key), `${locale}: errors.${key}`).toEqual(
          expect.any(String),
        );
      }
    }
  });

  test("provides exact localized recovery guidance for worker timeouts", () => {
    expect(errorResources).toMatchObject({
      "zh-CN": {
        worker: {
          idleTimeout: "处理长时间没有新的进展，StudyMind 已停止本次任务。现有结果已保留，请重试。",
          executionTimeout: "处理已超过最长运行时间，StudyMind 已停止本次任务。现有结果已保留，请重试。",
        },
      },
      "zh-TW": {
        worker: {
          idleTimeout: "處理長時間沒有新的進度，StudyMind 已停止本次工作。現有結果已保留，請重試。",
          executionTimeout: "處理已超過最長執行時間，StudyMind 已停止本次工作。現有結果已保留，請重試。",
        },
      },
      "en-US": {
        worker: {
          idleTimeout: "StudyMind stopped this operation after it made no progress for too long. Existing results were kept; try again.",
          executionTimeout: "StudyMind stopped this operation after it reached the maximum run time. Existing results were kept; try again.",
        },
      },
    });
  });
});
