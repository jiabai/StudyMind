import { describe, expect, test } from "vitest";
import { asrModelResources } from "./asrModelResources";
import { RESOURCE_NAMESPACES, resources } from "./resources";
import { SUPPORTED_LOCALES } from "./locale";

function flatten(
  value: Record<string, unknown>,
  prefix = "",
): Array<[key: string, value: string]> {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") {
      return [[path, child]];
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      return flatten(child as Record<string, unknown>, path);
    }
    throw new Error(`Invalid resource value at ${path}`);
  });
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+).*?}}/g)]
    .map((match) => match[1])
    .sort();
}

describe("bundled localization resources", () => {
  test("contains the foundational and semantic progress namespaces", () => {
    expect(RESOURCE_NAMESPACES).toEqual([
      "common",
      "settings",
      "bootstrap",
      "progress",
      "preferences",
      "account",
      "history",
      "transcript",
      "asrModel",
      "workflow",
      "synthesis",
      "updates",
      "errors",
      "sidebar",
    ]);
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  test("keeps key, interpolation, and plural parity across all locales", () => {
    const baselineLocale = SUPPORTED_LOCALES[0];

    for (const namespace of RESOURCE_NAMESPACES) {
      const baseline = new Map(flatten(resources[baselineLocale][namespace]));
      const baselineKeys = [...baseline.keys()].sort();

      for (const locale of SUPPORTED_LOCALES.slice(1)) {
        const candidate = new Map(flatten(resources[locale][namespace]));
        expect([...candidate.keys()].sort(), `${locale}.${namespace} key parity`).toEqual(
          baselineKeys,
        );

        for (const key of baselineKeys) {
          expect(
            interpolationTokens(candidate.get(key) ?? ""),
            `${locale}.${namespace}.${key} interpolation parity`,
          ).toEqual(interpolationTokens(baseline.get(key) ?? ""));
        }
      }

      const pluralBases = baselineKeys
        .filter((key) => key.endsWith("_one") || key.endsWith("_other"))
        .map((key) => key.replace(/_(one|other)$/, ""));
      for (const base of new Set(pluralBases)) {
        expect(baselineKeys).toContain(`${base}_one`);
        expect(baselineKeys).toContain(`${base}_other`);
      }
    }
  });

  test("provides the complete transcript notes key set in every locale", () => {
    const expectedKeys = [
      "ariaLabel",
      "title",
      "count",
      "empty",
      "loading",
      "loadError",
      "retry",
      "insert",
      "inserted",
      "edit",
      "delete",
      "blank",
      "orphaned",
      "save",
      "cancel",
      "saving",
      "saveFailed",
      "deleteFailed",
      "contentPlaceholder",
    ].sort();

    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(resources[locale].transcript.notes).sort(), locale).toEqual(
        expectedKeys,
      );
    }
  });

  test("contains no empty strings or inline HTML", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const namespace of RESOURCE_NAMESPACES) {
        for (const [key, value] of flatten(resources[locale][namespace])) {
          expect(value.trim(), `${locale}.${namespace}.${key}`).not.toBe("");
          expect(value, `${locale}.${namespace}.${key}`).not.toMatch(/<\/?[a-z][^>]*>/i);
        }
      }
    }
  });

  test("provides exact localized recovery guidance for model download timeouts", () => {
    expect(asrModelResources).toMatchObject({
      "zh-CN": {
        notice: {
          idleTimeout: "模型下载长时间没有新的进展，已停止。已下载的文件会保留，请稍后重试。",
          executionTimeout: "模型下载已超过最长运行时间，已停止。已下载的文件会保留，请稍后重试。",
        },
      },
      "zh-TW": {
        notice: {
          idleTimeout: "模型下載長時間沒有新的進度，已停止。已下載的檔案會保留，請稍後重試。",
          executionTimeout: "模型下載已超過最長執行時間，已停止。已下載的檔案會保留，請稍後重試。",
        },
      },
      "en-US": {
        notice: {
          idleTimeout: "The model download stopped after making no progress for too long. Downloaded files were kept; try again later.",
          executionTimeout: "The model download reached the maximum run time and was stopped. Downloaded files were kept; try again later.",
        },
      },
    });
  });

  test("provides generic content-free AI generation progress in every locale", () => {
    expect(resources["zh-CN"].progress.worker.ai_generation_running).toBe("正在生成 AI 结果。");
    expect(resources["zh-TW"].progress.worker.ai_generation_running).toBe("正在產生 AI 結果。");
    expect(resources["en-US"].progress.worker.ai_generation_running).toBe(
      "Generating AI results.",
    );
  });
});
