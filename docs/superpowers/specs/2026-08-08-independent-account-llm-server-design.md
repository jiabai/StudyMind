# StudyMind 独立账号、权益、计费与 LLM Server 设计

## 1. 目标与边界

StudyMind server 是一个独立的“账号认证 + LLM 密钥托管 + 计费权益”服务。它与 FrameQ server 结构相似但没有任何运行时、数据库或产品身份关联。

Server 负责：

- 邮箱 OTP 登录、desktop ticket 和 session；
- web user 与 admin session；
- 激活码、权益有效期和 LLM Credits；
- 加密保存管理员配置的 LLM API key；
- 每次 LLM 调用前执行幂等额度 checkout；
- 微信支付订单和 webhook 结算；
- admin 配置、审计与用户控制台；
- health、启动校验、日志、迁移、备份和恢复工具。

Server 永远不负责：

- 音视频上传、下载、解析或转写；
- Task、TaskProgress、AiGeneration、AsrModel 或 WorkerCommand；
- 保存文字稿、任务历史、AI 输出、媒体路径或本地模型状态；
- FrameQ desktop update、release manifest 或其他 FrameQ 产品能力。

## 2. 独立性约束

StudyMind 可以选择性移植 FrameQ 中经过并发测试的领域算法，但移植后的代码必须完整存在于 StudyMind 仓库，禁止跨仓库 import、共享数据库文件或共享部署配置。

必须使用以下 StudyMind 身份：

| 类型 | StudyMind 值 |
|---|---|
| Deep link | `studymind://auth/callback` |
| Login ticket | `smlt_` |
| Desktop session | `smds_` |
| Web user session / CSRF | `smus_` / `smuc_` |
| Admin session / CSRF | `smas_` / `smac_` |
| Order | `sm_` |
| Activation code | `SM-XXXX-XXXX-XXXX-XXXX` |
| User cookies | `studymind_user_session`, `studymind_user_csrf` |
| Admin cookies | `studymind_admin_session`, `studymind_admin_csrf` |
| CSRF header | `x-studymind-csrf` |
| Environment prefix | `STUDYMIND_`（`NODE_ENV`、`DATABASE_URL` 除外） |
| Default database | `server/data/studymind.sqlite` |
| Package name | `studymind-server` |

Production source and tests must reject `FrameQ`、`frameq`、`FRAMEQ`、`frameq://` and FrameQ cookie/token names. Historical documents that explicitly explain the reference relationship are exempt.

Rust 客户端环境变量统一为 `STUDYMIND_SERVER_BASE_URL`，替换当前错误的 `StudyMind_SERVER_BASE_URL`。

## 3. 数据模型

Prisma schema 恰好包含 14 个模型：

1. `User`：规范化邮箱和账号时间；关联 desktop/web session、订单、权益、激活记录和管理员调整。
2. `EmailOtp`：purpose、邮箱、state、code hash、IP、尝试次数、有效期和消费时间。
3. `AuthRateLimit`：按 purpose/scope 的 hash key、窗口、次数和下一允许时间。
4. `DesktopLoginTicket`：ticket hash、state、用户、有效期和消费时间。
5. `Session`：desktop bearer token hash、用户、有效期和撤销时间。
6. `Order`：用户、商户订单号、金额、状态、二维码、支付时间、transaction ID 和 provider payload。
7. `Entitlement`：每用户唯一的状态、有效期、Credit limit/used。
8. `LlmConfig`：provider、base URL、model、AES-GCM 密文 key、last4 和 timeout。
9. `LlmUsageEvent`：用户、权益、request ID 和时间；`(userId, requestId)` 唯一。
10. `ActivationCode`：code hash/prefix、状态、权益天数、兑换期限和兑换用户。
11. `AdminSession`：管理员 cookie session 与 CSRF hash。
12. `UserSession`：web user cookie session 与 CSRF hash。
13. `AdminEntitlementAdjustment`：权益调整前后值、原因、备注、管理员和时间。
14. `WebhookEvent`：provider/event ID、订单号、payload 和时间；`(provider, eventId)` 唯一。

