# ADR 0005: Adopt a native macOS recording backend (CoreAudio + ScreenCaptureKit)

## Status

Accepted — macOS 内置录音已立项，本文档冻结技术边界；#17 麦克风 E1 已完成，#18 系统声音已进入实现，#20 负责 mixed，完整真机与发布验收仍未完成。

Accepted 表示技术决策已批准，不表示实现或发布门槛已经通过。当前验证状态见
[macOS 录音验收计划](../test-plans/macos-recording-acceptance.md)，在要求项全部通过前不得宣称
macOS 录音实现完成。

本文档是 macOS 录音实现的技术事实来源。UI 的交互定稿仍见
[内置录音设计文档](../design-docs/02-audio-recording-design.md)；Windows 后端仍由
[ADR 0004](./0004-windows-wasapi-recording-backend.md) 负责。

## Context

当前 v0.2.0 的录音后端仍是 Windows-only：

- Rust 侧 `audio_capture/` 只有 `#[cfg(windows)]` 的 WASAPI 实现；非 Windows 由
  `RecordingController::from_runtime_paths` 注入不可用后端。
- 不可用后端返回 `platform: "unsupported"`，麦克风和系统声音均不可用。
- 前端 `RecordingCapabilities.platform` 目前只有 `"windows" | "unsupported"`，能力判断也把
  `platform === "windows"` 写死。
- 当前控制器、WAV 写入器、ffmpeg finalizer、`select_local_media_by_path` 和 Worker 管线已经
  能承载平台无关的录音产物；下游不应因为新增 macOS 采集而引入第二套媒体契约。

目标是在 macOS 上提供与 Windows 一致的三种录音模式：`mic`、`system`、`mixed`，同时保持：

- 本地优先：音频只写入 app-local data，不上传、不写入日志；
- 成功停止后仍产出一个稳定的 16 kHz、单声道、16-bit PCM WAV；
- 不安装 BlackHole 等虚拟声卡或内核驱动；
- system 模式只获取系统音频样本，不保存屏幕视频；
- 权限、设备、系统版本和流中断都通过能力探测或既有错误码表达。

## Decision

### 1. 能力矩阵

能力探测结果是 UI 的唯一依据；UI 不根据操作系统名称猜测某个模式是否可用。

| macOS 版本 | `mic` | `system` | `mixed` | 说明 |
|---|---:|---:|---:|---|
| macOS 13+ | 可用 | #18 已实现，待 native E1 重验（需 Screen Recording 权限） | #18 不开放；#20 完成双路 ready、原子失败和清理后再开放 | source 能力仍受设备、TCC 和运行时流状态影响 |
| macOS 12.x | 可用（cpal） | 不可用 | 不可用 | ScreenCaptureKit 的系统音频能力不纳入本产品兼容范围 |
| 其他平台 | 由现有后端决定 | 由现有后端决定 | 由现有后端决定 | Linux 仍是另案 P2 |

macOS 13+ 的任一 source 因权限、无可捕获内容或初始化失败而不可用时，能力结果将该 source
标记为不可用，并携带 `reasonCode`。在空闲态加载偏好或刷新能力时，已保存的不可用模式回退到
可用的 `mic`，并向用户解释原因；用户明确点击开始后不得静默换源，能力竞争或启动失败必须重新
探测并报错。录音已经开始后不做静默降级，采集流中断按失败处理。

能力契约中的 `mixed` 是显式 source capability，不得由 `microphone.available` 与
`systemAudio.available` 推导。#18 即使两路 source 都可用也保持 macOS `mixed` 不可用；只有
#20 完成双路 ready 屏障、原子失败、停止和清理语义后才允许开放。

### 2. 平台适配边界

继续复用既有 `RecordingBackend`、`ActiveCapture`、`RecordingController`、文件存储和
`RecordingFinalizer` 抽象：

- `from_runtime_paths` 增加 `#[cfg(target_os = "macos")]` 分支，注入 macOS 后端；
- `RecordingPlatform` 增加 `Macos` 变体，序列化为 `"macos"`；
- `UnavailableRecordingBackend` 继续作为 Linux 等未实现平台的兜底；
- macOS 使用现有 `$APPLOCALDATA/recordings/.tmp/<session-id>` 工作目录和 finalizer；
- 现有 500 MB 低磁盘告警在 macOS 也必须保留，复用 `RecordingDiskSpace` 抽象并提供 macOS
  的可用空间探测实现；
