import { smBaseCss, smTokenCss } from "./designtokens.js";
import { brandChromeCss, faviconLink, renderSmHeader } from "./pagechrome.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type DashboardAccountView = {
  authenticated: true;
  email: string;
  entitlement_status: "active" | "inactive";
  entitlement_expires_at: string | null;
  llm_quota_limit: number;
  llm_quota_used: number;
  llm_quota_remaining: number;
  llm_quota_resets_at: string | null;
  llm_configured: boolean;
  last_verified_at: string;
  can_process: boolean;
  can_generate_ai: boolean;
};

export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderDashboardPage(input: { account: DashboardAccountView; csrfToken: string }): string {
  const a = input.account;
  const entitlementLabel = a.entitlement_status === "active" ? "有效" : "未激活";
  const expiryText = a.entitlement_expires_at ? formatDate(a.entitlement_expires_at) : "—";
  const resetText = a.llm_quota_resets_at ? formatDate(a.llm_quota_resets_at) : "—";
  const llmConfiguredText = a.llm_configured ? "已配置" : "未配置";
  const canProcessText = a.can_process ? "可用" : "不可用";
  const canGenerateText = a.can_generate_ai ? "可用" : "不可用";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>StudyMind 控制台</title>
  ${faviconLink()}
  <style>
    ${smTokenCss()}
    ${smBaseCss()}
    ${brandChromeCss()}
    body { padding: 24px; }
    .wrap { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    header h1 { font-size: 22px; font-weight: 700; }
    .email { color: var(--sm-text-soft); font-size: 14px; }
    .header-right { display: flex; align-items: center; gap: 8px; }
    button.logout {
      border-radius: var(--sm-radius);
      background: var(--sm-surface-soft);
      color: var(--sm-text);
      font-weight: 600;
      padding: 8px 16px;
      min-height: 34px;
    }
    button.logout:hover { background: var(--sm-surface); }
    button.logout:disabled { cursor: wait; opacity: 0.6; }
    .card {
      background: var(--sm-surface);
      border: 1px solid var(--sm-border);
      border-radius: var(--sm-radius);
      padding: 20px;
      box-shadow: var(--sm-shadow-card);
    }
    .card h2 { margin: 0 0 12px; font-size: 16px; font-weight: 700; color: var(--sm-text); }
    .row {
      display: flex; justify-content: space-between; padding: 8px 0;
      border-bottom: 1px solid var(--sm-divider); font-size: 14px;
    }
    .row:last-child { border-bottom: 0; }
    .row .k { color: var(--sm-text-soft); }
    .row .v { color: var(--sm-text); font-weight: 600; text-align: right; word-break: break-all; }
    .quota-bar-wrap { padding: 6px 0 10px; display: flex; flex-direction: column; gap: 4px; }
    .quota-bar { height: 8px; background: var(--sm-surface-soft); border-radius: 99px; overflow: hidden; }
    .quota-bar-fill { height: 100%; background: var(--sm-primary); border-radius: 99px; transition: width 500ms ease; min-width: 0; }
    .quota-bar-label { font-size: 12px; color: var(--sm-text-soft); }
    .tag {
      display: inline-block; padding: 2px 8px; border-radius: var(--sm-radius-pill);
      font-size: 12px; font-weight: 700;
    }
    .tag.active { background: var(--sm-success-soft); color: var(--sm-success); }
    .tag.inactive { background: var(--sm-danger-soft); color: var(--sm-danger); }
    .placeholder { color: var(--sm-text-soft); font-size: 14px; }
    #status { min-height: 20px; color: var(--sm-text-soft); font-size: 13px; }
    #status.error { color: var(--sm-danger); }
  </style>
</head>
<body>
  <div class="wrap">
    ${renderSmHeader({
      title: "StudyMind 控制台",
      subtitleHtml: `<div class="email">${escapeHtml(a.email)}</div>`,
      rightHtml: `<div class="header-right">
        <button id="logout" class="logout" type="button">退出登录</button>
      </div>`,
    })}

    <section class="card">
      <h2>账户与配额</h2>
      <div class="row"><span class="k">会员状态</span><span class="v">${entitlementLabel}</span></div>
      <div class="row"><span class="k">到期时间</span><span class="v">${expiryText}</span></div>
      <div class="row"><span class="k">LLM 配额上限</span><span class="v">${a.llm_quota_limit}</span></div>
      <div class="row"><span class="k">LLM 已用</span><span class="v">${a.llm_quota_used}</span></div>
      <div class="row"><span class="k">LLM 剩余</span><span class="v">${a.llm_quota_remaining}</span></div>
      <div class="row"><span class="k">配额重置时间</span><span class="v">${resetText}</span></div>
      <div class="row"><span class="k">LLM 配置</span><span class="v">${llmConfiguredText}</span></div>
    </section>

    <section class="card">
      <h2>服务状态</h2>
      <div class="row"><span class="k">转写处理</span><span class="v">${canProcessText}</span></div>
      <div class="row"><span class="k">AI 生成</span><span class="v">${canGenerateText}</span></div>
    </section>

    <section class="card">
      <h2>操作</h2>
      <p class="placeholder">使用桌面端 StudyMind 应用进行音视频转写和 AI 总结。</p>
    </section>

    <div id="status" role="status" aria-live="polite"></div>
  </div>
  <script>
    var csrf = ${safeJsonForScript(input.csrfToken)};
    var logoutBtn = document.getElementById("logout");
    var status = document.getElementById("status");
    logoutBtn.addEventListener("click", async function () {
      logoutBtn.disabled = true;
      status.textContent = "正在退出…";
      try {
        var response = await fetch("/user/auth/logout", {
          method: "POST",
          headers: { "x-studymind-csrf": csrf },
        });
        if (response.ok) { window.location.href = "/login"; return; }
        status.textContent = "退出失败";
        status.className = "error";
      } catch (e) {
        status.textContent = "网络错误";
        status.className = "error";
      } finally {
        logoutBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
