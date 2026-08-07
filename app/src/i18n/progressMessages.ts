import {
  isKnownAsrModelDownloadMessageCode,
  isKnownWorkerMessageCode,
  type AsrModelDownloadWireStatus,
  type ProgressMessageDescriptor,
  type WorkflowStage,
} from "../desktopWorkerProtocol";
import type { AsrModelDownloadLocalPhase } from "../modelDownloadState";
import { StudyMindI18n } from "./i18n";
import type { SupportedLocale } from "./locale";

type Translate = (
  key: string,
  options?: Record<string, string | number>,
) => string;

function progressTranslator(locale: SupportedLocale): Translate {
  return StudyMindI18n.getFixedT(locale, "progress") as unknown as Translate;
}

function codeResourceKey(prefix: "worker" | "model", code: string): string {
  return `${prefix}.${code.replace(/\./g, "_")}`;
}

function appendSafeDetails(
  translate: Translate,
  message: string,
  descriptor: ProgressMessageDescriptor,
): string {
  const details: string[] = [];
  if (descriptor.args.language !== undefined) {
    details.push(
      translate("details.language", { language: descriptor.args.language }),
    );
  }
  if (descriptor.args.model !== undefined) {
    details.push(translate("details.model", { model: descriptor.args.model }));
  }
  if (
    descriptor.args.attempt !== undefined &&
    descriptor.args.total !== undefined
  ) {
    details.push(
      translate("details.retry", {
        attempt: descriptor.args.attempt,
        total: descriptor.args.total,
      }),
    );
  }
  return details.length > 0 ? `${message} ${details.join(" · ")}` : message;
}

export function renderWorkerProgressMessage(
  locale: SupportedLocale,
  stage: WorkflowStage,
  descriptor: ProgressMessageDescriptor,
): string {
  const translate = progressTranslator(locale);
  if (!isKnownWorkerMessageCode(descriptor.messageCode)) {
    return translate(`workerFallback.${stage}`);
  }
  return appendSafeDetails(
    translate,
    translate(codeResourceKey("worker", descriptor.messageCode)),
    descriptor,
  );
}

export function renderAsrModelDownloadMessage(
  locale: SupportedLocale,
  state: {
    phase: AsrModelDownloadLocalPhase;
    wireStatus: AsrModelDownloadWireStatus | null;
    message: ProgressMessageDescriptor | null;
  },
): string {
  const translate = progressTranslator(locale);
  if (
    state.message &&
    isKnownAsrModelDownloadMessageCode(state.message.messageCode)
  ) {
    return appendSafeDetails(
      translate,
      translate(codeResourceKey("model", state.message.messageCode)),
      state.message,
    );
  }
  if (state.phase !== "running") {
    return translate(`modelPhaseFallback.${state.phase}`);
  }
  if (state.wireStatus) {
    return translate(`modelStatusFallback.${state.wireStatus}`);
  }
  return translate(`modelPhaseFallback.${state.phase}`);
}
