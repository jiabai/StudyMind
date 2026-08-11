import {
  canGenerateAiWithAccount,
  type AccountStatus,
} from "./accountState";
import { uiMessage, type UiMessage } from "./i18n/uiMessage";
import type {
  InsightRetryTarget,
  ProgressMessageDescriptor,
  ProgressStep,
  WorkflowState,
  WorkflowStage,
} from "./workflowState";

export type WorkspaceCancellationOwner = "local" | "ai" | null;
export type LocalWorkspacePhase = "waiting" | "processing" | "ready" | "failed";
export type AiWorkspacePhase = "waiting_transcript" | "ready" | "generating";
export type AiAvailability = "available" | "unavailable" | "quota_exhausted";
export type AiTargetStatus =
  | "locked"
  | "available"
  | "generating"
  | "cancelling"
  | "ready"
  | "failed";

export type AiTargetViewModel = {
  target: InsightRetryTarget;
  status: AiTargetStatus;
  errorCode: string | null;
};

const LOCAL_PROGRESS_STEPS: Array<Pick<ProgressStep, "id">> = [
  { id: "video_extracting" },
  { id: "video_transcribing" },
];

export type TaskStatusBannerViewModel = {
  kind: "local_complete" | "local_failed" | "local_processing" | "idle";
  stage: WorkflowStage;
  message: UiMessage | null;
  progressMessage: ProgressMessageDescriptor | null;
};

export type WorkspaceCancellationViewModel = {
  visible: boolean;
  enabled: boolean;
  inProgress: boolean;
};

export type ArtifactActionViewModel = {
  visible: boolean;
  enabled: boolean;
};

export type TranscriptSourceViewModel =
  | { kind: "asr" }
  | { kind: "subtitle"; language: string | null }
  | null;

function hasSavedTranscript(workflow: WorkflowState): boolean {
  return Boolean(
    workflow.taskId &&
      workflow.taskDir &&
      workflow.artifacts.transcript_txt &&
      workflow.text,
  );
}

function isAiCancellation(workflow: WorkflowState): boolean {
  return (
    workflow.stage === "cancelling" &&
    workflow.cancellingFromStage === "insights_generating"
  );
}

function localProgressSteps(workflow: WorkflowState): ProgressStep[] {
  const stage =
    workflow.stage === "cancelling" ? workflow.cancellingFromStage : workflow.stage;
  const activeIndex = LOCAL_PROGRESS_STEPS.findIndex((step) => step.id === stage);

  return LOCAL_PROGRESS_STEPS.map((step, index) => ({
    ...step,
    state:
      activeIndex === -1
        ? hasSavedTranscript(workflow)
          ? "complete"
          : "pending"
        : index < activeIndex
          ? "complete"
          : index === activeIndex
            ? "active"
            : "pending",
  }));
}

function aiAvailability(account: AccountStatus): AiAvailability {
  if (account.llmQuotaRemaining <= 0 && account.authenticated) {
    return "quota_exhausted";
  }
  return canGenerateAiWithAccount(account) ? "available" : "unavailable";
}

function aiTargetStatus(
  workflow: WorkflowState,
  target: InsightRetryTarget,
  transcriptReady: boolean,
): AiTargetViewModel {
  if (!transcriptReady) {
    return { target, status: "locked", errorCode: null };
  }

  if (workflow.activeAiTarget === target) {
    return {
      target,
      status: isAiCancellation(workflow) ? "cancelling" : "generating",
      errorCode: null,
    };
  }

  const targetError = workflow.aiTargetErrors[target];
  if (targetError) {
    return { target, status: "failed", errorCode: targetError.code };
  }

  const ready =
    target === "summary"
      ? Boolean(workflow.summary || workflow.artifacts.summary)
      : target === "insights"
        ? Boolean(workflow.insights.length || workflow.artifacts.insights || workflow.artifacts.insights_md)
        : Boolean(workflow.dissection || workflow.artifacts.dissection);

  return { target, status: ready ? "ready" : "available", errorCode: null };
}

function cancellationOwner(workflow: WorkflowState): WorkspaceCancellationOwner {
  const stage =
    workflow.stage === "cancelling" ? workflow.cancellingFromStage : workflow.stage;
  if (stage === "insights_generating") {
    return "ai";
  }
  if (stage === "video_extracting" || stage === "video_transcribing") {
    return "local";
  }
  return null;
}

