import { describe, expect, test } from "vitest";
import Fastify from "fastify";
import { renderLegalPage } from "../src/legalPages.js";
import { registerLegalRoutes } from "../src/routes/legal.js";

describe("StudyMind legal pages", () => {
  test("renders localized privacy and terms pages with product facts", () => {
    for (const kind of ["privacy", "terms"] as const) {
      const zh = renderLegalPage(kind, "zh-CN");
      expect(zh).toContain('<html lang="zh-CN">');
      expect(zh).toContain(`StudyMind · ${kind === "privacy" ? "隐私政策" : "服务条款"}`);
      expect(zh).toContain("本地优先");
      expect(zh).toContain("StudyMind");

      const tw = renderLegalPage(kind, "zh-TW");
      expect(tw).toContain('<html lang="zh-TW">');
      expect(tw).toContain("本機");

      const en = renderLegalPage(kind, "en");
      expect(en).toContain('<html lang="en">');
      expect(en).toContain(kind === "privacy" ? "Privacy Policy" : "Terms of Service");
    }
  });

  test("links the alternate legal page with a same-origin relative path", () => {
    const privacy = renderLegalPage("privacy", "en");
    expect(privacy).toContain('href="/terms"');
    const terms = renderLegalPage("terms", "en");
    expect(terms).toContain('href="/privacy"');
  });

  test("keeps local-first guarantees in the privacy copy without uploading claims", () => {
    const privacy = renderLegalPage("privacy", "zh-CN");
    expect(privacy).toContain("音视频文件、带时间戳的文字稿与历史课题均保存在你的设备上");
    expect(privacy).not.toContain("标注");
    expect(privacy).not.toContain("上传你的音视频");
  });

  test("falls back to zh-CN without reflecting an invalid locale", () => {
    const html = renderLegalPage("privacy", "<script>alert(1)</script>" as never);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("serves both pages as cacheable HTML with locale detection", async () => {
    const app = Fastify();
    registerLegalRoutes(app);

    const privacy = await app.inject({
      method: "GET",
      url: "/privacy",
      headers: { "accept-language": "zh-Hant-TW,zh;q=0.8" },
    });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.headers["content-type"]).toContain("text/html");
    expect(privacy.headers["cache-control"]).toBe("public, max-age=3600");
    expect(privacy.body).toContain('<html lang="zh-TW">');
    expect(privacy.body).toContain("隱私政策");

    const terms = await app.inject({
      method: "GET",
      url: "/terms?lang=en",
    });
    expect(terms.statusCode).toBe(200);
    expect(terms.body).toContain('<html lang="en">');
    expect(terms.body).toContain("Terms of Service");
  });
});
