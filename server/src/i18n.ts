export type Locale = "zh-CN" | "en" | "zh-TW";
export const DEFAULT_LOCALE: Locale = "zh-CN";
export const SUPPORTED_LOCALES: readonly Locale[] = ["zh-CN", "en", "zh-TW"];
export const LOCALE_LABELS: Record<Locale, string> = { "zh-CN": "中文", en: "English", "zh-TW": "繁體中文" };
export const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

const strings: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "login.title": "StudyMind 登录",
    "login.intro": "输入邮箱获取验证码，验证后返回 StudyMind 客户端。",
    "lang.select": "语言",
    "privacy.title": "隐私政策",
    "privacy.updated": "更新日期：2026-08-10",
    "privacy.intro": "本隐私政策说明 StudyMind 客户端与账号服务如何处理你的信息。",
    "privacy.s1.title": "我们收集的信息",
    "privacy.s1.body": "账号服务仅处理提供服务所必需的信息：邮箱地址、激活码、授权状态与 AI Credits 用量。",
    "privacy.s2.title": "本地优先存储",
    "privacy.s2.body": "音视频文件、带时间戳的文字稿、历史课题与标注均保存在你的设备上，不会自动上传到服务器。",
    "privacy.s3.title": "云端处理",
    "privacy.s3.body": "生成 AI 结果时，客户端仅向云端 LLM 发送必要的文字稿片段，视频与音频不会被上传。LLM 配置由管理员在服务端统一管理。",
    "privacy.s4.title": "数据保留与删除",
    "privacy.s4.body": "账号与授权记录按服务运营需要保留。删除课题会同时移除本机的视频、音频、文字稿、AI 结果与播放缓存。如需删除账号数据，请联系管理员。",
    "privacy.s5.title": "联系我们",
    "privacy.s5.body": "如对本隐私政策有任何疑问，请联系部署本服务的机构管理员。",
    "terms.title": "服务条款",
    "terms.updated": "更新日期：2026-08-10",
    "terms.intro": "使用 StudyMind 即表示你同意本服务条款。",
    "terms.s1.title": "服务说明",
    "terms.s1.body": "StudyMind 是本地优先的学习笔记工具，提供课堂录音与讲座录像的转写、文字稿校验与 AI 知识点总结功能。",
    "terms.s2.title": "账号与激活码",
    "terms.s2.body": "账号由管理员统一发放。激活码用于兑换授权期限与 AI Credits，请勿共享或转售激活码。",
    "terms.s3.title": "可接受使用",
    "terms.s3.body": "你仅可将本服务用于合法用途，不得利用本服务侵犯他人权利或干扰服务的正常运行。",
    "terms.s4.title": "免责声明",
    "terms.s4.body": "AI 生成内容仅供参考，不构成权威学习材料，请以课堂讲授与教材为准。服务按现状提供，不保证不间断或无差错。",
    "terms.s5.title": "服务变更与终止",
    "terms.s5.body": "管理员可调整服务功能、额度与政策。违反本条款可能导致账号停用。",
    "terms.s6.title": "联系我们",
    "terms.s6.body": "如对本服务条款有任何疑问，请联系部署本服务的机构管理员。",
  },
  "zh-TW": {
    "login.title": "StudyMind 登入",
    "login.intro": "輸入電子郵件取得驗證碼，驗證後返回 StudyMind 用戶端。",
    "lang.select": "語言",
    "privacy.title": "隱私政策",
    "privacy.updated": "更新日期：2026-08-10",
    "privacy.intro": "本隱私政策說明 StudyMind 用戶端與帳號服務如何處理你的資訊。",
    "privacy.s1.title": "我們收集的資訊",
    "privacy.s1.body": "帳號服務僅處理提供服務所必需的資訊：電子郵件地址、啟用碼、授權狀態與 AI Credits 用量。",
    "privacy.s2.title": "本機優先儲存",
    "privacy.s2.body": "音訊、影片檔案、帶時間戳的逐字稿、歷史課題與標註均儲存在你的裝置上，不會自動上傳到伺服器。",
    "privacy.s3.title": "雲端處理",
    "privacy.s3.body": "產生 AI 結果時，用戶端僅向雲端 LLM 傳送必要的逐字稿片段，影片與音訊不會被上傳。LLM 設定由管理員在伺服器端統一管理。",
    "privacy.s4.title": "資料保留與刪除",
    "privacy.s4.body": "帳號與授權記錄依服務營運需要保留。刪除課題會同時移除本機的影片、音訊、逐字稿、AI 結果與播放快取。如需刪除帳號資料，請聯絡管理員。",
    "privacy.s5.title": "聯絡我們",
    "privacy.s5.body": "如對本隱私政策有任何疑問，請聯絡部署本服務的機構管理員。",
    "terms.title": "服務條款",
    "terms.updated": "更新日期：2026-08-10",
    "terms.intro": "使用 StudyMind 即表示你同意本服務條款。",
    "terms.s1.title": "服務說明",
    "terms.s1.body": "StudyMind 是本機優先的學習筆記工具，提供課堂錄音與講座錄影的轉寫、逐字稿校驗與 AI 知識點總結功能。",
    "terms.s2.title": "帳號與啟用碼",
    "terms.s2.body": "帳號由管理員統一發放。啟用碼用於兌換授權期限與 AI Credits，請勿共享或轉售啟用碼。",
    "terms.s3.title": "可接受使用",
    "terms.s3.body": "你僅可將本服務用於合法用途，不得利用本服務侵犯他人權利或干擾服務的正常運作。",
    "terms.s4.title": "免責聲明",
    "terms.s4.body": "AI 產生內容僅供參考，不構成權威學習材料，請以課堂講授與教材為準。服務按現況提供，不保證不中斷或無錯誤。",
    "terms.s5.title": "服務變更與終止",
    "terms.s5.body": "管理員可調整服務功能、額度與政策。違反本條款可能導致帳號停用。",
    "terms.s6.title": "聯絡我們",
    "terms.s6.body": "如對本服務條款有任何疑問，請聯絡部署本服務的機構管理員。",
  },
  en: {
    "login.title": "StudyMind Login",
    "login.intro": "Enter your email to receive a verification code and return to StudyMind.",
    "lang.select": "Language",
    "privacy.title": "Privacy Policy",
    "privacy.updated": "Last updated: 2026-08-10",
    "privacy.intro": "This Privacy Policy explains how the StudyMind desktop app and account service handle your information.",
    "privacy.s1.title": "Information we collect",
    "privacy.s1.body": "The account service only processes what is required to provide the service: email address, activation codes, authorization status, and AI Credits usage.",
    "privacy.s2.title": "Local-first storage",
    "privacy.s2.body": "Audio, video, timestamped transcripts, topic history, and annotations stay on your device and are never uploaded automatically.",
    "privacy.s3.title": "Cloud processing",
    "privacy.s3.body": "When generating AI results, the app sends only the necessary transcript excerpts to the cloud LLM; video and audio are never uploaded. LLM configuration is managed centrally by an administrator.",
    "privacy.s4.title": "Retention and deletion",
    "privacy.s4.body": "Account and authorization records are kept as long as the service needs them. Deleting a topic also removes its video, audio, transcript, AI results, and playback cache from your device. To delete account data, contact your administrator.",
    "privacy.s5.title": "Contact us",
    "privacy.s5.body": "If you have any questions about this Privacy Policy, contact the administrator who deployed this service.",
    "terms.title": "Terms of Service",
    "terms.updated": "Last updated: 2026-08-10",
    "terms.intro": "By using StudyMind you agree to these Terms of Service.",
    "terms.s1.title": "Service description",
    "terms.s1.body": "StudyMind is a local-first study notes tool that transcribes class recordings and lectures, helps you review transcripts, and generates AI knowledge summaries.",
    "terms.s2.title": "Accounts and activation codes",
    "terms.s2.body": "Accounts are issued by an administrator. Activation codes exchange for authorization periods and AI Credits; do not share or resell them.",
    "terms.s3.title": "Acceptable use",
    "terms.s3.body": "You may use the service only for lawful purposes. You must not use it to infringe others' rights or disrupt the service.",
    "terms.s4.title": "Disclaimer",
    "terms.s4.body": "AI-generated content is provided for reference only and is not authoritative study material; rely on your lectures and textbooks. The service is provided as-is without guarantees of uninterrupted or error-free operation.",
    "terms.s5.title": "Changes and termination",
    "terms.s5.body": "Administrators may adjust features, quotas, and policies. Violating these terms may lead to account suspension.",
    "terms.s6.title": "Contact us",
    "terms.s6.body": "If you have any questions about these Terms, contact the administrator who deployed this service.",
  },
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
