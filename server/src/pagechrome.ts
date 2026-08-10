/**
 * Shared StudyMind brand chrome for server-rendered web pages.
 *
 * Brand identity (the `SM` monogram tile, its row layout and the eyebrow label)
 * must read as one product across `/login`, `/dashboard`, `/admin/login` and
 * `/admin`. Each page injects {@link brandChromeCss} into its `<style>` and
 * composes its header with {@link renderBrandMark}, so the brand mark is defined
 * once instead of being copy-pasted per page.
 *
 * The brand mark is decorative (`aria-hidden`): the accessible product/page name
 * comes from the heading in each header.
 */

/** Shared CSS for `.brand-row`, `.brand-mark` and `.eyebrow`. Consumes `var(--sm-*)`. */
export function brandChromeCss(): string {
  return `
    .brand-row { align-items: center; display: flex; gap: 12px; min-width: 0; }
    .brand-mark {
      align-items: center;
      background: var(--sm-primary);
      border-radius: var(--sm-radius);
      color: var(--sm-text-on-primary);
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 0.78rem;
      font-weight: 800;
      height: 38px;
      justify-content: center;
      letter-spacing: 0;
      width: 38px;
    }
    .eyebrow {
      color: var(--sm-text-soft);
      font-size: 0.74rem;
      font-weight: 760;
      letter-spacing: 0;
      margin-bottom: 3px;
      text-transform: uppercase;
    }
  `;
}

/** Renders the StudyMind `SM` monogram tile. Decorative — not exposed to AT. */
export function renderBrandMark(): string {
  return `<span class="brand-mark" aria-hidden="true">SM</span>`;
}

/**
 * Inlined favicon SVG for StudyMind. Color (`#1668dc`) matches `--sm-primary`.
 */
const STUDYMIND_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
  '<rect width="64" height="64" rx="14" fill="#1668dc"/>' +
  '<text x="32" y="45" font-family="-apple-system, \'Segoe UI\', system-ui, sans-serif" font-size="36" font-weight="700" text-anchor="middle" fill="#ffffff">SM</text>' +
  "</svg>";

const STUDYMIND_FAVICON_URI = `data:image/svg+xml;base64,${Buffer.from(STUDYMIND_FAVICON_SVG, "utf8").toString("base64")}`;

/** `<link rel="icon">` for the StudyMind mark. */
export function faviconLink(): string {
  return `<link rel="icon" type="image/svg+xml" href="${STUDYMIND_FAVICON_URI}" />`;
}

/** Options for {@link renderSmHeader}. */
export type SmHeaderOptions = {
  /** Optional eyebrow label above the title (e.g. "StudyMind Admin"). */
  eyebrow?: string;
  /** Page title. */
  title: string;
  /** Optional id for the title heading (for `aria-labelledby` on a section). */
  titleId?: string;
  /** Optional HTML rendered under the title (e.g. an email subtitle). */
  subtitleHtml?: string;
  /** Optional HTML for the right-side actions (logout, session chip…). */
  rightHtml?: string;
  /** Optional class for the `<header>` wrapper. */
  wrapperClass?: string;
};

/**
 * Renders the shared StudyMind page header: a `<header>` containing the brand row
 * (brand mark + optional eyebrow / title / subtitle) and an optional right-side
 * actions slot. Pages pass their own title and right-side HTML.
 */
export function renderSmHeader(options: SmHeaderOptions): string {
  const { eyebrow, title, titleId, subtitleHtml, rightHtml, wrapperClass } = options;
  const classAttr = wrapperClass ? ` class="${wrapperClass}"` : "";
  const idAttr = titleId ? ` id="${titleId}"` : "";
  const titleBlock = [
    eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : "",
    `<h1${idAttr}>${title}</h1>`,
    subtitleHtml ?? "",
  ]
    .filter(Boolean)
    .join("\n          ");
  const rightBlock = rightHtml ? `\n        ${rightHtml}` : "";
  return `      <header${classAttr}>
        <div class="brand-row">
          ${renderBrandMark()}
          <div>
            ${titleBlock}
          </div>
        </div>${rightBlock}
      </header>`;
}
