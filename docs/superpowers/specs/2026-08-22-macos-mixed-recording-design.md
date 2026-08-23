# macOS Mixed Recording Design

> 状态：已获用户确认；异步终态失败契约已确认并纳入文档；Task 1-3 已完成，Task 4 为下一实现边界

## Goal

为 Issue #20 交付 macOS `mixed` 录音，并把 Windows 现有 mixed 启动逻辑迁移到同一套平台无关
协调器。一个 `RecordingSession` 同时采集麦克风与系统声音；只有两路均完成 native 初始化并越过
共同 ready 屏障后，session 才开始计时。任一路失败都会使整个 mixed 会话失败，不提交单路产物。

最终仍只产生一个 16 kHz、单声道、16-bit PCM WAV，并继续进入现有
`LocalMediaSource`、Worker、转写与总结流程。该功能不新增第二套前端录音或媒体流。

## Current Evidence and Scope

- macOS 麦克风与 system audio 单源后端已经实现；Intel Mac E1 已完成两条单源核心 native
  验收，system recovery supervisor 也已实现。
- 现有 `mixer.rs` 已支持两个输入的等权混音和最终格式归一化。
- Windows WASAPI 已能录制 mixed，但两路 worker 按顺序等待 ready；先启动的一路会在另一
  路 ready 前写帧，不满足 ADR 0005 的共同 time-zero 语义。
- 本切片包含共享 mixed coordinator、Windows 迁移、macOS mixed 接入、错误 source 元数据、
  自动化测试、前端 capability/error 契约和文档状态更新。
- Apple Silicon E2、外接显示器 E3、Developer ID 签名与公证不具备当前硬件或凭据条件，继续
  作为后续真机验收，不因 host-side 测试通过而标记为 Pass。
- 麦克风设备选择、sample-accurate 双源时钟同步、漂移校正、暂停/恢复和新媒体契约不在本切片
  内。

## Product Semantics

1. `mixed` 是显式 capability，不由 microphone 与 systemAudio 两个 capability 在前端推导。
2. macOS mixed 固定先请求麦克风权限，再请求 Screen Recording 权限。部分授权不产生降级：
   任何一项拒绝或初始化失败都使整个启动失败。
3. 两路 native stream 都开始运行并报告 Ready 后，协调器一次性打开共同 gate。打开 gate 的
   时刻定义 mixed audio time zero，也定义后端 `start` 可以成功返回的时刻；Controller 随后
   才启动 session timer。
4. callback 不得等待 gate。gate 打开前到达的数据必须被消费并丢弃，不能写入临时 WAV、不能
   计入有效帧，也不能因等待另一 source 而阻塞 native 实时线程。
5. 两路各自保留 native 协商格式，分别写入 `mic.wav` 与 `system.wav`。停止后 finalizer 负责
   重采样、声道转换和等权混音。
6. 任一路收到有效但振幅全零的帧是合法静音；任一路有效帧数为零则 mixed 整体失败。不存在
   “保留另一条路”或提交部分 `LocalMediaSource` 的路径。
7. system source 继续使用现有 ScreenCaptureKit recovery supervisor。主显示器只作为 filter
   技术入口，不改变“系统声音”的产品语义；mixed 不引入新的显示器范围语义或视频输出。
8. 两个 native source 不承诺 sample-accurate 同步。共同 gate 提供 best-effort 起点对齐，
   v1 接受长录音的轻微独立时钟漂移。
9. 权限交互先于 Ready 等待。用户处理 macOS TCC 对话框的时间不计入三秒 Ready timeout；v1
   不为尚未返回 `sessionId` 的首次权限等待增加取消协议。
10. `start_recording` 成功返回后的任一致命失败必须立即结束用户可见的 RecordingSession；前端
    停止计时并进入错误终态，后端在不阻塞通知的情况下继续清理采集资源。

## Chosen Architecture

### 1. Platform-neutral mixed coordinator

新增 `app/src-tauri/src/audio_capture/mixed.rs`，集中负责双源原子生命周期。平台后端为它提供
两个带稳定 source 身份的 prepared source handle；handle 封装 worker、ready 信号、共同 gate、
停止/取消控制和 join 结果，但不暴露 WASAPI、cpal 或 ScreenCaptureKit 类型。

协调器只处理以下职责：

