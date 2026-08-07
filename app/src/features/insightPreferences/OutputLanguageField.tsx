import type { SupportedLocale } from "../../i18n/locale";
import {
  getOutputLanguageName,
  getPreferenceCopy,
} from "../../i18n/preferencePresentation";

type OutputLanguageFieldProps = {
  locale: SupportedLocale;
  outputLanguage: SupportedLocale;
};

export function OutputLanguageField({
  locale,
  outputLanguage,
}: OutputLanguageFieldProps) {
  const copy = getPreferenceCopy(locale).outputLanguage;
  return (
    <div data-output-language={outputLanguage}>
      <span className="account-status-label">{copy.label}</span>
      <strong>{getOutputLanguageName(locale, outputLanguage)}</strong>
    </div>
  );
}
