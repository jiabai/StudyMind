import { describe, expect, test } from "vitest";
import { renderLoginPage } from "../src/loginPage.js";
import Fastify from "fastify";
import { registerDesktopAuthRoutes } from "../src/routes/desktopAuth.js";
import { MemoryStore } from "../src/store.js";

const OTP_KEY = "0123456789abcdef0123456789abcdef"; // 32+ bytes

describe("StudyMind login page", () => {
  test("renders localized StudyMind-only HTML with intl support", () => {
    const html = renderLoginPage("en");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("StudyMind");
    expect(html).toContain("studymind://auth/callback");
    expect(html).toContain("/auth/email/start");
    expect(html).toContain("/auth/email/verify");
    expect(html).toContain("login.intro.desktop");
    expect(html).toContain("login.intro.web");
    expect(html).toContain("login.verify_desktop");
    expect(html).toContain("login.verify_web");
  });

  test("falls back to zh-CN for default locale", () => {
    const html = renderLoginPage();
    expect(html).toContain('<html lang="zh-CN">');
  });

  test("detects an explicit locale cookie before Accept-Language", async () => {
    const app = Fastify();
    registerDesktopAuthRoutes(app, { store: new MemoryStore(), otpHmacKey: OTP_KEY, sendOtp: async () => undefined });
    const cookie = await app.inject({ method: "GET", url: "/login", headers: { cookie: "studymind_locale=en", "accept-language": "zh-TW" } });
    expect(cookie.body).toContain('<html lang="en">');
    const header = await app.inject({ method: "GET", url: "/login", headers: { "accept-language": "zh-Hant-TW,zh;q=0.8" } });
    expect(header.body).toContain('<html lang="zh-TW">');
  });

  test("language selector persists the StudyMind locale cookie and reloads", () => {
    const html = renderLoginPage("en");
    expect(html).toContain('document.cookie="studymind_locale="');
    expect(html).toContain("path=/");
    expect(html).toContain("samesite=lax");
    expect(html).toContain("max-age=31536000");
    expect(html).toContain("window.location.reload()");
  });
});