- Worker、`desktop-worker-contract.json`、任务状态机和最终的 `LocalMediaSource` 交接不变。

ScreenCaptureKit 的 Rust 绑定选用 `screencapturekit` crate（启用 macOS 13 的音频 API），
不引入 Swift helper binary，也不在首版方案中维护手写 Objective-C 消息桥。这样采集线程仍
留在同一 Rust 后端内，权限和生命周期可以收敛到 `RecordingBackend`。如果目标 Rust 工具链
或发布 SDK 无法满足该绑定的 API/链接要求，应在实现前重新打开本 ADR，而不是无记录地换成
另一种桥接方式。正式实现前必须完成 macOS 13+ Intel 与 Apple Silicon 的最小可行性验证，
覆盖编译/链接、audio-only 输出、TCC 行为和 ad-hoc 包；验证失败时先重开本 ADR。

### 3. 麦克风（`mic`）— cpal/CoreAudio

- 在 macOS target dependency 中加入 `cpal`，使用其 CoreAudio host 捕获默认输入设备；v1
  不增加麦克风设备选择，设备变更属于 P1。
- 权限只在用户点击开始录音后懒请求，不在录音入口加载时主动弹窗；`mixed` 固定先请求麦克风，
  再请求 Screen Recording。
- `mic` 和 `mixed` 首次启动需要 TCC 麦克风权限，并在最终 app bundle 的 `Info.plist` 声明
  `NSMicrophoneUsageDescription`。
- cpal 的实时数据回调只负责把音频块送入有界队列；不得在回调中执行磁盘 I/O、阻塞等待或
  调用 ffmpeg。独立 writer 线程负责追加 WAV；队列溢出或设备错误视为
  `RECORDING_STREAM_ERROR`。
- 权限拒绝映射为 `RECORDING_MIC_ACCESS_DENIED`；设备不存在或初始化失败映射为
  `RECORDING_MIC_INIT_FAILED`。

### 4. 系统音频（`system`）— ScreenCaptureKit

- macOS 13+ 使用 `SCShareableContent` 取得可捕获内容，以主显示器建立初始
  `SCContentFilter`；v1 不提供显示器选择 UI。产品承诺是“可捕获的 macOS 全局系统音频”，主
  显示器只是 `SCContentFilter` 的技术入口，不是用户可见的录音范围。实现前必须验证只注册
  audio output 的 stream 能持续捕获全局系统音频，不能未经验证把产品语义收窄为“主显示器声音”。
- 建立 `SCStream` 和 `SCStreamConfiguration`，开启 `capturesAudio`，请求稳定的音频采样率
  和声道数，并只注册 `SCStreamOutputType.audio` 输出。不得注册 `.screen` 或 `.microphone`
  输出，也不得把任何视频 sample buffer 写入文件或传给 Worker。
- 默认排除 StudyMind 自身进程音频，避免应用提示音或后续 UI 音频回录；是否排除自身音频是
  平台实现的固定策略，不暴露为 v1 用户选项。
- system-only 只请求 Screen Recording 权限；mixed 同时请求 Screen Recording 和麦克风权限。
  最终 app bundle 的 `Info.plist` 必须声明 `NSScreenCaptureUsageDescription`。该权限在系统设置
  中可能显示为“屏幕与系统音频录制”；前端必须明确告知用户“只保存音频，不录屏”。
- 首次授权后可能需要重启应用，前端的“前往系统设置”流程应在回到应用后重新探测能力；不能
  假定当前进程立即获得权限。应用回到前台和重启后都必须重新探测能力。
- 录音期间发生显示器切换时，优先更新现有 stream 的 content filter；若 filter 更新不足以维持
  audio-only stream，再重建 stream。只有更新或重建均无法恢复连续音频时，才将 system source
  判定为失败；不得因为主显示器发生变化就直接失败。恢复窗口为 2 秒以内；窗口内的短暂无帧
  间隙按音频 sample buffer 的媒体时间戳或统一 capture timebase 计算并以静音补齐，同时发出
  `RECORDING_SYSTEM_AUDIO_RECOVERED` warning；不得使用前端计时器或墙上时钟推算缺口。超过
  窗口仍未恢复时返回 `RECORDING_STREAM_ERROR`，并附带 `source: "systemAudio"`。
