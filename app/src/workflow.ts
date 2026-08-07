export type { Insight } from "./insightPreferences";
export * from "./workflowState";
export * from "./workerErrorCopy";
export * from "./taskArtifacts";
export * from "./taskWorkspaceViewModel";


export function canSubmitUrl(_url: string): boolean { return false; }

export function normalizeSubmitUrl(url: string): string { return url; }