- 同时持有 microphone 与 systemAudio 两个 worker；
- 在既有三秒启动窗口内等待两路 Ready；
- 任一路启动错误、ready channel 断开或超时后，取消两路并等待两路退出；
- Ready deadline 到期时，若恰有一路未 Ready，则 timeout error 归因给该 source；若两路都未
  Ready，则返回无 source 的 `RECORDING_STREAM_ERROR`；
- 两路均 Ready 时仅打开一次共同 gate，并返回一个 `MixedActiveCapture`；
- stop 时先向两路广播停止，再等待两路结果，避免顺序 stop 给另一 source 增加额外录音尾巴；
- cancel 时向两路广播取消、等待退出且不返回 source paths；
- 仅当两个结果都成功且各自具有有效帧时，按固定顺序返回 `mic.wav`、`system.wav`；
- 按 failure latch 的实际观察顺序锁存第一个已确认的 source failure，不按媒体 timestamp 排序；
  后续 cleanup 或另一 source 的派生错误不得覆盖它。

该模块不负责权限请求、native stream 创建、WAV 编码、system recovery、ffmpeg 或 Controller
状态。这样协调语义可以用确定性 fake source 在任意 host 测试，而平台 worker 仍保持单一职责。

### 2. Prepared source lifecycle

每个 source worker 遵循相同阶段：

1. 平台适配器完成权限、设备、队列、WAV writer 和 native stream 初始化。
2. native stream 成功开始后向协调器发送 Ready。此时 callback 已可运行，但 gate 尚未打开，
   所有 pre-gate block 都被丢弃。
3. 共同 gate 打开后，worker 才允许 writer 写帧并累计 `valid_frame_count`。
4. stop/cancel/source failure 都进入幂等 shutdown：停止 callback/stream、关闭队列、drain 或丢弃
   按控制类型允许的数据、finalize WAV header、join writer，最后返回 source summary 或错误。

Ready 表示该 source 已具备采集能力，不表示它已经写入一帧。有效帧检查发生在 stop/join 后，
因此合法静音可提交，而 ready 后始终无帧会以 Empty 语义使 mixed 失败。

### 3. Platform adapters

Windows `wasapi.rs` 把现有两个 source worker 接入共享 gate 与 coordinator。单源 mic/system
行为保持原样；mixed 不再按 worker 顺序等待或停止，从而获得与 macOS 一致的原子 startup、
stop 和 failure 语义。

macOS `macos.rs` 复用现有 cpal microphone worker 与 ScreenCaptureKit system worker：

- mixed 启动前按 microphone → Screen Recording 的固定顺序完成权限处理；
- 两个 worker 都接受共享 gate，并在 native stream start 后报告 Ready；
- system worker 继续负责 audio-only、self-audio exclusion、filter update/rebuild、2 秒 recovery、
  CMSampleBuffer 时间轴、补静音和 warning；
- 任一 worker 的 queue overflow、native runtime error、stop error 或无有效帧都会带 source 进入
  coordinator 的原子失败路径；
- 只有 mixed coordinator 已编入当前构建，且本次 capability probe 中 microphone 与
  systemAudio 都可用时，macOS 的显式 mixed capability 才标为 available；前端仍不得自行推导。

`RecordingBackend` 的平台边界、workspace 和 finalizer 继续复用；`ActiveCapture` 与 Controller
之间增加平台无关的异步终态通道，使 source worker 不必等待用户调用 stop 才能报告 runtime
failure。该通道适用于所有平台和所有 RecordingMode，公共层不得加入 macOS 或 mixed 特判。
`ActiveCapture` 还提供可克隆的 cancel handle：Controller 进入 Stopping 并把 capture 所有权交给
stop 操作后，竞态中的 cancel 仍能向 native workers 提升控制信号；两路 join 成功后 Controller
才原子进入 Finalizing，此后 cancel 被拒绝。

### 4. Accepted-session terminal failure supervisor

`start_recording` 成功返回是启动失败与已接受会话失败的边界：

- 返回前发生的权限、初始化、Ready 或 timeout 错误属于 `RecordingStartFailure`。启动调用在两路
  cancel、join 和 workspace cleanup 完成后直接返回错误，不发送失败 event，不留下 hydration
  快照；
- 返回后发生的 runtime、提前正常退出、stop、Empty 或 finalizer 错误属于
  `RecordingFailure`。Controller 原子锁存首个失败并立即发布终态，停止用户可见计时；
- runtime failure 锁存后先发送 `recording-failed`，随后后台 cancel peer、join worker 并清理
  workspace。清理期间 `cleanupPending=true`，拒绝确认错误和开始新会话；