- 2 秒恢复窗口是 v1 固定产品常量，不提供用户设置、配置文件或远端覆盖。每次恢复独立应用该
  上限；会话不因恢复次数本身失败，但必须累计 warning 的 `count` 和 `totalGapMs`。
- 未授权、无可捕获显示器/内容、系统版本不满足或 `SCStream` 启动失败时，映射为
  `RECORDING_SYSTEM_AUDIO_UNAVAILABLE` 或 `RECORDING_SYSTEM_LOOPBACK_INIT_FAILED`，并在能力
  结果中让 system source 不可用。ScreenCaptureKit 不是传统输出设备 loopback，因此这里不
  以“无默认输出设备”作为唯一失败条件。
- 如果无法可靠验证 `excludesCurrentProcessAudio` 生效，system source 不得标记为可用；实现应
  让能力探测返回不可用，而不是接受可能回录 StudyMind 自身音频的风险。
- audio-only 边界按 fail-closed 处理：实现不得注册 screen output；如果收到视频 sample buffer，
  或无法证明视频数据没有进入 writer/Worker，system source 不得标记为可用，活动会话必须失败。

### 5. 混合（`mixed`）— 双路并发 + 既有 ffmpeg

- 同一 `RecordingSession` 内并发启动 cpal 和 ScreenCaptureKit；只有两路都启动成功后才向
  `start_recording` 返回成功。两路都发出 ready 信号后才定义 session audio time zero；屏障前
  先就绪一路产生的帧不得进入最终录音。
- 两路分别写入 session 临时目录的 WAV。任一路启动、运行或停止失败，都停止另一条路、清理
  临时目录，并使整个 mixed 会话失败；不得静默退化为单路录音。
- 两路临时 WAV 必须写入各自协商出的明确 PCM 格式和完整 WAV header；采样率、声道数等差异
  由 ffmpeg finalizer 在混音阶段处理，最终产物仍固定为 16 kHz、单声道、16-bit PCM WAV。
- 一路收到有效但振幅为零的音频帧时，视为合法静音；一路完全没有有效音频帧时，视为失败，
  `mixed` 不得提交部分结果。两路均有有效帧但其中一路静音时，仍提交合法的 SilentRecording。
- 任一路 writer 有界队列溢出视为该 source 的 `RECORDING_STREAM_ERROR`。用户停止与 source
  failure 竞态时，只要错误在两路正常停止完成前已经确定，就由失败结果优先；只有两路均正常
  完成后才允许 finalizer 提交结果。
- 停止时复用现有 `mixer.rs` 和捆绑的 ffmpeg，保持当前 equal-weight 归一化参数：
  `amix=inputs=2:duration=longest:dropout_transition=0:normalize=1`，最后输出
  `-ar 16000 -ac 1 -c:a pcm_s16le`。
- 两个系统音频时钟不做 sample-accurate 共享时钟同步；方案只保证按 session 起点进行 best-
  effort 对齐，接受长期录音的轻微漂移；v1 不设置硬性时长上限，也不提供数值化的
  sample-accurate 或漂移承诺。实现验收必须覆盖短录音、60 分钟录音和任一路静音/提前结束的
  场景，并确认没有明显错位或截断。

### 6. IPC、前端能力门控和错误语义

- Tauri 命令保持现有集合：`get_recording_capabilities`、`start_recording`、
  `stop_recording`、`cancel_recording`、`get_recording_state`；不新增 Worker 或录音专用
  网络接口。
- v1 新增最小化的 Rust → 前端 `recording-warning` Tauri 事件，用于运行时可恢复异常。payload
  固定为 `{ sessionId, warningCode, source?, count, totalGapMs }`；本 ADR 定义的首个 warning
  code 为 `RECORDING_SYSTEM_AUDIO_RECOVERED`，`source` 为 `systemAudio`。事件不得携带
  message、OSStatus、设备名或音频数据；用户文案由前端本地化。
