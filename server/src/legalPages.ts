import { langSwitcherStyles, renderLangSwitcher, resolveLocale, t, type Locale } from "./i18n.js";

export type LegalPageKind = "privacy" | "terms";

const SECTIONS: Record<LegalPageKind, number[]> = {
  privacy: [1, 2, 3, 4, 5],
  terms: [1, 2, 3, 4, 5, 6],
};

export function renderLegalPage(kind: LegalPageKind, locale: Locale): string {
  const resolvedLocale = resolveLocale(locale);
  const title = t(resolvedLocale, `${kind}.title`);
  const sections = SECTIONS[kind]
    .map(
      (index) =>
        `<section><h2>${t(resolvedLocale, `${kind}.s${index}.title`)}</h2><p>${t(resolvedLocale, `${kind}.s${index}.body`)}</p></section>`,
    )
    .join("");
  const alternateKind: LegalPageKind = kind === "privacy" ? "terms" : "privacy";
  const footer = `<footer><a href="/${alternateKind}">${t(resolvedLocale, `${alternateKind}.title`)}</a></footer>`;
  return `<!doctype html><html lang="${resolvedLocale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StudyMind · ${title}</title><style>${legalPageStyles()}</style></head><body><main><header><p class="brand">StudyMind</p><h1>${title}</h1><p class="updated">${t(resolvedLocale, `${kind}.updated`)}</p>${renderLangSwitcher(resolvedLocale)}</header><p class="intro">${t(resolvedLocale, `${kind}.intro`)}</p>${sections}${footer}</main></body></html>`;
}

function legalPageStyles(): string {
  return `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef0f4;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","Microsoft YaHei",sans-serif;line-height:1.7;-webkit-font-smoothing:antialiased}main{background:#f6f7fa;border:1px solid rgba(60,60,67,0.14);border-radius:14px;box-shadow:0 24px 60px rgba(28,31,38,0.1);margin:40px auto;max-width:720px;padding:32px 36px}header{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 14px;border-bottom:1px solid rgba(60,60,67,0.12);padding-bottom:16px}header .brand{color:#6e6e73;font-size:0.82rem;font-weight:700;letter-spacing:0.04em;margin:0;text-transform:uppercase}h1{font-size:1.6rem;line-height:1.25;margin:0}.updated{color:#747982;font-size:0.8rem;margin:0 0 0 auto}.lang-switch{margin-left:0}${langSwitcherStyles()}p.intro{color:#34363b;font-size:1rem;margin:18px 0 0}section{margin-top:22px}section h2{font-size:1.02rem;margin:0 0 6px}section p{color:#34363b;font-size:0.94rem;margin:0}footer{border-top:1px solid rgba(60,60,67,0.12);margin-top:28px;padding-top:14px}footer a{color:#0a84ff;font-size:0.86rem;text-decoration:none}footer a:hover{text-decoration:underline}@media (max-width:640px){main{margin:16px;padding:22px 20px}}`;
}
