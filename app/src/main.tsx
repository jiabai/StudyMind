import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getUiPreferences } from "./settingsClient";
import { initializeI18n } from "./i18n/i18n";
import { LocaleProvider } from "./i18n/LocaleProvider";
import { navigatorLanguageSource, syncDocumentLocale } from "./i18n/locale";
import { startLocalizedApplication } from "./i18n/startup";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("StudyMind root element is missing");
}

void startLocalizedApplication({
  readPreferences: getUiPreferences,
  getSystemLanguages: () => navigatorLanguageSource.getLanguages(),
  initialize: async (locale) => {
    await initializeI18n(locale);
    syncDocumentLocale(locale);
  },
  mount: (outcome) => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <LocaleProvider initialOutcome={outcome}>
          <App />
        </LocaleProvider>
      </React.StrictMode>,
    );
  },
});
