export type Locale = "zh-CN" | "en" | "zh-TW";
export const DEFAULT_LOCALE: Locale = "zh-CN";
export const SUPPORTED_LOCALES: readonly Locale[] = ["zh-CN", "en", "zh-TW"];
export const LOCALE_LABELS: Record<Locale, string> = { "zh-CN": "中文", en: "English", "zh-TW": "繁體中文" };
export const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const strings: Record<Locale, Record<string, string>> = {
  "zh-CN": { "login.title": "StudyMind 登录", "login.intro": "输入邮箱获取验证码，验证后返回 StudyMind 客户端。", "lang.select": "语言" },
  "zh-TW": { "login.title": "StudyMind 登入", "login.intro": "輸入電子郵件取得驗證碼，驗證後返回 StudyMind 用戶端。", "lang.select": "語言" },
  en: { "login.title": "StudyMind Login", "login.intro": "Enter your email to receive a verification code and return to StudyMind.", "lang.select": "Language" },
};

export function resolveLocale(value: unknown): Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value) ? value as Locale : DEFAULT_LOCALE;
}

export function t(locale: Locale, key: string): string { return strings[locale][key] ?? strings[DEFAULT_LOCALE][key] ?? key; }
export function extractQueryLang(query: unknown): string | null { const value = (query as Record<string, unknown> | undefined)?.lang; return typeof value === "string" ? value : null; }
export function resolveCookieLocale(header: string | null | undefined): Locale | null {
  const raw = header?.match(/(?:^|;\s*)studymind_locale=([^;]+)/)?.[1];
  if (!raw) return null;
  try { const decoded = decodeURIComponent(raw); return (SUPPORTED_LOCALES as readonly string[]).includes(decoded) ? decoded as Locale : null; }
  catch { return null; }
}
export function detectLocale(input: { cookie?: string | null; queryLang?: string | null; acceptLanguage?: string | null }): Locale {
  const explicit = resolveCookieLocale(input.cookie) ?? ((SUPPORTED_LOCALES as readonly string[]).includes(input.queryLang ?? "") ? input.queryLang as Locale : null);
  if (explicit) return explicit;
  const ranges = (input.acceptLanguage ?? "").split(",").map((part) => part.trim().split(";")[0]?.toLowerCase() ?? "");
  for (const range of ranges) {
    if (range === "zh-tw" || range.startsWith("zh-hant")) return "zh-TW";
    if (range === "zh" || range === "zh-cn" || range.startsWith("zh-hans")) return "zh-CN";
    if (range === "en" || range.startsWith("en-")) return "en";
  }
  return DEFAULT_LOCALE;
}
export function renderLangSwitcher(locale: Locale): string {
  const options = SUPPORTED_LOCALES.map((value) => `<option value="${value}"${value === locale ? " selected" : ""}>${LOCALE_LABELS[value]}</option>`).join("");
  return `<select class="lang-switch" aria-label="${t(locale, "lang.select")}">${options}</select><script>(function(){var selector=document.currentScript.previousElementSibling;if(!selector)return;selector.addEventListener("change",function(){var target=selector.value;document.cookie = "studymind_locale=" + encodeURIComponent(target) + "; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax";window.location.reload()})})()</script>`;
}
export function langSwitcherStyles(): string { return ".lang-switch{min-height:34px;padding:6px 12px}"; }
export function dateLocale(locale: Locale): string { return locale; }
