import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  Download,
  History as HistoryIcon,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  Settings,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import "./App.css";
import {
  getExportPath,
  isProcessingStage,
  type TaskArtifactKey,
} from "./workflow";
import { createTaskWorkspaceViewModel } from "./taskWorkspaceViewModel";
import type { HistoryItem } from "./historyClient";
import {
  canProcessWithAccount,
  type AccountStatus,
} from "./accountState";
import { AccountSheet } from "./features/account/AccountSheet";
import { useAccountController } from "./features/account/useAccountController";
import { useAppUpdateController } from "./features/updates/useAppUpdateController";
import { getAiCreditsCostHint } from "./aiCreditsCopy";
import { ModelGuideSheet } from "./features/asrModel/ModelGuideSheet";
import { useAsrModelDownload } from "./features/asrModel/useAsrModelDownload";
import { HistorySheet } from "./features/history/HistorySheet";
import { useHistoryController } from "./features/history/useHistoryController";
import { InsightPreferenceFlow } from "./features/insightPreferences/InsightPreferenceFlow";
import { OutputLanguageField } from "./features/insightPreferences/OutputLanguageField";
import { useInsightGenerationController } from "./features/insightPreferences/useInsightGenerationController";
import { TranscriptDissectionConfirmationSheet } from "./features/dissection/TranscriptDissectionConfirmationSheet";
import { useTranscriptDissectionController } from "./features/dissection/useTranscriptDissectionController";
import { AiGenerationWorkspace } from "./features/results/AiGenerationWorkspace";
import { AiResultDetailSheet } from "./features/results/AiResultDetailSheet";
import { TaskStatusBanner } from "./features/results/TaskStatusBanner";
import { SettingsSheet } from "./features/settings/SettingsSheet";
import { useSettingsController } from "./features/settings/useSettingsController";
import { LocalTranscriptWorkspace } from "./features/transcript/LocalTranscriptWorkspace";
import { useTranscriptDetailController } from "./features/transcript/useTranscriptDetailController";
import { useWindowChromeController } from "./features/window/useWindowChromeController";
import { useModalFocus } from "./features/modal/useModalFocus";
import { TaskComposer } from "./features/workflow/TaskComposer";
import { useTaskProcessingController } from "./features/workflow/useTaskProcessingController";
import { useLocale } from "./i18n/LocaleProvider";
import { countTextUnits, formatWordCount } from "./i18n/formatters";
import { renderUiMessage, uiMessage, type UiMessage } from "./i18n/uiMessage";

const asrModelLabels: Record<string, string> = {
  "Qwen/Qwen3-ASR-0.6B": "Qwen3-ASR 0.6B",
  "iic/SenseVoiceSmall": "SenseVoice Small",
  "iic/SenseVoiceSmall-onnx": "SenseVoiceSmall-ONNX (≈ 230 MB)",
};

function formatProgressPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function accountProcessBlockerMessage(account: AccountStatus): UiMessage {
  if (!account.authenticated) {
    return uiMessage("account.notice.signInRequired");
  }

  if (account.entitlementStatus !== "active") {
    return uiMessage("account.notice.activationRequiredForAction");
  }

  return uiMessage(
    account.serverError
      ? "account.notice.accountUnavailable"
      : "account.notice.processingUnavailable",
  );
}

function accountAiBlockerMessage(account: AccountStatus): UiMessage {
  if (!account.authenticated) {
    return uiMessage("account.notice.signInRequired");
  }

  if (account.entitlementStatus !== "active") {
    return uiMessage("account.notice.activationRequiredForAction");
  }

  if (!account.llmConfigured) {
    return uiMessage("account.notice.llmConfigurationRequired");
  }

  if (account.llmQuotaRemaining <= 0) {
    return uiMessage("account.notice.creditsExhausted");
  }

  return uiMessage(
    account.serverError
      ? "account.notice.accountUnavailable"
      : "account.notice.aiUnavailable",
  );
}

