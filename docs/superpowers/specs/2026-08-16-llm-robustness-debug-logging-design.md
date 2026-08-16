# LLM 调用健壮性与 Debug 日志设计

## 目标

增强 Worker 调用 OpenAI-compatible LLM 和 StudyMind managed checkout 的可诊断性与边界安全性，帮助定位配置、网络、服务端 checkout、provider 响应和响应解析问题，同时避免在日志中泄露凭据或用户 prompt。

## 范围

本次只修改 Worker LLM 客户端及其测试：

- `worker/studymind_worker/llm.py`
- `worker/tests/test_llm.py`

不修改 server checkout 协议，不引入底层自动重试，不把 prompt 或完整响应写入日志，也不改动 Tauri/frontend 现有工作区修改。

## 方案

### 调用日志

使用 Python 标准库 `logging`，在 checkout 和 provider completion 两个边界分别记录：

- `stage`：`checkout` 或 `completion`；
- 脱敏后的 URL（只保留 scheme、hostname、port 和 path，不记录 query/fragment/userinfo）；
- provider/model；
- managed 请求的 per-call request id（不记录 session token）；
- 请求耗时；
- 成功、HTTP 状态、错误码或异常类型。

成功日志使用 debug 级别，失败日志使用 warning 级别。日志消息只包含有限长度的错误摘要；API key、session token、Authorization、prompt、响应正文和 provider detail 中可能出现的凭据都不进入日志。为方便调用方区分同一次 managed 调用的 checkout 与 provider 请求，使用同一个 per-call request id 作为日志 correlation 字段。

### 输入与异常边界

- 构造请求前校验 base URL、model、API key、timeout 和 managed checkout URL；非法 URL 不再让底层 `ValueError` 直接穿透。
- 将 `socket.timeout`、`TimeoutError`、`URLError`、`OSError` 统一映射为现有 `InsightGenerationError` 错误码，并保留 checkout 与 provider 的错误码区分。
- 保留现有响应大小限制和严格 JSON 结构校验。
- 不在底层自动重试：provider 生成可能产生副作用，managed checkout 还涉及额度消耗，重试策略继续由上层任务流程决定。

## 数据流

```text
InsightFlow
    -> ServerManagedInsightClient.generate
        -> checkout (session token, request id)
        -> OpenAICompatibleInsightClient.generate
            -> provider completion (managed api key)
            -> bounded response + strict content extraction
    -> InsightGenerationError / result
```

## 测试

补充测试覆盖：

- checkout 与 completion 成功日志包含阶段、耗时/结果字段和安全 correlation 信息；
- 日志不包含 session token、API key、Authorization、prompt 或完整响应；
- checkout/provider 的 timeout、URL/配置错误和网络异常被映射为稳定错误码；
- 非法 completion URL、空/超大/结构错误响应仍被安全拒绝；
- 现有 per-call request id、session/provider 凭据隔离和 checkout 错误映射保持不变。

## 非目标

- 不添加第三方日志依赖；
- 不实现 token usage 统计或完整 provider request/response dump；
- 不改变 server API 返回字段；
- 不更改 InsightFlow 的重试次数、提示词或业务错误文案。
