import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AudioReviewCacheUsage,
  LlmConfig,
  LlmConfigDraft,
} from "../../settingsClient";
import type { InsightPreferenceState } from "../../insightPreferencesClient";
import type { SettingsController } from "./useSettingsController";
import { uiMessage } from "../../i18n/uiMessage";

type StateUpdater<T> = T | ((current: T) => T);

type HookHarness = {
  resetRender: () => void;
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => T;
  useState: <T>(initialValue: T | (() => T)) => [T, (next: StateUpdater<T>) => void];
};

const mocks = vi.hoisted(() => ({
  clearAudioReviewCache: vi.fn<() => Promise<AudioReviewCacheUsage>>(),
  clearInspirationProfile: vi.fn<() => Promise<InsightPreferenceState>>(),
  getAudioReviewCacheUsage: vi.fn<() => Promise<AudioReviewCacheUsage>>(),
  getInsightPreferences: vi.fn<() => Promise<InsightPreferenceState>>(),
  getLlmConfig: vi.fn<() => Promise<LlmConfig>>(),
  revealItemInDir: vi.fn<(path: string) => Promise<void>>(),
  saveLlmConfig: vi.fn<(draft: LlmConfigDraft) => Promise<LlmConfig>>(),
}));

vi.mock("../../settingsClient", () => ({
  clearAudioReviewCache: mocks.clearAudioReviewCache,
  getAudioReviewCacheUsage: mocks.getAudioReviewCacheUsage,
  getLlmConfig: mocks.getLlmConfig,
  saveLlmConfig: mocks.saveLlmConfig,
}));

vi.mock("../../insightPreferencesClient", () => ({
  clearInspirationProfile: mocks.clearInspirationProfile,
  getInsightPreferences: mocks.getInsightPreferences,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: mocks.revealItemInDir,
}));

function createHookHarness(): HookHarness {
  const states: unknown[] = [];
  let cursor = 0;

  return {
    resetRender: () => {
      cursor = 0;
    },
    useCallback: (callback) => callback,
    useState: <T,>(initialValue: T | (() => T)) => {
      const stateIndex = cursor;
      cursor += 1;
      if (states.length <= stateIndex) {
        states[stateIndex] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      const setState = (next: StateUpdater<T>) => {
        states[stateIndex] =
          typeof next === "function"
            ? (next as (current: T) => T)(states[stateIndex] as T)
            : next;
      };
      return [states[stateIndex] as T, setState];
    },
  };
}

function createLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    outputDir: "D:/StudyMind/outputs",
    asrModel: "iic/SenseVoiceSmall",
    supportedAsrModels: ["iic/SenseVoiceSmall", "Qwen/Qwen3-ASR-0.6B"],
    configPath: "D:/StudyMind/app-data/StudyMind-settings.json",
    ...overrides,
  };
}

function createAudioCacheUsage(
  overrides: Partial<AudioReviewCacheUsage> = {},
): AudioReviewCacheUsage {
  return {
    sizeBytes: 4096,
    cachePath: "D:/StudyMind/app-cache/.StudyMind-audio-review",
    ...overrides,
  };
}

function createInsightPreferences(
  overrides: Partial<InsightPreferenceState> = {},
): InsightPreferenceState {
  return {
    profile: null,
    profileSkipped: false,
    profileStatus: "missing",
    profileError: null,
    defaultGenerationPreferences: null,
    legacyGenerationPreferenceSeed: null,
    preferencesPath: "D:/StudyMind/app-data/insight-preferences.json",
    ...overrides,
  };
}

function mockSettingsLoad(options: {
  config?: LlmConfig;
  audioCacheUsage?: AudioReviewCacheUsage;
  insightPreferences?: InsightPreferenceState;
  insightPreferenceError?: Error;
} = {}) {
  const config = options.config ?? createLlmConfig();
  const audioCacheUsage = options.audioCacheUsage ?? createAudioCacheUsage();
  const insightPreferences = options.insightPreferences ?? createInsightPreferences();

  mocks.getLlmConfig.mockResolvedValueOnce(config);
  mocks.getAudioReviewCacheUsage.mockResolvedValueOnce(audioCacheUsage);
  if (options.insightPreferenceError) {
    mocks.getInsightPreferences.mockRejectedValueOnce(options.insightPreferenceError);
  } else {
    mocks.getInsightPreferences.mockResolvedValueOnce(insightPreferences);
  }

  return { audioCacheUsage, config, insightPreferences };
}

async function createController(): Promise<{
  render: () => SettingsController;
}> {
  const harness = createHookHarness();
  vi.doMock("react", () => ({
    useCallback: harness.useCallback,
    useState: harness.useState,
  }));
  const { useSettingsController } = await import("./useSettingsController");

  return {
    render: () => {
      harness.resetRender();
      return useSettingsController();
    },
  };
}

function createSubmitEvent(): Parameters<SettingsController["submitSettings"]>[0] {
  return {
    preventDefault: vi.fn(),
  } as unknown as Parameters<SettingsController["submitSettings"]>[0];
}

