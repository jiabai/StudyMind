import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type {
  AsrModelDownloadWireStatus,
  ProgressMessageDescriptor,
} from "./desktopWorkerProtocol";
import { isLanguagePreference, type LanguagePreference } from "./i18n/locale";
import type { AsrModelDownloadLocalPhase } from "./modelDownloadState";
import {
  IpcProtocolError,
  readIpcDataArray,
  readIpcDataObject,
} from "./tauriIpcProtocol";
import {
  parseAsrModelDownloadResult,
  parseCancelProcessResult,
  type AsrModelDownloadResult,
  type CancelProcessResult,
} from "./workerResultProtocol";

export {
  ASR_MODEL_DOWNLOAD_PROGRESS_EVENT,
  parseAsrModelDownloadProgressEvent,
} from "./desktopWorkerProtocol";
export type { AsrModelDownloadResult, CancelProcessResult } from "./workerResultProtocol";

export type LlmConfig = {
  outputDir: string;
  asrModel: string;
  supportedAsrModels: string[];
  configPath: string;
};

export type LlmConfigDraft = {
  outputDir: string;
  asrModel: string;
};

export type AsrModelStatusResponseView = {
  userDataDir: string;
  defaultOutputDir: string;
  asrModel: string;
  asrModelDir: string;
  asrModelAvailable: boolean;
  asrModelSource: string;
};

export type AsrModelStatusResponse = {
  user_data_dir: string;
  default_output_dir: string;
  asr_model: string;
  asr_model_dir: string;
  asr_model_available: boolean;
  asr_model_source: string;
};

export type CancelAsrModelDownloadResult = CancelProcessResult;

export type AsrModelDownloadProgress = {
  phase: AsrModelDownloadLocalPhase;
  wireStatus: AsrModelDownloadWireStatus | null;
  message: ProgressMessageDescriptor | null;
  progress: number;
  currentFile?: string;
};

export type LlmConfigResponse = {
  output_dir: string;
  asr_model: string;
  supported_asr_models: string[];
  config_path: string;
};

export type AudioReviewCacheUsage = {
  sizeBytes: number;
  cachePath: string;
};

export type AudioReviewCacheUsageResponse = {
  size_bytes: number;
  cache_path: string;
};

export type SettingsCommandRunner = (
  command: string,
  args: InvokeArgs,
) => Promise<unknown>;

export type UiPreferencesView = {
  schemaVersion: 1;
  language: LanguagePreference;
  recovered: boolean;
};

const defaultSettingsRunner: SettingsCommandRunner = (command, args) => invoke(command, args);
const SETTINGS_IPC_RESPONSE_INVALID = "SETTINGS_IPC_RESPONSE_INVALID" as const;
let browserUiPreferences: UiPreferencesView = {
  schemaVersion: 1,
  language: "en-US",
  recovered: false,
};

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

const defaultUiPreferencesRunner: SettingsCommandRunner = async (command, args) => {
  if (hasTauriRuntime()) {
    return invoke(command, args);
  }

  if (command === "get_ui_preferences") {
    return { ...browserUiPreferences };
  }
  if (command === "save_ui_preferences") {
    const language = (args as { preferences?: { language?: unknown } }).preferences?.language;
    if (!isLanguagePreference(language)) {
      throw new Error("INVALID_UI_PREFERENCES_REQUEST");
    }
    browserUiPreferences = { schemaVersion: 1, language, recovered: false };
    return { ...browserUiPreferences };
  }
  throw new Error("UNSUPPORTED_UI_PREFERENCES_COMMAND");
};

export async function getUiPreferences(
  runner: SettingsCommandRunner = defaultUiPreferencesRunner,
): Promise<UiPreferencesView> {
  return mapUiPreferencesResponse(await runner("get_ui_preferences", {}));
}

export async function saveUiPreferences(
  language: LanguagePreference,
  runner: SettingsCommandRunner = defaultUiPreferencesRunner,
): Promise<UiPreferencesView> {
  return mapUiPreferencesResponse(
    await runner("save_ui_preferences", { preferences: { language } }),
  );
}

export async function getLlmConfig(
  runner: SettingsCommandRunner = defaultSettingsRunner,
): Promise<LlmConfig> {
  return mapLlmConfigResponse(
    parseLlmConfigResponse(await runner("get_llm_config", {})),
  );
}

export async function saveLlmConfig(
  draft: LlmConfigDraft,
  runner: SettingsCommandRunner = defaultSettingsRunner,
): Promise<LlmConfig> {
  return mapLlmConfigResponse(
    parseLlmConfigResponse(
      await runner("save_llm_config", {
        config: {
          output_dir: draft.outputDir,
          asr_model: draft.asrModel,
        },
      }),
    ),
  );
}

export async function getAudioReviewCacheUsage(
  runner: SettingsCommandRunner = defaultSettingsRunner,
): Promise<AudioReviewCacheUsage> {
  return mapAudioReviewCacheUsageResponse(
    parseAudioReviewCacheUsageResponse(
      await runner("get_audio_review_cache_usage", {}),
    ),
  );
}

export async function clearAudioReviewCache(
  runner: SettingsCommandRunner = defaultSettingsRunner,
): Promise<AudioReviewCacheUsage> {
  return mapAudioReviewCacheUsageResponse(
    parseAudioReviewCacheUsageResponse(
      await runner("clear_audio_review_cache", {}),
    ),
  );
}

export async function getAsrModelStatus(
  asrModelOrRunner: string | SettingsCommandRunner = "iic/SenseVoiceSmall",
  runner: SettingsCommandRunner = defaultSettingsRunner,
): Promise<AsrModelStatusResponseView> {
  const asrModel =
    typeof asrModelOrRunner === "string" ? asrModelOrRunner : "iic/SenseVoiceSmall";
  const resolvedRunner =
    typeof asrModelOrRunner === "function" ? asrModelOrRunner : runner;
  return mapAsrModelStatusResponse(
    parseAsrModelStatusResponse(
      await resolvedRunner("get_asr_model_status", { asrModel }),
    ),
  );
}

