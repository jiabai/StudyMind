import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

describe("deployment contracts", () => {
  test("production-only install retains runtime and migration executables", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies).toHaveProperty("tsx");
    expect(pkg.dependencies).toHaveProperty("prisma");
    expect(pkg.scripts.start).toBe("node --import tsx src/index.ts");
    expect(pkg.scripts["db:migrate:deploy"]).toBe("prisma migrate deploy");
  });

  test("ships preflight, restore-smoke, and a complete product-only env example", () => {
    expect(read("scripts/database-preflight.mjs")).toContain("PRAGMA integrity_check");
    expect(read("scripts/restore-smoke.mjs")).toContain("mkdtemp");
    const example = read(".env.example");
    for (const name of ["DATABASE_URL", "STUDYMIND_SERVER_HOST", "STUDYMIND_SERVER_PORT", "STUDYMIND_ADMIN_EMAIL", "STUDYMIND_AUTH_OTP_HMAC_KEY", "STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY", "STUDYMIND_SMTP_HOST", "STUDYMIND_WECHAT_PAY_ENABLED"]) expect(example).toContain(name);
    expect(example).not.toMatch(/FRAMEQ|STUDYMIND_(TASK|WORKER|UPDATE|PROGRESS)/i);
  });
});