function workspaceCancellation(
  owner: WorkspaceCancellationOwner,
  workspace: Exclude<WorkspaceCancellationOwner, null>,
  workflow: WorkflowState,
): WorkspaceCancellationViewModel {
  const visible = owner === workspace;
  const inProgress = visible && workflow.stage === "cancelling";
  return {
    visible,
    enabled: visible && !inProgress,
    inProgress,
  };
}

function artifactAction(
  transcriptReady: boolean,
  artifactPath: string | undefined,
): ArtifactActionViewModel {
  const available = transcriptReady && Boolean(artifactPath);
  return { visible: available, enabled: available };
}

function transcriptSource(workflow: WorkflowState): TranscriptSourceViewModel {
  if (!workflow.transcript) {
    return null;
  }
  return workflow.transcript.source === "subtitle"
    ? { kind: "subtitle", language: workflow.transcript.language }
    : { kind: "asr" };
}

export function createTaskWorkspaceViewModel(
  workflow: WorkflowState,
  account: AccountStatus,
) {
  const transcriptReady = hasSavedTranscript(workflow);
  const aiActive = workflow.activeAiTarget !== null;
  const localProcessing =
    workflow.stage === "video_extracting" ||
    workflow.stage === "video_transcribing" ||
    (workflow.stage === "cancelling" && !isAiCancellation(workflow));
  const localPhase: LocalWorkspacePhase = transcriptReady
    ? "ready"
    : localProcessing
      ? "processing"
      : workflow.stage === "failed"
        ? "failed"
        : "waiting";
  const readOnly = transcriptReady && (aiActive || isAiCancellation(workflow));
  const summary = aiTargetStatus(workflow, "summary", transcriptReady);
  const insights = aiTargetStatus(workflow, "insights", transcriptReady);
  const dissection = aiTargetStatus(workflow, "dissection", transcriptReady);
  const owner = cancellationOwner(workflow);
  const aiPhase: AiWorkspacePhase = !transcriptReady
    ? "waiting_transcript"
    : aiActive || isAiCancellation(workflow)
      ? "generating"
      : "ready";

  return {
    banner: {
      ...(transcriptReady
        ? {
            kind: "local_complete" as const,
            message: uiMessage(
              workflow.taskSource?.kind === "local_file" &&
                workflow.taskSource.mediaKind === "audio"
                ? "workflow.banner.localAudioCompleteMessage"
                : "workflow.banner.localCompleteMessage",
            ),
            progressMessage: null,
          }
        : localPhase === "failed"
          ? {
              kind: "local_failed" as const,
              message: workflow.error?.code
                ? uiMessage("workflow.banner.localFailedWithCode", {
                    code: workflow.error.code,
                  })
                : uiMessage("workflow.banner.localFailedMessage"),
              progressMessage: null,
            }
          : {
              kind: localProcessing ? ("local_processing" as const) : ("idle" as const),
              message: workflow.progressMessage === null ? workflow.statusMessage : null,
              progressMessage: workflow.progressMessage,
            }),
      stage: workflow.stage,
    } satisfies TaskStatusBannerViewModel,
    cancellationOwner: owner,
    local: {
      taskId: workflow.taskId,
      sourceMediaKind:
        workflow.taskSource?.kind === "local_file"
          ? workflow.taskSource.mediaKind
          : null,
      phase: localPhase,
      progressSteps: localProgressSteps(workflow),
      canReview: transcriptReady,
      canEdit: transcriptReady && !readOnly,
      readOnly,
      cancellation: workspaceCancellation(owner, "local", workflow),
      artifactActions: {
        locateVideo: artifactAction(
          transcriptReady,
          workflow.artifacts.video,
        ),
        locateAudio: artifactAction(
          transcriptReady,
          workflow.artifacts.audio,
        ),
      },
      transcriptSource: transcriptSource(workflow),
      error: !transcriptReady && workflow.error?.stage !== "insights_generating"
        ? workflow.error
        : null,
    },
    ai: {
      visible: transcriptReady,
      taskId: workflow.taskId,
      phase: aiPhase,
      availability: aiAvailability(account),
      activeTarget: workflow.activeAiTarget,
      progressMessage:
        aiActive || isAiCancellation(workflow) ? workflow.progressMessage : null,
      cancellation: workspaceCancellation(owner, "ai", workflow),
      summary,
      insights,
      dissection,
      dissectionAvailable: workflow.dissection !== null,
      dissectionStale: workflow.dissectionStale,
    },
  };
}

export type TaskWorkspaceViewModel = ReturnType<typeof createTaskWorkspaceViewModel>;
