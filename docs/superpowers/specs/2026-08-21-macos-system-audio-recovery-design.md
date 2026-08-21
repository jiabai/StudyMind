# macOS System Audio Recovery Design

> 状态：已获用户确认，等待 spec review · 日期：2026-08-21

## Goal

为 Issue #21 增加 macOS `system` audio-only 录音的运行中恢复能力：显示器或默认输出变化
不得改变“系统声音”的产品语义；短暂中断在 2 秒内恢复时补齐静音并保留 warning；无法在
窗口内恢复时才以 `systemAudio` source failure 结束会话。

## Current Evidence and Scope

- Issue #18 的 E1 Intel macOS 产品代码已完成核心 native compile、TCC、全局系统音频、
  audio-only fail-closed、start/stop/cancel 和 ad-hoc bundle 基础验收。
- F-03 已观察到默认输出切换后的约 1.04 秒自然静音缺口，但当前产品没有补静音逻辑，状态
  为 `Partial`。
- F-04（显示器变化）和 F-05（恢复窗口）仍是实现后的补验/验收阻塞项；E2/E3、60 分钟
  录音、Developer ID/公证继续按验收计划暂缓。
- 本设计只处理单路 macOS `system` source。Issue #20 mixed、Windows WASAPI 行为、
  麦克风设备选择和暂停/恢复不在本切片内。

## Product Semantics

1. ScreenCaptureKit 的 display/filter 是技术入口，不是用户可见的录音范围。主显示器切换、
   外接显示器连接/拔出和默认输出切换都不能切换 source、静默回退到 mic 或直接令 system
   录音失败。
2. 录音期间继续只注册 `SCStreamOutputType::Audio`，保持 `capturesAudio=true`、
   `excludesCurrentProcessAudio=true`；任何 screen/microphone sample buffer 都维持
   fail-closed。
3. 2 秒是 v1 固定恢复窗口。恢复判断使用 worker 的 monotonic deadline；补静音的数量必须
   使用 CoreMedia sample presentation timestamp 与 duration 计算，不使用前端计时器、墙上
   时钟或“每次固定补 N 帧”的猜测。
4. 下一帧到达后若可可靠计算缺口且缺口不超过 2 秒，则向 writer 先写与缺口等长的零振幅
   PCM16，再写真实音频帧，并累计一个 `RECORDING_SYSTEM_AUDIO_RECOVERED` warning。
   若 timestamp 缺失/不单调，或缺口超过 2 秒，则 fail-closed，不伪造时间轴。
5. warning 是非阻塞的即时事件，同时必须持久在当前 `RecordingSession` 的内存状态中，供
   `get_recording_state` 和 `stop_recording` 返回；事件漏收不能丢失 warning 事实。

## Architecture

### 1. Portable recovery state machine

新增 `app/src-tauri/src/audio_capture/system_audio_recovery.rs`，不依赖 ScreenCaptureKit，
负责可测试的状态与时间计算：

- `SystemRecoveryState`: `Streaming`、`Recovering { deadline_ms }`、`Failed`、`Stopping`；
- `SystemAudioTimeline`: 保存最后一个有效 sample 的 presentation end、采样率、声道数和
  是否已经建立 time zero；
- `SystemAudioEvent`: `AudioSample { pcm16, presentation_ns, duration_ns }`、
  `StreamInterrupted`、`StreamRecovered`、`Stop`、`Cancel`；
- `SystemAudioRecoveryAction`: `WriteAudio`、`WriteSilenceThenAudio`、`RebuildStream`、
  `EmitWarning`、`FailSource`、`StopCleanly`；
- `RecoveryClock` 只用于恢复 deadline 和测试注入，CoreMedia timestamp 只用于媒体缺口。

状态机输入输出必须是纯数据，便于在 Windows host 上覆盖：

