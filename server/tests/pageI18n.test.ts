import { describe, expect, test } from "vitest";
import { renderLoginPage } from "../src/loginPage.js";
import Fastify from "fastify";
import { registerDesktopAuthRoutes } from "../src/routes/desktopAuth.js";
import { MemoryStore } from "../src/store.js";

const OTP_KEY = "test-otp-hmac-key-32-bytes-long!!";

describe("StudyMind login page", () => {
  test("renders localized StudyMind-only HTML with strict callback constants", () => {
    const html = renderLoginPage({ locale: "en", desktop: true, state: "state-123456", redirectUri: "studymind://auth/callback" });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("StudyMind");
    expect(html).toContain("studymind://auth/callback");
    expect(html).toContain("/auth/email/start");
    expect(html).toContain("/auth/email/verify");
  });

  test("falls back to zh-CN without reflecting an invalid locale", () => {
    const html = renderLoginPage({ locale: "<script>alert(1)</script>", desktop: false, state: "", redirectUri: "" });
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).not.toContain("<script>alert(1)</script>");
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
    const html = renderLoginPage({ locale: "en", desktop: false, state: "", redirectUri: "" });
    expect(html).toContain('document.cookie = "studymind_locale="');
    expect(html).toContain("Path=/");
    expect(html).toContain("SameSite=Lax");
    expect(html).toContain("Max-Age=31536000");
    expect(html).toContain("window.location.reload()");
    expect(html).not.toContain('document.cookie = "lang="');
  });
});