Prisma schema 表达关系、唯一约束和索引；SQLite check constraint 由 reviewed SQL migration 维护。生产部署只能使用 `prisma migrate deploy`。

错误的 `server/prisma/dev.db` 从版本库删除。首个 StudyMind migration 从空数据库建立这 14 个模型，不尝试把 Task 数据迁入账号域。

## 4. 模块架构

### 4.1 HTTP 与装配层

`server.ts` 只负责创建 Fastify、构造 services 并注册 route modules。`index.ts` 负责环境加载、runtime config、Prisma、readiness 和进程生命周期。

Route modules：

- `routes/health.ts`
- `routes/desktopAuth.ts`
- `routes/desktopAccount.ts`
- `routes/desktopLlm.ts`
- `routes/billing.ts`
- `routes/admin.ts`
- `routes/userAuth.ts`
- `routes/dashboard.ts`

不创建 `taskRoutes`、`progressRoutes`、`workerRoutes` 或 `desktopUpdates`。

### 4.2 Domain services

- `AuthService`：desktop OTP、ticket、session exchange。
- `UserAuthService`：web user session 与 CSRF。
- `AdminAuthService`：限定管理员邮箱的 OTP/session/CSRF。
- `ActivationCodeService`：生成和兑换 StudyMind 激活码。
- `LlmConfigService`：校验、AES-256-GCM 加解密与公开/desktop 配置视图。
- `BillingService`：微信 Native 订单和幂等结算。
- `EntitlementAdjustmentService`：管理员权益调整和审计。

### 4.3 Store port

公开 Store 只暴露封闭的业务语义操作。route/service 不允许组合关键的 read-check-write 序列。

同时实现：

- `MemoryStore`：快速领域和 route 测试；
- `PrismaStore`：生产持久化与并发事务；
- 共享 contract tests：保证两者的业务结果一致。

## 5. HTTP 契约

### 5.1 Desktop routes

1. `GET /login`
2. `POST /auth/email/start`
3. `POST /auth/email/verify`
4. `POST /api/desktop/sessions/exchange`
5. `POST /api/desktop/logout`
6. `GET /api/desktop/account`
7. `POST /api/desktop/activation-codes/redeem`
8. `POST /api/desktop/billing/wechat-native`
9. `GET /api/desktop/billing/orders/:orderId`
10. `POST /api/desktop/llm/checkouts`

请求与响应保持 StudyMind Rust 客户端当前字段契约；登录回调、ticket 前缀和 server URL env 同步改为 StudyMind 值。

### 5.2 Health

- `GET /health/live`
- `GET /health/ready`

### 5.3 Admin 与 web user

Admin 提供登录页、OTP、logout、dashboard、激活码生成、LLM 配置和用户权益调整。Web user 提供邮箱登录、logout、dashboard 和账号状态。所有 HTML、cookie、CSRF header 与可见文案使用 StudyMind。

Admin routes 固定为：

- `GET /admin/login`
- `POST /admin/auth/email/start`
- `POST /admin/auth/email/verify`
- `POST /admin/auth/logout`
- `GET /admin`
- `POST /admin/api/activation-codes`
- `POST /admin/api/llm-config`
- `POST /admin/api/users/:userId/entitlement-adjustments`

Web user routes 固定为：

- `POST /user/auth/email/start`
- `POST /user/auth/email/verify`
- `POST /user/auth/logout`
- `GET /dashboard`
- `GET /api/dashboard/account`

### 5.4 Payment webhook

`POST /api/wechat/notify` 只在微信支付显式启用且配置完整时注册有效行为；禁用时返回固定 404 错误。

## 6. 认证与并发不变量

