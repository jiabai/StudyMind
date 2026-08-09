import { langSwitcherStyles, renderLangSwitcher, resolveLocale, t, type Locale } from "./i18n.js";

type Input = { locale: unknown; desktop: boolean; state: string; redirectUri: string };
export function renderLoginPage(input: Input | Locale): string {
  const options: Input = typeof input === "string"
    ? { locale: input, desktop: false, state: "", redirectUri: "" }
    : input;
  const locale = resolveLocale(options.locale);
  const redirect = options.desktop ? "studymind://auth/callback" : "";
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${t(locale, "login.title")}</title><style>${langSwitcherStyles()}</style></head><body><main><header><h1>${t(locale, "login.title")}</h1>${renderLangSwitcher(locale)}</header><p>${t(locale, "login.intro")}</p><form id="login-form"><input id="email" type="email" required><button id="send" type="button">Send code</button><input id="code" maxlength="6" pattern="[0-9]{6}" required><button>Sign in</button></form><script>const state=${JSON.stringify(options.state)};const redirectUri=${JSON.stringify(redirect)};async function postJson(url,payload){const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error||"Request failed");return data}document.getElementById("send").onclick=()=>postJson("/auth/email/start",{email:document.getElementById("email").value,state});document.getElementById("login-form").onsubmit=async(event)=>{event.preventDefault();const data=await postJson("/auth/email/verify",{email:document.getElementById("email").value,code:document.getElementById("code").value,state});window.location.href = data.redirect_url};</script></main></body></html>`;
}
