/**
 * Shared design tokens and base element styles for StudyMind server-rendered
 * web pages (login / dashboard / admin).
 *
 * These pages are standalone HTML documents served as strings, so each page
 * injects {@link smTokenCss} (the `:root` token block) followed by
 * {@link smBaseCss} (shared element defaults) into its own `<style>`, then
 * adds page-specific layout that references `var(--sm-*)`.
 *
 * The token values follow an established server-web design pattern with StudyMind's brand
 * primary `#7e9b8a` (Morandi sage, aligned with the desktop app).
 *
 * Note: this module is intentionally server-web only. It is NOT imported by the
 * desktop app, which keeps its own token system.
 */

/** Brand-aligned design tokens shared by every server web page. */
export function smTokenCss(): string {
  return `
    :root {
      color-scheme: light;
      /* surfaces */
      --sm-bg: #f6f2e7;
      --sm-surface: #ffffff;
      --sm-surface-soft: #f3f0e8;
      /* text */
      --sm-text: #2a2a24;
      --sm-text-soft: #7c766a;
      --sm-text-on-primary: #ffffff;
      /* brand / semantic */
      --sm-primary: #7e9b8a;
      --sm-primary-pressed: #64806f;
      --sm-primary-soft: #edf0e2;
      --sm-focus-ring: rgba(126, 155, 138, 0.22);
      --sm-link: #64806f;
      --sm-success: #4d7a5e;
      --sm-success-soft: #edf1e7;
      --sm-danger: #a85a52;
      --sm-danger-soft: #f6ede9;
      --sm-warning: #8a6d3f;
      /* lines */
      --sm-border: #e3dfd3;
      --sm-border-strong: #d8d2c4;
      --sm-divider: #efece2;
      /* shape */
      --sm-radius: 8px;
      --sm-radius-sm: 6px;
      --sm-radius-pill: 999px;
      /* elevation */
      --sm-shadow-card: 0 1px 2px rgba(70, 62, 48, 0.05), 0 6px 20px rgba(70, 62, 48, 0.06);
      --sm-shadow-raised: 0 10px 40px rgba(70, 62, 48, 0.1);
      /* type */
      --sm-font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      --sm-font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
  `;
}

/**
 * Shared base element styles. Pages must still apply layout (body placement,
 * cards, headers) on top of these defaults.
 */
export function smBaseCss(): string {
  return `
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: var(--sm-font);
      background: var(--sm-bg);
      color: var(--sm-text);
      font-size: 16px;
      line-height: 1.5;
    }
    h1, h2, h3, p { margin: 0; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button { border: 0; cursor: pointer; background: none; }
    button:disabled { cursor: not-allowed; opacity: 0.58; }
    input, select, textarea {
      background: var(--sm-surface);
      border: 1px solid var(--sm-border-strong);
      border-radius: var(--sm-radius);
      color: var(--sm-text);
      min-height: 42px;
      padding: 0 12px;
      width: 100%;
      outline: none;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--sm-primary);
      box-shadow: 0 0 0 3px var(--sm-focus-ring);
    }
    code {
      font-family: var(--sm-font-mono);
    }
  `;
}