- OTP 有效期 10 分钟，最多验证 5 次。
- 同 `{purpose,email,state}` 新 OTP 使旧未消费 OTP 失效。
- 每邮箱/purpose 每分钟最多发送 1 次、每小时 5 次；每 IP/purpose 每小时 20 次。
- desktop 与 admin OTP purpose 不能交叉使用。
- OTP 验证、用户 upsert、ticket/web session 创建在同一事务。
- ticket 有效期 5 分钟；ticket 消费与 desktop session 创建在同一事务。
- desktop session 有效期 90 天；admin session 12 小时；web user session 90 天。
- raw OTP、ticket、session、CSRF 和激活码不进入数据库，只保存 SHA-256 hash。
- 固定长度 hash 使用 constant-time compare。
- 只有 SQLite busy/locked 或明确事务冲突可执行最多 3 次的内部有界重试；未知错误立即失败。

## 7. 权益、Credits 与计费

首期固定业务值：

- 激活码：31 天权益 + 20 LLM Credits；默认 30 天内可兑换。
- 微信月卡：¥9.90（990 分）+ 31 天处理权益。
- Credits 由激活码或管理员调整发放；月卡本身不自动增加 Credits。

Account 状态：

- 有效 Entitlement ⇒ `can_process=true`；
- 有效 Entitlement + remaining Credits > 0 + LLM configured ⇒ `can_generate_ai=true`。

激活码兑换在一个事务内完成 code 条件消费、权益延长和 Credits 增加。并发兑换只允许一个成功。

支付 webhook 在一个事务内完成 event 幂等记录、订单条件结算和权益延长。相同 provider/event ID 重放不会重复发放；订单号或 transaction ID 不一致时拒绝。

管理员权益调整必须在同一事务中更新 Entitlement 并写入调整前后值的审计记录。

## 8. LLM 密钥托管与 checkout

管理员保存 LLM config 时：

- provider 只允许 `openai` 或 `openai_compatible`；
- base URL 必须是 HTTP(S)；
- model 非空；
- timeout 为 1–600 秒；
- API key 使用从 `STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY` 派生的 AES-256-GCM key 加密；
- 公开页面只展示是否配置和 last4。

`POST /api/desktop/llm/checkouts`：

1. 验证 desktop bearer session；
2. 校验 `request_id`；
3. 确认 LLM config 存在；
4. 在事务内以 `(userId, requestId)` 幂等签出一个 Credit；
5. 成功后通过 TLS 响应返回 provider/base URL/model/API key/timeout/remaining。

相同 request ID 重试返回 `reused` 且不再次扣减；不同 ID 并发争抢最后一个 Credit 时最多一个成功。Server 不代理 prompt 或 LLM 响应，也不保存这些内容。

## 9. 安全与错误处理

- Desktop API 使用 bearer token。
- Web/admin 使用 HttpOnly session cookie + 独立可读 CSRF cookie/header。
- 生产 cookie 必须 `Secure`、`SameSite=Lax`、path `/`。
- 不启用 wildcard CORS；web 页面和 API 同源。
- 生产只信任同机 loopback reverse proxy 提供的 forwarded client IP。
- SMTP、数据库、管理员邮箱和 LLM encryption key 在生产缺失时拒绝启动。
- Runtime config 使用 `STUDYMIND_SERVER_HOST`、`STUDYMIND_SERVER_PORT`、`STUDYMIND_ADMIN_EMAIL`、`STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY`、`STUDYMIND_ALLOW_CONSOLE_OTP`、`STUDYMIND_SMTP_*` 和 `STUDYMIND_WECHAT_*`；仅 `NODE_ENV` 与 `DATABASE_URL` 保留生态通用名称。
- Console OTP 只允许非生产环境显式开启。
- 所有公开错误使用固定 code；不返回 Prisma、SQLite、stack 或任意内部 error message。
- 日志不得包含 OTP、邮件正文、Authorization/Cookie/Set-Cookie、session/CSRF、激活码明文、LLM key、request body、prompt、输出、支付 payload 或原始数据库错误。

