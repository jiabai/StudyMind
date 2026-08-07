import { useCallback, useEffect, useState } from "react";

import type { AccountStatus } from "../../accountState";
import type { SupportedLocale } from "../../i18n/locale";
import type { UiMessage } from "../../i18n/uiMessage";
import type { InsightRetryTarget, WorkflowState } from "../../workflow";
import { buildDissectionCallPlan } from "./dissectionCallPlan";

export type DissectionPreview = {
  taskTitle: string;
  characterCount: number;
  chunkCount: number;
  minimumCalls: number;
  maximumCalls: number;
  hardMaximumCalls: 6;
  outputLanguage: SupportedLocale;
  quotaRemaining: number;
  eligible: boolean;
  canConfirm: boolean;
};

type CreateDissectionPreviewOptions = {
  taskTitle: string;
  transcript: string;
  outputLanguage: SupportedLocale;
  quotaRemaining: number;
};

export function createDissectionPreview({
  taskTitle,
  transcript,
  outputLanguage,
  quotaRemaining,
}: CreateDissectionPreviewOptions): DissectionPreview {
  const plan = buildDissectionCallPlan(transcript);
  return {
    taskTitle,
    characterCount: Array.from(transcript).length,
    chunkCount: plan.chunkCount,
    minimumCalls: plan.minimumCalls,
    maximumCalls: plan.maximumCalls,
    hardMaximumCalls: 6,
    outputLanguage,
    quotaRemaining,
    eligible: plan.eligible,
    canConfirm: plan.eligible && quotaRemaining >= plan.maximumCalls,
  };
}

type RetryDissection = (
  target: InsightRetryTarget,
  outputLanguage: SupportedLocale,
  preferenceSnapshot: null,
  account: AccountStatus,
  openAccountPanel: (notice?: UiMessage) => void,
) => Promise<void>;

type UseTranscriptDissectionControllerOptions = {
  workflow: WorkflowState;
  account: AccountStatus;
  openAccountPanel: (notice?: UiMessage) => void;
  outputLanguage: SupportedLocale;
  retryInsightGeneration: RetryDissection;
};

export function useTranscriptDissectionController({
  workflow,
  account,
  openAccountPanel,
  outputLanguage,
  retryInsightGeneration,
}: UseTranscriptDissectionControllerOptions) {
  const [preview, setPreview] = useState<DissectionPreview | null>(null);
  const taskTitle = workflow.taskSource?.kind === "local_file"
    ? workflow.taskSource.displayName
    : workflow.taskId ?? "";
  useEffect(() => setPreview(null), [workflow.taskId]);

  const openConfirmation = useCallback(() => {
    if (!workflow.taskId || !workflow.artifacts.transcript_txt || !workflow.text.trim()) {
      return;
    }
    setPreview(createDissectionPreview({
      taskTitle,
      transcript: workflow.text,
      outputLanguage,
      quotaRemaining: account.llmQuotaRemaining,
    }));
  }, [account.llmQuotaRemaining, outputLanguage, taskTitle, workflow]);

  const closeConfirmation = useCallback(() => setPreview(null), []);

  const confirmGeneration = useCallback(async () => {
    if (
      !preview?.canConfirm ||
      !workflow.taskId ||
      account.llmQuotaRemaining < preview.maximumCalls
    ) {
      return;
    }
    const frozenLanguage = preview.outputLanguage;
    setPreview(null);
    await retryInsightGeneration("dissection", frozenLanguage, null, account, openAccountPanel);
  }, [account, openAccountPanel, preview, retryInsightGeneration, workflow.taskId]);

  return {
    preview,
    openConfirmation,
    closeConfirmation,
    confirmGeneration,
  };
}
