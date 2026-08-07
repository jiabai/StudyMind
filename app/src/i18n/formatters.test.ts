import { describe, expect, test } from "vitest";
import {
  countTextUnits,
  formatBytes,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatWordCount,
  formatTextUnitCount,
  selectPluralCategory,
} from "./formatters";

describe("locale-aware formatters", () => {
  test("formats dates, numbers, and percentages with the selected locale", () => {
    const instant = new Date("2026-07-15T08:09:10.000Z");
    expect(formatDateTime(instant, "zh-TW", { timeZone: "UTC" })).toBe(
      new Intl.DateTimeFormat("zh-TW", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(instant),
    );
    expect(formatNumber(1234567.89, "en-US")).toBe("1,234,567.89");
    expect(formatNumber(1234567.89, "zh-CN")).toBe("1,234,567.89");
    expect(formatPercent(0.375, "en-US")).toBe("38%");
  });

  test("accepts granular date fields without mixing them with style defaults", () => {
    const instant = new Date("2026-07-15T08:09:10.000Z");
    expect(
      formatDateTime(instant, "en-US", { year: "numeric", timeZone: "UTC" }),
    ).toBe(
      new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        timeZone: "UTC",
      }).format(instant),
    );
  });

  test("formats byte sizes with localized numbers and stable units", () => {
    expect(formatBytes(0, "en-US")).toBe("0 B");
    expect(formatBytes(1536, "en-US")).toBe("1.5 KB");
    expect(formatBytes(1536, "zh-CN")).toBe("1.5 KB");
    expect(formatBytes(-1, "en-US")).toBe("0 B");
  });

  test("selects locale-aware word-count plural copy", () => {
    expect(formatWordCount(1, "en-US")).toBe("1 word");
    expect(formatWordCount(2, "en-US")).toBe("2 words");
    expect(formatWordCount(2, "zh-CN")).toBe("2 字");
    expect(formatWordCount(2, "zh-TW")).toBe("2 字");
  });

  test("counts real English words instead of UTF-16 characters", () => {
    expect(countTextUnits("hello world", "en-US")).toBe(2);
    expect(formatTextUnitCount("hello world", "en-US")).toBe("2 words");
    expect(formatTextUnitCount("hello", "en-US")).toBe("1 word");
    expect(formatTextUnitCount("hello world", "en-US")).not.toBe("11 words");
  });

  test("counts non-whitespace Unicode characters for Chinese text", () => {
    expect(countTextUnits("你 好\n世界", "zh-CN")).toBe(4);
    expect(formatTextUnitCount("你 好\n世界", "zh-CN")).toBe("4 字");
    expect(formatTextUnitCount("測 試", "zh-TW")).toBe("2 字");
  });

  test("exposes the actual locale plural category for other counted copy", () => {
    expect(selectPluralCategory(1, "en-US")).toBe("one");
    expect(selectPluralCategory(2, "en-US")).toBe("other");
    expect(selectPluralCategory(1, "zh-CN")).toBe("other");
  });
});
