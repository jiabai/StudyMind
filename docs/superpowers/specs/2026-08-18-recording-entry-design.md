# Recording Entry and Fake Composer Flow Design

## Goal

为 StudyMind 接入第一个可验证的录音入口：在现有输入区以与上传同级的双卡片展示录音，使用 Issue #9 的 Tauri façade 和 fake backend 走通能力探测、模式选择、开始、计时、停止、取消确认、最终 WAV 的 local-media handoff 与 retry。真实 WASAPI 采集、混音和生命周期加固由后续票据实现。

## Scope and boundaries

本票据修改录音入口、前端 controller、Tauri invoke adapter、录音偏好 v1→v2 兼容迁移和 composer handoff。录音状态独立于既有 `WorkflowState`；Worker Contract、Pipeline、WorkflowState stage 和现有 local-media selection 契约保持不变。

生产输入入口是 `app/src/App.tsx` 使用的 `app/src/features/workflow/HeroUploadZone.tsx`。`TaskComposer.tsx` 保持现状，仅保留既有测试与兼容用途，不作为新的生产入口。

## UX design

空闲态在 HeroUploadZone 输入区域渲染两个等权卡片：

- 上传卡片保留现有拖拽、选择文件、最近使用和标题行为。
- 录音卡片包含音源原生 select 与明确的“开始录音”按钮；点击卡片其他区域不开始采集。
- 能力探测 loading/unknown 时，录音 mode select 和 start 按钮 disabled。
- `mic`、`system`、`mixed` 按能力结果禁用不可用模式；若当前偏好不可用，视觉上回退到 mic。

录音态只在录音卡片内显示固定音源、elapsed time、stop 和 discard。模式 select 在会话期间 disabled，上传卡片不响应选择/拖拽，防止一个活动会话被另一个输入替换。

停止成功后，controller 先调用 `select_local_media_by_path`，再通过既有 workflow callback 设置 selected local-media composer source；不自动提交。如果 handoff 失败，保留 stop 返回值和最终 WAV 的受信任 retry 状态，retry 只重试 handoff，不重复 stop 或录音。

录音中的 Escape 打开 discard confirmation；确认框中的 Escape 只关闭 confirmation，只有显式确认才调用 cancel。start/stop/cancel 操作期间避免重复提交并保持焦点回到对应控制。

## Frontend architecture

### `recordingClient.ts`

新增严格解析的 invoke adapter，负责把 Tauri 的 snake/camel IPC payload 映射为前端类型：

- `getRecordingCapabilities`
- `startRecording(mode)`
- `stopRecording(sessionId)`
- `cancelRecording(sessionId)`
- `getRecordingState()`

解析器拒绝缺失字段、未知 enum、错误类型和不安全错误 payload，并以稳定 error code 抛出。它不渲染绝对路径、设备名、session token 或底层诊断。

### `useRecordingController.ts`

controller 状态由以下独立值组成：

- `capability`: `loading | unknown | ready | unsupported | unavailable`
- `mode`: 当前 select 值
- `session`: `idle | starting | recording | stopping | error`
- `activeSessionId` 与 elapsed time（仅 recording 时存在）
- `discardConfirmationOpen`
- `handoff`: `idle | retryable`，retryable 保存受信任的 stop result

controller 通过依赖注入接收 recording client、local-media handoff、偏好读写、clock/timer 和错误报告函数，测试不依赖 Tauri runtime 或真实计时器。

生命周期：

1. mount 与窗口 foreground 时读取 capabilities；该调用不请求麦克风权限。
2. 读取并校验 v2 偏好；缺失或不可用模式使用 mic，但只有成功 start 后才写入有效模式。
3. start 前再次依赖 façade 做能力/模式校验；成功返回 session 后进入 recording 并保存模式。
4. stop 成功后进入 stopping，完成 local-media handoff 后回到 idle；handoff 失败则进入 retryable error。
5. cancel 只在显式确认后执行；成功后回到 idle，失败保留 recording 或显示稳定错误。

### `RecordingCard.tsx`

新增纯展示组件，接收 controller view model 和 callbacks。它不直接调用 invoke、不直接读写偏好、不修改 `WorkflowState`。HeroUploadZone 负责布局与上传卡片，App 负责把录音成功后的 selection 交给现有 workflow composer callback。

## Preference migration

后端 UI preference 的 authoritative schema 从 v1 迁移到 v2：

```json
{
  "schemaVersion": 2,
  "language": "system",
  "recording": { "audioSourceMode": "mic" },
  "recovered": false
}
```

读取 v1 时保留 language，填充 `recording.audioSourceMode = "mic"`，并按现有 atomic/backup 规则完成迁移。未知或不可用模式在 view model 层回退 mic；失败 start 不覆盖最后一个成功模式。

## Error and privacy behavior

前端只按稳定 error code 映射本地化文案：capability unavailable、mic permission、system unavailable、active session、empty recording、stream/finalization failure、invalid session 和 handoff failure。IPC 原始错误 message 仅作为内部诊断，禁止进入 UI、普通日志或最近文件记录。

## Testing strategy

测试先行，所有新增行为先以失败测试固定：

- `app/src/recordingClient.test.ts`：命令名/参数、严格响应解析、稳定错误 code。
- `app/src/features/workflow/useRecordingController.test.ts`：capability 生命周期、模式回退、成功 start 才保存偏好、elapsed time、stop/handoff/retry、cancel confirmation、Escape 和失败恢复。
- `app/src/features/workflow/RecordingCard.test.tsx`：同级卡片、控件 disabled、固定模式、按钮行为与可访问性。
- `app/src/features/workflow/HeroUploadZone.test.tsx`：既有上传流程回归与录音卡片布局集成。
- 现有设置偏好 Rust/TypeScript 测试：v1→v2 迁移、默认 mic、损坏数据恢复和原子保存。

验证命令：

```text
npm.cmd --prefix app test
npm.cmd --prefix app run build
cargo test --manifest-path app/src-tauri/Cargo.toml --lib
```

## Out of scope

- Windows WASAPI microphone/system capture implementation。
- mixed 双流采集、等权混音和 ffmpeg finalization。
- 低磁盘 warning、真实 write failure、窗口关闭收尾和 stale temp cleanup。
- 新的 Worker media type、Pipeline stage 或 WorkflowState 录音分支。
- pause/resume、设备列表、RMS、全局快捷键和最终录音库 UI。
