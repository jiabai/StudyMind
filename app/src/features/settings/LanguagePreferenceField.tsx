import { useTranslation } from "react-i18next";
import { isLanguagePreference, type LanguagePreference } from "../../i18n/locale";
import { useLocale } from "../../i18n/LocaleProvider";

const LANGUAGE_OPTIONS: Array<{
  value: LanguagePreference;
  labelKey:
    | "language.options.system"
    | "language.options.zhCN"
    | "language.options.zhTW"
    | "language.options.enUS";
}> = [
  { value: "system", labelKey: "language.options.system" },
  { value: "zh-CN", labelKey: "language.options.zhCN" },
  { value: "zh-TW", labelKey: "language.options.zhTW" },
  { value: "en-US", labelKey: "language.options.enUS" },
];

export function LanguagePreferenceField() {
  const { t } = useTranslation("settings");
  const { preference, setLanguagePreference } = useLocale();

  return (
    <section className="sheet-form-section language-settings-section">
      <div className="form-section-heading">
        <h3>{t("language.title")}</h3>
        <p>{t("language.description")}</p>
      </div>
      <label className="field-row" htmlFor="ui-language-preference">
        <span>{t("language.label")}</span>
        <select
          id="ui-language-preference"
          value={preference}
          onChange={(event) => {
            const nextPreference = event.currentTarget.value;
            if (isLanguagePreference(nextPreference)) {
              setLanguagePreference(nextPreference);
            }
          }}
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option value={option.value} key={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