| 输入 | 状态变化 | 结果 |
|---|---|---|
| 首个合法 sample | `Streaming` | 建立 time zero，写真实帧 |
| 连续合法 sample 且无缺口 | `Streaming` | 写真实帧 |
| stream error / filter 更新失败 | `Streaming → Recovering` | 设置 2 秒 deadline，请求恢复 |
| 恢复后的合法 sample，媒体缺口 `0 < gap ≤ 2000ms` | `Recovering → Streaming` | 写静音 + 真实帧，累计 warning |
| 恢复后的合法 sample，媒体缺口 `> 2000ms` 或 timestamp 无效 | `Recovering → Failed` | `RECORDING_STREAM_ERROR`, source=`systemAudio` |
| deadline 到期仍无合法 sample | `Recovering → Failed` | `RECORDING_STREAM_ERROR`, source=`systemAudio` |
| 用户 stop/cancel | 任意非终态 → `Stopping` | 不把用户操作误报成 source failure |

状态机不直接持有 `SCStream`、Tauri `AppHandle` 或文件路径。writer 只接收已经做完时间轴
决策的 PCM16 block，因此短暂中断不会把 wall-clock 逻辑泄漏到媒体层。

### 2. macOS stream supervisor

修改 `app/src-tauri/src/audio_capture/macos.rs` 的 `run_system_capture_worker`：

- callback 保持非阻塞，只把音频 sample 的 owned PCM16 数据和 CoreMedia timing 放入有界
  supervisor channel；队列溢出仍映射为 `RECORDING_STREAM_ERROR`；
- 使用 `SCStream::new_with_delegate` 接收 `did_stop_with_error`，将 stream interruption 送回
  worker；delegate 不直接操作 writer 或 controller；
- worker 在活动 stream 上首先调用 `update_content_filter`；更新失败时停止旧 stream、
  使用同一 audio-only configuration 重建 stream、重新注册 Audio output 并启动；不会注册
  Screen 或 Microphone output；
- worker 在内部 control loop 中检查 shareable display topology，比较技术性 display id；
  发现 anchor 变化只触发 filter update/rebuild，不改变 source capability 或用户模式；
- 每次恢复尝试拥有同一个 2 秒 deadline，禁止无限重建。恢复成功后交给 portable state
  machine 计算静音缺口和 warning；恢复超时交给既有清理路径。

默认输出切换不新增设备选择或设备监听 API。它只表现为 audio sample gap 或 stream callback
error，并通过同一恢复路径处理，确保产品仍捕获全局系统音频。

### 3. Warning contract and controller persistence

修改 `app/src-tauri/src/audio_capture/mod.rs`：

- 增加稳定 warning code `RECORDING_SYSTEM_AUDIO_RECOVERED`，纳入既有闭集错误/警告解析；
- 增加序列化的 `RecordingWarningView`：

  ```text
  {
    warningCode: "RECORDING_SYSTEM_AUDIO_RECOVERED",
    source: "systemAudio",
    count: u32,
    totalGapMs: u64
  }
  ```

- `RecordingSession` 持有按 `(warningCode, source)` 聚合的 warning accumulator；stream worker
  通过 trait 注入 accumulator 和即时 emitter，不直接依赖 controller mutex；
- `RecordingStateView` 和 `RecordingResult` 增加 `warnings`；正常 stop、恢复后 stop、
  error/cancel 清理都不得泄漏音频路径、OSStatus、设备名或音频数据；
- `RecordingController::from_runtime_paths` 接收可选的 Tauri warning emitter，测试使用 no-op
  sink。`AppHandle` 只在 `lib.rs` setup 处注入，事件名固定为 `recording-warning`。

事件 payload 固定为：

```text
{
  sessionId,
  warningCode,
  source: "systemAudio",
  count,
  totalGapMs
}
```

即时 emit 失败不改变录音状态；accumulator 仍然保留 warning，保证 IPC 查询可恢复。

### 4. Frontend state and event consumption

修改 `app/src/recordingClient.ts`、`app/src/features/workflow/useRecordingController.ts`：

- 增加 `RecordingWarningView` 解析和 `RecordingStateView.warnings`、`RecordingResult.warnings`
  的闭集校验；未知字段、错误 source、负数/超大数值和未知 warning code 均拒绝；
- controller 在录音开始后监听 `recording-warning`，只接受当前 `sessionId` 的事件；事件到达
  时更新非阻塞 warning 状态并触发既有错误报告入口，不停止录音、不打开模态框；
- controller 启动/重新挂载时调用既有 `get_recording_state`，用持久化 warnings 恢复 UI，
  不用前端时钟估算 gap；停止时以 `stop_recording.warnings` 作为最终事实；
