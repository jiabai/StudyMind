# StudyMind Server 边界清理与正确性加固设计

## 目标

在保留当前 WorkerCommand 删除工作的基础上，使 `server/` 符合 StudyMind 的 local-first 产品边界，并修复已确认的 API 正确性、错误处理、SSE 生命周期和可验证性问题。

本次不实现账号认证、授权或 LLM 密钥托管。这些能力虽然出现在 ADR-0002 的长期职责描述中，但当前仓库没有完整 server 侧协议，需另行设计。

## 模块边界

Server 继续只暴露：

- `/health/live` 与 `/health/ready`
- `/api/tasks`
- `/api/progress`

不恢复 `/api/workers`，也不引入远程媒体处理、URL 抓取或远程 Worker 派发。

`Task` 删除旧来源追踪字段 `platform`、`sourceKind`、`sourceDisplay`。保留 `sourceMediaKind` 和 `sourceExtension`，因为它们描述本地媒体类型而非平台/URL 身份；保留值必须受本地媒体契约约束。

## API 与校验

所有请求对象使用严格 Zod schema，拒绝未知字段，避免客户端拼写错误被静默忽略。

- task ID：非空、最大 255 字符，所有 task/progress/SSE 路由复用同一约束。
- `sourceMediaKind`：仅 `audio` 或 `video`。
- `sourceExtension`：仅允许 `contracts/desktop-worker-contract.json` 中与媒体类型匹配的扩展名。
- progress stage：复用 contractVersion 8 的七个枚举值；progress 必须是 0–100 的整数。
- `PATCH /api/tasks/:taskId` 拒绝空对象；`completedAt: null` 明确清空完成时间，ISO 时间字符串转为 `Date`。
- 列表分页维持默认 50、最大 200。

创建重复 task ID 返回 409；查询、更新、删除不存在的 task 返回 404；给不存在 task 写进度返回 404。参数错误返回 400。未知服务端错误记录到 Fastify logger，并只向客户端返回稳定的通用消息。

## 数据一致性

移除 task 更新和删除中的“先查询再写”窗口，直接执行 Prisma 操作并集中映射 `P2025`。重复 task ID 映射 Prisma `P2002`。外键不存在映射 `P2003`。

记录进度时，在一个 Prisma transaction 内：

1. 创建 `TaskProgress`；
2. 更新对应 `Task.stage`；
3. terminal stage 同步 task status 和 `completedAt`：`completed`、`partial_completed`、`failed` 设置同名 status 与当前完成时间；非 terminal stage 将 `pending` 推进为 `processing`，但不覆盖已有 terminal status。

只有 transaction 成功后才向 SSE 监听者广播，避免客户端看到未持久化事件。

Prisma schema 删除三个旧来源字段，并同步已跟踪的开发数据库。不会删除用户任务数据；当前库仅用于开发。

## HTTP 与生命周期

- 显式响应 CORS `OPTIONS` 预检；现阶段保持现有 `Access-Control-Allow-Origin: *`，认证上线前不引入凭据型 CORS。
- `/health/live` 仅证明进程存活。
- `/health/ready` 执行轻量数据库查询；数据库不可用时返回 503。
- SSE stream 在连接、close、error 路径上使用幂等清理，避免重复 `end()`；提高 emitter listener 上限以容纳合理的同任务多窗口订阅，并继续每 30 秒发送 heartbeat。
- server 关闭时断开 Prisma，避免测试和进程退出泄漏句柄。

## 测试策略

使用 Vitest 与 Fastify `inject` 编写 server 集成测试，测试数据库使用独立临时 SQLite 文件，不依赖或污染 `server/prisma/dev.db`。

测试先行覆盖：

- health live/ready 与数据库失败场景；
- CORS preflight；
- 创建、列表、读取、更新、清空 completedAt、删除；
- 重复 ID、未知字段、空 PATCH、非法媒体扩展组合；
- 不存在 task 的更新、删除、进度写入；
- progress transaction 对 task stage/status/completedAt 的同步；
- SSE task ID 校验和事件广播后的清理。

最终验证运行：

- `npm --prefix server test`
- `npm --prefix server run build`
- `npm --prefix server exec prisma validate`

README 更新实际 API、环境变量、数据库配置和验证命令。

## 非目标与后续风险

- 不实现账号认证、权限隔离、限流、云端密钥托管或部署迁移系统。
- wildcard CORS 与未认证 API 不能作为公网生产配置；在认证设计完成前，README 必须明确这一限制。
- server 的 transcript/insights 云同步数据策略不在本次改变，后续应单独评估隐私、加密与保留周期。