- 仅临时文件删除失败不阻塞后续会话。若 native stream、callback 或 worker 无法确认退出，则
  `cleanupPending` 保持为 true，本进程内禁止新录音并提示用户重启；
- 清理完成后使用同一失败身份重发 `recording-failed`，更新 `cleanupPending=false` 和最终聚合的
  warnings。event 是实时路径，`get_recording_state` hydration 是漏收补偿路径。

失败身份固定为 `(sessionId, errorCode, source?)`。event、命令返回和 hydration 中的同一身份只能
使前端进入一次错误终态、调用一次用户错误入口；后续副本只更新 cleanup 与 warning 信息。

### 5. Finalization and downstream flow

成功 stop 只向现有 finalizer 交付两个 workspace-contained source path，顺序固定为 microphone
后 systemAudio。`mixer.rs` 继续使用：

```text
[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=1
-ar 16000 -ac 1 -c:a pcm_s16le
```

两个 source WAV header 记录各自协商格式，禁止先在 capture worker 中强制统一格式。ffmpeg 或
最终 WAV 验证失败返回既有 `RECORDING_MIX_FAILED` / `RECORDING_FINALIZE_FAILED`，Controller
清理整个 session workspace，不创建 `LocalMediaSource`。成功结果仍是单个 recording result，
继续走既有 IPC、前端和 Worker 管线。

## Data and Error Contract

### Source identity

在公共录音契约中增加闭集 `RecordingSource`：

- `Microphone`，序列化为 `microphone`；
- `SystemAudio`，序列化为 `systemAudio`。

`RecordingError` 增加可选 `source`。不新增 macOS 专用错误码，也不把设备名、display id、
OSStatus、路径或底层错误 message 传给前端或日志。

### Error mapping

| 阶段 | 错误结果 |
|---|---|
| microphone 权限拒绝 | `RECORDING_MIC_ACCESS_DENIED`, source=`microphone` |
| microphone 初始化失败 | `RECORDING_MIC_INIT_FAILED`, source=`microphone` |
| system 权限或 capability 不可用 | `RECORDING_SYSTEM_AUDIO_UNAVAILABLE`, source=`systemAudio` |
| system stream 初始化失败 | `RECORDING_SYSTEM_LOOPBACK_INIT_FAILED`, source=`systemAudio` |
| 任一路 runtime、queue 或 stop 失败 | `RECORDING_STREAM_ERROR`，携带对应 source |
| 任一路无有效帧 | 保持 Empty 语义并携带对应 source，mixed 不提交另一条路 |
| ffmpeg 混音失败 | `RECORDING_MIX_FAILED`，不携带 source |
| 最终产物验证失败 | `RECORDING_FINALIZE_FAILED`，不携带 source |

第一个已确认的 source failure 优先于后续正常 stop、另一 worker 因取消产生的错误或 workspace
cleanup 错误。只有两路都正常完成，才允许进入 finalizer。若 finalizer 已开始，则其失败属于
组合产物而不是某个 source，不附加 source。

前端解析器接受可选 source，并在现有本地化错误路径中用于解释失败来源。source 缺失仍兼容
现有非 source 错误；未知 source 或错误类型的数据继续 fail-closed。前端不新增 mixed 专用页面、
第二个 session 或第二套媒体选择流程。

### Accepted-session state and event

`get_recording_state` 从“活动对象或 null”扩展为显式 tagged union：

```text
{ status: "recording", sessionId, mode, elapsedMs, warnings }
{ status: "failed", sessionId, mode, elapsedMs, errorCode, source?, cleanupPending, warnings }
null
```

failed variant 与 `recording-failed` payload 共用同一个 `RecordingFailureView`，不得维护两套字段。
失败快照仅存在于当前 Tauri 进程，不落盘；保留到用户确认或新会话原子取得所有权。新增
`acknowledge_recording_failure(sessionId)`：只有匹配且 `cleanupPending=false` 的快照可清除；
同 session 重复确认成功，不匹配的旧 session 返回 `RECORDING_SESSION_INVALID`。

同一已失败 session 的 `stop_recording` 返回已锁存原始失败；`cancel_recording` 是幂等清理请求且
不覆盖失败快照。finalizer 开始后 cancel 不再胜出，返回 `RECORDING_SESSION_INVALID`，原 stop/
finalize 继续完成。

## Cleanup and Concurrency Rules

- startup 任一路失败或超时：协调器先向两路发送 cancel，再 join 两路，随后由 Controller 清理
  整个 workspace；权限等待结束后才开始三秒 Ready timeout。
