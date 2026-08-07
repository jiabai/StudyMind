import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { initializeI18n } from "../../i18n/i18n";
import { WorkerErrorNotice } from "./WorkerErrorNotice";

describe("WorkerErrorNotice", () => {
  test("renders localized guidance and only allowlisted technical details", async () => {
    await initializeI18n("zh-CN");
    const secret = "https://secret.example/private?api_key=sk-secret";
    const markup = renderToStaticMarkup(
      <WorkerErrorNotice
        locale="zh-TW"
        error={{
          code: "INSIGHTFLOW_LLM_REQUEST_FAILED",
          message: `HTTP 503 ${secret} C:\\private\\prompt.txt`,
          stage: "insights_generating",
        }}
      />,
    );

    expect(markup).toContain("雲端 LLM 請求失敗");
    expect(markup).toContain("技術詳細資料");
    expect(markup).toContain("INSIGHTFLOW_LLM_REQUEST_FAILED");
    expect(markup).toContain("503");
    expect(markup).not.toContain("open=\"");
    expect(markup).not.toContain(secret);
    expect(markup).not.toContain("private");
    expect(markup).not.toContain("sk-secret");
  });

  test("shows a localized generic explanation with a safe unknown code", async () => {
    await initializeI18n("en-US");
    const markup = renderToStaticMarkup(
      <WorkerErrorNotice
        locale="en-US"
        error={{
          code: "FUTURE_WORKER_FAILURE",
          message: "Cookie=session-secret transcript=private prose",
          stage: "failed",
        }}
      />,
    );

    expect(markup).toContain("The operation failed");
    expect(markup).toContain("FUTURE_WORKER_FAILURE");
    expect(markup).not.toContain("session-secret");
    expect(markup).not.toContain("private prose");
  });
});
