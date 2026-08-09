# StudyMind Independent Account and LLM Server Implementation Plan

**Status:** Implementation complete on 2026-08-09. All Server, migration, Rust account/callback, and Worker contract gates passed. The repository-wide Rust suite retains pre-existing desktop filesystem/watchdog failures and timeouts documented in `progress.md`; they are outside this Server correction scope.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 14 个账号/权益模型和完整认证、计费、LLM checkout 能力重建 StudyMind server，并消除 Task 域与所有 FrameQ 产品耦合。

**Architecture:** 选择性移植 `D:\Github\FrameQ\server` 已验证的领域事务和测试思想，但在 StudyMind 仓库内重新建立 schema、Store、services、routes、页面、配置和运维。MemoryStore 与 PrismaStore 实现同一 semantic Store contract；Fastify 只依赖注入 Store/services，SQLite 是单实例持久化边界。

**Tech Stack:** Node.js 24、TypeScript 5.9、Fastify 5.6、Zod 4、Prisma 6.19、SQLite、Vitest 4、Nodemailer 7、Rust/Tauri client、Python Worker。

---

## Reference rule

`D:\Github\FrameQ\server` 只能只读参考。允许把算法和测试结构内置到 StudyMind，但每个移植任务必须同时完成：

1. 所有产品身份改成 StudyMind；
2. 删除 updates/release manifest 和 Task 域；
3. 不产生跨仓库 import、共享路径、共享数据库或共享环境变量；
4. 用 StudyMind 测试证明行为，而不是只证明文本替换。

## Final file structure

```text
server/
├── prisma/
│   ├── schema.prisma
│   └── migrations/202608080001_account_server_baseline/migration.sql
├── scripts/
│   ├── database-preflight.mjs
│   └── restore-smoke.mjs
├── src/
│   ├── routes/{admin,billing,dashboard,desktopAccount,desktopAuth,desktopLlm,health,userAuth}.ts
│   ├── store/contracts.ts
│   ├── store/memory.ts
│   ├── store/memory/{atomic,auth,billing,entitlements,llmConfig,userSession}.ts
│   ├── prismaStore.ts
│   ├── prismaStore/{auth,billing,concurrency,entitlements,llmConfig,userSession}.ts
│   ├── activation.ts
│   ├── adminAuth.ts
│   ├── adminPage.ts
│   ├── auth.ts
│   ├── billing.ts
│   ├── bootstrap.ts
│   ├── dashboardPage.ts
│   ├── database.ts
│   ├── email.ts
│   ├── entitlementAdjustment.ts
│   ├── env.ts
│   ├── i18n.ts
│   ├── index.ts
│   ├── llmConfig.ts
│   ├── loginPage.ts
│   ├── observability.ts
│   ├── readiness.ts
│   ├── runtimeConfig.ts
│   ├── security.ts
│   ├── server.ts
│   ├── store.ts
│   ├── userAuth.ts
│   └── wechat.ts
└── tests/
```

Production code must not contain `taskRoutes.ts`、`progressRoutes.ts`、`workerRoutes.ts`、`taskService.ts`、`testDatabase.ts` or `server.test.ts` from the superseded design.

### Task 1: Delete the wrong domain and establish the 14-model migration baseline

**Files:**
- Delete: `server/src/routes/taskRoutes.ts`
- Delete: `server/src/routes/progressRoutes.ts`
- Delete: `server/src/services/taskService.ts`
- Delete: `server/src/lib/prisma.ts`
- Delete: `server/src/server.test.ts`
- Delete: `server/src/testDatabase.ts`
- Delete: `server/prisma/dev.db`
- Modify: `.gitignore`
- Rewrite: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/migration_lock.toml`
- Create: `server/prisma/migrations/202608080001_account_server_baseline/migration.sql`
- Create: `server/tests/serverDomainBoundary.test.ts`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Modify: `server/tsconfig.json`
- Create: `server/vitest.config.ts`

- [ ] **Step 1: Write the boundary test before deleting the wrong domain**

Create `server/tests/serverDomainBoundary.test.ts` with these assertions:

```ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = readFileSync(resolve(serverRoot, "prisma/schema.prisma"), "utf8");
const expectedModels = [
  "User", "EmailOtp", "AuthRateLimit", "DesktopLoginTicket", "Session", "Order",
  "Entitlement", "LlmConfig", "LlmUsageEvent", "ActivationCode", "AdminSession",
  "UserSession", "AdminEntitlementAdjustment", "WebhookEvent",
];

