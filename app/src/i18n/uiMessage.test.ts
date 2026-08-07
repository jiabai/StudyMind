import { describe, expect, test } from "vitest";

import { initializeI18n } from "./i18n";
import { renderUiMessage, uiMessage } from "./uiMessage";

describe("semantic UI messages", () => {
  test("re-renders one descriptor in the requested locale", async () => {
    await initializeI18n("zh-CN");
    const message = uiMessage("bootstrap.preferencesReadFailed");

    expect(renderUiMessage("zh-CN", message)).toContain("无法读取语言偏好");
    expect(renderUiMessage("zh-TW", message)).toContain("無法讀取語言偏好");
    expect(renderUiMessage("en-US", message)).toContain("could not read");
  });

  test("interpolates bounded semantic args without storing rendered copy", async () => {
    await initializeI18n("en-US");
    const message = uiMessage("progress.details.retry", {
      attempt: 2,
      total: 3,
    });

    expect(message).toEqual({
      messageCode: "progress.details.retry",
      args: { attempt: 2, total: 3 },
    });
    expect(renderUiMessage("en-US", message)).toBe("Attempt 2 of 3");
  });

  test("does not render malformed or missing internal message codes", async () => {
    await initializeI18n("en-US");

    expect(
      renderUiMessage("en-US", {
        messageCode: "https://secret.example/private",
        args: {},
      }),
    ).toBe("");
    expect(renderUiMessage("en-US", uiMessage("common.notRegistered"))).toBe("");
  });
});
