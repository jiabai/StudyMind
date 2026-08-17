import { describe, expect, test } from "vitest";
import {
  ASR_MODEL_DOWNLOAD_PROGRESS_EVENT,
  cancelAsrModelDownload,
  clearAudioReviewCache,
  downloadAsrModel,
  getAudioReviewCacheUsage,
  getAsrModelStatus,
  getUiPreferences,
  getLlmConfig,
  saveRecordingAudioSourceMode,
  saveUiPreferences,
  saveLlmConfig,
  type SettingsCommandRunner,
} from "./settingsClient";
import { IpcProtocolError } from "./tauriIpcProtocol";

describe("settings client", () => {
  test("loads selected ASR model status from Tauri", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        user_data_dir: "C:\\Users\\demo\\AppData\\Local\\StudyMind",
        default_output_dir: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\outputs",
        asr_model: "iic/SenseVoiceSmall",
        asr_model_dir: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\models",
        asr_model_available: false,
        asr_model_source: "modelscope",
      };
    };

    const status = await getAsrModelStatus(runner);

    expect(calls).toEqual([
      {
        command: "get_asr_model_status",
        args: { asrModel: "iic/SenseVoiceSmall" },
      },
    ]);
    expect(status).toEqual({
      userDataDir: "C:\\Users\\demo\\AppData\\Local\\StudyMind",
      defaultOutputDir: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\outputs",
      asrModel: "iic/SenseVoiceSmall",
      asrModelDir: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\models",
      asrModelAvailable: false,
      asrModelSource: "modelscope",
    });
  });

  test("starts and cancels ASR model download through Tauri", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "download_asr_model") {
        return { started: true, status: "completed" };
      }
      return { status: "cancelling", error: null };
    };

    await expect(downloadAsrModel(runner)).resolves.toEqual({
      started: true,
      status: "completed",
    });
    await expect(cancelAsrModelDownload(runner)).resolves.toEqual({
      status: "cancelling",
      error: null,
    });

    expect(calls).toEqual([
      {
        command: "download_asr_model",
        args: { asrModel: "iic/SenseVoiceSmall" },
      },
      { command: "cancel_asr_model_download", args: {} },
    ]);
    expect(ASR_MODEL_DOWNLOAD_PROGRESS_EVENT).toBe("asr-model-download-progress");
  });

  test.each([
    { started: false, status: "completed", secret: "model-result-secret" },
    { started: true, status: "cancelled" },
    { started: false, status: "already_available", extra: true },
  ])("rejects malformed model-download responses without echoing payloads", async (payload) => {
    const runner: SettingsCommandRunner = async () => payload;

    await expect(downloadAsrModel(runner)).rejects.toThrow(
      "INVALID_ASR_MODEL_DOWNLOAD_RESPONSE",
    );
  });

  test.each([
    { status: "cancelling", error: "unexpected", secret: "cancel-result-secret" },
    { status: "failed", error: null },
    { status: "not_running", error: null, extra: true },
  ])("rejects malformed model-cancel responses without echoing payloads", async (payload) => {
    const runner: SettingsCommandRunner = async () => payload;

    await expect(cancelAsrModelDownload(runner)).rejects.toThrow(
      "INVALID_CANCEL_PROCESS_RESPONSE",
    );
  });

  test("loads app settings without LLM config from Tauri", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        output_dir: "D:\\StudyMind\\outputs",
        asr_model: "iic/SenseVoiceSmall",
        supported_asr_models: ["iic/SenseVoiceSmall"],
        config_path: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\.env",
      };
    };

    const config = await getLlmConfig(runner);

    expect(calls).toEqual([{ command: "get_llm_config", args: {} }]);
    expect(config).toEqual({
      outputDir: "D:\\StudyMind\\outputs",
      asrModel: "iic/SenseVoiceSmall",
      supportedAsrModels: ["iic/SenseVoiceSmall"],
      configPath: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\.env",
    });
  });

  test("saves app settings without LLM fields through Tauri", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        output_dir: "D:\\StudyMind\\outputs",
        asr_model: "Qwen/Qwen3-ASR-0.6B",
        supported_asr_models: ["iic/SenseVoiceSmall"],
        config_path: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\.env",
      };
    };

    const config = await saveLlmConfig(
      {
        outputDir: "D:\\StudyMind\\outputs",
        asrModel: "Qwen/Qwen3-ASR-0.6B",
      },
      runner,
    );

    expect(calls).toEqual([
      {
        command: "save_llm_config",
        args: {
          config: {
            output_dir: "D:\\StudyMind\\outputs",
            asr_model: "Qwen/Qwen3-ASR-0.6B",
          },
        },
      },
    ]);
    expect(config).toMatchObject({
      outputDir: "D:\\StudyMind\\outputs",
      configPath: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\.env",
    });
  });

  test("loads and clears audio review cache usage through Tauri", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "get_audio_review_cache_usage") {
        return {
          size_bytes: 1_572_864,
          cache_path: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\cache\\.StudyMind-audio-review",
        };
      }
      return {
        size_bytes: 0,
        cache_path: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\cache\\.StudyMind-audio-review",
      };
    };

    await expect(getAudioReviewCacheUsage(runner)).resolves.toEqual({
      sizeBytes: 1_572_864,
      cachePath: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\cache\\.StudyMind-audio-review",
    });
    await expect(clearAudioReviewCache(runner)).resolves.toEqual({
      sizeBytes: 0,
      cachePath: "C:\\Users\\demo\\AppData\\Local\\StudyMind\\cache\\.StudyMind-audio-review",
    });

    expect(calls).toEqual([
      { command: "get_audio_review_cache_usage", args: {} },
      { command: "clear_audio_review_cache", args: {} },
    ]);
  });

  test("rejects malformed runtime settings and model arrays", async () => {
    await expect(
      getLlmConfig(async () => ({
        output_dir: "D:\\StudyMind\\outputs",
        asr_model: "iic/SenseVoiceSmall",
        supported_asr_models: ["iic/SenseVoiceSmall", 42],
        config_path: "C:\\Users\\private\\StudyMind\\.env",
      })),
    ).rejects.toEqual(
      new IpcProtocolError("SETTINGS_IPC_RESPONSE_INVALID"),
    );
    await expect(
      saveLlmConfig(
        { outputDir: "", asrModel: "iic/SenseVoiceSmall" },
        async () => ({
          output_dir: "",
          asr_model: "iic/SenseVoiceSmall",
          supported_asr_models: [],
          config_path: "C:\\Users\\private\\StudyMind\\.env",
          unexpected: true,
        }),
      ),
    ).rejects.toEqual(
      new IpcProtocolError("SETTINGS_IPC_RESPONSE_INVALID"),
    );
  });

  test("rejects malformed audio cache usage and model-status responses", async () => {
    await expect(
      getAudioReviewCacheUsage(async () => ({
        size_bytes: -1,
        cache_path: "C:\\Users\\private\\cache",
      })),
    ).rejects.toEqual(
      new IpcProtocolError("SETTINGS_IPC_RESPONSE_INVALID"),
    );
    await expect(
      getAsrModelStatus(async () => ({
        user_data_dir: "C:\\Users\\private\\StudyMind",
        default_output_dir: "C:\\Users\\private\\StudyMind\\outputs",
        asr_model: "iic/SenseVoiceSmall",
        asr_model_dir: "C:\\Users\\private\\StudyMind\\models",
        asr_model_available: "false",
        asr_model_source: "modelscope",
      })),
    ).rejects.toEqual(
      new IpcProtocolError("SETTINGS_IPC_RESPONSE_INVALID"),
    );
  });

  test("maps Tauri errors to settings errors", async () => {
    const runner: SettingsCommandRunner = async () => {
      throw new Error("Unsupported ASR model");
    };

    await expect(saveLlmConfig({ outputDir: "", asrModel: "iic/SenseVoiceSmall" }, runner)).rejects.toThrow(
      "Unsupported ASR model",
    );
  });

  test("strictly loads and maps UI preferences from Tauri", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        schemaVersion: 2,
        language: "zh-TW",
        recording: { audioSourceMode: "mixed" },
        recovered: false,
      };
    };

    await expect(getUiPreferences(runner)).resolves.toEqual({
      schemaVersion: 2,
      language: "zh-TW",
      recording: { audioSourceMode: "mixed" },
      recovered: false,
    });
    expect(calls).toEqual([{ command: "get_ui_preferences", args: {} }]);
  });

  test("saves only the UI language preference through the exact command envelope", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        schemaVersion: 2,
        language: "system",
        recording: { audioSourceMode: "mic" },
        recovered: false,
      };
    };

    await expect(saveUiPreferences("system", runner)).resolves.toEqual({
      schemaVersion: 2,
      language: "system",
      recording: { audioSourceMode: "mic" },
      recovered: false,
    });
    expect(calls).toEqual([
      {
        command: "save_ui_preferences",
        args: { preferences: { language: "system" } },
      },
    ]);
  });

  test("saves only the recording audio source mode through the exact command envelope", async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const runner: SettingsCommandRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        schemaVersion: 2,
        language: "zh-CN",
        recording: { audioSourceMode: "system" },
        recovered: false,
      };
    };

    await expect(saveRecordingAudioSourceMode("system", runner)).resolves.toEqual({
      schemaVersion: 2,
      language: "zh-CN",
      recording: { audioSourceMode: "system" },
      recovered: false,
    });
    expect(calls).toEqual([
      {
        command: "save_ui_preferences",
        args: {
          preferences: { recording: { audioSourceMode: "system" } },
        },
      },
    ]);
  });

  test.each([
    null,
    {},
    { schemaVersion: 1, language: "system", recording: { audioSourceMode: "mic" }, recovered: false },
    { schemaVersion: 2, language: "fr-FR", recording: { audioSourceMode: "mic" }, recovered: false },
    { schemaVersion: 2, language: "system", recovered: false },
    { schemaVersion: 2, language: "system", recording: "mic", recovered: false },
    { schemaVersion: 2, language: "system", recording: { audioSourceMode: "bluetooth" }, recovered: false },
    { schemaVersion: 2, language: "system", recording: { audioSourceMode: "mic", extra: true }, recovered: false },
    { schemaVersion: 2, language: "system", recording: { audioSourceMode: "mic" }, recovered: "false" },
    { schemaVersion: 2, language: "system", recording: { audioSourceMode: "mic" }, recovered: false, extra: true },
  ])("rejects malformed UI preference responses without echoing payloads", async (payload) => {
    const runner: SettingsCommandRunner = async () => payload;
    await expect(getUiPreferences(runner)).rejects.toThrow(
      "INVALID_UI_PREFERENCES_RESPONSE",
    );
  });

  test("does not evaluate accessor-backed UI preferences", async () => {
    let getterCalls = 0;
    const response = {
      schemaVersion: 2,
      language: "system",
      recording: Object.defineProperty({}, "audioSourceMode", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "mic";
        },
      }),
      recovered: false,
    };

    await expect(getUiPreferences(async () => response)).rejects.toThrow(
      "INVALID_UI_PREFERENCES_RESPONSE",
    );
    expect(getterCalls).toBe(0);
  });

  test("browser mock preserves the other UI preference during partial saves", async () => {
    await expect(saveRecordingAudioSourceMode("system")).resolves.toMatchObject({
      schemaVersion: 2,
      language: "en-US",
      recording: { audioSourceMode: "system" },
      recovered: false,
    });
    await expect(saveUiPreferences("zh-TW")).resolves.toMatchObject({
      schemaVersion: 2,
      language: "zh-TW",
      recording: { audioSourceMode: "system" },
      recovered: false,
    });

    await saveUiPreferences("en-US");
    await saveRecordingAudioSourceMode("mic");
  });

  test("uses an immediate in-memory UI-preferences mock outside Tauri", async () => {
    await expect(getUiPreferences()).resolves.toMatchObject({
      schemaVersion: 2,
      language: "en-US",
      recording: { audioSourceMode: "mic" },
      recovered: false,
    });
  });
});