describe("StudyMind server domain boundary", () => {
  test("contains exactly the account, entitlement, billing, and LLM models", () => {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
    expect(models).toEqual(expectedModels);
  });

  test.each(["Task", "TaskProgress", "AiGeneration", "AsrModel", "WorkerCommand"])(
    "forbids the %s model",
    (name) => expect(schema).not.toMatch(new RegExp(`^model\\s+${name}\\s*\\{`, "m")),
  );
});
```

- [ ] **Step 2: Run the boundary test and verify RED**

Run: `npm --prefix server test -- --run tests/serverDomainBoundary.test.ts`

Expected: FAIL because the current schema contains Task models and not the 14 required models.

- [ ] **Step 3: Replace package and TypeScript baselines**

Set package identity to `studymind-server`; use `@prisma/client ^6.19.0`、`dotenv ^17.4.2`、`fastify ^5.6.2`、`nodemailer ^7.0.11`、`zod ^4.2.1` and matching TypeScript/Vitest/Prisma/types. Scripts must include:

```json
{
  "build": "prisma generate && tsc --noEmit",
  "dev": "tsx src/index.ts",
  "start": "node --import tsx src/index.ts",
  "test": "vitest run",
  "db:migrate:deploy": "prisma migrate deploy",
  "db:migrate:status": "prisma migrate status",
  "db:preflight": "node --import dotenv/config scripts/database-preflight.mjs",
  "db:restore-smoke": "node scripts/restore-smoke.mjs",
  "prisma:generate": "prisma generate"
}
```

Use NodeNext, strict, `noUncheckedIndexedAccess`, `resolveJsonModule`, and include `src/**/*.ts` + `tests/**/*.ts`.

- [ ] **Step 4: Replace the Prisma schema and add one fresh baseline migration**

Port the final 14-model shape from `D:\Github\FrameQ\server\prisma\schema.prisma`, preserving relations/indexes but using a new StudyMind baseline migration. The SQL migration must include these checks from the hardened reference:

```sql
CHECK ("purpose" IN ('desktop_login', 'admin_login'))
CHECK ("attempts" >= 0 AND "attempts" <= 5)
CHECK ("scope" IN ('email_minute', 'email_hour', 'ip_hour'))
CHECK ("count" >= 0)
CHECK ("llmQuotaLimit" >= 0)
CHECK ("llmQuotaUsed" >= 0)
CHECK ("llmQuotaUsed" <= "llmQuotaLimit")
```

Do not include any migration that reads or transforms Task rows.

- [ ] **Step 5: Delete the superseded files and tracked database**

Verify each exact target is inside `D:\Github\StudyMind\server`, then remove only the files listed for deletion. Add `server/prisma/*.db` to `.gitignore`; runtime data remains under already-ignored `server/data/`.

- [ ] **Step 6: Install dependencies and generate Prisma client**

Run: `npm --prefix server install`

Run: `$env:DATABASE_URL='file:../data/studymind.sqlite'; npm --prefix server run prisma:generate`

Expected: both exit 0 and package-lock resolves the StudyMind dependency set.

- [ ] **Step 7: Verify GREEN and fresh migration**

Run: `npm --prefix server test -- --run tests/serverDomainBoundary.test.ts`

Run against a disposable temp database:

```powershell
$migrationDb = Join-Path ([System.IO.Path]::GetTempPath()) "studymind-plan-migration.sqlite"
$env:DATABASE_URL = "file:$($migrationDb.Replace('\\', '/'))"
npm.cmd --prefix server run db:migrate:deploy
Remove-Item -LiteralPath $migrationDb -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$migrationDb-journal" -ErrorAction SilentlyContinue
```

Expected: boundary tests pass and migration creates exactly 14 models.

- [ ] **Step 8: Commit Task 1**

Stage only Task 1 files and commit: `refactor(server): replace task domain with account schema`.

### Task 2: Port the semantic Store contract and MemoryStore

**Files:**
- Create: `server/src/store/contracts.ts`
- Create: `server/src/store.ts`
- Create: `server/src/store/memory.ts`
- Create: `server/src/store/memory/atomic.ts`
- Create: `server/src/store/memory/auth.ts`
- Create: `server/src/store/memory/billing.ts`
- Create: `server/src/store/memory/entitlements.ts`
- Create: `server/src/store/memory/llmConfig.ts`
- Create: `server/src/store/memory/userSession.ts`
- Create: `server/tests/storeCompatibility.test.ts`
- Create: `server/tests/transactionSafety.test.ts`

- [ ] **Step 1: Write Store contract tests first**

Port the MemoryStore cases from FrameQ `storeCompatibility.test.ts` and `transactionSafety.test.ts`, replacing every product identity with StudyMind. Required cases: OTP purpose isolation/replacement/limits; ticket single consumption; activation single redemption; request-ID quota reuse; webhook replay; admin adjustment audit.

Use constants that prove the StudyMind domain:

```ts
expect(ticket.ticketHash).not.toContain("smlt_");
expect(result.status).toBe("verified");
expect(secondCheckout.status).toBe("reused");
expect(store.llmUsageEvents).toHaveLength(1);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm --prefix server test -- --run tests/storeCompatibility.test.ts tests/transactionSafety.test.ts`

Expected: FAIL because Store/MemoryStore do not exist.

- [ ] **Step 3: Port `Store` records and closed result unions**

Port FrameQ `store/contracts.ts` completely because all 14 models are in scope. Preserve semantic operations such as `issueEmailOtp`、`verifyDesktopOtpAndCreateTicketAndWebSession`、`exchangeDesktopTicketAndCreateSession`、`consumeLlmQuota`、`redeemActivationCodeAndGrantEntitlement`、`settlePaidOrder` and `applyEntitlementAdjustmentWithAudit`.

- [ ] **Step 4: Port MemoryStore as an independent StudyMind implementation**

Port FrameQ memory modules and keep atomic serialization inside the MemoryStore only. Change auth-rate key namespace to `studymind:auth-rate-limit:v1`. No source file may import outside StudyMind.

- [ ] **Step 5: Run MemoryStore tests GREEN**

Run: `npm --prefix server test -- --run tests/storeCompatibility.test.ts tests/transactionSafety.test.ts`

Expected: all MemoryStore contract and atomicity tests pass.

- [ ] **Step 6: Commit Task 2**

Commit: `feat(server): add semantic account store`.

### Task 3: Implement PrismaStore and real SQLite concurrency invariants

**Files:**
- Create: `server/src/prismaStore.ts`
- Create: `server/src/prismaStore/auth.ts`
- Create: `server/src/prismaStore/billing.ts`
- Create: `server/src/prismaStore/concurrency.ts`
- Create: `server/src/prismaStore/entitlements.ts`
- Create: `server/src/prismaStore/llmConfig.ts`
- Create: `server/src/prismaStore/userSession.ts`
- Create: `server/tests/prismaTestHarness.ts`
- Create: `server/tests/prismaTestHarness.test.ts`
- Create: `server/tests/prismaMigration.test.ts`
- Create: `server/tests/prismaTransactionSafety.test.ts`
- Create: `server/tests/prismaAuthQuotaConcurrency.test.ts`

- [ ] **Step 1: Write independent-client concurrency tests before PrismaStore**

Port the five FrameQ Prisma harness/migration/transaction/concurrency tests. The harness must create a temp SQLite file, deploy the StudyMind migration, generate/use the StudyMind client, and open at least two independent PrismaClient instances.

Required assertions:

```ts
expect(successfulOtpVerifications).toHaveLength(1);
expect(createdSessions).toHaveLength(1);
expect(successfulDistinctCheckouts).toHaveLength(1);
expect(await prisma.llmUsageEvent.count()).toBe(1);
expect(await prisma.webhookEvent.count()).toBe(1);
```

- [ ] **Step 2: Run Prisma tests and verify RED**

Run: `npm --prefix server test -- --run tests/prisma*.test.ts`

Expected: FAIL because PrismaStore modules do not exist.

- [ ] **Step 3: Port concurrency primitives**

Port parameterized SQL and bounded conflict retry. Change the rate-limit hash namespace to StudyMind. Retry only P2034/P1008/SQLite busy-lock classifications; maximum 3 attempts with bounded backoff. Do not retry validation or unknown errors.

- [ ] **Step 4: Port auth, user-session, entitlement, LLM config and billing operations**

Preserve the reference transaction shapes. Critical SQL must stay parameterized through `Prisma.sql`; no string-built values. Remove reference-only compatibility helpers not declared on StudyMind `Store`.

- [ ] **Step 5: Implement the PrismaStore facade**

Every public method delegates to the focused module with typed `ReturnType<Store[...]>`. Do not use `any`; replace the reference `adminEntitlementAdjustment` cast with generated Prisma types.

- [ ] **Step 6: Run Prisma tests GREEN twice**

Run: `npm --prefix server test -- --run tests/prisma*.test.ts`

Repeat the same command once.

Expected: both runs pass with no temp database residue.

- [ ] **Step 7: Commit Task 3**

Commit: `feat(server): add transactional prisma store`.

### Task 4: Implement StudyMind desktop authentication and synchronize the Rust contract

**Files:**
- Create: `server/src/security.ts`
- Create: `server/src/auth.ts`
- Create: `server/src/userAuth.ts`
- Create: `server/src/adminAuth.ts`
- Create: `server/src/email.ts`
- Create: `server/src/i18n.ts`
- Create: `server/src/loginPage.ts`
- Create: `server/src/routes/authSchemas.ts`
- Create: `server/src/routes/cookies.ts`
- Create: `server/src/routes/shared.ts`
- Create: `server/src/routes/desktopAuth.ts`
- Create: `server/tests/auth.test.ts`
- Create: `server/tests/authQuotaConcurrency.test.ts`
- Create: `server/tests/email.test.ts`
- Create: `server/tests/pageI18n.test.ts`
- Create: `server/tests/routes.test.ts`
- Modify: `app/src-tauri/src/account.rs`
- Modify: `app/src-tauri/src/lib.rs`

- [ ] **Step 1: Write StudyMind identity tests first**

Port relevant auth/routes/page tests and assert exact identities:

```ts
expect(result.ticket).toMatch(/^smlt_/);
expect(result.redirectUrl).toMatch(/^studymind:\/\/auth\/callback/);
expect(exchange.sessionToken).toMatch(/^smds_/);
expect(loginPage.body).toContain("StudyMind");
expect(loginPage.body).not.toContain("FrameQ");
```

Add Rust tests for `STUDYMIND_SERVER_BASE_URL`、`studymind://auth/callback`、`smlt_` ticket acceptance and rejection of the legacy env spelling/prefix.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm.cmd --prefix server test -- --run tests/auth.test.ts tests/authQuotaConcurrency.test.ts tests/email.test.ts tests/pageI18n.test.ts tests/routes.test.ts
cargo test --manifest-path app/src-tauri/Cargo.toml account
```

Expected failures: missing server modules and current Rust `flt_`/`StudyMind_SERVER_BASE_URL` values.

- [ ] **Step 3: Port security/auth/email modules with StudyMind values**

Use these exact prefixes:

```ts
const ticket = secureToken("smlt_");
const desktopSession = secureToken("smds_");
const webSession = secureToken("smus_");
const webCsrf = secureToken("smuc_");
const adminSession = secureToken("smas_");
const adminCsrf = secureToken("smac_");
```

Email subject/body/log prefix must say StudyMind. `authRateLimitKey` must hash `studymind:auth-rate-limit:v1|...`.

- [ ] **Step 4: Port login page and desktop auth routes**

Only accept `studymind://auth/callback`. Cookies set during desktop-mode verification use StudyMind web-cookie names. Public errors remain fixed and raw Store/Prisma errors are hidden.

- [ ] **Step 5: Update Rust account contract**

Use `STUDYMIND_SERVER_BASE_URL`; validate `smlt_`; keep the production base URL owned by StudyMind; do not change account status/activation/billing JSON fields.

- [ ] **Step 6: Run server and Rust auth tests GREEN**

Run the focused commands from Step 2. Expected: all pass and no FrameQ identity occurs in runtime code.

- [ ] **Step 7: Commit Task 4**

Commit: `feat(server): add StudyMind desktop authentication`.

### Task 5: Implement account, activation, entitlement adjustment and LLM checkout

**Files:**
- Create: `server/src/activation.ts`
- Create: `server/src/entitlementAdjustment.ts`
- Create: `server/src/llmConfig.ts`
- Create: `server/src/routes/desktopAccount.ts`
- Create: `server/src/routes/desktopLlm.ts`
- Create: `server/tests/activation.test.ts`
- Create: `server/tests/llmQuota.test.ts`
- Create: `worker/tests/test_llm.py`

- [ ] **Step 1: Write activation/account/LLM tests RED**

Assert `SM-` codes, 31 days, 20 Credits, account gate separation, AES-GCM round trip, wrong key failure, request-ID reuse and final-credit concurrency. Assert checkout response fields exactly match Worker parser: `provider/base_url/model/api_key/timeout_seconds/quota_remaining`.

- [ ] **Step 2: Run focused server + Worker tests and verify RED**

Run:

```powershell
npm.cmd --prefix server test -- --run tests/activation.test.ts tests/llmQuota.test.ts
uv run pytest worker/tests/test_llm.py -q
```

Expected: missing service/route modules and the new Worker contract test proves the required checkout response fields.

- [ ] **Step 3: Implement StudyMind activation and adjustment services**

Use `SM-XXXX-XXXX-XXXX-XXXX`, 31 entitlement days, 30-day redemption window and 20 Credits. Redemption calls only the Store atomic operation.

- [ ] **Step 4: Implement LLM config encryption and account/checkout routes**

Rename the required key error to `STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY is required.` Account `can_process` and `can_generate_ai` follow the confirmed rules. Checkout validates request IDs with `/^[A-Za-z0-9._~-]{8,160}$/` and returns key only after successful quota consumption.

- [ ] **Step 5: Run focused tests GREEN**

Run the exact two commands from Step 2. Expected: all pass.

- [ ] **Step 6: Commit Task 5**

Commit: `feat(server): add entitlements and managed llm checkout`.

### Task 6: Implement billing, webhook, admin and web dashboard

**Files:**
- Create: `server/src/billing.ts`
- Create: `server/src/wechat.ts`
- Create: `server/src/adminPage.ts`
- Create: `server/src/dashboardPage.ts`
- Create: `server/src/routes/admin.ts`
- Create: `server/src/routes/billing.ts`
- Create: `server/src/routes/dashboard.ts`
- Create: `server/src/routes/userAuth.ts`
- Create: `server/tests/admin.test.ts`
- Create: `server/tests/billing.test.ts`
- Create: `server/tests/webDashboard.test.ts`
- Create: `server/tests/wechatConfig.test.ts`

- [ ] **Step 1: Write billing/admin/web tests RED**

Port tests with exact StudyMind identities: order prefix `sm_`, description `StudyMind monthly pass`, user/admin cookies, `x-studymind-csrf`, StudyMind page text. Cover disabled billing 404, order ownership, webhook replay/conflict, admin auth/CSRF, activation generation, LLM config save and audited entitlement adjustment.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm.cmd --prefix server test -- --run tests/admin.test.ts tests/billing.test.ts tests/webDashboard.test.ts tests/wechatConfig.test.ts
```

Expected: missing billing/admin/dashboard modules.

- [ ] **Step 3: Implement billing and WeChat integration**

Use amount 990 fen and 31 days. All WeChat runtime keys use `STUDYMIND_WECHAT_*`. Preserve exact raw-body verification and atomic Store settlement.

- [ ] **Step 4: Implement admin and web user surfaces**

Use StudyMind cookie names and CSRF header everywhere, including embedded page JavaScript. Admin routes are the eight specified in the design; web user routes are the five specified. No updates route is registered.

- [ ] **Step 5: Run focused tests GREEN**

Run the exact command from Step 2. Expected: admin, billing, dashboard and WeChat tests all pass.

- [ ] **Step 6: Commit Task 6**

Commit: `feat(server): add billing and account administration`.

### Task 7: Add runtime configuration, server assembly and production operations

**Files:**
- Rewrite: `server/src/server.ts`
- Rewrite: `server/src/index.ts`
- Create: `server/src/bootstrap.ts`
- Create: `server/src/database.ts`
- Create: `server/src/env.ts`
- Create: `server/src/observability.ts`
- Create: `server/src/readiness.ts`
- Create: `server/src/runtimeConfig.ts`
- Create: `server/src/routes/health.ts`
- Create: `server/scripts/database-preflight.mjs`
- Create: `server/scripts/restore-smoke.mjs`
- Create: `server/.env.example`
- Create: `server/tests/database.test.ts`
- Create: `server/tests/deploymentContracts.test.ts`
- Create: `server/tests/health.test.ts`
- Create: `server/tests/lifecycle.test.ts`
- Create: `server/tests/observability.test.ts`
- Create: `server/tests/proxyTrust.test.ts`
- Create: `server/tests/runtimeConfig.test.ts`
- Create: `server/tests/serverModuleBoundaries.test.ts`

- [ ] **Step 1: Write runtime/operations tests RED**

Port the reference tests but use only `STUDYMIND_*`, `studymind.sqlite`, and StudyMind log events. Add a server assembly assertion that registers no desktop update/task/progress/worker routes.

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```powershell
npm.cmd --prefix server test -- --run tests/database.test.ts tests/deploymentContracts.test.ts tests/health.test.ts tests/lifecycle.test.ts tests/observability.test.ts tests/proxyTrust.test.ts tests/runtimeConfig.test.ts tests/serverModuleBoundaries.test.ts
```

Expected: missing runtime/readiness/lifecycle modules and old server assembly.

- [ ] **Step 3: Implement fail-closed runtime config**

Allowed product variables are:

```text
STUDYMIND_SERVER_HOST
STUDYMIND_SERVER_PORT
STUDYMIND_ADMIN_EMAIL
STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY
STUDYMIND_ALLOW_CONSOLE_OTP
STUDYMIND_SMTP_HOST/PORT/USER/PASS/FROM
STUDYMIND_WECHAT_PAY_ENABLED
STUDYMIND_WECHAT_APP_ID/MCH_ID/MCH_SERIAL_NO/MCH_PRIVATE_KEY/NOTIFY_URL
STUDYMIND_WECHAT_API_V3_KEY/PLATFORM_CERT_PEM/DEV_INSECURE_NOTIFY
```

`NODE_ENV` and `DATABASE_URL` are the only generic configuration names. Production requires database, admin email, encryption key >=32 characters and complete SMTP; insecure/console modes are forbidden.

- [ ] **Step 4: Implement database, readiness, observability and lifecycle**

Default database is `server/data/studymind.sqlite`; connect with WAL + 5000ms busy timeout. Readiness verifies the 14-model schema and ping. Trust only loopback proxy. Redact auth/cookie/key/body fields. Shutdown is idempotent and bounded to 15 seconds.

- [ ] **Step 5: Assemble the complete server**

Register health, desktop auth/account/LLM, billing, admin, user auth and dashboard. Do not import or register updates/task/progress/worker modules. Capture raw JSON body only for payment webhook verification.

- [ ] **Step 6: Port preflight and restore smoke tools**

Adapt all filenames, messages and expected tables to StudyMind. Tools must never print database contents or secret values.

- [ ] **Step 7: Run runtime tests GREEN**

Run the exact command from Step 2. Expected: pass with no secret fixture in logs.

- [ ] **Step 8: Commit Task 7**

Commit: `feat(server): add production runtime and lifecycle`.

### Task 8: Enforce zero FrameQ coupling, complete docs and run final verification

**Files:**
- Create: `server/tests/productIdentityBoundary.test.ts`
- Rewrite: `server/README.md`
- Modify: `.gitignore`
- Modify: `AGENTS.md` if its server description still mentions task synchronization
- Modify: `task_plan.md`
- Modify: `findings.md`
- Modify: `progress.md`

- [ ] **Step 1: Write the product identity boundary test RED**

Recursively scan `server/src`、`server/tests`、`server/scripts`、`server/prisma`、`server/.env.example` and the relevant Rust account files. Reject:

```ts
const forbidden = [
  /FrameQ/g, /frameq:\/\//g, /FRAMEQ_/g,
  /frameq_(?:user|admin)/g, /x-frameq-csrf/g,
  /\b(?:flt_|fq_|fqus_|fqcs_|fas_|fac_|fus_|fuc_)/g,
];
```

Allow FrameQ only in ADR/spec prose outside the scanned production/test paths.

- [ ] **Step 2: Run the identity test and verify RED if any residue exists**

Run: `npm --prefix server test -- --run tests/productIdentityBoundary.test.ts`

Expected before cleanup: FAIL with precise file/line residue, or PASS if prior tasks already removed every identity. If it passes immediately, temporarily insert one forbidden fixture into an in-memory test input to prove the scanner detects it, then remove the fixture.

- [ ] **Step 3: Remove every residue and update docs**

README must describe only StudyMind account/auth/entitlement/billing/LLM service, exact routes, 14 models, migrations, env, local development, deployment limits, backup/restore and the fact that local media/tasks never reach server.

- [ ] **Step 4: Run complete server gates**

Run:

```powershell
npm.cmd --prefix server test
npm.cmd --prefix server run build
$env:DATABASE_URL='file:../data/studymind.sqlite'; npm.cmd --prefix server run db:migrate:status
```

Expected: exit 0, zero failed tests, valid migrations.

- [ ] **Step 5: Run client and Worker contract gates**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml account
uv run pytest worker/tests/test_llm.py -q
```

Then run the repository-level relevant suites:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml
uv run pytest worker/tests
```

Expected: StudyMind endpoint/prefix/env and managed checkout tests pass.

- [ ] **Step 6: Perform final diff and requirement audit**

Verify:

- exactly 14 Prisma models;
- exactly the specified desktop/admin/web/health/webhook surface;
- no Task models/routes/services/database;
- no FrameQ identity in scanned code;
- no user pre-existing unrelated changes reverted;
- `git diff --check` is clean.

- [ ] **Step 7: Update work records and commit**

Record exact test counts and residual operational risks in `progress.md`/`findings.md`; mark the corrective plan complete. Commit: `docs(server): document independent account service`.
