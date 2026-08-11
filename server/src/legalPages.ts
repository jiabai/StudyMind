import { langSwitcherStyles, renderLangSwitcher, resolveLocale, t, type Locale } from "./i18n.js";
import { smBaseCss, smTokenCss } from "./designtokens.js";

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
  return `<!doctype html><html lang="${resolvedLocale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>StudyMind · ${title}</title><style>${smTokenCss()}${smBaseCss()}main{background:var(--sm-surface);border:1px solid var(--sm-border);border-radius:var(--sm-radius);box-shadow:var(--sm-shadow-raised);margin:40px auto;max-width:720px;padding:32px 36px}header{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 14px;border-bottom:1px solid var(--sm-divider);padding-bottom:16px}header .brand{color:var(--sm-text-soft);font-size:0.82rem;font-weight:700;letter-spacing:0.04em;margin:0;text-transform:uppercase}h1{font-size:1.6rem;line-height:1.25;margin:0}.updated{color:var(--sm-text-soft);font-size:0.8rem;margin:0 0 0 auto}.lang-switch{margin-left:0}${langSwitcherStyles()}p.intro{color:var(--sm-text);font-size:1rem;margin:18px 0 0}section{margin-top:22px}section h2{font-size:1.02rem;margin:0 0 6px}section p{color:var(--sm-text);font-size:0.94rem;margin:0}footer{border-top:1px solid var(--sm-divider);margin-top:28px;padding-top:14px}footer a{color:var(--sm-link);font-size:0.86rem;text-decoration:none}footer a:hover{text-decoration:underline}@media (max-width:640px){main{margin:16px;padding:22px 20px}}</style></head><body><main><header><p class="brand">StudyMind</p><h1>${title}</h1><p class="updated">${t(resolvedLocale, `${kind}.updated`)}</p>${renderLangSwitcher(resolvedLocale)}</header><p class="intro">${t(resolvedLocale, `${kind}.intro`)}</p>${sections}${footer}</main></body></html>`;
}

