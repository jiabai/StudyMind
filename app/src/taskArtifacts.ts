import type { Insight } from "./insightPreferences";
import type { SupportedLocale } from "./i18n/locale";
import { resources } from "./i18n/resources";
import type { TaskArtifactKey, WorkflowState } from "./workflowState";

export type DetailTab = "summary" | "insights" | "dissection" | "transcript";
export type ExportTarget = DetailTab | "video" | "audio";

export function getDetailText(
  tab: DetailTab,
  state: WorkflowState,
  locale: SupportedLocale,
): string {
  if (tab === "transcript") {
    return state.text.trim();
  }
  if (tab === "summary") {
    return state.summary.trim();
  }
  if (tab === "dissection") {
    const report = state.dissection;
    if (!report) {
      return "";
    }
    return [
      report.overallNarrative.structureType,
      ...report.segments.flatMap((segment) => [
        segment.title,
        segment.coreClaim,
        ...segment.supportingPoints,
        ...segment.rhetoricalDevices,
        segment.rhythmNote,
        segment.reusablePattern,
        ...segment.riskFlags,
      ]),
      report.reusableTemplate.name,
      ...report.reusableTemplate.skeleton,
      ...report.highlights.slice(0, 8),
      ...report.strengths.slice(0, 6),
      ...report.weaknesses.slice(0, 6),
      ...report.audienceFit.flatMap((item) => [item.audience, item.note]),
    ].filter(Boolean).join("\n");
  }
  return state.insights
    .map((insight, index) => formatInsightForCopy(insight, index, locale))
    .join("\n\n");
}

function formatInsightForCopy(
  insight: Insight,
  index: number,
  locale: SupportedLocale,
): string {
  const copy = resources[locale].synthesis.detail;
  const separator = copy.fieldSeparator;
  const questions = new Intl.ListFormat(locale, {
    style: "long",
    type: "conjunction",
  }).format(insight.followUpQuestions);
  return [
    `${index + 1}. ${insight.topic}`,
    `${copy.matchReason}${separator}${insight.matchReason}`,
    `${copy.questions}${separator}${questions}`,
    `${copy.suitableUse}${separator}${insight.suitableUse}`,
    insight.sourceChunkId === null
      ? ""
      : `${copy.sourceChunk}${separator}${insight.sourceChunkId}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function getExportPath(tab: ExportTarget, state: WorkflowState): string | null {
  if (tab === "video" || tab === "audio") {
    return getTaskArtifactPath(state, tab);
  }
  if (tab === "transcript") {
    return getTaskArtifactPath(state, "transcript_txt");
  }
  if (tab === "summary") {
    return getTaskArtifactPath(state, "summary");
  }
  if (tab === "dissection") {
    return getTaskArtifactPath(state, "dissection_md");
  }
  return getTaskArtifactPath(state, "insights_md") ?? getTaskArtifactPath(state, "insights");
}

export function hasArtifact(state: WorkflowState, key: TaskArtifactKey): boolean {
  return Boolean(state.taskDir && state.artifacts[key]);
}

export function getTaskArtifactPath(
  state: WorkflowState,
  key: TaskArtifactKey,
): string | null {
  const artifact = state.artifacts[key];
  if (!state.taskDir || !artifact) {
    return null;
  }
  return joinTaskArtifactPath(state.taskDir, artifact);
}

export function joinTaskArtifactPath(taskDir: string, artifact: string): string {
  const separator = taskDir.includes("\\") ? "\\" : "/";
  const normalizedTaskDir = taskDir.replace(/[\\/]+$/, "");
  const normalizedArtifact = artifact.replace(/^[\\/]+/, "").replace(/[\\/]+/g, separator);
  return `${normalizedTaskDir}${separator}${normalizedArtifact}`;
}
