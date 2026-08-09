# StudyMind Server 最终发现

## Corrected domain boundary

- StudyMind Server 是独立的账号认证、LLM 密钥托管和计费权益服务；参考项目与它没有运行时关系。
- 数据库只有 14 个模型：User、EmailOtp、AuthRateLimit、DesktopLoginTicket、Session、Order、Entitlement、LlmConfig、LlmUsageEvent、ActivationCode、AdminSession、UserSession、AdminEntitlementAdjustment、WebhookEvent。
- Server 不保存 Task、TaskProgress、AiGeneration、AsrModel、WorkerCommand、本地媒体、文字稿或思维导图。
- 六个基础 desktop 路由为 `/login`、`/auth/email/start`、`/auth/email/verify`、`/api/desktop/sessions/exchange`、`/api/desktop/logout`、`/api/desktop/llm/checkouts`；客户端所需的 account、activation 和 billing 路由也已纳入完整 surface。

## Security and transaction findings implemented

- OTP HMAC 与 LLM AES-256-GCM 密钥独立，生产环境均要求至少 32 UTF-8 字节；SMTP 必须完整配置，console OTP 与不安全 webhook 模式在生产禁止。
- Desktop ticket、Session、Web/Admin session 和 CSRF 全部使用 StudyMind 专属命名空间；管理端只允许固定配置邮箱。
- MemoryStore 和 PrismaStore 对 OTP、ticket、激活码、配额、订单、webhook 和人工权益调整实现同一封闭结果语义及原子事务。
- LLM checkout 只在配置可解密且权益有效后消耗配额；request ID 幂等，响应只暴露 Worker 所需的六个字段。
- 微信支付 raw body 只在精确 webhook 路径保存；签名验证、响应上限、超时、重放和冲突处理均 fail closed。
- SQLite 仅允许本机文件，启用 WAL、5000ms busy timeout 和外键；readiness 同时检查 ping、14 表和 draining 状态。

## Documentation and identity audit

- `server/README.md` 已覆盖实际模型、路由、环境变量、迁移、本地开发、生产限制、备份/恢复及数据边界。
- 身份边界测试递归扫描 Server 源码、测试、脚本、Prisma、环境模板和 Rust 账号入口；错误包含原文件和表达式行号。
- 原始文本扫描不足以识别静态拆分。加固后的扫描器同时检查原文和有限静态折叠结果：TypeScript/JavaScript 通过 TypeScript AST 仅求值字符串字面量、括号、二元 `+`、全字符串数组 `join` 与字符串 `concat`；Rust 仅折叠参数全是普通字符串字面量的 `concat!`。不进行跨语句或任意函数求值，避免宽泛假阳性。
- 内存源码回归 fixture 先证明旧扫描器对 TS 静态拼接和 Rust `concat!` 返回空结果；启用折叠后它们被准确捕获，并同时发现 9 处仓库内旧负向样例。
- 回归逐项断言 TS/JS 中的产品名、scheme、环境变量和两类旧 token 前缀，以及 Rust `concat!` 中的产品名与旧 ticket；raw 和 folded 结果均保留原文件的精确行定位。
- 页面中的冗余旧产品断言由统一身份边界取代；仍需验证拒绝旧 scheme/ticket 的路由和 Rust 测试改用运行时字符输入，不依赖扫描器盲区，也没有静默 allowlist。
- `AGENTS.md` 的 Server 描述没有过时 Task 同步语义，因此保留用户已有修改，不纳入本次提交。
- `.gitignore` 已具备 `server/data/`、`server/backups/`、Prisma DB 与 journal/WAL/SHM sidecar 规则，无需重复修改。

## Operational findings

- Node 24 对 `node:sqlite` 的 preflight/restore 脚本仍显示 ExperimentalWarning；工具行为和退出码正常。
- 此环境的 `RUST_LOG=warn` 会触发 Prisma 6.19 CLI schema engine 无细节失败；设置为测试 harness 已使用的 `RUST_LOG=info` 后，新的临时数据库可稳定 migrate/status/preflight/restore。
- 全量 Cargo 的失败集中在既有 annotation/settings/progress/worker watchdog 测试。本次修改只调整 legacy ticket 负向 fixture 的构造方式；直接覆盖的 auth callback 5/5 和 account 5/5 均通过，未扩大范围修复无关 Rust 问题。
