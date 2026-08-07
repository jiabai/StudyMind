import { type Dispatch, type SetStateAction, useCallback, useState } from "react";

import {
  canGenerateAiWithAccount,
  type AccountStatus,
} from "../../accountState";
import {
  buildPreferenceSnapshot,
  type GenerationPreferences,
  type InspirationProfile,
  type PreferenceSnapshot,
} from "../../insightPreferences";
import {
  createInsightPreferenceFlow,
  skipProfileSetupInFlow,
  startGenerationPreferenceEditing,
  startProfileSetupInFlow,
  type InsightPreferenceFlowState,
} from "../../insightPreferenceFlow";
import {
  getInsightPreferences,
  saveDefaultGenerationPreferences,
  saveInspirationProfile,
  skipInspirationProfile,
} from "../../insightPreferencesClient";
import type { InsightRetryTarget, WorkflowState } from "../../workflow";
import type { SupportedLocale } from "../../i18n/locale";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";

type OpenAccountPanel = (notice?: UiMessage) => void;
type RetryInsightGeneration = (
  target: InsightRetryTarget,
  outputLanguage: SupportedLocale,
  preferenceSnapshot: PreferenceSnapshot | null,
  account: AccountStatus,
  openAccountPanel: OpenAccountPanel,
  onRetryCompleted?: () => void,
) => Promise<void>;

type UseInsightGenerationControllerOptions = {
  workflow: WorkflowState;
  account: AccountStatus;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
  closeSettings: () => void;
  closeDetail: () => void;
  openAccountPanel: OpenAccountPanel;
  refreshAccountStatus: () => Promise<void>;
  outputLanguage: SupportedLocale;
  retryInsightGeneration: RetryInsightGeneration;
  aiBlockerMessage: (account: AccountStatus) => UiMessage;
};

