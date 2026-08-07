# Local-only media sources: drop URL/social-platform tracking

StudyMind 仅处理用户导入的本地音视频文件，不再追踪任何 URL 或社交平台来源。移除 `SourceIdentity` 模块（Python 与 Rust 双端）、`ProcessRequest`（URL 入口）、`UrlTaskSource`、`WorkerOperation::{ProcessVideo, ResolveSourceIdentity}`，以及 manifest 中的 `source_url` / `source_identity` / `source_privacy_migration_version` 字段。

## Context

StudyMind 从 FrameQ 派生，FrameQ 处理 Bilibili / Douyin / Xiaohongshu / YouTube 等社交平台视频。派生时产品定位已明确为"本地优先的学习笔记工具"，AGENTS.md 将"不包含网络视频 URL 抓取功能 / 不包含社交平台 fallback 解析"列为硬约束。但代码层面 `SourceIdentity` 模块、URL 解析逻辑、`ProcessRequest` URL 入口、`UrlTaskSource` 等仍完整保留——既违反设计意图，又因 URL 管线在派生过程中已被部分拆除（`studymind_worker/pipeline.py` 仅剩 `from __future__ import annotations`，`studymind_worker/requests.py` 已不存在）而成为 dead code。

## Decision

彻底移除 URL 与社交平台源追踪能力，只保留本地文件路径：

- 删除 `worker/studymind_worker/source_identity.py` 与 `app/src-tauri/src/task_manifest/source_identity.rs` 整模块
- 删除 `ProcessRequest`（URL 入口）、`UrlTaskSource`、`TaskSource` 联合类型简化为 `LocalFileTaskSource`
- 删除 `WorkerOperation::{ProcessVideo, ResolveSourceIdentity}`、`WorkerJob::ProcessVideo`、`WorkerInvocation::ProcessVideo` 等 URL 相关 worker 操作
- 删除 CLI 的 `--request-stdin` 与 `--resolve-source-stdin` 模式
- manifest schema 移除 `source_url` / `source_identity` / `source_privacy_migration_version` / `source_privacy_quarantined` 字段，`source_kind` 隐式为 `local_file`
- bump `TASK_SCHEMA_VERSION` 3 → 4 与 `DESKTOP_WORKER_CONTRACT_VERSION` 7 → 8，旧 manifest 因 schema 不匹配而被视为不可读（已在历史记录中无 URL 任务）

## Consequences

- 代码面大幅简化：删除约 1500 行 URL/平台特定解析与校验逻辑
- 跨进程契约收紧：Tauri ↔ Worker 仅剩 `ProcessLocalMedia` / `RetryInsights` / `DownloadAsrModel` 三种操作
- 历史 manifest 兼容性：v3 manifest 不再可读，但当前部署中无 URL 任务（派生后未上线），无实际影响
- 未来若需恢复 URL 支持，应作为新模块重新设计，而不是复活已删除的 `SourceIdentity`
