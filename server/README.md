# StudyMind Server

StudyMind Server 是独立部署的“账号认证 + LLM 密钥托管 + 计费权益”服务。它不处理媒体、转写、思维导图或桌面任务；这些数据和任务只存在于本地桌面应用与 Worker。FrameQ 仅是只读设计参考：StudyMind 与 FrameQ 是两个完全独立的程序，没有任何运行时关系，也不共享代码导入、配置、密钥、数据库、Cookie 或令牌命名空间。

## 数据模型

SQLite 数据库固定包含 14 个业务模型：

`User`、`EmailOtp`、`AuthRateLimit`、`DesktopLoginTicket`、`Session`、`Order`、`Entitlement`、`LlmConfig`、`LlmUsageEvent`、`ActivationCode`、`AdminSession`、`UserSession`、`AdminEntitlementAdjustment`、`WebhookEvent`。

Server 不包含 `Task`、任务进度、AI 生成记录或 ASR 模型。桌面端只向 Server 请求账号状态、激活/支付和一次性的 LLM checkout；本地媒体、文字稿及任务内容绝不上传到 Server。

## HTTP 接口

六个基础 desktop 登录与密钥接口：

- `GET /login`
- `POST /auth/email/start`
- `POST /auth/email/verify`
- `POST /api/desktop/sessions/exchange`
- `POST /api/desktop/logout`
- `POST /api/desktop/llm/checkouts`

Desktop 账号与计费接口：

- `GET /api/desktop/account`
- `POST /api/desktop/activation-codes/redeem`
- `POST /api/desktop/billing/wechat-native`
- `GET /api/desktop/billing/orders/:orderId`

管理端的 8 个接口为 `GET /admin/login`、`POST /admin/auth/email/start`、`POST /admin/auth/email/verify`、`POST /admin/auth/logout`、`GET /admin`、`POST /admin/api/activation-codes`、`POST /admin/api/llm-config`、`POST /admin/api/users/:userId/entitlement-adjustments`。

Web 用户端的 5 个接口为 `POST /user/auth/email/start`、`POST /user/auth/email/verify`、`POST /user/auth/logout`、`GET /dashboard`、`GET /api/dashboard/account`。运维与支付回调接口为 `GET /health/live`、`GET /health/ready` 和 `POST /api/wechat/notify`。支付未启用时，相关支付接口返回 404。

## 本地开发

需要 Node.js 24。命令从仓库根目录执行：

```powershell
npm.cmd --prefix server install
npm.cmd --prefix server run prisma:generate
npm.cmd --prefix server run db:migrate:deploy
npm.cmd --prefix server run dev
```

开发环境未显式设置 `DATABASE_URL` 时，默认使用 `server/data/studymind.sqlite`。本地调试 OTP 只有在 `STUDYMIND_ALLOW_CONSOLE_OTP=true` 时才可使用专用开发输出；不要在共享环境启用。

测试与类型检查：

```powershell
npm.cmd --prefix server test
npm.cmd --prefix server run build
```

## 配置

以 [`.env.example`](./.env.example) 为模板。服务只读取 `NODE_ENV`、`DATABASE_URL` 以及以下 StudyMind 命名变量：

- 服务：`STUDYMIND_SERVER_HOST`、`STUDYMIND_SERVER_PORT`
- 身份和密钥：`STUDYMIND_ADMIN_EMAIL`、`STUDYMIND_AUTH_OTP_HMAC_KEY`、`STUDYMIND_LLM_CONFIG_ENCRYPTION_KEY`
- 邮件：`STUDYMIND_ALLOW_CONSOLE_OTP`、`STUDYMIND_SMTP_HOST`、`STUDYMIND_SMTP_PORT`、`STUDYMIND_SMTP_USER`、`STUDYMIND_SMTP_PASS`、`STUDYMIND_SMTP_FROM`
- 微信支付：`STUDYMIND_WECHAT_PAY_ENABLED`、`STUDYMIND_WECHAT_APP_ID`、`STUDYMIND_WECHAT_MCH_ID`、`STUDYMIND_WECHAT_MCH_SERIAL_NO`、`STUDYMIND_WECHAT_MCH_PRIVATE_KEY`、`STUDYMIND_WECHAT_NOTIFY_URL`、`STUDYMIND_WECHAT_API_V3_KEY`、`STUDYMIND_WECHAT_PLATFORM_CERT_PEM`、`STUDYMIND_WECHAT_DEV_INSECURE_NOTIFY`

两个密钥必须是不同的、至少 32 UTF-8 字节的随机值。SMTP 和微信支付配置要么完整提供，要么整体关闭。

## 迁移与生产限制

生产启动前先部署迁移并执行预检：

```powershell
$env:DATABASE_URL='file:D:/StudyMind/server/data/studymind.sqlite'
npm.cmd --prefix server run db:migrate:deploy
npm.cmd --prefix server run db:preflight
npm.cmd --prefix server start
```

生产环境会在配置不完整时拒绝启动：必须显式设置本地 SQLite `DATABASE_URL`、管理员邮箱、两把独立密钥及完整 SMTP；禁止 console OTP 和不安全的微信通知验证。数据库只允许本机文件，不接受网络共享、远程数据库或 URL 参数。运行时启用 WAL、`busy_timeout=5000` 和外键约束，因此该部署边界是单主机、单服务实例，不支持多实例横向扩展。仅信任 loopback 反向代理。

## 备份与恢复演练

备份前应先优雅停止服务，使 WAL 内容完成检查点，再复制 `.sqlite` 主文件到受控的本机备份目录。不要只在运行中复制主文件，也不要提交数据库、WAL/SHM sidecar 或备份到 Git。

用绝对路径对备份副本做只读恢复冒烟检查；工具会复制到临时目录，不会修改源备份或输出数据内容：

```powershell
npm.cmd --prefix server run db:restore-smoke -- --backup D:\Backups\studymind.sqlite
```

恢复前应再次停止服务，保留当前数据库的可回滚副本，验证备份通过 restore smoke 后再替换，并重新运行 `db:preflight` 和 `db:migrate:status`。健康探针中 `/health/live` 只表示进程存活；只有 `/health/ready` 成功才可接收流量。