- `RecordingCard` 只展示本地化 warning 文案，不暴露 `OSStatus`、设备名或 display id。

## Failure and Cleanup Rules

- 用户 stop/cancel 优先于未确认的 recovery attempt；已确认的 source failure 在两路 mixed
  之外仍按现有 system error 清理路径处理。
- 旧 stream 停止、重建 stream、writer join 和临时目录 cleanup 必须是幂等的；重建失败不能
  留下第二个 writer 或第二个活跃 callback。
- 恢复窗口内补静音仍算有效音频帧，合法全静音录音可以提交；没有任何有效音频帧仍返回
  `RECORDING_EMPTY`。
- 不为 F-05 添加自动重试上限之外的后台守护、不保留诊断 WAV、不提交部分结果。

## Test Strategy

### Rust red-green tests

- `system_audio_recovery.rs`：首帧/time zero、连续帧、1.04 秒 gap 补静音、2 秒边界、
  超时失败、timestamp 不可用失败、stop/cancel 竞态、warning 聚合；
- `macos.rs`：delegate stream error 进入恢复、filter update 优先、rebuild 重新注册 Audio
  only、display id 变化不改变 source、重建失败映射稳定错误、队列溢出 fail-closed；
- `mod.rs`：warning accumulator 通过 `get_recording_state`/`stop_recording` 保留，emit 失败
  不改变录音结果，正常 stop 与 source failure 的优先级保持稳定；
- 测试顺序必须遵守 TDD：每个行为先写一个会失败的测试，确认失败原因，再写最小实现。

### TypeScript tests

- `recordingClient.test.ts`：解析 warning view、state/result warnings、事件 payload 边界；
- `useRecordingController.test.ts`：只消费当前 session warning、漏收后从 state 恢复、warning
  不改变 recording 状态、stop 返回 warning 后清理；
- `RecordingCard.test.tsx`：warning 文案非阻塞展示且不显示原始内部细节。

### Deferred native acceptance

本切片只把可自动化的 seam 和状态机实现完毕，不将 Windows host 测试写成 macOS Pass。恢复
实现后仍需在具备条件时补验：E1 F-03 复核、E3 F-04/F-05、E2 Apple Silicon、C-06 60 分钟、
Developer ID/公证以及真实 `.app` 重启/TCC 流程。

## Alternatives Considered

1. **推荐：Rust worker 内的 recovery supervisor + portable state machine。** 保留时间轴和
   stream 生命周期在 native 后端，前端只消费事实；可在 Windows host 证明边界，且不改变
   “系统声音”的用户语义。
2. **只重建 stream，不补静音。** 能减少状态，但无法满足 2 秒恢复产品契约，F-03 的自然
   静音缺口会进入最终媒体，故不采用。
3. **前端计时器发现停顿后重启录音。** 无法取得可靠媒体 timestamp，会造成重复/缺口、
   破坏 session identity，并可能静默换源，故拒绝。

## File Boundaries

- Create: `app/src-tauri/src/audio_capture/system_audio_recovery.rs` (new portable state machine)
- Modify: `app/src-tauri/src/audio_capture/macos.rs` (delegate, filter update/rebuild, supervisor)
- Modify: `app/src-tauri/src/audio_capture/mod.rs` (warning contract, persistence, controller sink)
- Modify: `app/src-tauri/src/lib.rs` (inject Tauri warning emitter during setup)
- Modify: `app/src/recordingClient.ts` (warning/state/result contract parsing)
- Modify: `app/src/features/workflow/useRecordingController.ts` (event subscription and state recovery)
- Test: `app/src-tauri/src/audio_capture/system_audio_recovery.rs`
- Test: `app/src-tauri/src/audio_capture/macos.rs`
- Test: `app/src-tauri/src/audio_capture/mod.rs`
- Test: `app/src/recordingClient.test.ts`
- Test: `app/src/features/workflow/useRecordingController.test.ts`
- Test: `app/src/features/workflow/RecordingCard.test.tsx`
- Reference only: `docs/adr/0005-macos-recording-backend.md`, `docs/test-plans/macos-recording-acceptance.md`
