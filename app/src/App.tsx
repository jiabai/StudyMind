import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import {
  Download,
  ListChecks,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import "./App.css";
import {
  getExportPath,
  isProcessingStage,
  type TaskArtifactKey,
} from "./workflow";
import { createTaskWorkspaceViewModel } from "./taskWorkspaceViewModel";
import type { HistoryItem } from "./historyClient";
import { getServerBaseUrl } from "./accountClient";
import { type AccountStatus } from "./accountState";
import { AccountSheet } from "./features/account/AccountSheet";
import { LoginGuide, type LoginGuideFooterLinks } from "./features/account/LoginGuide";
import { useAccountController } from "./features/account/useAccountController";
import { useAppUpdateController } from "./features/updates/useAppUpdateController";
import { getAiCreditsCostHint } from "./aiCreditsCopy";
import { ModelGuideSheet } from "./features/asrModel/ModelGuideSheet";
import { useAsrModelDownload } from "./features/asrModel/useAsrModelDownload";
import { useHistoryController } from "./features/history/useHistoryController";
import { InsightPreferenceFlow } from "./features/insightPreferences/InsightPreferenceFlow";
import { OutputLanguageField } from "./features/insightPreferences/OutputLanguageField";
import { useInsightGenerationController } from "./features/insightPreferences/useInsightGenerationController";
import { TranscriptDissectionConfirmationSheet } from "./features/dissection/TranscriptDissectionConfirmationSheet";
import { useTranscriptDissectionController } from "./features/dissection/useTranscriptDissectionController";
import { AiGenerationWorkspace } from "./features/results/AiGenerationWorkspace";
import { AiResultDetailSheet } from "./features/results/AiResultDetailSheet";
import { TaskStatusBanner } from "./features/results/TaskStatusBanner";
import { AppSidebar } from "./features/sidebar/AppSidebar";
import { SettingsSheet } from "./features/settings/SettingsSheet";
import { useSettingsController } from "./features/settings/useSettingsController";
import { LocalTranscriptWorkspace } from "./features/transcript/LocalTranscriptWorkspace";
import { TranscriptNotesPanel } from "./features/transcript/TranscriptNotesPanel";
import { useTranscriptDetailController } from "./features/transcript/useTranscriptDetailController";
import { useTranscriptNotesController } from "./features/transcript/useTranscriptNotesController";
import { useWindowChromeController } from "./features/window/useWindowChromeController";
import { useModalFocus } from "./features/modal/useModalFocus";
import { HeroUploadZone } from "./features/workflow/HeroUploadZone";
import { useTaskProcessingController } from "./features/workflow/useTaskProcessingController";
import { useLocale } from "./i18n/LocaleProvider";
import { countTextUnits, formatWordCount } from "./i18n/formatters";
import { uiMessage, type UiMessage } from "./i18n/uiMessage";

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
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(null);
  const [workspaceTransition, setWorkspaceTransition] = useState<"hero-to-workspace" | "workspace-to-hero" | null>(null);
  const prevStageRef = useRef<string>("waiting_input");
  const [loginTransition, setLoginTransition] = useState<"guide-to-hero" | null>(null);
  const prevLoginGuideVisibleRef = useRef(false);

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
    toolbarNewTaskButtonState,
    cancelCurrentProcessing,
    resetWorkflow,
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

  useEffect(() => {
    const prev = prevStageRef.current;
    const next = workflow.stage;
    if (prev === "waiting_input" && next !== "waiting_input") {
      setWorkspaceTransition("hero-to-workspace");
      const t = setTimeout(() => setWorkspaceTransition(null), 400);
      return () => clearTimeout(t);
    }
    if (prev !== "waiting_input" && next === "waiting_input") {
      setWorkspaceTransition("workspace-to-hero");
      const t = setTimeout(() => setWorkspaceTransition(null), 400);
      return () => clearTimeout(t);
    }
    prevStageRef.current = next;
    return undefined;
  }, [workflow.stage]);

  const transcriptDetailController = useTranscriptDetailController({
    workflow,
    applyTranscriptSave,
    setActionNotice,
    locale: resolvedLocale,
  });
  const transcriptNotesController = useTranscriptNotesController({
    workflow,
    setActionNotice,
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
    accountStatusPending,
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
  const loginGuideVisible =
    workflow.stage === "waiting_input" &&
    !account.authenticated &&
    !account.serverError &&
    !accountStatusPending;

  useEffect(() => {
    let cancelled = false;
    getServerBaseUrl()
      .then((url) => {
        if (!cancelled) {
          setServerBaseUrl(url);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const loginGuideFooterLinks: LoginGuideFooterLinks = serverBaseUrl
    ? {
        privacyUrl: `${serverBaseUrl.replace(/\/+$/, "")}/privacy`,
        termsUrl: `${serverBaseUrl.replace(/\/+$/, "")}/terms`,
      }
    : {};

  useEffect(() => {
    const prev = prevLoginGuideVisibleRef.current;
    if (prev && !loginGuideVisible) {
      setLoginTransition("guide-to-hero");
      const t = setTimeout(() => setLoginTransition(null), 400);
      prevLoginGuideVisibleRef.current = loginGuideVisible;
      return () => clearTimeout(t);
    }
    prevLoginGuideVisibleRef.current = loginGuideVisible;
    return undefined;
  }, [loginGuideVisible]);
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
        console.log("[studymind] registerDeepLinkListeners start");
        const currentUrls = await getCurrent();
        if (!cancelled && currentUrls) {
          console.log("[studymind] getCurrent returned", currentUrls);
          for (const url of currentUrls) {
            void handleAuthCallback(url);
          }
        } else {
          console.log("[studymind] getCurrent returned null/empty");
        }
        unlisten = await onOpenUrl((urls) => {
          console.log("[studymind] onOpenUrl fired with", urls);
          for (const url of urls) {
            void handleAuthCallback(url);
          }
        });
        console.log("[studymind] onOpenUrl listener registered");
        // Also listen for the custom event emitted by single_instance
        // callback, which carries the raw command-line argv containing
        // the deep-link URL on Windows when the app is already running.
        const unlistenCustom = await listen<string[]>(
          "studymind-deep-link-args",
          (event) => {
            console.log("[studymind] studymind-deep-link-args event fired, payload:", event.payload);
            for (const arg of event.payload) {
              if (
                typeof arg === "string" &&
                arg.startsWith("studymind://")
              ) {
                console.log("[studymind] calling handleAuthCallback with", arg);
                void handleAuthCallback(arg);
              }
            }
          },
        );
        console.log("[studymind] studymind-deep-link-args listener registered");
        // Merge both unlisten functions into one cleanup handle
        const originalUnlisten = unlisten;
        unlisten = () => {
          originalUnlisten();
          unlistenCustom();
        };
      } catch (err) {
        console.error("[studymind] registerDeepLinkListeners failed:", err);
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

  return (
    <main className="app-shell">
      <section className="desktop-window" aria-label={tCommon("window.ariaLabel")}>
        {account.authenticated ? (
          <AppSidebar
            className={loginTransition ? "sidebar-enter" : undefined}
            controller={historyController}
            workflow={workflow}
            selectionDisabled={!canRestoreHistory}
            deletionDisabled={!canDeleteHistory}
            newTopicDisabled={toolbarNewTaskButtonState.disabled}
            onNewTopic={startNewTaskFromToolbar}
            onOpenSettings={openSettings}
            onOpenAccount={() => openAccountPanel()}
            onSignOut={() => void signOutAccount()}
            account={account}
            accountChipLabel={accountChipLabel}
          />
        ) : null}
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
          </div>
        </header>

        <section
          className={`workspace ${workflow.stage === "waiting_input" ? "waiting-layout" : "active-layout"}${workspaceTransition ? ` hero-transitioning ${workspaceTransition}` : ""}${loginTransition ? ` login-transitioning ${loginTransition}` : ""}`}
          aria-label={tWorkflow("input.workspaceAria")}
        >
          {workflow.stage === "waiting_input" ? (
            loginGuideVisible ? (
              <LoginGuide
                loginInProgress={accountLoading}
                footerLinks={loginGuideFooterLinks}
                onOpenLink={(url) => void openUrl(url)}
                onLogin={() => {
                  openAccountPanel();
                  void startLoginFlow();
                }}
              />
            ) : (
              <HeroUploadZone
                source={workflow.composerSource}
                canSubmit={canSubmit}
                statusBody={activeStageBody}
                onLocalMediaSelected={setLocalMediaSelection}
                onRemoveLocalMedia={removeLocalMediaSelection}
                onSubmit={(submission) => {
                  void submitTask(submission, account, openAccountPanel);
                }}
              />
            )
          ) : (
            <>
              <TaskStatusBanner model={taskWorkspaceModel.banner} />
              <div
                className={`task-workspace-layout${taskWorkspaceModel.local.canReview ? "" : " transcript-only"}`}
              >
                <LocalTranscriptWorkspace
                  model={taskWorkspaceModel.local}
                  controller={transcriptDetailController}
                  notesController={transcriptNotesController}
                  actionNotice={aiActionNotice ? null : actionNotice}
                  onLocateArtifact={(artifact) => void locateArtifact(artifact)}
                  onCancel={() => void cancelCurrentProcessing()}
                />
                {taskWorkspaceModel.local.canReview ? (
                  <TranscriptNotesPanel
                    controller={transcriptNotesController}
                    transcriptSegments={transcriptDetailController.transcriptSegments}
                    editingDisabled={!taskWorkspaceModel.local.canEdit}
                  />
                ) : null}
                {taskWorkspaceModel.ai.visible ? (
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
                ) : null}
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
        onLocateDissectionChunks={locateDissectionChunks}
        onOpenDirectionEditor={openDirectionEditorFromDetail}
        onOpenDissectionConfirmation={dissectionController.openConfirmation}
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