## 10. 运行与故障处理

- SQLite 只支持一个 server 实例和本地磁盘，不支持 NFS/SMB。
- Prisma client 启用 WAL 与 5 秒 busy timeout。
- 启动先验证 runtime config、migration/schema、数据库连接，再监听端口。
- liveness 只表示进程可服务；readiness 要求启动完成、schema 兼容、数据库 ping 成功且未 draining。
- SIGINT/SIGTERM 幂等关闭：先 readiness false，再 `app.close()` 排空请求，最后 disconnect Prisma；15 秒超时后非零退出。
- 生产使用 migration deploy，并提供数据库 preflight、完整性检查、备份/恢复 smoke 和回滚说明。
- SMTP、微信、LLM provider 失败使用固定外部错误；readiness 不依赖可选供应商网络。

## 11. 非功能目标

- 初始拓扑面向小型单实例服务，不声明多实例或高写入吞吐能力。
- 数据正确性优先于可用性；认证、额度和支付冲突 fail closed。
- 数据库备份目标：每日受保护备份和每次 migration 前停服备份；具体 RPO/RTO 在部署 runbook 中记录。
- 结构化日志支持请求生命周期、稳定 error code、readiness 和 shutdown 诊断，但不牺牲隐私。
- 模块边界和共享 contract tests 使未来迁移 PostgreSQL 时可以保留 domain/services/routes。

## 12. 测试与验收

必须覆盖：

- schema 恰好包含 14 个模型并禁止 Task 类模型；
- production `server/` 无 FrameQ 身份或跨仓库 import；
- 10 个 desktop routes 与 Rust 客户端字段、URL、prefix 一致；
- OTP purpose、replacement、rate limit、attempt 上限和并发唯一结果；
- ticket exchange 原子性与失败回滚；
- MemoryStore/PrismaStore contract parity；
- 多独立 Prisma clients 的 OTP、ticket、激活、quota 和 webhook 并发；
- account 状态、激活码、admin 调整、LLM config 加密与 checkout 幂等；
- billing 禁用、订单所有权、webhook 重放和冲突；
- web/admin session、CSRF 和 secure cookie；
- runtime config fail closed、proxy trust、日志脱敏、health 与优雅关闭；
- fresh migration、preflight、integrity check 与 restore smoke；
- Rust account/server URL/deep-link/endpoint tests 和 Worker managed LLM checkout tests。

最终门禁至少运行：

- `npm --prefix server test`
- `npm --prefix server run build`
- `npm --prefix server run db:migrate:status`
- 相关 `cargo test --manifest-path app/src-tauri/Cargo.toml`
- 相关 `uv run pytest worker/tests`
- repository namespace/boundary tests

## 13. 实施顺序

1. 清除错误 Task server 代码、测试设施和 tracked dev database；建立 schema/migrations/package 基线。
2. 建立 Store contracts、MemoryStore、PrismaStore 和并发 primitives。
3. 实现 desktop auth 与 StudyMind login page/deep link。
4. 实现 account、activation 和 entitlement adjustment。
5. 实现 LLM config 与 quota checkout。
6. 实现 billing/webhook。
7. 实现 admin/web dashboard。
8. 实现 runtime config、health、observability、lifecycle 和运维工具。
9. 同步 Rust/Worker 契约，执行零 FrameQ 耦合与全量验证。

## 14. Alternatives

### 整体复制后批量改名

拒绝。速度快但残留产品身份和部署耦合的风险最高。

### 完全从零设计业务事务

拒绝。会重复承担已在参考实现中解决的 OTP、quota 和 webhook 并发风险。

### 选择性独立移植（采用）

复用已验证的领域不变量、transaction shape 和测试思想；重新建立 StudyMind 的 schema migration、配置、装配、route identity、页面、部署和边界测试。