- 事件只负责即时通知，不能作为 warning 的唯一存储。`RecordingSession` 按
  `(warningCode, source)` 去重并累计 `count` / `totalGapMs`；`get_recording_state` 和
  `stop_recording` 都必须返回当前累计的 `warnings` 列表，使前端重新挂载或漏收事件后仍能恢复。
- `RecordingCapabilities.platform` 类型增加 `"macos"`，解析器和能力判断允许
  `windows` / `macos`，不再硬编码 Windows。能力契约显式携带 microphone、systemAudio 和
  mixed capability：Windows 可由两路已实现 source 组合出 mixed；macOS 在 #18 只开放 system，
  mixed 必须保持 unavailable，直到 #20 完成双路 ready、原子失败和清理语义后才开放。这样分阶段
  交付不会把“两个 source 分别可用”误解释为“mixed 已实现”。
- `start_recording` v1 仍只接收 `{ mode }`，不提前加入未实现的 `micDeviceId`；设备选择属于
  P1，需要另行定义设备生命周期和权限行为。
- 复用现有错误码，不增加 macOS 专用错误码：
  - 麦克风 TCC 拒绝：`RECORDING_MIC_ACCESS_DENIED`；
  - 系统音频权限/能力不可用：`RECORDING_SYSTEM_AUDIO_UNAVAILABLE`；
  - 采集流运行中断：`RECORDING_STREAM_ERROR`，结构化错误可附带 `source`（`microphone` 或
    `systemAudio`）以便解释失败来源；
  - ffmpeg 或最终 WAV 校验失败：`RECORDING_MIX_FAILED` / `RECORDING_FINALIZE_FAILED`。
- 能力探测阶段的不可用只影响 option 和开始按钮；空闲态的已保存模式可按上述规则回退；用户
  明确点击开始后和活动会话中的 source 失败必须报错，不自动换源。

### 7. 打包、签名和数据边界

- 当前 Tauri 配置已将 `resources/bin/**/*` 纳入资源，macOS 发布流水线也已分别准备
  x64/arm64 的 `ffmpeg` 与 `ffprobe`。ADR 只要求实现时验证架构匹配、可执行位和
  `resolve_runtime_paths` 的路径解析，不再假设需要另建资源目录。
- `assetProtocol.scope` 和任何本地媒体路径校验必须覆盖 `$APPLOCALDATA/recordings/**`，但
  仍只允许 app-local 目录；不得扩大到用户主目录或任意文件系统路径。
- macOS 的 TCC 授权与 bundle identity/签名相关。当前构建是 ad-hoc signed / not notarized，
  只能作为开发验证材料；发布前必须使用稳定的 Developer ID 签名并完成公证验证。
- system capture 只向音频 writer 传递 `CMSampleBuffer` 的音频数据；屏幕权限是系统 API 的
  访问门槛，不改变 StudyMind 的本地优先和“不录屏”产品边界。显示器切换恢复必须保持这一
  audio-only 数据边界。mixed 失败时不保留任何一路临时 WAV，只保留稳定错误码和可选的
  `source` 元数据用于解释失败来源。
- 应用启动时清理 `$APPLOCALDATA/recordings/.tmp/` 中不属于当前活动会话的陈旧目录；v1 不尝试
  恢复、提交或保留崩溃前的部分 WAV。

## Alternatives considered

### cpal 同时承担 mic 与 system 捕获

Rejected：cpal 在 macOS 提供 CoreAudio 设备输入/输出抽象，但不提供 ScreenCaptureKit
系统音频内容捕获；不能把 output device 当作系统音频 loopback 的替代品。

### BlackHole 等虚拟声卡

Rejected：需要用户安装第三方音频设备，破坏开箱即用、权限可解释性和发布边界。它只作为
用户自行配置的外部 workaround，不作为 StudyMind 内建依赖。

### Swift helper 或手写 Objective-C 桥

Rejected for the first implementation：会增加 Swift runtime/签名/资源打包和跨架构构建面，
同时重复 Rust 后端的 session 生命周期。macOS API 绑定能力不足时再重新评估，不在实现中
静默切换。