- stop：先广播 stop，再 join；在两路正常完成前已锁存的 source failure 胜出。
- cancel：先广播 cancel，再 join；不运行 finalizer，不保留诊断 WAV。
- stop/cancel 竞态中，finalizer 开始前 Cancel 可覆盖 Stop；两路 join 完成且 finalizer 已开始后，
  Cancel 返回 `RECORDING_SESSION_INVALID`，不能中断组合产物提交。
- runtime failure：原子锁存失败并发送 `cleanupPending=true` 的终态 event，再 cancel peer、join、
  cleanup；清理成功后以同一失败身份发送 `cleanupPending=false` 更新。
- callback 和 writer 在返回 start/stop/cancel 前必须已脱离临时路径；Controller 不能删除仍被
  worker 写入的文件。
- shutdown、join 和 workspace cleanup 必须可以安全处理重复信号或部分初始化；不能遗留第二
  个 stream、writer、callback 或 worker。
- cleanup 失败不能把已锁存的业务失败替换为无来源错误，但必须继续执行剩余清理并遵守现有
  错误记录边界。
- 所有 source path 与删除操作继续受 `CaptureWorkspace` containment 检查约束。
- ScreenCaptureKit 只注册 Audio output；收到视频 buffer 仍 fail-closed，且任何 mixed 路径都
  不得创建、保存或向 Worker 传递视频数据。

## Test Strategy

### 1. Shared coordinator tests

使用可控 fake prepared sources 覆盖：

- 两路均 Ready 后只打开一次 gate，且 pre-gate frames 不写入、不计数；
- 一路 Ready、另一路初始化失败；一路 channel 断开；启动超时；
- startup 失败会 cancel/join 两路，不遗留活动 worker；
- stop 同时通知两路，不按 source 串行停止；
- source failure 与 stop 竞态，第一个已确认 failure 优先且 source 不丢失；
- cancel 不返回 source path、不进入 finalizer；
- 两路有效、一路合法静音、一路无帧、一路提前结束；
- 结果路径严格为 `mic.wav`、`system.wav`，任一失败时不返回部分路径；
- 第二个 cleanup/join 错误不覆盖首个 source failure。

### 2. Platform adapter tests

- Windows：WASAPI mixed 使用共享 gate/coordinator；两路各自格式保留；init/runtime/overflow/
  stop error 正确标记 source；单源行为不回归。
- macOS portable seams：固定权限顺序、mixed capability 显式门控、cpal/SCK adapter ready、
  gate 前丢帧、source 标记、system recovery 与 mixed failure 组合行为。
- `macos_test` 继续在 Windows host 编译纯逻辑 seam；这些测试不得被记录为 macOS native Pass。
- macOS target 上必须补 native compile，确认共享抽象未引入 Send/Sync、callback lifetime、
  CoreAudio 或 ScreenCaptureKit 绑定问题。

### 3. Finalizer and controller tests

- finalizer 只接受两个 contained source paths；不同 WAV header/采样率/声道数能使用既有等权
  `amix` 参数得到 16 kHz mono PCM16；ffmpeg 失败不提交结果。
- Controller 只有 backend 两路 Ready 并成功返回后才进入 recording 状态和启动计时。
- startup、runtime、stop、empty、finalizer、cancel 和 cleanup 竞态都只结束一个 session，清理
  整个 workspace，不创建部分 `LocalMediaSource`。
- runtime failure 无需等待用户 stop 即结束 Controller 会话；event、stop 返回和 hydration 的
  重复失败按身份去重，cleanup 状态更新不重复调用用户错误入口。
- `get_recording_state` 覆盖 recording/failed/null；failed snapshot、确认、清理完成重发、窗口
  重载恢复和进程重启清除均有测试。
- `cleanupPending=true` 禁止确认和新启动；临时文件删除失败可解除阻塞，native teardown 未确认
  时持续阻塞并保留原始失败。
- 正常 mixed stop 只产生一个 `RecordingResult`，warning hydration 与 system 单源保持一致。

### 4. Frontend tests

- mixed option 只服从显式 capability，不从两个单源 availability 推导；
- source-tagged errors 能解析并使用现有本地化错误入口显示，不暴露内部 message；
- `RecordingFailureView` 同时解析 event 与 hydration，按 session/error/source 去重；
- runtime failure 立即停止 timer、清除活动控制、关闭 discard dialog，进入 error 且不 handoff；
- cleanup 完成前禁用关闭/重试，完成 event 只更新状态，不重复显示错误；
- mixed start/stop/cancel 仍使用一个 RecordingSession、一个 timer 和一个 media handoff；
- state hydration、system recovery warnings 和已有 mic/system 流程不回归。

