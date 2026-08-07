import type { UiPreferencesView } from "../settingsClient";
import { uiMessage, type UiMessage } from "./uiMessage";
import {
  resolveLanguagePreference,
  type LanguagePreference,
  type SupportedLocale,
} from "./locale";

export const STARTUP_LOCALE_TIMEOUT_MS = 1_500;

export type StartupLocaleOutcome = {
  preference: LanguagePreference;
  resolvedLocale: SupportedLocale;
  persistedAnchor: LanguagePreference | null;
  notice: UiMessage | null;
};

export type StartupLocaleOptions = {
  readPreferences: () => Promise<UiPreferencesView>;
  getSystemLanguages: () => readonly string[];
  timeoutMs?: number;
};

type ReadOutcome =
  | { kind: "loaded"; preferences: UiPreferencesView }
  | { kind: "failed" }
  | { kind: "timed-out" };

export async function resolveStartupLocale({
  readPreferences,
  getSystemLanguages,
  timeoutMs = STARTUP_LOCALE_TIMEOUT_MS,
}: StartupLocaleOptions): Promise<StartupLocaleOutcome> {
  const readOutcome: Promise<ReadOutcome> = Promise.resolve()
    .then(readPreferences)
    .then(
      (preferences) => ({ kind: "loaded", preferences }),
      () => ({ kind: "failed" }),
    );

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutOutcome = new Promise<ReadOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
  });
  const outcome = await Promise.race([readOutcome, timeoutOutcome]);

  if (outcome.kind !== "timed-out" && timeoutHandle !== undefined) {
    clearTimeout(timeoutHandle);
  }

  const systemLanguages = getSystemLanguages();
  if (outcome.kind === "loaded") {
    const preference = outcome.preferences.language;
    return {
      preference,
      resolvedLocale: resolveLanguagePreference(preference, systemLanguages),
      persistedAnchor: preference,
      notice: outcome.preferences.recovered
        ? uiMessage("bootstrap.preferencesRecovered")
        : null,
    };
  }

  return {
    preference: "en-US",
    resolvedLocale: "en-US",
    persistedAnchor: null,
    notice:
      outcome.kind === "timed-out"
        ? uiMessage("bootstrap.preferencesReadTimedOut")
        : uiMessage("bootstrap.preferencesReadFailed"),
  };
}

export async function startLocalizedApplication(
  options: StartupLocaleOptions & {
    initialize: (locale: SupportedLocale) => void | Promise<void>;
    mount: (outcome: StartupLocaleOutcome) => void;
  },
): Promise<StartupLocaleOutcome> {
  const outcome = await resolveStartupLocale(options);
  await options.initialize(outcome.resolvedLocale);
  options.mount(outcome);
  return outcome;
}