export async function downloadAsrModel(
  asrModelOrRunner: string | SettingsCommandRunner = "iic/SenseVoiceSmall",
  runner: SettingsCommandRunner = defaultSettingsRunner,
): Promise<AsrModelDownloadResult> {
  const asrModel =
    typeof asrModelOrRunner === "string" ? asrModelOrRunner : "iic/SenseVoiceSmall";
  const resolvedRunner =
    typeof asrModelOrRunner === "function" ? asrModelOrRunner : runner;
  const result = parseAsrModelDownloadResult(
    await resolvedRunner("download_asr_model", { asrModel }),
  );
  if (!result) {
    throw new Error("INVALID_ASR_MODEL_DOWNLOAD_RESPONSE");
  }
  return result;
}

export async function cancelAsrModelDownload(
  runner: SettingsCommandRunner = defaultSettingsRunner,
): Promise<CancelAsrModelDownloadResult> {
  const result = parseCancelProcessResult(await runner("cancel_asr_model_download", {}));
  if (!result) {
    throw new Error("INVALID_CANCEL_PROCESS_RESPONSE");
  }
  return result;
}

function mapLlmConfigResponse(response: LlmConfigResponse): LlmConfig {
  return {
    outputDir: response.output_dir,
    asrModel: response.asr_model,
    supportedAsrModels: response.supported_asr_models,
    configPath: response.config_path,
  };
}

function parseLlmConfigResponse(value: unknown): LlmConfigResponse {
  const response = readIpcDataObject(
    value,
    [
      "output_dir",
      "asr_model",
      "supported_asr_models",
      "config_path",
    ],
    [],
    SETTINGS_IPC_RESPONSE_INVALID,
  );
  const supportedAsrModels = readIpcDataArray(
    response.supported_asr_models,
    SETTINGS_IPC_RESPONSE_INVALID,
  );
  if (
    typeof response.output_dir !== "string" ||
    typeof response.asr_model !== "string" ||
    !supportedAsrModels.every((model) => typeof model === "string") ||
    typeof response.config_path !== "string"
  ) {
    throwInvalidSettingsResponse();
  }
  return {
    output_dir: response.output_dir,
    asr_model: response.asr_model,
    supported_asr_models: supportedAsrModels,
    config_path: response.config_path,
  };
}

function parseAsrModelStatusResponse(
  value: unknown,
): AsrModelStatusResponse {
  const response = readIpcDataObject(
    value,
    [
      "user_data_dir",
      "default_output_dir",
      "asr_model",
      "asr_model_dir",
      "asr_model_available",
      "asr_model_source",
    ],
    [],
    SETTINGS_IPC_RESPONSE_INVALID,
  );
  if (
    typeof response.user_data_dir !== "string" ||
    typeof response.default_output_dir !== "string" ||
    typeof response.asr_model !== "string" ||
    typeof response.asr_model_dir !== "string" ||
    typeof response.asr_model_available !== "boolean" ||
    typeof response.asr_model_source !== "string"
  ) {
    throwInvalidSettingsResponse();
  }
  return {
    user_data_dir: response.user_data_dir,
    default_output_dir: response.default_output_dir,
    asr_model: response.asr_model,
    asr_model_dir: response.asr_model_dir,
    asr_model_available: response.asr_model_available,
    asr_model_source: response.asr_model_source,
  };
}

function parseAudioReviewCacheUsageResponse(
  value: unknown,
): AudioReviewCacheUsageResponse {
  const response = readIpcDataObject(
    value,
    ["size_bytes", "cache_path"],
    [],
    SETTINGS_IPC_RESPONSE_INVALID,
  );
  if (
    !isSafeUnsignedInteger(response.size_bytes) ||
    typeof response.cache_path !== "string"
  ) {
    throwInvalidSettingsResponse();
  }
  return {
    size_bytes: response.size_bytes,
    cache_path: response.cache_path,
  };
}

function isSafeUnsignedInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function throwInvalidSettingsResponse(): never {
  throw new IpcProtocolError(SETTINGS_IPC_RESPONSE_INVALID);
}

function mapAsrModelStatusResponse(
  response: AsrModelStatusResponse,
): AsrModelStatusResponseView {
  return {
    userDataDir: response.user_data_dir,
    defaultOutputDir: response.default_output_dir,
    asrModel: response.asr_model,
    asrModelDir: response.asr_model_dir,
    asrModelAvailable: response.asr_model_available,
    asrModelSource: response.asr_model_source,
  };
}

function mapAudioReviewCacheUsageResponse(
  response: AudioReviewCacheUsageResponse,
): AudioReviewCacheUsage {
  return {
    sizeBytes: response.size_bytes,
    cachePath: response.cache_path,
  };
}

function mapUiPreferencesResponse(response: unknown): UiPreferencesView {
  let record: Record<string, unknown>;
  try {
    record = readIpcDataObject(
      response,
      ["schemaVersion", "language", "recovered"],
      [],
      SETTINGS_IPC_RESPONSE_INVALID,
    );
  } catch {
    throw new Error("INVALID_UI_PREFERENCES_RESPONSE");
  }

  if (
    record.schemaVersion !== 1 ||
    !isLanguagePreference(record.language) ||
    typeof record.recovered !== "boolean"
  ) {
    throw new Error("INVALID_UI_PREFERENCES_RESPONSE");
  }

  return {
    schemaVersion: 1,
    language: record.language,
    recovered: record.recovered,
  };
}
