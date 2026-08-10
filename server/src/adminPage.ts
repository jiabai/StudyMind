import type { ActivationCodeRecord, AdminEntitlementAdjustmentRecord, EntitlementRecord, UserRecord } from "./store.js";
import type { AdminLlmConfigView } from "./llmConfig.js";
import { smBaseCss, smTokenCss } from "./designtokens.js";
import { brandChromeCss, faviconLink, renderSmHeader } from "./pagechrome.js";
import { buildClientStrings, langSwitcherStyles, renderLangSwitcher, type Locale, t } from "./i18n.js";
import { safeJsonForScript } from "./dashboardPage.js";

// ── Utility ──
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value: Date | null | undefined, locale: Locale): string {
  if (!value) return "";
  return escapeHtml(value.toLocaleString(locale === "en" ? "en-US" : "zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
}

function statusBadge(status: string, label: string): string {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function activationStatusText(status: string, locale: Locale): string {
  const labels: Record<string, string> = { active: t(locale, "admin.code_active"), redeemed: t(locale, "admin.code_redeemed"), expired: t(locale, "admin.code_expired"), disabled: t(locale, "admin.code_disabled") };
  return labels[status] ?? status;
}

function adjustmentReasonText(reason: string, locale: Locale): string {
  switch (reason) {
    case "bug_compensation": return t(locale, "admin.reason_bug");
    case "support_goodwill": return t(locale, "admin.reason_goodwill");
    case "manual_repair": return t(locale, "admin.reason_repair");
    default: return t(locale, "admin.reason_other");
  }
}

// ── Admin Login Page ──
export function renderAdminLoginPage(locale: Locale = "zh-CN"): string {
  const i18n = buildClientStrings(locale);
  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t(locale, "admin_login.title")}</title>
  ${faviconLink()}
  <style>${adminLoginStyles(locale)}</style>
</head>
<body class="login-page">
  <main class="login-shell">
    <section class="login-card" aria-labelledby="login-title">
      ${renderSmHeader({
        wrapperClass: "login-card-header",
        eyebrow: "StudyMind Admin",
        title: t(locale, "admin_login.heading"),
        titleId: "login-title",
        rightHtml: renderLangSwitcher(locale),
      })}
      <p class="muted">${t(locale, "admin_login.intro")}</p>
      <form id="admin-login" class="admin-form">
        <label class="field">
          <span>${t(locale, "admin_login.code")}</span>
          <div class="inline-action-field">
            <input id="code" name="code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="${t(locale, "admin_login.code_placeholder")}" required />
            <button id="send-code" class="secondary-button" type="button">${t(locale, "admin_login.send_code")}</button>
          </div>
        </label>
        <button id="signin" class="primary-button" type="submit">${t(locale, "admin_login.signin")}</button>
      </form>
      <p id="status" class="status-message" role="status"></p>
    </section>
  </main>
  <script>
    const i18n = ${JSON.stringify(i18n)};
    const state = "admin-" + crypto.randomUUID();
    const code = document.getElementById("code");
    const status = document.getElementById("status");
    const sendCode = document.getElementById("send-code");
    const signin = document.getElementById("signin");
    function setStatus(msg, tone) { status.textContent = msg; status.dataset.tone = tone || "neutral"; }
    sendCode.addEventListener("click", async () => {
      sendCode.disabled = true; setStatus(i18n["admin_login.status_sending"]);
      try {
        const r = await fetch("/admin/auth/email/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }) });
        setStatus(r.ok ? i18n["admin_login.status_sent"] : i18n["admin_login.status_send_failed"], r.ok ? "success" : "error");
      } catch { setStatus(i18n["admin_login.network_error"], "error"); }
      finally { sendCode.disabled = false; }
    });
    document.getElementById("admin-login").addEventListener("submit", async (e) => {
      e.preventDefault(); signin.disabled = true; setStatus(i18n["admin_login.status_verifying"]);
      try {
        const r = await fetch("/admin/auth/email/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, code: code.value }) });
        if (r.ok) { setStatus(i18n["admin_login.status_success"], "success"); window.location.href = "/admin"; }
        else setStatus(i18n["admin_login.status_code_error"], "error");
      } catch { setStatus(i18n["admin_login.network_error"], "error"); }
      finally { signin.disabled = false; }
    });
  </script>
</body>
</html>`;
}

// ── Admin Dashboard Page ──
export function renderAdminPage(input: {
  adminEmail: string;
  csrfToken: string;
  users: UserRecord[];
  entitlements: Map<string, EntitlementRecord | null>;
  llmConfig: AdminLlmConfigView;
  activationCodes: ActivationCodeRecord[];
  entitlementAdjustments: AdminEntitlementAdjustmentRecord[];
  locale?: Locale;
}): string {
  const locale = input.locale ?? "zh-CN";
  const now = new Date();
  const activeUsers = input.users.filter((u) => {
    const e = input.entitlements.get(u.id);
    return Boolean(e && e.expiresAt > now);
  }).length;
  const availableCodes = input.activationCodes.filter((c) => c.status === "active" && c.redeemedAt === null).length;
  const userEmailsById = new Map(input.users.map((u) => [u.id, u.email]));

  // Monthly trends (last 6 months)
  const monthKeys: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const monthLabels = monthKeys.map((k) => k.slice(5).replace(/^0/, "") + (locale === "en" ? "M" : "月"));
  function monthKey(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
  const signupsByMonth = new Map<string, number>();
  const redemptionsByMonth = new Map<string, number>();
  const adjustmentsByMonth = new Map<string, number>();
  for (const k of monthKeys) { signupsByMonth.set(k, 0); redemptionsByMonth.set(k, 0); adjustmentsByMonth.set(k, 0); }
  for (const u of input.users) { const k = monthKey(u.createdAt); if (signupsByMonth.has(k)) signupsByMonth.set(k, (signupsByMonth.get(k) ?? 0) + 1); }
  for (const c of input.activationCodes) { if (c.redeemedAt) { const k = monthKey(c.redeemedAt); if (redemptionsByMonth.has(k)) redemptionsByMonth.set(k, (redemptionsByMonth.get(k) ?? 0) + 1); } }
  for (const a of input.entitlementAdjustments) { const k = monthKey(a.createdAt); if (adjustmentsByMonth.has(k)) adjustmentsByMonth.set(k, (adjustmentsByMonth.get(k) ?? 0) + 1); }
  const maxSignups = Math.max(1, ...Array.from(signupsByMonth.values()));
  const maxRedeems = Math.max(1, ...Array.from(redemptionsByMonth.values()));
  const maxAdjust = Math.max(1, ...Array.from(adjustmentsByMonth.values()));
  const statsBars = monthKeys.map((k, i) => `<div class="stats-row">
    <span class="stats-month">${monthLabels[i]}</span>
    <div class="stats-bar-group">
      <div class="stats-bar-wrap"><div class="stats-bar stats-bar-signup" style="width:${Math.round((signupsByMonth.get(k) ?? 0) / maxSignups * 100)}%">${signupsByMonth.get(k) ?? 0}</div></div>
      <div class="stats-bar-wrap"><div class="stats-bar stats-bar-redeem" style="width:${Math.round((redemptionsByMonth.get(k) ?? 0) / maxRedeems * 100)}%">${redemptionsByMonth.get(k) ?? 0}</div></div>
      <div class="stats-bar-wrap"><div class="stats-bar stats-bar-adjust" style="width:${Math.round((adjustmentsByMonth.get(k) ?? 0) / maxAdjust * 100)}%">${adjustmentsByMonth.get(k) ?? 0}</div></div>
    </div>
  </div>`).join("");

  // User table
  const userRows = input.users.length
    ? input.users.map((u) => {
        const e = input.entitlements.get(u.id);
        const active = Boolean(e && e.expiresAt > now);
        return `<tr><td>${escapeHtml(u.email)}</td><td>${statusBadge(active ? "active" : "inactive", active ? t(locale, "admin.user_active") : t(locale, "admin.user_inactive"))}</td><td>${formatDate(e?.expiresAt, locale)}</td></tr>`;
      }).join("")
    : `<tr><td colspan="3" class="empty-cell">${t(locale, "admin.no_users")}</td></tr>`;

  // LLM quota table
  const quotaRows = input.users.length
    ? input.users.map((u) => {
        const e = input.entitlements.get(u.id);
        const total = e?.llmQuotaLimit ?? 0;
        const used = e?.llmQuotaUsed ?? 0;
        const remaining = Math.max(0, total - used);
        return `<tr><td>${escapeHtml(u.email)}</td><td>${total}</td><td>${used}</td><td>${remaining}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4" class="empty-cell">${t(locale, "admin.no_users")}</td></tr>`;

  // Entitlement adjustment table
  const adjustmentRows = input.users.length
    ? input.users.map((u) => {
        const e = input.entitlements.get(u.id);
        const remaining = e ? Math.max(0, e.llmQuotaLimit - e.llmQuotaUsed) : 0;
        return `<tr data-user-id="${escapeHtml(u.id)}">
          <td>${escapeHtml(u.email)}</td>
          <td class="adj-expiry-cell">${formatDate(e?.expiresAt, locale)}</td>
          <td class="adj-remaining-cell">${remaining}</td>
          <td><input class="adj-extend-days" type="number" min="0" max="365" value="0" aria-label="${t(locale, "admin.col_extend_days")}" /></td>
          <td><input class="adj-quota-add" type="number" min="0" max="100000" value="0" aria-label="${t(locale, "admin.col_add_quota")}" /></td>
          <td><select class="adj-reason" aria-label="${t(locale, "admin.col_reason")}">
            <option value="bug_compensation">${t(locale, "admin.reason_bug")}</option>
            <option value="support_goodwill">${t(locale, "admin.reason_goodwill")}</option>
            <option value="manual_repair">${t(locale, "admin.reason_repair")}</option>
            <option value="other">${t(locale, "admin.reason_other")}</option>
          </select></td>
          <td><input class="adj-note" type="text" maxlength="1024" placeholder="${t(locale, "admin.note_placeholder")}" /></td>
          <td><button class="secondary-button adj-save" type="button" data-user-id="${escapeHtml(u.id)}">${t(locale, "admin.save")}</button><span class="adj-status"></span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8" class="empty-cell">${t(locale, "admin.no_users")}</td></tr>`;

  // Audit history table
  const historyRows = input.entitlementAdjustments.length
    ? input.entitlementAdjustments.map((a) => {
        const email = userEmailsById.get(a.userId) ?? a.userId;
        const beforeExpiry = a.beforeExpiresAt ? formatDate(a.beforeExpiresAt, locale) : t(locale, "admin.none");
        const afterExpiry = formatDate(a.afterExpiresAt, locale);
        const quotaDelta = a.afterLlmQuotaLimit - a.beforeLlmQuotaLimit;
        return `<tr>
          <td>${formatDate(a.createdAt, locale)}</td>
          <td>${escapeHtml(email)}</td>
          <td>${escapeHtml(adjustmentReasonText(a.reason, locale))}</td>
          <td>${escapeHtml(beforeExpiry)} → ${escapeHtml(afterExpiry)}</td>
          <td>${quotaDelta >= 0 ? "+" : ""}${quotaDelta}</td>
          <td>${escapeHtml(a.note ?? "")}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" class="empty-cell">${t(locale, "admin.no_adjustments")}</td></tr>`;

  // Activation codes table
  const codeRows = input.activationCodes.length
    ? input.activationCodes.map((c) => `<tr>
          <td><code>${escapeHtml(c.codePrefix)}</code></td>
          <td>${statusBadge(c.status, activationStatusText(c.status, locale))}</td>
          <td>${c.entitlementDays}${t(locale, "admin.entitlement_days_suffix")}</td>
          <td>${formatDate(c.redeemBy, locale)}</td>
          <td>${formatDate(c.redeemedAt, locale)}</td>
          <td>${escapeHtml(c.redeemedByUserId ? (userEmailsById.get(c.redeemedByUserId) ?? c.redeemedByUserId) : "")}</td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="empty-cell">${t(locale, "admin.no_codes")}</td></tr>`;

  const i18n = buildClientStrings(locale);

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${t(locale, "admin.title")}</title>
  ${faviconLink()}
  <style>${adminShellStyles(locale)}</style>
</head>
<body>
  <main class="admin-shell">
    ${renderSmHeader({
      wrapperClass: "admin-header",
      eyebrow: "StudyMind Admin",
      title: t(locale, "admin.heading"),
      rightHtml: `<div class="admin-session">
        <span class="session-chip">${t(locale, "admin.logged_in_as")}${escapeHtml(input.adminEmail)}</span>
        ${renderLangSwitcher(locale)}
        <button id="logout-admin" class="secondary-button" type="button">${t(locale, "admin.logout")}</button>
      </div>`,
    })}

    <section class="metrics-grid" aria-label="Platform summary">
      <div class="metric"><span>${t(locale, "admin.metrics_users")}</span><strong>${input.users.length}</strong></div>
      <div class="metric"><span>${t(locale, "admin.metrics_active")}</span><strong>${activeUsers}</strong></div>
      <div class="metric"><span>${t(locale, "admin.metrics_codes")}</span><strong>${availableCodes}</strong></div>
    </section>

    <section class="admin-panel">
      <div class="table-heading">
        <div>
          <p class="eyebrow">${t(locale, "admin.stats_eyebrow")}</p>
          <h2>${t(locale, "admin.stats_heading")}</h2>
        </div>
        <div class="stats-legend">
          <span class="stats-legend-item"><span class="stats-dot stats-dot-signup"></span>${t(locale, "admin.stats_signup")}</span>
          <span class="stats-legend-item"><span class="stats-dot stats-dot-redeem"></span>${t(locale, "admin.stats_redeem")}</span>
          <span class="stats-legend-item"><span class="stats-dot stats-dot-adjust"></span>${t(locale, "admin.stats_adjust")}</span>
        </div>
      </div>
      <div class="stats-chart">${statsBars}</div>
    </section>

    <section class="admin-panel create-panel">
      <div>
        <p class="eyebrow">${t(locale, "admin.llm_eyebrow")}</p>
        <h2>${t(locale, "admin.llm_heading")}</h2>
        <p class="muted">${t(locale, "admin.llm_desc")}</p>
      </div>
      <form id="llm-config-form" class="llm-config-grid">
        <label class="field compact"><span>${t(locale, "admin.llm_provider")}</span>
          <select id="llm-provider">
            <option value="openai"${input.llmConfig.provider === "openai" ? " selected" : ""}>OpenAI</option>
            <option value="openai_compatible"${input.llmConfig.provider === "openai_compatible" ? " selected" : ""}>OpenAI Compatible</option>
          </select>
        </label>
        <label class="field compact"><span>${t(locale, "admin.llm_base_url")}</span>
          <input id="llm-base-url" type="url" maxlength="2048" value="${escapeHtml(input.llmConfig.baseUrl)}" placeholder="https://api.openai.com/v1" />
        </label>
        <label class="field compact"><span>${t(locale, "admin.llm_model")}</span>
          <input id="llm-model" maxlength="256" value="${escapeHtml(input.llmConfig.model)}" placeholder="gpt-4o-mini" />
        </label>
        <label class="field compact"><span>${t(locale, "admin.llm_timeout")}</span>
          <input id="llm-timeout" type="number" min="1" max="600" value="${input.llmConfig.timeoutSeconds}" />
        </label>
        <label class="field compact"><span>${t(locale, "admin.llm_api_key")}</span>
          <input id="llm-api-key" type="password" minlength="8" maxlength="4096" autocomplete="new-password" placeholder="${input.llmConfig.configured ? `${t(locale, "admin.llm_api_key_saved")}${escapeHtml(input.llmConfig.apiKeyLast4)}` : t(locale, "admin.llm_api_key_placeholder")}" />
        </label>
        <button id="save-llm-config" class="primary-button" type="submit">${t(locale, "admin.llm_save")}</button>
      </form>
      <p id="llm-config-status" class="status-message" role="status"></p>
    </section>

    <section class="admin-panel create-panel">
      <div>
        <p class="eyebrow">${t(locale, "admin.activation_eyebrow")}</p>
        <h2>${t(locale, "admin.activation_heading")}</h2>
        <p class="muted">${t(locale, "admin.activation_desc")}</p>
      </div>
      <div class="create-controls">
        <label class="field compact">
          <span>${t(locale, "admin.code_validity")}</span>
          <div class="unit-input">
            <input id="redeem-window-days" type="number" min="1" max="365" value="30" />
            <span>${t(locale, "admin.days")}</span>
          </div>
        </label>
        <button id="create-code" class="primary-button" type="button">${t(locale, "admin.generate_code")}</button>
      </div>
      <div id="created-code-card" class="created-code-card" hidden>
        <span>${t(locale, "admin.new_code")}</span>
        <code id="created-code"></code>
        <button id="copy-code" class="secondary-button" type="button">${t(locale, "admin.copy")}</button>
      </div>
      <p id="create-status" class="status-message" role="status"></p>
    </section>

    <section class="admin-panel">
      <div class="table-heading">
        <div>
          <p class="eyebrow">${t(locale, "admin.users_eyebrow")}</p>
          <h2>${t(locale, "admin.users_heading")}</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${t(locale, "admin.col_email")}</th><th>${t(locale, "admin.col_entitlement")}</th><th>${t(locale, "admin.col_expiry")}</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-panel">
      <div class="table-heading">
        <div>
          <p class="eyebrow">${t(locale, "admin.quota_eyebrow")}</p>
          <h2>${t(locale, "admin.quota_heading")}</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table id="llm-quota-table">
          <thead><tr><th>${t(locale, "admin.col_email")}</th><th>${t(locale, "admin.col_total")}</th><th>${t(locale, "admin.col_used")}</th><th>${t(locale, "admin.col_remaining")}</th></tr></thead>
          <tbody>${quotaRows}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-panel">
      <div class="table-heading">
        <div>
          <p class="eyebrow">${t(locale, "admin.compensation_eyebrow")}</p>
          <h2>${t(locale, "admin.compensation_heading")}</h2>
        </div>
      </div>
      <p class="muted panel-desc" style="margin-top:-10px">${t(locale, "admin.compensation_desc")}</p>
      <div class="table-wrap table-wrap--scroll">
        <table id="entitlement-adjustment-table">
          <thead><tr><th>${t(locale, "admin.col_email")}</th><th>${t(locale, "admin.col_current_expiry")}</th><th>${t(locale, "admin.col_remaining_quota")}</th><th>${t(locale, "admin.col_extend_days")}</th><th>${t(locale, "admin.col_add_quota")}</th><th>${t(locale, "admin.col_reason")}</th><th>${t(locale, "admin.col_note")}</th><th>${t(locale, "admin.col_action")}</th></tr></thead>
          <tbody>${adjustmentRows}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-panel">
      <div class="table-heading">
        <div>
          <p class="eyebrow">${t(locale, "admin.audit_eyebrow")}</p>
          <h2>${t(locale, "admin.audit_heading")}</h2>
        </div>
      </div>
      <div class="table-wrap table-wrap--scroll">
        <table id="entitlement-adjustment-history-table">
          <thead><tr><th>${t(locale, "admin.col_time")}</th><th>${t(locale, "admin.col_email")}</th><th>${t(locale, "admin.col_reason")}</th><th>${t(locale, "admin.col_expiry_change")}</th><th>${t(locale, "admin.col_quota_change")}</th><th>${t(locale, "admin.col_note")}</th></tr></thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>
    </section>

    <section class="admin-panel">
      <div class="table-heading">
        <div>
          <p class="eyebrow">${t(locale, "admin.codes_eyebrow")}</p>
          <h2>${t(locale, "admin.codes_heading")}</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${t(locale, "admin.col_prefix")}</th><th>${t(locale, "admin.col_status")}</th><th>${t(locale, "admin.col_entitlement_days")}</th><th>${t(locale, "admin.col_redeem_by")}</th><th>${t(locale, "admin.col_redeemed_at")}</th><th>${t(locale, "admin.col_redeemed_by")}</th></tr></thead>
          <tbody>${codeRows}</tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const i18n = ${JSON.stringify(i18n)};
    ${adminScript(input.csrfToken, locale)}
  </script>
</body>
</html>`;
}

// ── Styles ──

function adminLoginStyles(locale: Locale): string {
  void locale;
  return `
    ${langSwitcherStyles()}
    ${smTokenCss()}
    ${smBaseCss()}
    ${brandChromeCss()}
    h1 { color: var(--sm-text); font-size: clamp(1.7rem, 4vw, 2.3rem); line-height: 1.08; }
    .login-page {
      align-items: center;
      display: flex;
      justify-content: center;
      padding: 32px 18px;
    }
    .login-shell { width: min(100%, 480px); }
    .login-card {
      background: var(--sm-surface);
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius);
      box-shadow: var(--sm-shadow-raised);
      display: grid;
      gap: 18px;
      padding: 28px;
    }
    .login-card-header { align-items: center; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; }
    .muted { color: var(--sm-text-soft); font-size: 0.92rem; }
    .admin-form { display: grid; gap: 14px; }
    .field { color: var(--sm-text); display: grid; font-size: 0.88rem; font-weight: 680; gap: 7px; }
    .inline-action-field { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; }
    .primary-button,
    .secondary-button {
      align-items: center;
      border-radius: var(--sm-radius);
      display: inline-flex;
      font-weight: 720;
      justify-content: center;
      min-height: 42px;
      padding: 0 14px;
      white-space: nowrap;
    }
    .primary-button { background: var(--sm-primary); color: var(--sm-text-on-primary); width: 100%; }
    .primary-button:hover { background: var(--sm-primary-pressed); }
    .secondary-button {
      background: var(--sm-surface-soft);
      border: 1px solid var(--sm-border);
      color: var(--sm-text);
    }
    .secondary-button:hover { background: var(--sm-surface); border-color: var(--sm-border-strong); }
    .status-message { color: var(--sm-text-soft); font-size: 0.88rem; min-height: 22px; }
    .status-message[data-tone="success"] { color: var(--sm-success); }
    .status-message[data-tone="error"] { color: var(--sm-danger); }
    @media (max-width: 760px) {
      .login-page { align-items: stretch; padding-top: 18px; }
      .login-card { padding: 22px; }
      .inline-action-field { grid-template-columns: 1fr; }
    }
  `;
}

function adminShellStyles(locale: Locale): string {
  void locale;
  return `
    ${langSwitcherStyles()}
    ${smTokenCss()}
    ${smBaseCss()}
    ${brandChromeCss()}
    h1 { color: var(--sm-text); font-size: clamp(1.7rem, 4vw, 2.3rem); line-height: 1.08; }
    h2 { color: var(--sm-text); font-size: 1.08rem; line-height: 1.2; }
    .admin-shell { display: grid; gap: 18px; margin: 0 auto; max-width: 1180px; padding: 28px; }
    .admin-header { align-items: end; display: flex; gap: 16px; justify-content: space-between; }
    .admin-session { align-items: center; display: flex; gap: 10px; }
    .session-chip {
      background: var(--sm-surface);
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius-pill);
      color: var(--sm-text);
      font-size: 0.84rem;
      font-weight: 700;
      min-height: 34px;
      padding: 6px 12px;
      white-space: nowrap;
    }
    .metrics-grid { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .metric {
      background: var(--sm-surface);
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius);
      box-shadow: none;
      display: grid;
      gap: 4px;
      padding: 16px;
    }
    .metric span { color: var(--sm-text-soft); font-size: 0.82rem; font-weight: 680; }
    .metric strong { color: var(--sm-text); font-size: 1.8rem; line-height: 1; }
    .admin-panel {
      background: var(--sm-surface);
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius);
      box-shadow: none;
      display: grid;
      gap: 14px;
      padding: 18px;
    }
    .create-panel { grid-template-columns: minmax(0, 1fr) auto; }
    .llm-config-grid { display: grid; gap: 10px; grid-column: 1 / -1; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .create-controls { align-items: end; display: flex; gap: 10px; }
    .muted { color: var(--sm-text-soft); font-size: 0.92rem; }
    .panel-desc { color: var(--sm-text-soft); font-size: 0.9rem; line-height: 1.55; }
    .field { color: var(--sm-text); display: grid; font-size: 0.88rem; font-weight: 680; gap: 7px; }
    .field.compact { min-width: 180px; }
    .unit-input { align-items: center; display: grid; grid-template-columns: minmax(84px, 1fr) auto; }
    .unit-input input { border-bottom-right-radius: 0; border-top-right-radius: 0; }
    .unit-input span {
      align-items: center;
      background: var(--sm-surface-soft);
      border: 1px solid var(--sm-border-strong);
      border-left: 0;
      border-radius: 0 var(--sm-radius) var(--sm-radius) 0;
      color: var(--sm-text-soft);
      display: flex;
      min-height: 42px;
      padding: 0 10px;
    }
    .created-code-card {
      align-items: center;
      background: var(--sm-success-soft);
      border: 1px solid rgba(31, 122, 77, 0.24);
      border-radius: var(--sm-radius);
      display: grid;
      gap: 10px;
      grid-column: 1 / -1;
      grid-template-columns: auto minmax(0, 1fr) auto;
      padding: 12px;
    }
    .created-code-card span { color: var(--sm-success); font-size: 0.82rem; font-weight: 760; }
    .primary-button,
    .secondary-button {
      align-items: center;
      border-radius: var(--sm-radius);
      display: inline-flex;
      font-weight: 720;
      justify-content: center;
      min-height: 42px;
      padding: 0 14px;
      white-space: nowrap;
    }
    .primary-button { background: var(--sm-primary); color: var(--sm-text-on-primary); }
    .primary-button:hover { background: var(--sm-primary-pressed); }
    .secondary-button {
      background: var(--sm-surface-soft);
      border: 1px solid var(--sm-border);
      color: var(--sm-text);
    }
    .secondary-button:hover { background: var(--sm-surface); border-color: var(--sm-border-strong); }
    .status-message { color: var(--sm-text-soft); font-size: 0.88rem; min-height: 22px; }
    .status-message[data-tone="success"] { color: var(--sm-success); }
    .status-message[data-tone="error"] { color: var(--sm-danger); }
    code {
      background: var(--sm-surface-soft);
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius-sm);
      color: var(--sm-text);
      overflow-wrap: anywhere;
      padding: 3px 7px;
    }
    .table-heading { align-items: center; display: flex; justify-content: space-between; }
    .table-wrap { overflow-x: auto; }
    .table-wrap--scroll { max-height: 65vh; overflow: auto; }
    .table-wrap--scroll thead th { position: sticky; top: 0; z-index: 1; }
    table { border-collapse: collapse; min-width: 720px; width: 100%; }
    th, td {
      border-bottom: 1px solid var(--sm-border);
      color: var(--sm-text);
      font-size: 0.9rem;
      padding: 10px 8px;
      text-align: left;
      vertical-align: middle;
      white-space: nowrap;
    }
    th { background: var(--sm-surface); color: var(--sm-text-soft); font-size: 0.76rem; font-weight: 760; text-transform: uppercase; }
    tr:last-child td { border-bottom: 0; }
    tbody tr:nth-child(even) { background: var(--sm-surface-soft); }
    tbody tr:hover { background: var(--sm-primary-soft); }
    .badge {
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius-pill);
      display: inline-flex;
      font-size: 0.78rem;
      font-weight: 760;
      min-height: 24px;
      padding: 2px 9px;
    }
    .badge.active { background: var(--sm-success-soft); border-color: rgba(31, 122, 77, 0.2); color: var(--sm-success); }
    .badge.redeemed { background: var(--sm-primary-soft); border-color: rgba(22, 104, 220, 0.2); color: var(--sm-primary); }
    .badge.inactive,
    .badge.expired,
    .badge.disabled { background: var(--sm-danger-soft); border-color: rgba(180, 35, 24, 0.2); color: var(--sm-danger); }
    .empty-cell { color: var(--sm-text-soft); text-align: center; }
    td input, td select { min-height: 34px; font-size: 0.84rem; border: 1px solid var(--sm-border); border-radius: var(--sm-radius-sm); padding: 0 8px; outline: none; width: 100%; max-width: 120px; }
    td input:focus, td select:focus { border-color: var(--sm-primary); box-shadow: 0 0 0 2px var(--sm-focus-ring); }
    .adj-status { font-size: 0.76rem; color: var(--sm-text-soft); margin-left: 6px; }
    /* Stats chart */
    .stats-legend { display: flex; gap: 16px; flex-wrap: wrap; }
    .stats-legend-item { display: flex; align-items: center; gap: 4px; font-size: 0.8rem; color: var(--sm-text-soft); }
    .stats-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
    .stats-dot-signup { background: var(--sm-primary); }
    .stats-dot-redeem { background: var(--sm-success); }
    .stats-dot-adjust { background: var(--sm-warning); }
    .stats-chart { display: flex; flex-direction: column; gap: 8px; }
    .stats-row { display: grid; grid-template-columns: 36px 1fr; gap: 10px; align-items: start; }
    .stats-month { font-size: 0.78rem; color: var(--sm-text-soft); font-weight: 640; text-align: right; padding-top: 2px; }
    .stats-bar-group { display: flex; flex-direction: column; gap: 3px; }
    .stats-bar-wrap { height: 20px; background: var(--sm-surface-soft); border-radius: 3px; overflow: hidden; position: relative; }
    .stats-bar { height: 100%; border-radius: 3px; font-size: 0.7rem; color: #fff; font-weight: 680; display: flex; align-items: center; padding-left: 6px; min-width: 0; transition: width 600ms ease; }
    .stats-bar-signup { background: var(--sm-primary); }
    .stats-bar-redeem { background: var(--sm-success); }
    .stats-bar-adjust { background: var(--sm-warning); }
    @media (max-width: 760px) {
      .metrics-grid,
      .create-panel,
      .llm-config-grid { grid-template-columns: 1fr; }
      .admin-shell { padding: 18px; }
      .admin-header { align-items: start; flex-direction: column; }
      .admin-session { align-items: stretch; flex-direction: column; width: 100%; }
      .session-chip { text-align: center; }
      .create-controls { align-items: stretch; flex-direction: column; }
      .primary-button,
      .secondary-button { width: 100%; }
      .created-code-card { grid-template-columns: 1fr; }
    }
  `;
}

// ── Client Script ──
function adminScript(csrfToken: string, locale: Locale): string {
  return `
(function () {
  "use strict";
  var csrf = ${safeJsonForScript(csrfToken)};

  // ── Logout ──
  document.getElementById("logout-admin").addEventListener("click", async function () {
    var btn = document.getElementById("logout-admin");
    btn.disabled = true;
    try {
      var r = await fetch("/admin/auth/logout", {
        method: "POST",
        headers: { "x-studymind-csrf": csrf },
      });
      if (r.ok) {
        var d = await r.json().catch(function () { return {}; });
        window.location.href = d.redirect_url || "/admin/login";
        return;
      }
      btn.disabled = false;
    } catch {
      btn.disabled = false;
    }
  });

  // ── LLM Config ──
  var llmForm = document.getElementById("llm-config-form");
  var llmStatus = document.getElementById("llm-config-status");
  function setLlmStatus(msg, tone) { llmStatus.textContent = msg; llmStatus.dataset.tone = tone || "neutral"; }
  llmForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    setLlmStatus(i18n["admin.llm_saving"]);
    var provider = document.getElementById("llm-provider").value;
    var base_url = document.getElementById("llm-base-url").value.trim();
    var model = document.getElementById("llm-model").value.trim();
    var api_key = document.getElementById("llm-api-key").value;
    var timeout_seconds = Number(document.getElementById("llm-timeout").value || 60);
    try {
      var r = await fetch("/admin/api/llm-config", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-studymind-csrf": csrf },
        body: JSON.stringify({ provider: provider, base_url: base_url, model: model, api_key: api_key, timeout_seconds: timeout_seconds }),
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(r.status === 400 ? i18n["admin.llm_check_fields"] : i18n["admin.llm_save_failed"]);
      document.getElementById("llm-api-key").value = "";
      document.getElementById("llm-api-key").placeholder = i18n["admin.llm_api_key_saved"] + (d.api_key_last4 || "");
      setLlmStatus(i18n["admin.llm_saved"], "success");
    } catch (err) {
      setLlmStatus(err instanceof Error ? err.message : i18n["admin.llm_save_failed"], "error");
    }
  });

  // ── Activation Code ──
  var createCode = document.getElementById("create-code");
  var createStatus = document.getElementById("create-status");
  var codeCard = document.getElementById("created-code-card");
  var codeText = document.getElementById("created-code");
  var copyCode = document.getElementById("copy-code");
  function setCreateStatus(msg, tone) { createStatus.textContent = msg; createStatus.dataset.tone = tone || "neutral"; }
  createCode.addEventListener("click", async function () {
    var redeemDays = Number(document.getElementById("redeem-window-days").value || 30);
    createCode.disabled = true; codeCard.hidden = true; setCreateStatus(i18n["admin.generating"]);
    try {
      var r = await fetch("/admin/api/activation-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-studymind-csrf": csrf },
        body: JSON.stringify({ redeem_window_days: redeemDays }),
      });
      var d = await r.json();
      if (!r.ok) { setCreateStatus(i18n["admin.generate_failed"], "error"); return; }
      codeText.textContent = d.code; codeCard.hidden = false;
      setCreateStatus(i18n["admin.generated"], "success");
    } catch { setCreateStatus(i18n["admin.cannot_connect"], "error"); }
    finally { createCode.disabled = false; }
  });
  copyCode.addEventListener("click", async function () {
    await navigator.clipboard.writeText(codeText.textContent || "");
    setCreateStatus(i18n["admin.code_copied"], "success");
  });

  // ── Entitlement Adjustments ──
  document.querySelectorAll(".adj-save").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var userId = btn.dataset.userId;
      var row = btn.closest("tr");
      var extendInput = row && row.querySelector(".adj-extend-days");
      var quotaInput = row && row.querySelector(".adj-quota-add");
      var reasonInput = row && row.querySelector(".adj-reason");
      var noteInput = row && row.querySelector(".adj-note");
      var statusEl = row && row.querySelector(".adj-status");
      var expiryCell = row && row.querySelector(".adj-expiry-cell");
      var remainingCell = row && row.querySelector(".adj-remaining-cell");
      if (!userId || !extendInput || !quotaInput || !reasonInput || !noteInput || !statusEl) return;
      btn.disabled = true; statusEl.textContent = i18n["admin.saving"];
      var payload = { reason: reasonInput.value, note: noteInput.value };
      var extendDays = Number(extendInput.value || 0);
      var quotaAdd = Number(quotaInput.value || 0);
      if (extendDays > 0) payload.extend_days = extendDays;
      if (quotaAdd > 0) payload.quota_add = quotaAdd;
      try {
        var r = await fetch("/admin/api/users/" + encodeURIComponent(userId) + "/entitlement-adjustments", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-studymind-csrf": csrf },
          body: JSON.stringify(payload),
        });
        var d = await r.json().catch(function () { return null; });
        if (!r.ok || !d) { statusEl.textContent = i18n["admin.save_failed"]; return; }
        if (expiryCell && d.entitlement_expires_at) {
          expiryCell.textContent = new Date(d.entitlement_expires_at).toLocaleString(${(locale === "en" ? '"en-US"' : '"zh-CN"')}, { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        }
        if (remainingCell && typeof d.llm_quota_remaining === "number") {
          remainingCell.textContent = String(d.llm_quota_remaining);
        }
        extendInput.value = "0"; quotaInput.value = "0"; noteInput.value = "";
        statusEl.textContent = i18n["admin.saved"];
      } catch { statusEl.textContent = i18n["admin.cannot_connect"]; }
      finally { btn.disabled = false; }
    });
  });
})();`;
}