### 5. Verification commands

实现计划应至少执行：

```text
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
cargo check --manifest-path app/src-tauri/Cargo.toml
npm --prefix app test
npm --prefix app run build
git diff --check
```

macOS 原生编译与真机命令在可用机器上按验收计划记录系统版本、架构、工具链、commit SHA 和
产物证据，不由 Windows 命令替代。

## Acceptance and Issue Closeout

当前 Windows 环境可以完成共享协调器、Windows 迁移、macOS portable seam、前端契约、完整
host-side tests/build 和文档更新。完成这些工作后：

- Issue #20 转为 `ready-for-human`，不直接关闭；
- 验收计划中的 M-01 至 M-10 和 D-06 至 D-10 可记录 Host-side implementation evidence，但
  E1/E2 runtime 状态仍保持 Planned，直到真机执行；Host-side evidence 不得表述为 macOS runtime Pass；
- E2 Apple Silicon 与 E3 外接显示器继续保留，不用 Intel 或 Windows 结果替代；
- E3 主要验证 system recovery/display 场景，mixed 必须证明能继承同一 system failure/recovery
  语义，但不另造显示器产品语义；
- ADR、handoff 和 acceptance 文档只写实际证据，不将 host-side Pass 表述为 macOS runtime Pass。

后续 E1/E2 mixed 真机验收至少覆盖：权限顺序与部分授权、双源实际有声、两路不同协商格式、
start/stop/cancel、一路静音、一路无帧或提前失败、queue/runtime/stop 失败、停止竞态、60 分钟
录音、ffprobe 最终格式、临时目录清理、无部分产物及无视频输出。Issue #20 只有在要求的真机
证据完成且验收文档回填后才可关闭。

## Alternatives Considered

1. **采用：共享平台无关 mixed coordinator。** Windows 与 macOS 使用相同 ready gate、广播
   stop/cancel、首错优先和原子结果语义；行为集中且能在 host 上确定性测试。代价是需要迁移
   Windows 现有逻辑，但这也修正了其 pre-ready frame 不一致。
2. **由 Controller 调用两次 backend start 再组合。** 现有 `RecordingBackend`/`ActiveCapture`
   是单会话生命周期，Controller 无法在不扩散平台细节的情况下保证 callback gate、同时停止和
   原子 join；会把 native 协调泄漏到上层，因此不采用。
3. **Windows 与 macOS 分别实现 mixed lifecycle。** 改动局部，但 ready、竞态和 cleanup 规则
   会形成两套实现与测试，长期容易漂移，因此不采用。

## File Boundaries

- Create: `app/src-tauri/src/audio_capture/mixed.rs`（共享 coordinator、gate 和 fake-source tests）
- Create: `app/src-tauri/src/audio_capture/failure_supervisor.rs`（通用首错锁存与异步唤醒）
- Modify: `app/src-tauri/src/audio_capture/mod.rs`（module wiring、source error、终态通道、failed snapshot、状态 union、确认命令）
- Modify: `app/src-tauri/src/lib.rs`（注册失败确认命令）
- Modify: `app/src-tauri/src/audio_capture/wasapi.rs`（Windows source adapter 与共享 mixed）
- Modify: `app/src-tauri/src/audio_capture/macos.rs`（macOS source adapter、权限顺序、mixed capability）
- Modify: `app/src-tauri/src/audio_capture/mixer.rs`（仅补充不同格式/原子输入测试，保留混音参数）
- Modify: `app/src/recordingClient.ts`（可选 error source、RecordingFailureView、failed event/state、确认命令）
- Modify: `app/src/recordingClient.test.ts`（source/error/capability/failure event/state contract tests）
- Modify: `app/src/features/workflow/useRecordingController.ts` 及其测试（把 error source 送入现有
  本地化错误入口，处理 event/hydration 去重、cleanup UI，并断言 mixed 仍只有一个 session）
- Modify: `app/src/features/workflow/RecordingCard.tsx` 及其测试（失败来源和 cleanupPending 文案/控制）
- Update evidence: `docs/adr/0005-macos-recording-backend.md`
- Update evidence: `docs/test-plans/macos-recording-acceptance.md`
- Update handoff: `docs/handoffs/studymind-macos-recording-implementation-handoff.md`