export function useInsightGenerationController({
  workflow,
  account,
  setActionNotice,
  closeSettings,
  closeDetail,
  openAccountPanel,
  refreshAccountStatus,
  outputLanguage,
  retryInsightGeneration,
  aiBlockerMessage,
}: UseInsightGenerationControllerOptions) {
  const [summaryConfirmOpen, setSummaryConfirmOpen] = useState(false);
  const [insightPreferenceFlow, setInsightPreferenceFlow] =
    useState<InsightPreferenceFlowState | null>(null);
  const [insightPreferenceBusy, setInsightPreferenceBusy] = useState(false);
  const [confirmedOutputLanguage, setConfirmedOutputLanguage] =
    useState<SupportedLocale | null>(null);
  const [aiActionNotice, setAiActionNotice] = useState<UiMessage | null>(null);
  const reportAiNotice = useCallback(
    (notice: UiMessage | null) => {
      setAiActionNotice(notice);
      setActionNotice(notice);
    },
    [setActionNotice],
  );

  const closeSummaryConfirmation = useCallback(() => {
    setSummaryConfirmOpen(false);
  }, []);

  const closeInsightPreferenceFlow = useCallback(() => {
    setInsightPreferenceFlow(null);
    setConfirmedOutputLanguage(null);
  }, []);

  const resetInsightGenerationUi = useCallback(() => {
    setSummaryConfirmOpen(false);
    setInsightPreferenceFlow(null);
    setConfirmedOutputLanguage(null);
    reportAiNotice(null);
  }, [reportAiNotice]);

  const openInsightPreferenceFlow = useCallback(async () => {
    if (!workflow.taskId || !workflow.artifacts.transcript_txt) {
      reportAiNotice(uiMessage("preferences.notice.transcriptRequiredInsights"));
      return;
    }

    setConfirmedOutputLanguage(null);
    setInsightPreferenceBusy(true);
    reportAiNotice(null);
    try {
      const preferences = await getInsightPreferences();
      setInsightPreferenceFlow(createInsightPreferenceFlow(preferences));
    } catch {
      reportAiNotice(uiMessage("preferences.notice.preferencesReadFailed"));
    } finally {
      setInsightPreferenceBusy(false);
    }
  }, [reportAiNotice, workflow.artifacts.transcript_txt, workflow.taskId]);

  const openSummaryConfirmation = useCallback(() => {
    if (!workflow.taskId || !workflow.artifacts.transcript_txt) {
      reportAiNotice(uiMessage("preferences.notice.transcriptRequiredSummary"));
      return;
    }

    reportAiNotice(null);
    setSummaryConfirmOpen(true);
  }, [reportAiNotice, workflow.artifacts.transcript_txt, workflow.taskId]);

  const confirmSummaryGeneration = useCallback(async () => {
    const confirmedOutputLanguage = outputLanguage;
    if (!canGenerateAiWithAccount(account)) {
      openAccountPanel(aiBlockerMessage(account));
      return;
    }

    setSummaryConfirmOpen(false);
    try {
      await retryInsightGeneration(
        "summary",
        confirmedOutputLanguage,
        null,
        account,
        openAccountPanel,
        refreshAccountStatus,
      );
    } catch {
      reportAiNotice(uiMessage("preferences.notice.summaryStartFailed"));
    }
  }, [
    account,
    aiBlockerMessage,
    openAccountPanel,
    outputLanguage,
    refreshAccountStatus,
    retryInsightGeneration,
    reportAiNotice,
  ]);

  const openProfileEditorFromSettings = useCallback(async () => {
    closeSettings();
    setInsightPreferenceBusy(true);
    reportAiNotice(null);
    try {
      const preferences = await getInsightPreferences();
      setInsightPreferenceFlow(startProfileSetupInFlow(createInsightPreferenceFlow(preferences)));
    } catch {
      reportAiNotice(uiMessage("preferences.notice.preferencesReadFailed"));
    } finally {
      setInsightPreferenceBusy(false);
    }
  }, [closeSettings, reportAiNotice]);

  const openDirectionEditorFromDetail = useCallback(async () => {
    if (!workflow.taskId || !workflow.artifacts.transcript_txt) {
      reportAiNotice(uiMessage("preferences.notice.transcriptRequiredDirection"));
      return;
    }

    closeDetail();
    setInsightPreferenceBusy(true);
    reportAiNotice(null);
    try {
      const preferences = await getInsightPreferences();
      setInsightPreferenceFlow(startGenerationPreferenceEditing(createInsightPreferenceFlow(preferences)));
    } catch {
      reportAiNotice(uiMessage("preferences.notice.preferencesReadFailed"));
    } finally {
      setInsightPreferenceBusy(false);
    }
  }, [closeDetail, reportAiNotice, workflow.artifacts.transcript_txt, workflow.taskId]);

  const skipCurrentProfileSetup = useCallback(async () => {
    if (!insightPreferenceFlow) {
      return;
    }
    setInsightPreferenceBusy(true);
    try {
      await skipInspirationProfile();
      setInsightPreferenceFlow(skipProfileSetupInFlow(insightPreferenceFlow));
    } catch {
      reportAiNotice(uiMessage("preferences.notice.skipSaveFailed"));
    } finally {
      setInsightPreferenceBusy(false);
    }
  }, [insightPreferenceFlow, reportAiNotice]);

  const saveCurrentProfile = useCallback(
    async (profile: InspirationProfile) => {
      setInsightPreferenceBusy(true);
      try {
        const preferences = await saveInspirationProfile(profile);
        setInsightPreferenceFlow(startGenerationPreferenceEditing(createInsightPreferenceFlow(preferences)));
      } catch {
        reportAiNotice(uiMessage("preferences.notice.profileSaveFailed"));
      } finally {
        setInsightPreferenceBusy(false);
      }
    },
    [reportAiNotice],
  );

  const confirmInsightPreferences = useCallback(
    async (preferences: GenerationPreferences) => {
      const confirmedOutputLanguage = outputLanguage;
      if (!canGenerateAiWithAccount(account)) {
        openAccountPanel(aiBlockerMessage(account));
        return;
      }

      setConfirmedOutputLanguage(confirmedOutputLanguage);
      setInsightPreferenceBusy(true);
      try {
        const preferenceSnapshot = insightPreferenceFlow
          ? buildPreferenceSnapshot({
              profile: insightPreferenceFlow.profile,
              profileSkipped: insightPreferenceFlow.profileSkipped,
              generationPreferences: preferences,
            })
          : null;
        await saveDefaultGenerationPreferences(preferences);
        setInsightPreferenceFlow(null);
        await retryInsightGeneration(
          "insights",
          confirmedOutputLanguage,
          preferenceSnapshot,
          account,
          openAccountPanel,
          refreshAccountStatus,
        );
      } catch {
        reportAiNotice(uiMessage("preferences.notice.insightsStartFailed"));
      } finally {
        setConfirmedOutputLanguage(null);
        setInsightPreferenceBusy(false);
      }
    },
    [
      account,
      aiBlockerMessage,
      insightPreferenceFlow,
      openAccountPanel,
      outputLanguage,
      refreshAccountStatus,
      retryInsightGeneration,
      reportAiNotice,
    ],
  );

  return {
    aiActionNotice,
    summaryConfirmOpen,
    insightPreferenceFlow,
    insightPreferenceBusy,
    confirmedOutputLanguage,
    setInsightPreferenceFlow,
    closeSummaryConfirmation,
    closeInsightPreferenceFlow,
    resetInsightGenerationUi,
    openInsightPreferenceFlow,
    openSummaryConfirmation,
    confirmSummaryGeneration,
    openProfileEditorFromSettings,
    openDirectionEditorFromDetail,
    skipCurrentProfileSetup,
    saveCurrentProfile,
    confirmInsightPreferences,
  };
}

export type InsightGenerationController = ReturnType<typeof useInsightGenerationController>;
