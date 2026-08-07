import { beforeAll, describe, expect, test } from "vitest";

import {
  ASR_MODEL_DOWNLOAD_MESSAGE_CODE_RULES,
  WORKER_MESSAGE_CODE_RULES,
  type ProgressMessageDescriptor,
} from "../desktopWorkerProtocol";
import { initializeI18n } from "./i18n";
import { SUPPORTED_LOCALES } from "./locale";
import {
  renderAsrModelDownloadMessage,
  renderWorkerProgressMessage,
} from "./progressMessages";

beforeAll(async () => {
  await initializeI18n("zh-CN");
});

describe("semantic progress message rendering", () => {
  test("renders every registered worker and model code in all three locales", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const messageCode of Object.keys(WORKER_MESSAGE_CODE_RULES)) {
        const rendered = renderWorkerProgressMessage(
          locale,
          "video_extracting",
          { messageCode, args: {} },
        );
        expect(rendered.trim(), `${locale}:${messageCode}`).not.toBe("");
        expect(rendered).not.toContain(messageCode);
      }
      for (const [messageCode, rule] of Object.entries(
        ASR_MODEL_DOWNLOAD_MESSAGE_CODE_RULES,
      )) {
        const rendered = renderAsrModelDownloadMessage(locale, {
          phase: rule.status === "cancelled" ? "cancelled" : "running",
          wireStatus: rule.status,
          message: { messageCode, args: {} },
        });
        expect(rendered.trim(), `${locale}:${messageCode}`).not.toBe("");
        expect(rendered).not.toContain(messageCode);
      }
    }
  });

  test("re-renders the same stored semantic progress after a locale switch", () => {
    const message: ProgressMessageDescriptor = {
      messageCode: "douyin.stream.retrying",
      args: { attempt: 2, total: 3 },
    };

    const simplified = renderWorkerProgressMessage(
      "zh-CN",
      "video_extracting",
      message,
    );
    const traditional = renderWorkerProgressMessage(
      "zh-TW",
      "video_extracting",
      message,
    );
    const english = renderWorkerProgressMessage("en-US", "video_extracting", message);

    expect(new Set([simplified, traditional, english]).size).toBe(3);
    expect(simplified).toContain("2");
    expect(traditional).toContain("2");
    expect(english).toContain("2");
  });

  test.each([
    ["local.media.validating", "Validating the local media file."],
    ["local.video.copying", "Copying the local video file."],
    ["local.audio.normalizing", "Normalizing the local audio."],
  ])("renders local-media code %s as user copy instead of an i18n key", (messageCode, expected) => {
    expect(
      renderWorkerProgressMessage("en-US", "video_extracting", {
        messageCode,
        args: {},
      }),
    ).toBe(expected);
  });

  test("uses localized stage/status fallback for safe unknown codes without raw prose", () => {
    const workerMessage: ProgressMessageDescriptor = {
      messageCode: "future.action.running",
      args: {},
    };
    expect(
      renderWorkerProgressMessage("en-US", "video_transcribing", workerMessage),
    ).toBe("Transcribing audio locally.");
    expect(
      renderAsrModelDownloadMessage("zh-TW", {
        phase: "running",
        wireStatus: "extracting",
        message: { messageCode: "future.model.extracting", args: {} },
      }),
    ).toBe("正在解壓縮 ASR 模型檔案。");
    expect(workerMessage.messageCode).toBe("future.action.running");
  });

  test("local cancelling and failed phases override an older downloading wire status", () => {
    expect(
      renderAsrModelDownloadMessage("en-US", {
        phase: "cancelling",
        wireStatus: "downloading",
        message: { messageCode: "model.cancel.requested", args: {} },
      }),
    ).toBe("Cancelling the ASR model download.");
    expect(
      renderAsrModelDownloadMessage("en-US", {
        phase: "failed",
        wireStatus: "downloading",
        message: { messageCode: "model.download.failed", args: {} },
      }),
    ).toBe("The ASR model download failed.");
  });
});
