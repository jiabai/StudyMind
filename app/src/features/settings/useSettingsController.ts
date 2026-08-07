import { type FormEvent, useCallback, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";

import {
  clearAudioReviewCache,
  getAudioReviewCacheUsage,
  getLlmConfig,
  saveLlmConfig,
  type AudioReviewCacheUsage,
  type LlmConfigDraft,
} from "../../settingsClient";
import {
  clearInspirationProfile,
  getInsightPreferences,
  type InsightPreferenceState,
} from "../../insightPreferencesClient";

export type SettingsCategory = "basic" | "inspiration" | "storage" | "updates" | "advanced";

const defaultAsrModels = ["iic/SenseVoiceSmall", "iic/SenseVoiceSmall-onnx"];

export function useSettingsController() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("basic");
  const [settingsDraft, setSettingsDraft] = useState<LlmConfigDraft>({
    outputDir: "",
    asrModel: "iic/SenseVoiceSmall",
  });
  const [settingsSupportedAsrModels, setSettingsSupportedAsrModels] = useState(defaultAsrModels);
  const [settingsConfigPath, setSettingsConfigPath] = useState("");
  const [audioReviewCacheUsage, setAudioReviewCacheUsage] =
    useState<AudioReviewCacheUsage | null>(null);
  const [settingsInsightPreferences, setSettingsInsightPreferences] =
    useState<InsightPreferenceState | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<UiMessage | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const loadSettings = useCallback(async (successNotice?: UiMessage) => {
    setSettingsLoading(true);
    setSettingsNotice(uiMessage("settings.notice.reading"));
    try {
      const [config, audioCacheUsage, insightPreferences] = await Promise.all([
        getLlmConfig(),
        getAudioReviewCacheUsage(),
        getInsightPreferences().catch(() => null),
      ]);
      setSettingsDraft({
        outputDir: config.outputDir,
        asrModel: config.asrModel,
      });
      setSettingsSupportedAsrModels(
        config.supportedAsrModels.length > 0 ? config.supportedAsrModels : defaultAsrModels,
      );
      setSettingsConfigPath(config.configPath);
      setAudioReviewCacheUsage(audioCacheUsage);
      setSettingsInsightPreferences(insightPreferences);
      setSettingsNotice(
        successNotice ??
          (insightPreferences
            ? uiMessage("settings.notice.loadedAll")
            : uiMessage("settings.notice.loadedWithoutPreferences")),
      );
    } catch {
      setSettingsNotice(uiMessage("settings.notice.loadFailed"));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const openSettings = useCallback(async () => {
    setSettingsCategory("basic");
    setSettingsOpen(true);
    await loadSettings();
  }, [loadSettings]);

  const submitSettings = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSettingsSaving(true);
      setSettingsNotice(null);
      try {
        const config = await saveLlmConfig(settingsDraft);
        setSettingsDraft((current) => ({
          ...current,
          outputDir: config.outputDir,
          asrModel: config.asrModel,
        }));
        setSettingsSupportedAsrModels(
          config.supportedAsrModels.length > 0 ? config.supportedAsrModels : defaultAsrModels,
        );
        setSettingsConfigPath(config.configPath);
        setSettingsNotice(uiMessage("settings.notice.saved"));
      } catch {
        setSettingsNotice(uiMessage("settings.notice.saveFailed"));
      } finally {
        setSettingsSaving(false);
      }
    },
    [settingsDraft],
  );

  const updateSettingsDraft = useCallback((field: keyof LlmConfigDraft, value: string) => {
    setSettingsDraft((current) => ({ ...current, [field]: value }));
  }, []);

  const clearAudioReviewCacheFromSettings = useCallback(async () => {
    setSettingsSaving(true);
    setSettingsNotice(null);
    try {
      const usage = await clearAudioReviewCache();
      setAudioReviewCacheUsage(usage);
      setSettingsNotice(uiMessage("settings.notice.cacheCleared"));
    } catch {
      setSettingsNotice(uiMessage("settings.notice.cacheClearFailed"));
    } finally {
      setSettingsSaving(false);
    }
  }, []);

  const locateSettingsConfigFile = useCallback(async () => {
    if (!settingsConfigPath) {
      setSettingsNotice(uiMessage("settings.notice.configPathUnavailable"));
      return;
    }

    try {
      await revealItemInDir(settingsConfigPath);
      setSettingsNotice(uiMessage("settings.notice.configLocated"));
    } catch {
      setSettingsNotice(uiMessage("settings.notice.configLocateFailed"));
    }
  }, [settingsConfigPath]);

  const clearProfileFromSettings = useCallback(async () => {
    setSettingsSaving(true);
    setSettingsNotice(null);
    try {
      const preferences = await clearInspirationProfile();
      setSettingsInsightPreferences(preferences);
      setSettingsNotice(uiMessage("settings.notice.profileCleared"));
    } catch {
      setSettingsNotice(uiMessage("settings.notice.profileClearFailed"));
    } finally {
      setSettingsSaving(false);
    }
  }, []);

  return {
    settingsOpen,
    settingsCategory,
    settingsDraft,
    settingsSupportedAsrModels,
    settingsConfigPath,
    audioReviewCacheUsage,
    settingsInsightPreferences,
    settingsNotice,
    settingsLoading,
    settingsSaving,
    closeSettings,
    openSettings,
    loadSettings,
    submitSettings,
    setSettingsCategory,
    updateSettingsDraft,
    clearAudioReviewCacheFromSettings,
    clearProfileFromSettings,
    locateSettingsConfigFile,
  };
}

export type SettingsController = ReturnType<typeof useSettingsController>;