function App() {
  const { resolvedLocale } = useLocale();
  const { t: tCommon } = useTranslation("common");
  const { t: tWorkflow } = useTranslation("workflow");
  const { t: tUpdates } = useTranslation("updates");
  const { t: tSynthesis } = useTranslation("synthesis");
  const [actionNotice, setActionNotice] = useState<UiMessage | null>(null);
  const settingsController = useSettingsController();
  const { settingsOpen, closeSettings, openSettings } = settingsController;
  const closeDetailForTaskRef = useRef<() => void>(() => {});
  const resetInsightGenerationUiRef = useRef<() => void>(() => {});
  const {
    modelGuideOpen,
    setModelGuideOpen,
    asrModelStatus,
    modelDownloadProgress,
    modelDownloadNotice,
    modelDownloadStalled,
    modelDownloadActive,
    refreshAsrModelStatus,
    startAsrModelDownload,
    ensureAsrModelReady,
    cancelCurrentAsrModelDownload,
  } = useAsrModelDownload();

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    void refreshAsrModelStatus(settingsController.settingsDraft.asrModel).catch(() => undefined);
  }, [
    refreshAsrModelStatus,
    settingsController.settingsDraft.asrModel,
    settingsOpen,
  ]);

  const resetTaskUi = useCallback(() => {
    closeDetailForTaskRef.current();
    resetInsightGenerationUiRef.current();
    setActionNotice(null);
  }, []);
  const prepareInsightRetryUi = useCallback(() => {
    closeDetailForTaskRef.current();
    setActionNotice(null);
  }, []);
  const {
    workflow,
    canSubmit,
    canRestoreHistory,
    historyRestoreUnavailableMessage,
    toolbarNewTaskButtonState,
    cancelCurrentProcessing,
    resetWorkflow,
    updateUrlDraft,
    setLocalMediaSelection,
    removeLocalMediaSelection,
    applyTranscriptSave,
    completeHistoryTaskDeletion,
    restoreHistoryItem,
    retryInsightGeneration,
    startNewTaskFromToolbar,
    submitTask,
  } = useTaskProcessingController({
    onResetTaskUi: resetTaskUi,
    onRetryStarted: prepareInsightRetryUi,
    ensureAsrModelReady,
    modelDownloadActive,
    processBlockerMessage: accountProcessBlockerMessage,
    aiBlockerMessage: accountAiBlockerMessage,
  });
  const transcriptDetailController = useTranscriptDetailController({
    workflow,
    applyTranscriptSave,
    setActionNotice,
    locale: resolvedLocale,
  });
  const {
    detailTab,
    openDetailTab,
    closeDetail,
    currentTranscriptPath,
    prepareTranscriptForTaskDeletion,
    transcriptSaving,
  } = transcriptDetailController;
  closeDetailForTaskRef.current = closeDetail;
  const {
    account,
    accountOpen,
    accountNotice,
    accountLoading,
    activationCodeDraft,
    activationRedeeming,
    accountChipLabel,
    accountStatusText,
    closeAccountPanel,
    handleAuthCallback,
    openAccountPanel,
    redeemActivationCodeFromInput,
    refreshAccountStatus,
    setActivationCodeDraft,
    signOutAccount,
    startLoginFlow,
  } = useAccountController({
    onSignedOut: () => {
      if (isProcessingStage(workflow.stage)) {
        void cancelCurrentProcessing();
        return;
      }
      resetWorkflow();
    },
  });
  const taskWorkspaceModel = useMemo(
    () => createTaskWorkspaceViewModel(workflow, account),
    [account, workflow],
  );
  const {
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
  } = useInsightGenerationController({
    workflow,
    account,
    setActionNotice,
    closeSettings,
    closeDetail,
    openAccountPanel,
    refreshAccountStatus,
    outputLanguage: resolvedLocale,
    retryInsightGeneration,
    aiBlockerMessage: accountAiBlockerMessage,
  });
  const dissectionController = useTranscriptDissectionController({
    workflow,
    account,
    openAccountPanel,
    outputLanguage: resolvedLocale,
    retryInsightGeneration,
  });
  const locateDissectionChunks = useCallback((chunkIds: number[]) => {
    if (!workflow.dissection || workflow.dissectionStale || transcriptDetailController.transcriptDirty) {
      return;
    }
    const chunk = workflow.dissection.sourceChunks.find((candidate) =>
      chunkIds.includes(candidate.id)
    );
    if (!chunk) {
      return;
    }
    closeDetail();
    transcriptDetailController.locateTranscriptByteRange(chunk.startByte, chunk.endByte);
  }, [closeDetail, transcriptDetailController, workflow.dissection, workflow.dissectionStale]);
  const summaryModalRef = useModalFocus<HTMLElement>(summaryConfirmOpen);
  resetInsightGenerationUiRef.current = resetInsightGenerationUi;
  const handleHistoryItemSelected = useCallback(
    (item: HistoryItem) => {
      restoreHistoryItem(item);
    },
    [restoreHistoryItem],
  );
  const handleHistoryItemDeleted = useCallback(
    (taskId: string) => {
      completeHistoryTaskDeletion(taskId);
    },
    [completeHistoryTaskDeletion],
  );
  const historyController = useHistoryController({
    onHistoryItemSelected: handleHistoryItemSelected,
    onHistoryItemDeleted: handleHistoryItemDeleted,
    onPrepareHistoryItemDeletion: prepareTranscriptForTaskDeletion,
  });
  const canDeleteHistory = canRestoreHistory && !transcriptSaving;
  const historyDeleteUnavailableMessage = transcriptSaving
    ? uiMessage("history.disabled.deletionWhileTranscriptSaving")
    : uiMessage("history.disabled.deletionWhileProcessing");
  const { historyOpen, closeHistory, openHistory } = historyController;
  const {
    handleToolbarMouseDown,
    closeWindow,
    minimizeWindow,
    toggleMaximizeWindow,
  } = useWindowChromeController();
  const {
    updateState,
    updateBusy,
    updateInstallBlocked,
    updateToolbarVisible,
    updateSpinnerVisible,
    inAppUpdates,
    checkForUpdates,
    installUpdate,
    postponeUpdateReminder,
    restartForUpdate,
    openReleases,
  } = useAppUpdateController({
    processingActive: isProcessingStage(workflow.stage),
    modelDownloadActive,
  });

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      if (detailTab) {
        closeDetail();
        return;
      }

      if (historyOpen) {
        closeHistory();
        return;
      }

      if (summaryConfirmOpen) {
        closeSummaryConfirmation();
        return;
      }

      if (insightPreferenceFlow) {
        closeInsightPreferenceFlow();
        return;
      }

      if (settingsOpen) {
        closeSettings();
        return;
      }

      if (modelGuideOpen && !modelDownloadActive) {
        setModelGuideOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [
    detailTab,
    closeDetail,
    historyOpen,
    closeHistory,
    summaryConfirmOpen,
    closeSummaryConfirmation,
    insightPreferenceFlow,
    closeInsightPreferenceFlow,
    settingsOpen,
    closeSettings,
    modelGuideOpen,
    modelDownloadActive,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    async function registerDeepLinkListeners() {
      try {
        const currentUrls = await getCurrent();
        if (!cancelled && currentUrls) {
          for (const url of currentUrls) {
            void handleAuthCallback(url);
          }
        }
        unlisten = await onOpenUrl((urls) => {
          for (const url of urls) {
            void handleAuthCallback(url);
          }
        });
      } catch {
        // Browser-only tests and Vite preview do not provide the Tauri deep-link plugin.
      }
    }

    void registerDeepLinkListeners();
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleAuthCallback]);

  async function locateArtifact(artifact: Extract<TaskArtifactKey, "video" | "audio">) {
    const artifactPath = getExportPath(artifact, workflow);
    if (!artifactPath) {
      setActionNotice(uiMessage("transcript.notice.noExport"));
      return;
    }

    try {
      await revealItemInDir(artifactPath);
      setActionNotice(uiMessage("transcript.notice.exportLocated"));
    } catch {
      setActionNotice(uiMessage("transcript.notice.exportLocateFailed"));
    }
  }

  const activeStageBody = tWorkflow(`stage.${workflow.stage}.body`);
  const updateToolbarText =
    updateState.status === "ready_to_restart"
      ? tUpdates("toolbar.restart")
      : updateState.status === "downloading"
        ? formatProgressPercent(updateState.progress)
        : updateState.status === "installing"
          ? tUpdates("toolbar.installing")
          : updateState.availableVersion
            ? tUpdates("toolbar.version", { version: updateState.availableVersion })
            : tUpdates("toolbar.available");
  const confirmationTranscriptUnitCount = useMemo(
    () => countTextUnits(workflow.text, resolvedLocale),
    [resolvedLocale, workflow.text],
  );
  const toolbarNewTaskAriaLabel = renderUiMessage(
    resolvedLocale,
    toolbarNewTaskButtonState.ariaLabel,
  );
  const toolbarNewTaskTitle = renderUiMessage(
    resolvedLocale,
    toolbarNewTaskButtonState.title,
  );

  return (
    <main className="app-shell">
      <section className="desktop-window" aria-label={tCommon("window.ariaLabel")}>
        <header className="app-toolbar topbar" data-tauri-drag-region="" onMouseDown={handleToolbarMouseDown}>
          <div className="traffic-lights" role="group" aria-label={tCommon("window.controls")}>
            <button
              className="traffic-light close"
              type="button"
              aria-label={tCommon("window.close")}
              onClick={closeWindow}
            />
            <button
              className="traffic-light minimize"
              type="button"
              aria-label={tCommon("window.minimize")}
              onClick={minimizeWindow}
            />
            <button
              className="traffic-light zoom"
              type="button"
              aria-label={tCommon("window.maximize")}
              onClick={toggleMaximizeWindow}
            />
          </div>

          <div className="toolbar-title" data-tauri-drag-region="">
            <span className="app-mark" data-tauri-drag-region="">{tCommon("appMark")}</span>
            <div data-tauri-drag-region="">
              <h1 data-tauri-drag-region="">{tCommon("productName")}</h1>
            </div>
          </div>

          <div className="topbar-actions toolbar-actions">
            <button
              className={`account-chip ${canProcessWithAccount(account) ? "active" : ""}`}
              type="button"
              onClick={() => openAccountPanel()}
              aria-label={tCommon("toolbar.account")}
            >
              <UserRound size={15} />
              <span>{accountChipLabel}</span>
            </button>
            {updateToolbarVisible ? (
              <button
                className={`update-chip ${updateState.status}`}
                type="button"
                onClick={installUpdate}
                aria-label={tCommon("toolbar.update")}
                disabled={updateBusy}
              >
                {updateSpinnerVisible ? <LoaderCircle size={15} /> : <Download size={15} />}
                <span>{updateToolbarText}</span>
              </button>
            ) : null}
            <div className="toolbar-tool-group" role="group" aria-label={tCommon("toolbar.taskTools")}>
              <button className="icon-button" type="button" onClick={openHistory} aria-label={tCommon("toolbar.history")}>
                <HistoryIcon size={17} />
              </button>
              <button className="icon-button" type="button" onClick={openSettings} aria-label={tCommon("toolbar.settings")}>
                <Settings size={17} />
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={startNewTaskFromToolbar}
                aria-label={toolbarNewTaskAriaLabel}
                title={toolbarNewTaskTitle}
                disabled={toolbarNewTaskButtonState.disabled}
              >
                <RotateCcw size={17} />
              </button>
            </div>
          </div>
        </header>

        <section
          className={`workspace ${workflow.stage === "waiting_input" ? "waiting-layout" : "active-layout"}`}
          aria-label={tWorkflow("input.workspaceAria")}
        >
          {workflow.stage === "waiting_input" ? (
            <div className="workflow-column">
              <TaskComposer
                source={workflow.composerSource}
                canSubmit={canSubmit}
                statusBody={activeStageBody}
                onUrlDraftChange={updateUrlDraft}
                onLocalMediaSelected={setLocalMediaSelection}
                onRemoveLocalMedia={removeLocalMediaSelection}
                onSubmit={(submission) => {
                  void submitTask(submission, account, openAccountPanel);
                }}
              />
            </div>
          ) : (
            <>
              <TaskStatusBanner model={taskWorkspaceModel.banner} />
              <div className="task-workspace-layout">
                <LocalTranscriptWorkspace
                  model={taskWorkspaceModel.local}
                  controller={transcriptDetailController}
                  actionNotice={aiActionNotice ? null : actionNotice}
                  onLocateArtifact={(artifact) => void locateArtifact(artifact)}
                  onCancel={() => void cancelCurrentProcessing()}
                />
                <AiGenerationWorkspace
                  model={taskWorkspaceModel.ai}
                  quotaRemaining={account.llmQuotaRemaining}
                  notice={aiActionNotice}
                  onSummaryAction={openSummaryConfirmation}
                  onInsightsAction={() => void openInsightPreferenceFlow()}
                  onDissectionAction={dissectionController.openConfirmation}
                  onViewTarget={(target) => {
                    setActionNotice(null);
                    openDetailTab(target);
                  }}
                  onCancel={() => void cancelCurrentProcessing()}
                />
              </div>
            </>
          )}
        </section>
      </section>

      <AccountSheet
        open={accountOpen}
        account={account}
        accountStatusText={accountStatusText}
        accountNotice={accountNotice}
        accountLoading={accountLoading}
        activationCodeDraft={activationCodeDraft}
        activationRedeeming={activationRedeeming}
        onClose={closeAccountPanel}
        onActivationCodeChange={setActivationCodeDraft}
        onRedeemActivationCode={redeemActivationCodeFromInput}
        onSignOut={signOutAccount}
        onStartLogin={startLoginFlow}
      />

      <ModelGuideSheet
        open={modelGuideOpen}
        modelDownloadActive={modelDownloadActive}
        asrModelStatus={asrModelStatus}
        asrModelLabels={asrModelLabels}
        modelDownloadProgress={modelDownloadProgress}
        modelDownloadNotice={modelDownloadNotice}
        modelDownloadStalled={modelDownloadStalled}
        onClose={() => setModelGuideOpen(false)}
        onStartDownload={startAsrModelDownload}
        onCancelDownload={cancelCurrentAsrModelDownload}
      />

      {summaryConfirmOpen ? (
        <div
          className="modal-backdrop sheet-backdrop"
          role="presentation"
          onClick={closeSummaryConfirmation}
        >
          <section
            ref={summaryModalRef}
            className="sheet-panel detail-modal preference-flow-sheet"
            aria-label={tSynthesis("confirmation.ariaLabel")}
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="modal-header sheet-header">
              <div>
                <p className="section-label">{tSynthesis("confirmation.sectionLabel")}</p>
                <h2>{tSynthesis("confirmation.title")}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={closeSummaryConfirmation}
                aria-label={tSynthesis("confirmation.closeAria")}
              >
                <X size={18} />
              </button>
            </header>
            <div className="preference-flow-content">
              <p className="settings-warning privacy-callout">
                <ShieldCheck size={16} />
                <span>{tSynthesis("confirmation.privacy")}</span>
              </p>
              <div className="confirm-summary preference-confirm-grid">
                <div>
                  <span className="account-status-label">{tSynthesis("confirmation.currentTranscript")}</span>
                  <strong>
                    {confirmationTranscriptUnitCount > 0
                      ? formatWordCount(
                          confirmationTranscriptUnitCount,
                          resolvedLocale,
                        )
                      : tSynthesis("confirmation.waitingTranscript")}
                  </strong>
                  <small>{currentTranscriptPath || tSynthesis("confirmation.transcriptUnavailable")}</small>
                </div>
                <div>
                  <span className="account-status-label">{tSynthesis("confirmation.creditsLabel")}</span>
                  <strong>
                    {tSynthesis("confirmation.creditsBalance", {
                      formattedCount: new Intl.NumberFormat(resolvedLocale).format(account.llmQuotaRemaining),
                    })}
                  </strong>
                  <small>{getAiCreditsCostHint(resolvedLocale)}</small>
                </div>
                <OutputLanguageField
                  locale={resolvedLocale}
                  outputLanguage={resolvedLocale}
                />
              </div>
              <div className="settings-actions sheet-footer">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={closeSummaryConfirmation}
                  disabled={isProcessingStage(workflow.stage)}
                >
                  <span>{tSynthesis("confirmation.cancel")}</span>
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={confirmSummaryGeneration}
                  disabled={isProcessingStage(workflow.stage)}
                >
                  <ListChecks size={16} />
                  <span>{tSynthesis("confirmation.confirm")}</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {insightPreferenceFlow ? (
        <InsightPreferenceFlow
          flow={insightPreferenceFlow}
          busy={insightPreferenceBusy || isProcessingStage(workflow.stage)}
          accountQuotaRemaining={account.llmQuotaRemaining}
          transcriptText={workflow.text}
          transcriptPath={currentTranscriptPath}
          locale={resolvedLocale}
          outputLanguage={confirmedOutputLanguage ?? resolvedLocale}
          onFlowChange={setInsightPreferenceFlow}
          onSkipProfile={skipCurrentProfileSetup}
          onSaveProfile={saveCurrentProfile}
          onConfirm={confirmInsightPreferences}
          onCancel={closeInsightPreferenceFlow}
        />
      ) : null}

      {dissectionController.preview ? (
        <TranscriptDissectionConfirmationSheet
          preview={dissectionController.preview}
          onCancel={dissectionController.closeConfirmation}
          onConfirm={dissectionController.confirmGeneration}
        />
      ) : null}

      <AiResultDetailSheet
        actionNotice={actionNotice}
        controller={transcriptDetailController}
        workflow={workflow}
        onOpenDirectionEditor={openDirectionEditorFromDetail}
        onOpenDissectionConfirmation={dissectionController.openConfirmation}
        onLocateDissectionChunks={locateDissectionChunks}
      />

      <HistorySheet
        controller={historyController}
        selectionDisabled={!canRestoreHistory}
        selectionDisabledReason={historyRestoreUnavailableMessage}
        deletionDisabled={!canDeleteHistory}
        deletionDisabledReason={historyDeleteUnavailableMessage}
      />

      <SettingsSheet
        locale={resolvedLocale}
        controller={settingsController}
        asrModelStatus={asrModelStatus}
        asrModelLabels={asrModelLabels}
        modelDownloadActive={modelDownloadActive}
        updateState={updateState}
        updateBusy={updateBusy}
        updateInstallBlocked={updateInstallBlocked}
        inAppUpdates={inAppUpdates}
        formatProgressPercent={formatProgressPercent}
        onAsrModelSelection={(model) => {
          void refreshAsrModelStatus(model).catch(() => undefined);
        }}
        onOpenProfileEditorFromSettings={openProfileEditorFromSettings}
        onCheckForUpdates={checkForUpdates}
        onInstallUpdate={installUpdate}
        onPostponeUpdateReminder={postponeUpdateReminder}
        onRestartForUpdate={restartForUpdate}
        onOpenReleases={openReleases}
      />
    </main>
  );
}

export default App;
