import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { I18nextProvider } from "react-i18next";
import { getUiPreferences, saveUiPreferences } from "../settingsClient";
import { StudyMindI18n } from "./i18n";
import { LanguagePreferenceQueue } from "./languagePreferenceQueue";
import { renderUiMessage, uiMessage, type UiMessage } from "./uiMessage";
import {
  navigatorLanguageSource,
  observeSystemLocale,
  resolveLanguagePreference,
  syncDocumentLocale,
  type LanguagePreference,
  type SupportedLocale,
  type SystemLanguageSource,
} from "./locale";
import type { StartupLocaleOutcome } from "./startup";

export type LocalePersistence = {
  read(): Promise<LanguagePreference>;
  save(preference: LanguagePreference): Promise<LanguagePreference>;
};

export type LocaleContextValue = {
  preference: LanguagePreference;
  resolvedLocale: SupportedLocale;
  setLanguagePreference(preference: LanguagePreference): void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

const defaultPersistence: LocalePersistence = {
  async read() {
    return (await getUiPreferences()).language;
  },
  async save(preference) {
    return (await saveUiPreferences(preference)).language;
  },
};

export type LocaleProviderProps = {
  children: ReactNode;
  initialOutcome: StartupLocaleOutcome;
  languageSource?: SystemLanguageSource;
  persistence?: LocalePersistence;
};

function getNoticeText(
  notice: UiMessage,
  locale: SupportedLocale,
): string {
  return renderUiMessage(locale, notice);
}

export function LocaleProvider({
  children,
  initialOutcome,
  languageSource = navigatorLanguageSource,
  persistence = defaultPersistence,
}: LocaleProviderProps) {
  const [preference, setPreference] = useState(initialOutcome.preference);
  const [resolvedLocale, setResolvedLocale] = useState(initialOutcome.resolvedLocale);
  const [notice, setNotice] = useState<UiMessage | null>(initialOutcome.notice);

  const applyResolvedLocale = useCallback((locale: SupportedLocale) => {
    setResolvedLocale(locale);
    syncDocumentLocale(locale);
    void StudyMindI18n.changeLanguage(locale);
  }, []);

  const applyPreference = useCallback(
    (nextPreference: LanguagePreference) => {
      setPreference(nextPreference);
      applyResolvedLocale(
        resolveLanguagePreference(nextPreference, languageSource.getLanguages()),
      );
    },
    [applyResolvedLocale, languageSource],
  );

  const applyPreferenceRef = useRef(applyPreference);
  applyPreferenceRef.current = applyPreference;
  const queueRef = useRef<LanguagePreferenceQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new LanguagePreferenceQueue({
      persistedAnchor: initialOutcome.persistedAnchor,
      read: () => persistence.read(),
      save: (nextPreference) => persistence.save(nextPreference),
      apply: (nextPreference) => applyPreferenceRef.current(nextPreference),
      onLatestSaveFailure: () =>
        setNotice(uiMessage("settings.language.saveFailed")),
    });
  }

  const setLanguagePreference = useCallback((nextPreference: LanguagePreference) => {
    setNotice(null);
    void queueRef.current?.select(nextPreference);
  }, []);

  useEffect(() => {
    return observeSystemLocale(preference, languageSource, applyResolvedLocale);
  }, [applyResolvedLocale, languageSource, preference]);

  useEffect(() => {
    syncDocumentLocale(resolvedLocale);
  }, [resolvedLocale]);

  const value = useMemo<LocaleContextValue>(
    () => ({ preference, resolvedLocale, setLanguagePreference }),
    [preference, resolvedLocale, setLanguagePreference],
  );

  return (
    <I18nextProvider i18n={StudyMindI18n}>
      <LocaleContext.Provider value={value}>
        {notice ? (
          <div className="locale-recovery-notice" role="status" aria-live="polite">
            {getNoticeText(notice, resolvedLocale)}
          </div>
        ) : null}
        {children}
      </LocaleContext.Provider>
    </I18nextProvider>
  );
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used inside LocaleProvider");
  }
  return context;
}
