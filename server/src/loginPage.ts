import {
  buildClientStrings,
  langSwitcherStyles,
  LANG_COOKIE_MAX_AGE,
  renderLangSwitcher,
  type Locale,
  t,
} from "./i18n.js";
import { smBaseCss, smTokenCss } from "./designtokens.js";
import { brandChromeCss, faviconLink, renderBrandMark } from "./pagechrome.js";

export function renderLoginPage(locale: Locale = "zh-CN"): string {
  const i18n = buildClientStrings(locale);
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${t(locale, "login.title")}</title>
    ${faviconLink()}
    <style>
      ${langSwitcherStyles()}
      ${smTokenCss()}
      ${smBaseCss()}
      ${brandChromeCss()}
      body {
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(100%, 420px);
        background: var(--sm-surface);
        border: 1px solid var(--sm-border);
        border-radius: var(--sm-radius);
        padding: 28px;
        box-shadow: var(--sm-shadow-raised);
      }
      .page-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px 12px;
        margin-bottom: 8px;
      }
      .page-header h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        font-weight: 700;
      }
      p {
        margin: 0 0 20px;
        color: var(--sm-text-soft);
        line-height: 1.6;
      }
      label {
        display: block;
        margin: 16px 0 8px;
        color: var(--sm-text);
        font-size: 14px;
        font-weight: 650;
      }
      button {
        width: 100%;
        height: 44px;
        margin-top: 16px;
        border: 0;
        border-radius: var(--sm-radius);
        background: var(--sm-primary);
        color: var(--sm-text-on-primary);
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      button:hover { background: var(--sm-primary-pressed); }
      button.secondary {
        background: var(--sm-surface-soft);
        border: 1px solid var(--sm-border);
        color: var(--sm-text);
      }
      button.secondary:hover { background: var(--sm-surface); }
      button:disabled { cursor: wait; opacity: 0.58; }
      #status {
        min-height: 22px;
        margin-top: 16px;
        color: var(--sm-text-soft);
        font-size: 14px;
      }
      #status.error { color: var(--sm-danger); }
      #success-panel {
        display: none;
        text-align: center;
        padding: 8px 0 4px;
      }
      #success-panel h2 {
        margin: 0 0 12px;
        font-size: 22px;
        font-weight: 700;
        color: var(--sm-success);
      }
      #success-panel p {
        margin: 0 0 16px;
        color: var(--sm-text-soft);
        line-height: 1.6;
      }
      #success-panel a.dashboard-link {
        display: inline-block;
        padding: 10px 20px;
        border: 1px solid var(--sm-primary);
        border-radius: var(--sm-radius);
        color: var(--sm-primary);
        text-decoration: none;
        font-weight: 600;
        font-size: 14px;
      }
      #success-panel a.dashboard-link:hover {
        background: var(--sm-primary);
        color: var(--sm-text-on-primary);
      }
    </style>
  </head>
  <body>
    <main>
      <header class="page-header">
        <h1>${t(locale, "login.title")}</h1>
        ${renderLangSwitcher(locale)}
      </header>
      <p id="intro"></p>
      <form id="login-form">
        <label for="email">${t(locale, "login.email")}</label>
        <input id="email" name="email" type="email" autocomplete="email" required />
        <button id="send-code" type="button" class="secondary">${t(locale, "login.send_code")}</button>

        <label for="code">${t(locale, "login.code")}</label>
        <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required />
        <button id="verify-code" type="submit">${t(locale, "login.verify_desktop")}</button>
      </form>
      <div id="status" role="status" aria-live="polite"></div>
      <div id="success-panel">
        <h2>${t(locale, "login.success_title")}</h2>
        <p>${t(locale, "login.success_body")}</p>
      </div>
    </main>
    <script>
      const i18n = ${JSON.stringify(i18n)};
      const params = new URLSearchParams(window.location.search);
      const desktop = params.get("desktop") === "1";
      const redirectUri = params.get("redirect_uri") || "studymind://auth/callback";
      const state = params.get("state") || "";
      const startUrl = "/auth/email/start";
      const verifyUrl = "/auth/email/verify";
      const introText = desktop
        ? i18n["login.intro.desktop"]
        : i18n["login.intro.web"];
      const verifyLabel = desktop
        ? i18n["login.verify_desktop"]
        : i18n["login.verify_web"];
      const form = document.getElementById("login-form");
      const emailInput = document.getElementById("email");
      const codeInput = document.getElementById("code");
      const sendButton = document.getElementById("send-code");
      const verifyButton = document.getElementById("verify-code");
      const statusEl = document.getElementById("status");
      const intro = document.getElementById("intro");
      const successPanel = document.getElementById("success-panel");

      verifyButton.textContent = verifyLabel;
      intro.textContent = introText;

      function setStatus(message, isError) {
        statusEl.textContent = message;
        statusEl.className = isError ? "error" : "";
      }

      function assertDesktopLoginRequest() {
        if (!state || !/^[a-zA-Z0-9._~-]{8,160}$/.test(state)) {
          throw new Error(i18n["login.error_state_desktop"]);
        }
        if (redirectUri !== "studymind://auth/callback") {
          throw new Error(i18n["login.error_callback"]);
        }
      }

      async function postJson(url, payload) {
        var response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        var data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || i18n["login.error_request"]);
        }
        return data;
      }

      sendButton.addEventListener("click", async function () {
        try {
          if (desktop) assertDesktopLoginRequest();
          if (!emailInput.reportValidity()) return;
          sendButton.disabled = true;
          setStatus(i18n["login.status_sending"]);
          await postJson(startUrl, { email: emailInput.value, state: state });
          setStatus(i18n["login.status_sent"]);
          codeInput.focus();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : i18n["login.error_request"], true);
        } finally {
          sendButton.disabled = false;
        }
      });

      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          if (desktop) assertDesktopLoginRequest();
          if (!emailInput.reportValidity() || !codeInput.reportValidity()) return;
          verifyButton.disabled = true;
          setStatus(i18n["login.status_verifying"]);
          var data = await postJson(verifyUrl, {
            email: emailInput.value,
            code: codeInput.value,
            state: state,
          });
          if (desktop) {
            form.style.display = "none";
            intro.style.display = "none";
            statusEl.style.display = "none";
            successPanel.style.display = "block";
            setTimeout(function () {
              window.location.href = data.redirect_url;
            }, 200);
          } else {
            setStatus(i18n["login.status_verified_web"]);
            window.location.href = data.redirect_url;
          }
        } catch (error) {
          setStatus(error instanceof Error ? error.message : i18n["login.error_verify"], true);
        } finally {
          verifyButton.disabled = false;
        }
      });

      // Validate desktop params upfront and show inline error if invalid
      try {
        if (desktop) assertDesktopLoginRequest();
      } catch (error) {
        form.querySelectorAll("input, button").forEach(function (node) {
          node.disabled = true;
        });
        setStatus(error instanceof Error ? error.message : i18n["login.error_invalid"], true);
      }
    </script>
  </body>
</html>`;
}