describe("useSettingsController", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  });

  test("opens settings and loads config, cache usage, and insight preferences", async () => {
    const { audioCacheUsage, config, insightPreferences } = mockSettingsLoad();
    const { render } = await createController();

    let controller = render();
    expect(controller.settingsOpen).toBe(false);
    expect(controller.settingsLoading).toBe(false);

    const load = controller.openSettings();
    controller = render();
    expect(controller.settingsOpen).toBe(true);
    expect(controller.settingsLoading).toBe(true);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.reading" });

    await load;
    controller = render();
    expect(mocks.getLlmConfig).toHaveBeenCalledTimes(1);
    expect(mocks.getAudioReviewCacheUsage).toHaveBeenCalledTimes(1);
    expect(mocks.getInsightPreferences).toHaveBeenCalledTimes(1);
    expect(controller.settingsOpen).toBe(true);
    expect(controller.settingsLoading).toBe(false);
    expect(controller.settingsDraft).toEqual({
      outputDir: config.outputDir,
      asrModel: config.asrModel,
    });
    expect(controller.settingsSupportedAsrModels).toEqual(config.supportedAsrModels);
    expect(controller.settingsConfigPath).toBe(config.configPath);
    expect(controller.audioReviewCacheUsage).toEqual(audioCacheUsage);
    expect(controller.settingsInsightPreferences).toEqual(insightPreferences);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.loadedAll" });
  });

  test("keeps base settings available when insight preferences fail to load", async () => {
    const { audioCacheUsage, config } = mockSettingsLoad({
      insightPreferenceError: new Error("preferences unavailable"),
    });
    const { render } = await createController();

    let controller = render();
    await controller.openSettings();
    controller = render();

    expect(controller.settingsLoading).toBe(false);
    expect(controller.settingsDraft).toEqual({
      outputDir: config.outputDir,
      asrModel: config.asrModel,
    });
    expect(controller.audioReviewCacheUsage).toEqual(audioCacheUsage);
    expect(controller.settingsInsightPreferences).toBeNull();
    expect(controller.settingsNotice).toEqual({
      messageCode: "settings.notice.loadedWithoutPreferences",
    });
  });

  test("surfaces config load failures and resets loading state", async () => {
    mocks.getLlmConfig.mockRejectedValueOnce(new Error("config unavailable"));
    mocks.getAudioReviewCacheUsage.mockResolvedValueOnce(createAudioCacheUsage());
    mocks.getInsightPreferences.mockResolvedValueOnce(createInsightPreferences());
    const { render } = await createController();

    let controller = render();
    const load = controller.openSettings();
    controller = render();
    expect(controller.settingsOpen).toBe(true);
    expect(controller.settingsLoading).toBe(true);

    await load;
    controller = render();

    expect(controller.settingsLoading).toBe(false);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.loadFailed" });
    expect(JSON.stringify(controller.settingsNotice)).not.toContain("config unavailable");
  });

  test("surfaces audio cache usage load failures and resets loading state", async () => {
    mocks.getLlmConfig.mockResolvedValueOnce(createLlmConfig());
    mocks.getAudioReviewCacheUsage.mockRejectedValueOnce(new Error("cache unavailable"));
    mocks.getInsightPreferences.mockResolvedValueOnce(createInsightPreferences());
    const { render } = await createController();

    let controller = render();
    const load = controller.openSettings();
    controller = render();
    expect(controller.settingsLoading).toBe(true);

    await load;
    controller = render();

    expect(controller.settingsLoading).toBe(false);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.loadFailed" });
  });

  test("uses the provided success notice when settings load succeeds", async () => {
    mockSettingsLoad();
    const { render } = await createController();

    let controller = render();
    const successNotice = uiMessage("settings.notice.saved");
    await controller.loadSettings(successNotice);
    controller = render();

    expect(controller.settingsLoading).toBe(false);
    expect(controller.settingsNotice).toEqual(successNotice);
  });

  test("saves draft settings and refreshes saved config metadata", async () => {
    const savedConfig = createLlmConfig({
      outputDir: "D:/StudyMind/new-output",
      asrModel: "Qwen/Qwen3-ASR-0.6B",
      supportedAsrModels: ["Qwen/Qwen3-ASR-0.6B"],
      configPath: "D:/StudyMind/app-data/new-settings.json",
    });
    mocks.saveLlmConfig.mockResolvedValueOnce(savedConfig);
    const { render } = await createController();

    let controller = render();
    controller.updateSettingsDraft("outputDir", savedConfig.outputDir);
    controller.updateSettingsDraft("asrModel", savedConfig.asrModel);
    controller = render();
    const event = createSubmitEvent();

    await controller.submitSettings(event);
    controller = render();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.saveLlmConfig).toHaveBeenCalledWith({
      outputDir: savedConfig.outputDir,
      asrModel: savedConfig.asrModel,
    });
    expect(controller.settingsSaving).toBe(false);
    expect(controller.settingsDraft).toEqual({
      outputDir: savedConfig.outputDir,
      asrModel: savedConfig.asrModel,
    });
    expect(controller.settingsSupportedAsrModels).toEqual(savedConfig.supportedAsrModels);
    expect(controller.settingsConfigPath).toBe(savedConfig.configPath);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.saved" });
  });

  test("surfaces save failures and resets saving state", async () => {
    mocks.saveLlmConfig.mockRejectedValueOnce(new Error("disk full"));
    const { render } = await createController();

    let controller = render();
    const event = createSubmitEvent();
    const save = controller.submitSettings(event);
    controller = render();
    expect(controller.settingsSaving).toBe(true);

    await save;
    controller = render();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.saveLlmConfig).toHaveBeenCalledTimes(1);
    expect(controller.settingsSaving).toBe(false);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.saveFailed" });
    expect(JSON.stringify(controller.settingsNotice)).not.toContain("disk full");
  });

  test("clears audio review cache and refreshes cache usage", async () => {
    const clearedUsage = createAudioCacheUsage({ sizeBytes: 0 });
    mocks.clearAudioReviewCache.mockResolvedValueOnce(clearedUsage);
    const { render } = await createController();

    let controller = render();
    await controller.clearAudioReviewCacheFromSettings();
    controller = render();

    expect(mocks.clearAudioReviewCache).toHaveBeenCalledTimes(1);
    expect(controller.settingsSaving).toBe(false);
    expect(controller.audioReviewCacheUsage).toEqual(clearedUsage);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.cacheCleared" });
  });

  test("surfaces audio cache clear failures and resets saving state", async () => {
    mocks.clearAudioReviewCache.mockRejectedValueOnce(new Error("permission denied"));
    const { render } = await createController();

    let controller = render();
    const clearCache = controller.clearAudioReviewCacheFromSettings();
    controller = render();
    expect(controller.settingsSaving).toBe(true);

    await clearCache;
    controller = render();

    expect(mocks.clearAudioReviewCache).toHaveBeenCalledTimes(1);
    expect(controller.settingsSaving).toBe(false);
    expect(controller.settingsNotice).toEqual({
      messageCode: "settings.notice.cacheClearFailed",
    });
  });

  test("locates the settings config file when a path is loaded", async () => {
    const { config } = mockSettingsLoad();
    mocks.revealItemInDir.mockResolvedValueOnce();
    const { render } = await createController();

    let controller = render();
    await controller.locateSettingsConfigFile();
    controller = render();
    expect(mocks.revealItemInDir).not.toHaveBeenCalled();
    expect(controller.settingsNotice).toEqual({
      messageCode: "settings.notice.configPathUnavailable",
    });

    await controller.openSettings();
    controller = render();
    await controller.locateSettingsConfigFile();
    controller = render();

    expect(mocks.revealItemInDir).toHaveBeenCalledWith(config.configPath);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.configLocated" });
  });

  test("surfaces settings config locate failures", async () => {
    const { config } = mockSettingsLoad();
    mocks.revealItemInDir.mockRejectedValueOnce(new Error("shell unavailable"));
    const { render } = await createController();

    let controller = render();
    await controller.openSettings();
    controller = render();
    await controller.locateSettingsConfigFile();
    controller = render();

    expect(mocks.revealItemInDir).toHaveBeenCalledWith(config.configPath);
    expect(controller.settingsNotice).toEqual({
      messageCode: "settings.notice.configLocateFailed",
    });
  });

  test("clears inspiration profile from settings and refreshes preference state", async () => {
    const clearedPreferences = createInsightPreferences({
      profileSkipped: false,
      profileStatus: "missing",
      preferencesPath: "D:/StudyMind/app-data/cleared-preferences.json",
    });
    mocks.clearInspirationProfile.mockResolvedValueOnce(clearedPreferences);
    const { render } = await createController();

    let controller = render();
    await controller.clearProfileFromSettings();
    controller = render();

    expect(mocks.clearInspirationProfile).toHaveBeenCalledTimes(1);
    expect(controller.settingsSaving).toBe(false);
    expect(controller.settingsInsightPreferences).toEqual(clearedPreferences);
    expect(controller.settingsNotice).toEqual({ messageCode: "settings.notice.profileCleared" });
  });

  test("surfaces inspiration profile clear failures and resets saving state", async () => {
    mocks.clearInspirationProfile.mockRejectedValueOnce(new Error("profile locked"));
    const { render } = await createController();

    let controller = render();
    const clearProfile = controller.clearProfileFromSettings();
    controller = render();
    expect(controller.settingsSaving).toBe(true);

    await clearProfile;
    controller = render();

    expect(mocks.clearInspirationProfile).toHaveBeenCalledTimes(1);
    expect(controller.settingsSaving).toBe(false);
    expect(controller.settingsNotice).toEqual({
      messageCode: "settings.notice.profileClearFailed",
    });
  });
});
