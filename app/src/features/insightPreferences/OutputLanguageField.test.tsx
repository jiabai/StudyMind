import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { OutputLanguageField } from "./OutputLanguageField";

describe("OutputLanguageField", () => {
  test("exposes the actual language in localized confirmation copy", () => {
    const traditionalMarkup = renderToStaticMarkup(
      <OutputLanguageField locale="zh-TW" outputLanguage="zh-TW" />,
    );
    expect(traditionalMarkup).toContain('data-output-language="zh-TW"');
    expect(traditionalMarkup).toContain("本次輸出語言");
    expect(traditionalMarkup).toContain("繁體中文（台灣）");
    expect(traditionalMarkup).not.toContain("system");

    const englishMarkup = renderToStaticMarkup(
      <OutputLanguageField locale="en-US" outputLanguage="en-US" />,
    );
    expect(englishMarkup).toContain('data-output-language="en-US"');
    expect(englishMarkup).toContain("Output language for this run");
    expect(englishMarkup).toContain("English (US)");
  });
});