### 只开放 mic，永久放弃 system/mixed

Rejected：不满足已确认的 macOS 完整功能目标。

### Web `getUserMedia` / `MediaRecorder`

Rejected：WebView 无法提供所需的系统音频捕获语义，且无法统一 TCC、设备生命周期和稳定
WAV 产物。

## Consequences

### Positive

- macOS 13+ 的 Intel 和 Apple Silicon 共用同一能力模型和下游媒体管线；
- 不安装虚拟声卡，system/mixed 使用系统能力和明确的 TCC 权限；
- 状态机、WAV 文件层、ffmpeg finalizer、错误码和 Worker 契约保持复用；
- UI 可基于 capability 逐 source 灰显，而不是把 macOS 粗暴视为整个“不支持”。

### Costs and risks

- system/mixed 会触发 Screen Recording 权限；系统文案与“只录音”的用户预期存在解释成本，
  且授权后可能需要重启应用；
- macOS 13 是系统音频能力下限；系统更新、Intel 机型、多个显示器、远程会话和外接设备都
  需要真机验证；
- cpal 与 ScreenCaptureKit 使用独立时钟，长录音存在轻微漂移风险；
- `screencapturekit` Rust 绑定需要随 macOS SDK 和 Rust toolchain 验证；绑定失配需要重新
  评审，而不是在实现中引入未记录的 Swift/FFI 分支；
- macOS 发布需要稳定签名、公证和架构匹配的 ffmpeg/ffprobe 资源。

## Acceptance gates before implementation is called complete

1. macOS 13+ Intel 与 Apple Silicon：先完成绑定可行性验证，再分别验证 mic、system、mixed
   的 start/stop/cancel。硬门槛覆盖至少两个独立音频应用、默认输出设备变化、主显示器切换、
   外接显示器拔插、StudyMind 自身提示音排除和长时间只接收 audio output；任一失败先重开 ADR。
2. 首次拒绝、首次允许、允许后重启、系统设置撤销权限：能力结果、UI 灰显和错误码一致。
3. system 模式验证 audio-only stream 能持续捕获全局系统音频；显示器切换时优先更新 filter、
   必要时重建 stream，2 秒内恢复的间隙按媒体时间戳补静音并发出
   `RECORDING_SYSTEM_AUDIO_RECOVERED`；同时验证不注册 screen output、不产生或传递视频 sample
   buffer，且 StudyMind 自身音频不会被回录。
4. mixed 验证双路就绪屏障、两路不同协商格式、任一路初始化失败、运行中断、队列溢出、静音、
   无有效帧、提前结束、停止/错误竞态、部分权限成功和 60 分钟录音；确认不会提交部分录音、
   不发生静默换源，且失败后不残留用户音频临时文件。
5. 验证 macOS 12.x 只暴露 mic，Linux 和其他平台仍保持现有 unsupported 行为。
6. 验证 app-local 路径 containment、崩溃残留清理、500 MB 告警、ffmpeg 架构与可执行权限。
7. 在 ad-hoc 开发包与 Developer ID 公证包各走一次权限和重启流程，避免 TCC 结果只对开发
   进程成立。

逐项步骤、状态与证据字段见
[macOS 录音验收计划](../test-plans/macos-recording-acceptance.md)。

## Related

- [ADR 0003 — recording is finalized as local media](./0003-windows-recording-as-local-media.md)
- [ADR 0004 — Windows WASAPI recording backend](./0004-windows-wasapi-recording-backend.md)
- [内置录音设计文档](../design-docs/02-audio-recording-design.md)
- [macOS 录音验收计划](../test-plans/macos-recording-acceptance.md)
- [当前 Tauri 打包配置](../../app/src-tauri/tauri.conf.json)

## References

- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Apple: `SCStream`](https://developer.apple.com/documentation/screencapturekit/scstream)
- [Apple: Capturing screen content in macOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [Apple: `SCStreamConfiguration.capturesAudio`](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio)
- [Apple: Resetting access to protected resources in macOS](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos)
- [cpal documentation](https://docs.rs/cpal/latest/cpal/)
- [ScreenCaptureKit Rust bindings](https://docs.rs/screencapturekit/latest/screencapturekit/)
