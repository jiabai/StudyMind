import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  UserRound,
} from "lucide-react";

import { isProcessingStage, type WorkflowState } from "../../workflow";
import { renameTaskTitle } from "../../historyClient";
import type { HistoryListItem } from "../../historyClient";
import type { HistoryController } from "../history/useHistoryController";
import type { AccountStatus } from "../../accountState";
import { useSidebarState } from "./useSidebarState";
import { SidebarHistoryNotice } from "./SidebarHistoryNotice";
import { SidebarTopicItem, displayTopicTitle } from "./SidebarTopicItem";
import { InlineDeleteConfirm } from "./InlineDeleteConfirm";
import { SidebarUserMenu } from "./SidebarUserMenu";

type AppSidebarProps = {
  controller: HistoryController;
  workflow: WorkflowState;
  recordingActive: boolean;
  selectionDisabled: boolean;
  deletionDisabled: boolean;
  newTopicDisabled: boolean;
  onNewTopic: () => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
  onSignOut: () => void;
  signOutDisabled: boolean;
  account: AccountStatus;
  accountChipLabel: string;
  className?: string;
};

export function AppSidebar({
  controller,
  workflow,
  recordingActive,
  selectionDisabled,
  deletionDisabled,
  newTopicDisabled,
  onNewTopic,
  onOpenSettings,
  onOpenAccount,
  onSignOut,
  signOutDisabled,
  account,
  accountChipLabel,
  className,
}: AppSidebarProps) {
  const { t: tSidebar } = useTranslation("sidebar");
  const { t: tWorkflow } = useTranslation("workflow");
  const sidebarState = useSidebarState();
  const {
    historyItems,
    historyLoading,
    historyNotice,
    historyDeleteCandidate,
    historyDeleting,
    openHistoryItem,
    requestHistoryItemDeletion,
    cancelHistoryItemDeletion,
    confirmHistoryItemDeletion,
    loadHistory,
    clearHistoryNotice,
  } = controller;

  const [renameCandidateId, setRenameCandidateId] = useState<string | null>(null);

  const activeTaskId = workflow.taskId;
  const activeStage = workflow.stage;
  useEffect(() => {
    void loadHistory();
  }, [loadHistory, activeTaskId, activeStage]);

  // 取消重命名态：当处理中或选中课题变化时退出重命名。
  useEffect(() => {
    if (selectionDisabled) {
      setRenameCandidateId(null);
    }
  }, [selectionDisabled]);

  const collapsed = sidebarState.collapsed;
  const showCurrentTopicCard =
    activeTaskId !== null && workflow.stage !== "waiting_input";
  const currentTopicItem = activeTaskId
    ? historyItems.find((item) => item.taskId === activeTaskId) ?? null
    : null;
  const currentTopicTitle = currentTopicItem
    ? displayTopicTitle(currentTopicItem)
    : workflow.taskSource && workflow.taskSource.kind === "local_file"
      ? workflow.taskSource.displayName
      : "";
  const processingActive = isProcessingStage(workflow.stage);
  const progressPercent = Math.max(
    0,
    Math.min(100, Math.round(workflow.progressPercent ?? 0)),
  );

  const handleRenameRequest = useCallback((item: HistoryListItem) => {
    if (recordingActive) {
      return;
    }
    setRenameCandidateId(item.taskId);
  }, [recordingActive]);

  const handleRenameCancel = useCallback(() => {
    setRenameCandidateId(null);
  }, []);

  const handleRenameCommit = useCallback(
    async (item: HistoryListItem, title: string | null) => {
      if (recordingActive) {
        return;
      }
      await renameTaskTitle(item.taskId, title);
      await loadHistory();
      setRenameCandidateId(null);
    },
    [loadHistory, recordingActive],
  );

  const handleNewTopic = useCallback(() => {
    if (recordingActive) {
      return;
    }
    onNewTopic();
  }, [onNewTopic, recordingActive]);
  const handleHistoryItemSelected = useCallback(
    (item: HistoryListItem) => {
      if (recordingActive) {
        return;
      }
      void openHistoryItem(item);
    },
    [openHistoryItem, recordingActive],
  );
  const handleHistoryItemDeletionRequested = useCallback(
    (item: HistoryListItem) => {
      if (recordingActive) {
        return;
      }
      requestHistoryItemDeletion(item);
    },
    [recordingActive, requestHistoryItemDeletion],
  );
  const handleHistoryItemDeletionConfirmed = useCallback(() => {
    if (recordingActive) {
      return;
    }
    void confirmHistoryItemDeletion();
  }, [confirmHistoryItemDeletion, recordingActive]);
  const handleSignOut = useCallback(() => {
    if (recordingActive) {
      return;
    }
    onSignOut();
  }, [onSignOut, recordingActive]);

  if (collapsed) {
    return (
      <aside className={`app-sidebar collapsed${className ? ` ${className}` : ""}`} aria-label={tSidebar("ariaLabel")}>
        <div className="sidebar-collapse-rail">
          <button
            className="sidebar-collapse-toggle"
            type="button"
            onClick={sidebarState.toggleCollapsed}
            aria-label={tSidebar("expandAria")}
            title={tSidebar("expandAria")}
          >
            <PanelLeftOpen size={16} />
          </button>
          <button
            className="sidebar-rail-icon"
            type="button"
            onClick={handleNewTopic}
            disabled={newTopicDisabled || recordingActive}
            aria-label={tSidebar("newTopic")}
            title={tSidebar("newTopic")}
          >
            <Plus size={16} />
          </button>
          {showCurrentTopicCard ? (
            <button
              className="sidebar-rail-icon active"
              type="button"
              aria-label={tSidebar("currentTopicAria")}
              title={currentTopicTitle}
            >
              {processingActive ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <FileText size={16} />
              )}
            </button>
          ) : null}
        </div>
        <div className="sidebar-rail-bottom">
          <button
            className="sidebar-rail-icon"
            type="button"
            onClick={onOpenSettings}
            aria-label={tSidebar("settings")}
            title={tSidebar("settings")}
          >
            <Settings size={16} />
          </button>
          <button
            className="sidebar-rail-icon"
            type="button"
            onClick={onOpenAccount}
            aria-label={tSidebar("account")}
            title={accountChipLabel}
          >
            <UserRound size={16} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className={`app-sidebar expanded${className ? ` ${className}` : ""}`} aria-label={tSidebar("ariaLabel")}>
      <header className="sidebar-header">
        <button
          className="sidebar-collapse-toggle"
          type="button"
          onClick={sidebarState.toggleCollapsed}
          aria-label={tSidebar("collapseAria")}
          title={tSidebar("collapseAria")}
        >
          <PanelLeftClose size={16} />
        </button>
      </header>

      <button
        className="sidebar-new-topic"
        type="button"
        onClick={handleNewTopic}
        disabled={newTopicDisabled || recordingActive}
      >
        <Plus size={16} />
        <span>{tSidebar("newTopic")}</span>
      </button>

      {showCurrentTopicCard ? (
        <section className="sidebar-current-topic" aria-label={tSidebar("myTopic")}>
          <p className="sidebar-section-label">{tSidebar("myTopic")}</p>
          <div className="sidebar-current-card">
            <strong className="sidebar-current-title" title={currentTopicTitle}>
              {currentTopicTitle}
            </strong>
            {processingActive ? (
              <>
                <span className="sidebar-current-status">
                  {tWorkflow(`stage.${workflow.stage}.body`)}
                </span>
                <div className="sidebar-progress-track">
                  <div
                    className={`sidebar-progress-fill ${workflow.stage}`}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <span className="sidebar-progress-percent">{progressPercent}%</span>
              </>
            ) : (
              <span className="sidebar-current-status">
                {tWorkflow(`stage.${workflow.stage}.body`)}
              </span>
            )}
          </div>
        </section>
      ) : null}

      <section className="sidebar-topic-list-section" aria-label={tSidebar("topicListAria")}>
        <p className="sidebar-section-label">{tSidebar("allTopics")}</p>
        <SidebarHistoryNotice
          notice={historyNotice}
          onClose={clearHistoryNotice}
        />
        {historyLoading && historyItems.length === 0 ? (
          <div className="sidebar-loading">
            <LoaderCircle size={14} className="spin" />
            <span>{tSidebar("loading")}</span>
          </div>
        ) : historyItems.length === 0 ? (
          <div className="sidebar-empty">
            <FileText size={16} />
            <span>{tSidebar("empty")}</span>
          </div>
        ) : (
          <ul className="sidebar-topic-list">
            {historyItems.map((item) => (
              <SidebarTopicItem
                key={item.id}
                item={item}
                selected={activeTaskId === item.taskId}
                selectionDisabled={selectionDisabled || recordingActive}
                deletionDisabled={deletionDisabled || recordingActive}
                renaming={renameCandidateId === item.taskId}
                onSelect={handleHistoryItemSelected}
                onDeleteRequest={handleHistoryItemDeletionRequested}
                onRenameRequest={handleRenameRequest}
                onRenameCommit={handleRenameCommit}
                onRenameCancel={handleRenameCancel}
              />
            ))}
          </ul>
        )}
      </section>

      <div className="sidebar-footer">
        <SidebarUserMenu
          account={account}
          onOpenAccount={onOpenAccount}
          onOpenSettings={onOpenSettings}
          onSignOut={handleSignOut}
          signOutDisabled={signOutDisabled}
        />
      </div>

      <InlineDeleteConfirm
        open={Boolean(historyDeleteCandidate)}
        deleting={historyDeleting}
        onConfirm={handleHistoryItemDeletionConfirmed}
        onCancel={cancelHistoryItemDeletion}
      />
    </aside>
  );
}
