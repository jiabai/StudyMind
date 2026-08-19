# Architecture Decision Records

StudyMind 的架构决策记录。涉及录音、媒体来源或下游交接的实现，应先阅读相关 ADR；设计文档只负责补充交互和实施上下文，不覆盖已接受的架构决策。

| ADR | 决策 | 状态 |
|---|---|---|
| [0001 — local-only media sources](./0001-local-only-media-sources.md) | 只处理本地媒体，不保留 URL/社交平台抓取边界 | Accepted |
| [0002 — independent account, entitlement and LLM server](./0002-independent-account-entitlement-llm-server.md) | 账号、权益、计费与 LLM 服务独立于桌面端 | Accepted |
| [0003 — recording is finalized as local media](./0003-windows-recording-as-local-media.md) | 录音完成后复用 `LocalMediaSource` 和既有 Pipeline | Accepted；macOS 下游适用范围由 ADR 0005 扩展 |
| [0004 — Windows WASAPI recording backend](./0004-windows-wasapi-recording-backend.md) | Windows 使用原生 WASAPI 采集 mic/loopback/mixed | Accepted |
| [0005 — macOS recording backend](./0005-macos-recording-backend.md) | macOS 13+ 使用 cpal + ScreenCaptureKit，复用既有 WAV/finalizer/Worker 管线 | Accepted；已立项，实现尚未开始 |

## 录音 ADR 的关系

```text
ADR 0003  录音产物 = LocalMediaSource（跨平台下游边界）
   ├── ADR 0004  Windows 采集：WASAPI
   └── ADR 0005  macOS 采集：cpal + ScreenCaptureKit
```

ADR 0005 不改变 ADR 0003 的本地媒体交接、mixed 事务性和最终 WAV 保留策略；它只为 macOS
补充平台采集、TCC 权限、能力探测、打包和验收边界。
