import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from "react";

import type { SupportedLocale } from "../../i18n/locale";
import { uiMessage, type UiMessage } from "../../i18n/uiMessage";
import {
  getDetailText,
  getExportPath,
  type DetailTab,
  type WorkflowState,
} from "../../workflow";

type UseArtifactDetailControllerOptions = {
  workflow: WorkflowState;
  locale: SupportedLocale;
  transcriptDraft: string;
  transcriptDirty: boolean;
  setActionNotice: Dispatch<SetStateAction<UiMessage | null>>;
};

export function useArtifactDetailController({
  workflow,
  locale,
  transcriptDraft,
  transcriptDirty,
  setActionNotice,
}: UseArtifactDetailControllerOptions) {
  const [detailTab, setDetailTab] = useState<DetailTab | null>(null);

  const openDetailTab = useCallback((tab: DetailTab | null) => {
    setDetailTab(tab);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailTab(null);
  }, []);

  const detailText =
    detailTab === "transcript"
      ? transcriptDraft
      : detailTab
        ? getDetailText(detailTab, workflow, locale)
        : "";
  const exportPath = detailTab ? getExportPath(detailTab, workflow) : null;
  const currentTranscriptPath = getExportPath("transcript", workflow);

  const copyDetail = useCallback(async () => {
    if (!detailTab) {
      return;
    }
    const text =
      detailTab === "transcript"
        ? transcriptDraft
        : getDetailText(detailTab, workflow, locale);
    if (!text) {
      setActionNotice(uiMessage("transcript.notice.nothingToCopy"));
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setActionNotice(uiMessage("transcript.notice.copied"));
    } catch {
      setActionNotice(uiMessage("transcript.notice.copyFailed"));
    }
  }, [detailTab, locale, setActionNotice, transcriptDraft, workflow]);

  const copyTranscript = useCallback(async () => {
    if (!transcriptDraft) {
      setActionNotice(uiMessage("transcript.notice.nothingToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(transcriptDraft);
      setActionNotice(uiMessage("transcript.notice.copied"));
    } catch {
      setActionNotice(uiMessage("transcript.notice.transcriptCopyFailed"));
    }
  }, [setActionNotice, transcriptDraft]);

  const exportDetail = useCallback(async () => {
    if (!detailTab) {
      return;
    }
    if (detailTab === "transcript" && transcriptDirty) {
      setActionNotice(uiMessage("transcript.notice.unsavedLocate"));
      return;
    }
    const detailExportPath = getExportPath(detailTab, workflow);
    if (!detailExportPath) {
      setActionNotice(uiMessage("transcript.notice.noExport"));
      return;
    }

    try {
      await revealItemInDir(detailExportPath);
      setActionNotice(uiMessage("transcript.notice.exportLocated"));
    } catch {
      setActionNotice(uiMessage("transcript.notice.exportLocateFailed"));
    }
  }, [detailTab, setActionNotice, transcriptDirty, workflow]);

  const exportTranscript = useCallback(async () => {
    if (transcriptDirty) {
      setActionNotice(uiMessage("transcript.notice.unsavedLocate"));
      return;
    }
    const transcriptPath = getExportPath("transcript", workflow);
    if (!transcriptPath) {
      setActionNotice(uiMessage("transcript.notice.noTranscriptExport"));
      return;
    }
    try {
      await revealItemInDir(transcriptPath);
      setActionNotice(uiMessage("transcript.notice.transcriptLocated"));
    } catch {
      setActionNotice(uiMessage("transcript.notice.transcriptLocateFailed"));
    }
  }, [setActionNotice, transcriptDirty, workflow]);

  return {
    detailTab,
    openDetailTab,
    closeDetail,
    detailText,
    exportPath,
    currentTranscriptPath,
    copyDetail,
    copyTranscript,
    exportDetail,
    exportTranscript,
  };
}
