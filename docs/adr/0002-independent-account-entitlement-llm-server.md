# ADR-0002: StudyMind server 是独立账号、权益、计费与 LLM 服务

## Status

Accepted

## Context

StudyMind 与 FrameQ 是两个完全独立的产品。StudyMind 可以参考 FrameQ server 已验证的认证、并发与计费实现模式，但不能依赖 FrameQ 的运行时、数据库、部署、cookie、token、环境变量、URL scheme 或产品命名。

此前 StudyMind `server/` 被错误设计为任务同步和 WorkerCommand 派发服务，包含 `Task`、`TaskProgress`、`AiGeneration`、`AsrModel` 等模型。这些模型把桌面端本地任务域错误地搬到了云端，与 StudyMind 的 local-first 边界冲突。StudyMind 的音视频、文字稿、任务历史和 AI 结果默认只存在桌面端与本地 Worker。

与此同时，StudyMind 桌面端已经需要独立的邮箱登录、账号状态、激活码、计费权益和 server-managed LLM checkout 服务。

## Decision

StudyMind server 独立实现完整的账号认证、LLM 密钥托管和计费权益能力。

数据库只包含以下 14 个模型：

1. `User`
2. `EmailOtp`
3. `AuthRateLimit`
4. `DesktopLoginTicket`
5. `Session`
6. `Order`
7. `Entitlement`
8. `LlmConfig`
9. `LlmUsageEvent`
10. `ActivationCode`
11. `AdminSession`
12. `UserSession`
13. `AdminEntitlementAdjustment`
14. `WebhookEvent`

永久禁止 server 引入 `Task`、`TaskProgress`、`AiGeneration`、`AsrModel` 或远程 WorkerCommand 模型与路由。

FrameQ 仅作为行为参考。StudyMind 实现必须内置在本仓库中，并使用独立的：

- `studymind://auth/callback`
- `STUDYMIND_*` 环境变量
- `studymind_*` cookie 与 `x-studymind-csrf`
- `sm*` token/order 前缀与 `SM-` 激活码
- `server/data/studymind.sqlite`
- StudyMind 邮件、页面、日志、迁移和部署配置

服务提供 desktop auth/account/activation/billing/LLM checkout、health、admin 管理、web user dashboard 和支付 webhook；不提供 FrameQ desktop update 能力。

## Consequences

### Positive

- StudyMind 与 FrameQ 可独立部署、升级、备份和轮换密钥。
- server 不接触用户本地媒体、文字稿和任务数据。
- 认证、权益、额度与支付继续使用数据库事务、条件写入和幂等约束。
- 静态边界测试可以阻止 FrameQ 身份或 Task 模型再次混入。

### Negative

- 需要移除现有错误 schema、路由和开发数据库，并从全新 migration 建库。
- 参考实现中的所有产品身份必须逐项改写，不能机械复制。
- SQLite 生产拓扑只支持单实例和本地磁盘。

### Neutral

- StudyMind 桌面端和 Worker 仍在本机处理媒体与 AI 结果；server 只在每次 LLM 调用前签出受额度控制的供应商配置。

## Alternatives Considered

### 继续保留 Task 同步模型

拒绝。它违反 local-first 边界，也不是桌面客户端实际需要的 server 能力。

### 与 FrameQ 共用 server 或数据库

拒绝。两个产品的用户、会话、权益、密钥和部署生命周期必须隔离。

### 整体复制 FrameQ server 后批量替换名称

拒绝。容易残留 FrameQ URL scheme、cookie、token、环境变量、页面和部署耦合。采用选择性独立移植并增加零引用测试。

## References

- `docs/adr/0001-local-only-media-sources.md`
- `D:\Github\FrameQ\server`（只读参考，不是运行时依赖）
