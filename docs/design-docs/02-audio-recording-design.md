# StudyMind 内置录音功能设计文档

> 状态：**设计定稿 v1.5** · 日期：2026-08-19 · 经用户确认
> 对标：EV录屏 音源选择模式 · 三模式：仅系统声音 / 仅麦克风 / 两者混合
>
> **定稿范围**：UI/UX 设计（§2 需求与交互、§6 前端设计）已定稿；Windows 录音为现有基线；macOS 录音技术方案由 [ADR 0005](../adr/0005-macos-recording-backend.md) 定稿，开发时不得回退为“P2/另案评估”。其余技术实现章节（§3–§5、§7–§11）为配套实现方案，可在不改变已定稿边界的前提下细化。
>
> 变更历史：
> - v1.5（2026-08-19，用户指令）：macOS 录音由 P2 提升为**已立项**，技术方案定稿见 [ADR 0005](../adr/0005-macos-recording-backend.md)（mic=cpal，system=ScreenCaptureKit，mixed=双路+ffmpeg）；§3.2、§10 同步更新
> - v1.4（2026-08-17，用户反馈）：下拉框与「开始录音」按钮同排紧凑布局，按钮常规尺寸，消除两卡内容量失衡
> - v1.3（2026-08-17，用户决策）：音源选择从卡片内三行 radio 改为原生下拉框 + 「开始录音」按钮
> - v1.2（2026-08-17，用户决策）：音源选择内嵌在「开始录音」卡片内，不设独立面板（避免操作层级过深）
> - v1.1（2026-08-17，用户决策）：空闲态改为「上传文件 / 开始录音」两个同级并排入口卡片；早期位置研究底稿（HTML 已清理）中「次要按钮」层级结论被覆盖

---

## 0. 定稿决策摘要（UI/UX）

以下为定稿决策，实现时以此为唯一依据：

| # | 决策项 | 定稿内容 |
|---|--------|----------|
| D1 | 入口位置 | HeroUploadZone 空闲态：两个**同级、等宽、等高**并排入口卡片 |
| D2 | 上传卡片 | SVG 插图（文档+上箭头）+ 标题 + 说明 + 支持格式行；整卡可点击/拖拽 |
| D3 | 录音卡片 | SVG 插图（麦克风+声波）+ 标题 + 说明 + 音源控件行 |
| D4 | 音源控件 | 原生 `<select>` 下拉（仅麦克风 / 仅系统声音 / 麦克风和系统声音）+ 常规尺寸「开始录音」按钮，**同排紧凑布局** |
| D5 | 开始交互 | 选音源 → 点「开始录音」→ 直接进入录音面板，全程无中间面板/弹层 |
| D6 | 音源记忆 | 下拉默认展示上次使用音源（`ui_preferences.recording.audioSourceMode`） |
| D7 | 录音面板 | hero 区原地切换：脉冲红点 +「录音中」+ 计时 HH:MM:SS + 电平条 + 暂停/停止/放弃 |
| D8 | 放弃保护 | 「放弃」二次确认弹层，Esc 可触发 |
| D9 | 设备异常 | 系统音频不可用 → 相关 option 灰显并自动回退；麦克风被拒 → 错误面板 + 前往系统设置 |
| D10 | 停止后 | 写入本机 → 复用 `select_local_media_by_path` → 已选文件态（改名/提交），下游零改动 |

**不在当前 v1 实现范围**（后续单独确认）：暂停/恢复、麦克风设备选择、全局快捷键、双路电平条真实数据、Linux 支持、录音压缩（AAC）。macOS 录音已立项，三模式后端方案以 [ADR 0005](../adr/0005-macos-recording-backend.md) 为准；macOS 12.x 仅提供 mic，system/mixed 不可用。

---

## 1. 背景与目标

### 1.1 用户场景

| 场景 | 音源需求 | 典型用例 |
|------|----------|----------|
| 线上网课（B站/慕课/腾讯会议） | 仅系统声音 | 播放视频 → 录音转写 → 文字稿 + AI 总结 |
| 课堂现场 | 仅麦克风 | 老师讲课 → 录音 → 转写校验 |
| 线上课 + 自己的复述/提问 | 麦克风 + 系统声音 | 双源混合 → 完整对话记录 |
| 小组讨论回放 | 仅系统声音 | 回放会议录音 → 提取要点 |

### 1.2 设计目标

1. **EV录屏 对齐**：音源选择三种模式；空闲态两个同级并排入口卡片（上传文件 / 开始录音），点击录音卡片进入音源选择面板，记忆上次选择
2. **下游零改动**：录完的音频文件走既有 `select_local_media_by_path → worker ASR → 校验 → AI 总结` 管线，worker 契约、任务状态机、前端 WorkflowState 均不修改
3. **分阶段平台支持**：Windows WASAPI 是现有基线；macOS 录音已立项并按 [ADR 0005](../adr/0005-macos-recording-backend.md) 实现，Linux 仍为 P2
4. **隐私本地**：录音数据仅存本地 appdata 目录，不经过网络，不写入日志

### 1.3 不做什么（显式排除）

- 不录声音（EV 第四种模式）—— 出 scope，有需要时加一行 radio 即可
- 视频录制 —— 不属于本次需求
- Linux 系统声音采集 —— P2 另案；macOS 系统声音采集不再属于本设计的排除项，具体权限和降级见 [ADR 0005](../adr/0005-macos-recording-backend.md)
- 录制中实时编码（AAC/MP3）—— v1 用 WAV，v2 可选压缩
- 录音文件云端同步 —— 不符合本地优先定位

---

## 2. 需求拆解

### 2.1 功能清单

| 编号 | 功能 | 优先级 | 说明 |
|------|------|--------|------|
| F1 | 双入口卡片 + 卡片内下拉选音源 | P0 | 上传/录音并排等宽卡片，各带 SVG 插图；音源下拉框 + 开始按钮在录音卡片内 |
| F2 | 仅系统声音录制 | P0 | WASAPI loopback |
| F3 | 仅麦克风录制 | P0 | WASAPI capture |
| F4 | 麦克风 + 系统声音混合录制 | P0 | 双路并发采集 → ffmpeg amix |
| F5 | 停止 → 写入本地文件 → 进入 composer | P0 | 复用 selectLocalMediaByPath |
| F6 | 放弃录音（二次确认） | P0 | 删除临时文件，回空闲态 |
| F7 | 录音计时（前端） | P0 | 等宽字体，HH:MM:SS |
| F8 | 录音中视觉反馈（脉冲红点） | P0 | 由现有 `RecordingCard` 的录音态承载 |
| F9 | 权限/设备错误提示 | P0 | 麦克风被拒、无系统音频设备等 |
| F10 | 10 分钟无声音告警 | P1 | 提示用户可能麦克风/扬声器静音 |
| F11 | 暂停 / 恢复 | P1 | 停止采集线程，恢复时重新打开设备 |
| F12 | 双路电平条 | P1 | 100ms 间隔 RMS 电平，前端可视化 |
| F13 | 录制中音量过低告警 | P1 | 连续 30s 低于阈值提示 |
| F14 | 快捷键（Ctrl+Shift+R） | P1 | 全局唤起录音 |
| F15 | 麦克风设备选择 | P1 | 默认设备，下拉切换 |
| F16 | macOS 录音支持 | 已立项 | macOS 13+ 三模式；macOS 12.x 仅 mic；见 [ADR 0005](../adr/0005-macos-recording-backend.md) |
| F17 | Linux 录音支持 | P2 | 另案评估 |

### 2.2 入口与音源选择 UI 设计

**入口（用户决策 v1.3）**：`HeroUploadZone` 空闲态为两个**同级、等宽、并排**的入口卡片：

```text
┌─────────────────────────────────────────────────┐
│  新建课题                                        │
│  ┌───────────────────┐  ┌───────────────────┐   │
│  │   [SVG: 文档+箭头] │  │  [SVG: 麦克风+声波]│   │
│  │     上传文件       │  │     开始录音       │   │
│  │  选择已有音视频    │  │  录课堂/网课/会议  │   │
│  │                   │  │ 音源[▾] [开始录音] │   │
│  │ mp4·mov·mkv·wav…  │  │  记忆上次选择      │   │
│  └───────────────────┘  └───────────────────┘   │
└─────────────────────────────────────────────────┘
```

- 两卡片视觉权重相等、等高；上传卡片整体可点击/拖拽
- **音源选择零面板层级**：录音卡片内一行紧凑控件——「音源」标签 + 原生 `<select>` 下拉 + 常规尺寸「开始录音」按钮（同排）；选好音源 → 点开始 → 直接进入录音面板，全程不离开空闲页
- 按钮用常规尺寸（非全宽），避免录音卡片内容量明显多于上传卡片；两卡内容密度保持均衡
- 下拉框默认展示上次使用的音源（存 `ui_preferences.recording.audioSourceMode`），打开下拉即可切换
- 系统音频不可用时，「仅系统声音」「麦克风和系统声音」两个 option 置灰禁用；空闲态已保存的
  不可用模式自动回退为仅麦克风并解释原因，用户明确点击开始后不得静默换源
- 窗口最小宽度 720px 时两卡片并排无压力；≤700px 预览环境降级为上下堆叠

---

## 3. 平台可行性分析（核心技术决策）

### 3.1 方案对比

| 方案 | 麦克风 | 系统声音 | 实时电平 | 依赖 | 结论 |
|------|--------|----------|----------|------|------|
| Web MediaRecorder (getUserMedia) | ✅ | ❌ WebView2 不暴露 loopback | ✅ | 无 | 排除 |
| ffmpeg dshow 采集 | ✅ | ❌ 需虚拟声卡驱动 | ❌ | 捆绑 ffmpeg | 备选 |
| **Rust WASAPI（windows crate）** | ✅ | ✅ 原生 loopback | ✅ | windows crate（编译时） | **采用** |
| **macOS cpal + ScreenCaptureKit** | ✅ CoreAudio | ✅ 系统音频样本 | P1（真实电平） | cpal + ScreenCaptureKit Rust bindings | **ADR 0005 已立项** |

### 3.2 技术原理

#### Windows WASAPI Loopback（系统声音）

Windows 10 1803+ 原生支持。通过 `IAudioClient::Initialize` 时传入 `AUDCLNT_STREAMFLAGS_LOOPBACK` 标志，以默认输出设备（扬声器）的 mix format 采集系统播放的所有音频。不需要安装任何虚拟声卡驱动。

**与 EV录屏 一致**：EV 在 Windows 上就是 WASAPI loopback。DRM 保护内容会被 Windows 音频引擎静音，不会录制到。

#### macOS ScreenCaptureKit（系统声音）

macOS 13+ 使用 ScreenCaptureKit 的 `SCShareableContent` → 主显示器
`SCContentFilter` → `SCStream` 链路，开启 `SCStreamConfiguration.capturesAudio`，只注册
`SCStreamOutputType.audio` 输出，不注册 screen 或 microphone 输出。首次使用需要 Screen
Recording 权限，最终 app bundle 必须声明 `NSScreenCaptureUsageDescription`；前端需说明这项
权限只用于取得可捕获的系统音频，不保存或传递屏幕视频；主显示器只作为 v1 的技术入口，不是
用户可选择的录制对象。产品语义仍是全局系统音频；实现前必须验证 audio-only stream 能持续
捕获全局系统音频，不能把主显示器解释为用户可见的录音范围。显示器切换时优先更新 filter，
必要时重建 stream；2 秒内恢复的缺口按媒体时间戳补静音并发送运行时 warning，只有音频流确实
无法在窗口内恢复才判定 source failure。

macOS mic 使用 cpal/CoreAudio，mixed 由 cpal 与 ScreenCaptureKit 双路并发后复用 ffmpeg
混音。macOS 12.x 只保留 mic；system/mixed 在能力探测中标记为不可用。详细的权限、绑定、
失败和验收边界见 [ADR 0005](../adr/0005-macos-recording-backend.md)。

#### 双路并发采集

```text
┌──────────────┐     ┌──────────────────┐
│ 麦克风        │────▶│ WASAPI Capture    │────▶ mic.wav (PCM 48k/16bit/mono)
│ (默认设备)    │     │ (IAudioClient)    │
└──────────────┘     └──────────────────┘

┌──────────────┐     ┌──────────────────┐
│ 扬声器        │────▶│ WASAPI Loopback   │────▶ system.wav (PCM 48k/16bit/mono)
│ (默认设备)    │     │ (IAudioClient)    │
└──────────────┘     └──────────────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │ ffmpeg amix +     │
                     │ 归一化 (16k/mono) │
                     └──────────────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │ recording_*.wav   │
                     │ → selectByPath    │
                     │ → worker pipeline │
                     └──────────────────┘
```

#### 混音策略

双路采集后，调用捆绑的 `ffmpeg.exe` 执行混音 + 归一化：

```bash
ffmpeg -y \
  -i mic.wav -i system.wav \
  -filter_complex "amix=inputs=2:duration=longest" \
  -ac 1 -ar 16000 -c:a pcm_s16le \
  output.wav
```

输出文件格式：16kHz 单声道 16bit PCM WAV → 命中 worker 的 `is_normalized_pcm_wav` 直拷快路径（跳过 Audio Extraction 阶段），转写启动时间最优。

仅单路模式也走一次 ffmpeg 归一化（`ar 16000, ac 1`），路径统一、测试简单。

#### macOS / Linux

| 平台 | 系统声音方案 | 状态 |
|------|-------------|------|
| macOS | ScreenCaptureKit（macOS 13+，TCC Screen Recording）；<13 仅 mic（cpal），system/mixed 不可用 | **已立项** → [ADR 0005](../adr/0005-macos-recording-backend.md)；#17 mic 与 #18 system E1 核心验收已完成，F-03 Partial、F-04/F-05 暂缓，#20 mixed 后续开放 |
| Linux | PulseAudio monitor source | P2 |

生产 mic implementation 已落地并完成 E1 验收；#18 已加入 ScreenCaptureKit audio-only
adapter、显式能力门禁、有界 PCM writer 和 system session lifecycle，并完成 E1 Intel macOS
核心真机验收。F-03 仍有 1.04 秒自然静音缺口，F-04/F-05、E2/E3、打包签名和恢复场景本轮
暂缓；证据由[macOS 录音验收计划](../test-plans/macos-recording-acceptance.md)管理。macOS
13+ 的可用 option 由 `RecordingCapabilities` 决定；#18 只开放 system，mixed 由 #20 负责。
空闲态已保存的不可用模式灰显后回退到 mic，用户明确点击开始后和活动会话中均不做静默降级。
Linux 仍保持 P2。

---

## 4. 总体架构

### 4.1 模块划分

```text
app/src-tauri/src/audio_capture/     ← 新增 Rust 模块
  mod.rs           — 会话状态机 RecordingSession + 命令注册
  wasapi.rs        — WASAPI 采集/loopback 封装
  coreaudio.rs     — macOS mic 采集（cpal/CoreAudio）
  screencapturekit.rs — macOS system 音频采集（ScreenCaptureKit，仅 audio output）
  wav_writer.rs    — WAV 文件写入（数据块追加 + 最终封头）
  mixer.rs         — ffmpeg 混音/归一化调用封装

app/src/features/workflow/
  RecordingCard.tsx         ← 录音卡片与录音态面板
  useRecordingController.ts ← 新增 hook（前端录音状态）

app/src/settingsClient.ts  ← 持久化 recording.audioSourceMode
app/src/i18n/             ← 新增 input.record.* 文案
```

### 4.2 数据流

```
用户点击「开始录音」
  │
  ▼
前端 RecordingCard
  │ invoke("start_recording", { mode })
  ▼
Rust audio_capture::start_recording()
  │ 创建 RecordingSession { id: UUID, mode, start_time }
  │ RecordingBackend 按平台启动 mic/system source
  │ 双路模式：cpal + WASAPI/ScreenCaptureKit 并发写入临时 WAV
  │ 录音电平事件暂属 P1，不作为 v1 IPC 契约
  ▼
前端显示计时和脉冲红点；双路真实电平数据属于 P1，不作为当前 IPC 前置条件
  │
  │ 用户点击「停止」
  ▼
invoke("stop_recording", { sessionId })
  │
  ▼
Rust audio_capture::stop_recording()
  │ 停止采集线程，flush WAV 文件
  │ 若 mode=mixed: 调用 ffmpeg amix
  │ 单路归一化: ffmpeg ar=16000 ac=1
  │ 返回 { path, displayName, durationMs, sizeBytes }
  ▼
前端 invoke("select_local_media_by_path", { path })
  │ 复用现有 LocalMediaSelectionState
  ▼
Composer 自动进入「已选文件」态 → 填标题 → 提交
  │
  ▼
Worker pipeline（下游零改动）:
  Probe → is_normalized_pcm_wav=TRUE → shutil.copy2 直拷
  → ASR → 校验 → InsightFlow → 完成
```

### 4.3 与现有系统的集成点

| 集成点 | 方式 | 改动量 |
|--------|------|--------|
| 文件选择 | 复用 `select_local_media_by_path` | 零改动 |
| Worker 音频处理 | `.wav` 已在扩展列表，直拷快路径命中 | 零改动 |
| 任务提交 | 走现有 `TaskSubmission { kind: "local_media" }` | 零改动 |
| 最近使用 | 录音完成后写入 `useRecentMedia` | 零改动 |
| 契约 | `desktop-worker-contract.json` v8 | 零改动 |
| 前端状态机 | `WorkflowState` 不新增 stage | 零改动 |
| 录音目录 | assetProtocol scope 新增 `$APPLOCALDATA/recordings/**` | 一行配置 |

---

## 5. Rust 后端详细设计

### 5.1 会话状态机

```text
 idle ──start_recording()──▶ recording ──stop_recording()──▶ finalizing
                                 │
                                 ├── cancel_recording() ──▶ idle（删除文件）
                                 │
                                 ▼
                            finalizing ──(ffmpeg ok)──▶ idle（返回 path）
                                       ──(ffmpeg err)──▶ idle（返回 error）
```

**约束**：
- 全局单会话互斥：`Mutex<Option<RecordingSession>>`，`start_recording` 时若已有活动会话返回 `RECORDING_ALREADY_ACTIVE`
- 应用退出：窗口关闭时自动调用 `stop_recording`（通过 Tauri `on_window_event` 钩子），保存录音文件防止数据丢失
- 会话超时：无（用户可以录 3 小时长课）；但定期检查磁盘剩余空间 < 500MB 时通过事件告警

### 5.2 平台采集后端

#### Windows WASAPI 采集（wasapi.rs）

使用 `windows` crate，所需 features：

```toml
windows = { version = "0.61.3", features = [
  "Win32_Media_Audio",
  "Win32_System_Com",
  "Win32_System_Com_StructuredStorage",
  "Win32_Foundation",
  "Win32_System_Threading",
] }
```

当前仓库已使用 `windows` 0.61.3 与 `windows-sys` 0.61.2；本节只记录 WASAPI 依赖边界，不再把它写成待选择方案。

**核心 API 调用链**（伪代码）：

```rust
// 1. 创建 COM 实例
let enumerator = CoCreateInstance::<MMDeviceEnumerator>()?;

// 2. 获取设备
let device = match mode {
    Mic => enumerator.GetDefaultAudioCapture(),
    System => enumerator.GetDefaultAudioRender(), // loopback
};

// 3. 激活 AudioClient
let client: IAudioClient = device.Activate()?;
let mix_format = client.GetMixFormat()?; // 设备原生格式

// 4. 初始化（loopback 需要 LOOPBACK 标志）
let flags = if mode == System { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
client.Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    flags,
    0, 0, mix_format, None
)?;

// 5. 获取 CaptureClient
let capture: IAudioCaptureClient = client.GetService()?;
let buffer_frame_count = client.GetBufferSize()?;

// 6. 事件驱动采集循环
let event = CreateEventW(None, false, false, None)?;
client.SetEventHandle(event)?;
client.Start()?;

loop {
    WaitForSingleObject(event, INFINITE);
    while let Ok(packet) = capture.GetBuffer() {
        let audio_data = &packet.buffer[..packet.frames * channels * 2];
        wav_writer.append(audio_data);
        capture.ReleaseBuffer(packet.frames);
    }
}
```

#### macOS cpal + ScreenCaptureKit

- mic 使用 cpal 的 CoreAudio host 捕获默认输入设备；实时回调只投递到有界队列，WAV 写入由
  独立线程完成，避免在音频回调中阻塞。
- system 使用 ScreenCaptureKit：查询 `SCShareableContent`，选择主显示器建立
  `SCContentFilter`，设置 `capturesAudio = true`，只接收 `SCStreamOutputType.audio`，不接收
  或保存 screen sample buffer。
- 显示器切换时优先更新现有 stream 的 content filter，必要时重建 stream；恢复窗口为 2 秒，
  窗口内的音频间隙按 sample buffer 媒体时间戳或统一 capture timebase 补静音，并发送
  `RECORDING_SYSTEM_AUDIO_RECOVERED`；不得用前端计时器或墙上时钟推算。超过窗口则返回
  `RECORDING_STREAM_ERROR` + `source: "systemAudio"`。
- mixed 只有在 cpal 与 ScreenCaptureKit 都 ready 后才开始计入会话；两路临时 WAV 保留各自
  协商出的 PCM 格式，ffmpeg finalizer 负责重采样与混音，最终产物统一为 16 kHz/单声道/16-bit。
- 有有效帧但无可感知声音属于 `SilentRecording`；完全没有有效帧才属于 `EmptyRecording`。
  mixed 一路静音但另一路有有效帧时提交结果，一路无有效帧则整体失败并清理临时文件。
- 如果无法可靠验证 `excludesCurrentProcessAudio` 生效，system/mixed 不得标记为可用。
- audio-only 按 fail-closed 处理：不得注册 screen output；如果收到视频 sample buffer，或无法
  证明视频数据没有进入 writer/Worker，system/mixed 不得可用，活动会话必须失败。
- macOS 13+ 需要 `NSScreenCaptureUsageDescription` 和用户授予的 Screen Recording 权限；
  `mic`/`mixed` 另需 `NSMicrophoneUsageDescription`。macOS 12.x 的 system/mixed 在能力探测
  中标记为不可用。
- 具体 binding、权限重启、混合失败和 Intel/Apple Silicon 验收边界以
  [ADR 0005](../adr/0005-macos-recording-backend.md) 为准。

### 5.3 WAV 文件写入（wav_writer.rs）

简单 append-only 设计：采集回调把数据块交给 writer，writer 线程追加原始字节，停止时重建 WAV 头。

思路：先写一个占位 44 字节 WAV 头，数据追加在末尾。停止时 `seek(0)` 回写正确的 `data_size`、`file_size` 字段。

采集阶段保留平台/设备原生格式（可能是 44.1/48 kHz、mono/stereo 或不同 PCM sample
format），停止时统一交给 ffmpeg finalizer 转为 16kHz、16bit、mono；最终文件才是 Worker
的 normalized PCM WAV 快路径输入。每一路临时文件都必须写入完整且可校验的 WAV header；
显示器切换恢复窗口内缺失的音频帧以静音补齐，不改变最终 WAV 的稳定格式。
任一路 writer 队列溢出都视为 `RECORDING_STREAM_ERROR`；用户停止与 source failure 竞态时，
只要错误在两路正常停止完成前已经确定，就由失败结果优先，不提交部分录音。

### 5.4 混音封装（mixer.rs）

```rust
pub fn normalize_audio(
    input_paths: &[PathBuf],
    output_path: &Path,
    ffmpeg_path: &Path,
) -> Result<Duration, MixError> {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.arg("-y");
    for path in input_paths { cmd.arg("-i").arg(path); }
    let filter = if input_paths.len() == 1 {
        "anull".to_string()
    } else {
        format!("amix=inputs={}:duration=longest:dropout_transition=0:normalize=1", input_paths.len())
    };
    cmd.arg("-filter_complex").arg(filter);
    cmd.arg("-ac").arg("1");
    cmd.arg("-ar").arg("16000");
    cmd.arg("-c:a").arg("pcm_s16le");
    cmd.arg(output_path);
    // 执行 + 检查 exit code
}
```

### 5.5 错误码

错误码保持跨平台稳定；`RECORDING_STREAM_ERROR` 可附带稳定的 `source` 字段，底层 HRESULT、
OSStatus、设备名和 ffmpeg stderr 只属于内部诊断，不进入前端 IPC 契约。

| 错误码 | 含义 | 附带信息 |
|--------|------|----------|
| `RECORDING_ALREADY_ACTIVE` | 已有录音会话，不可新建 | session_id |
| `RECORDING_MIC_INIT_FAILED` | 麦克风设备初始化失败 | HRESULT, device_name |
| `RECORDING_MIC_ACCESS_DENIED` | 麦克风权限被拒绝 | — |
| `RECORDING_SYSTEM_LOOPBACK_INIT_FAILED` | 系统音频 loopback 初始化失败 | HRESULT |
| `RECORDING_SYSTEM_AUDIO_UNAVAILABLE` | 系统音频权限、可捕获内容或 ScreenCaptureKit 能力不可用 | 内部 OSStatus/原因 |
| `RECORDING_STREAM_ERROR` | 采集流中断 | 内部原因；可附带 `source`（microphone/systemAudio） |
| `RECORDING_MIX_FAILED` | ffmpeg 混音/归一化失败 | 内部 exit_code/stderr 摘要 |
| `RECORDING_WRITE_FAILED` | 磁盘写入失败 | 内部 I/O 原因 |
| `RECORDING_DISK_SPACE_LOW` | 剩余磁盘空间不足 | 内部 free_bytes |
| `RECORDING_EMPTY` | 录音会话没有产生有效音频帧 | — |
| `RECORDING_SESSION_INVALID` | 会话 ID 无效或已过期 | session_id |

macOS 的 Screen Recording 权限拒绝、没有可捕获内容或 ScreenCaptureKit 初始化失败
复用 `RECORDING_SYSTEM_AUDIO_UNAVAILABLE` / `RECORDING_SYSTEM_LOOPBACK_INIT_FAILED`；不新增
平台专用错误码。当前公开 IPC 错误契约只返回稳定 code 和用户友好 message，底层 HRESULT、
OSStatus、设备名等诊断信息不得进入前端契约；`source` 仅作为可选的稳定解释字段。

### 5.6 Tauri 命令注册

```rust
// lib.rs 新增
mod audio_capture;

// invoke_handler 新增
audio_capture::start_recording,
audio_capture::stop_recording,
audio_capture::cancel_recording,
audio_capture::get_recording_capabilities,
audio_capture::get_recording_state,
```

**命令签名**：

| 命令 | 参数 | 返回 |
|------|------|------|
| `get_recording_capabilities` | — | `{ platform, microphone, systemAudio }` |
| `start_recording` | `{ mode: "mic"\|"system"\|"mixed" }` | `{ sessionId: string, warnings }` |
| `stop_recording` | `{ sessionId: string }` | `{ path, displayName, durationMs, sizeBytes, warnings }` |
| `cancel_recording` | `{ sessionId: string }` | `void` |
| `get_recording_state` | — | `{ sessionId, mode, elapsedMs, warnings } \| null` |

**运行时事件**（Rust → 前端）：

v1 只新增最小化的 `recording-warning`；计时仍由前端根据 `start_recording` 返回结果维护。
`recording-level`、`recording-started`、`recording-stopped` 属于后续实时电平/可观测性设计，
在实现前不得把它们当作已存在的契约。warning payload 不携带 message、OSStatus、设备名或
音频数据，用户文案由前端按 `warningCode` 本地化。事件用于即时通知；后端会话同时按
`(warningCode, source)` 聚合 warning，`get_recording_state` 和 `stop_recording` 返回
`{ warningCode, source?, count, totalGapMs }[]`，避免前端漏收事件后丢失提示。

| 事件 | payload | 频率 |
|------|---------|------|
| `recording-started` | `{ sessionId, mode }` | 后续可观测性设计 |
| `recording-level` | `{ mic: number, system: number }` | P1，约 100ms |
| `recording-warning` | `{ sessionId, warningCode, source?, count, totalGapMs }`；首个 code 为 `RECORDING_SYSTEM_AUDIO_RECOVERED` | v1，运行时恢复后按需 |
| `recording-stopped` | `{ path, durationMs }` | 后续可观测性设计 |

---

## 6. 前端设计

### 6.1 组件结构

```text
HeroUploadZone (现有)
  ├── [idle] EntryGrid：两个并排等宽入口卡片
  │     ├── UploadCard：SVG 插图 + 上传文件（整卡可点击/拖拽）
  │     └── RecordCard：SVG 插图 + 开始录音
  │           └── 音源下拉框（原生 select）+ 常规尺寸「开始录音」按钮同排（零面板层级）
  └── [recording] RecordingCard 原地切换录音态
        ├── 脉冲红点 +「录音中」+ 计时 HH:MM:SS
        ├── 双路电平条（mixed 模式两条，P1 真实数据）
        ├── 暂停/恢复（P1）
        ├── 停止
        └── 放弃（二次确认）
```

### 6.2 录音状态管理

前端 `useRecordingController` hook 独立管理录音状态，不进入 `WorkflowState`：

```typescript
type RecordingState =
  | { kind: "idle" }
  | { kind: "starting" }              // 等待 Rust 初始化
  | { kind: "recording"; sessionId: string; elapsedMs: number }
  | { kind: "stopping" }             // 等待 Rust 停止 + 混音
  | { kind: "error"; code: string; message: string };
```

### 6.3 停止后文件交接

```typescript
async function handleStop() {
  // 1. 停止录制
  const result = await invoke("stop_recording", { sessionId });
  // 2. 复用现有文件选择
  const selection = await selectLocalMediaByPath(result.path);
  // 3. 写入最近使用
  await recordRecent({ path: result.path, displayName: result.displayName, ... });
  // 4. dispatch 到 composer: setComposerSource({ kind: "local_media", selection })
  // 5. 自动滚动到标题输入框
}
```

### 6.4 权限处理

- 权限只在用户点击「开始录音」后懒请求；macOS 的 `mic`/`mixed` 触发麦克风 TCC，`system`/`mixed` 触发 Screen Recording TCC，`mixed` 固定先请求麦克风、再请求 Screen Recording
- macOS 最终 app bundle 的 `Info.plist` 必须声明 `NSMicrophoneUsageDescription` 和 `NSScreenCaptureUsageDescription`；系统设置中的“屏幕与系统音频录制”只用于取得系统音频，不保存屏幕视频
- 如果用户拒绝 → Rust 返回对应稳定错误码 → 前端在面板内展示对应权限错误消息 + 按钮「前往系统设置」；`mixed` 只获得一类权限时整体失败，不退回单路；授权后回到应用和应用重启后都重新探测，必要时提示重启应用
- 系统声音不可用时，下拉箭头中「仅系统声音」和「混合」选项灰显并附带 tooltip 说明原因
- `RECORDING_SYSTEM_AUDIO_RECOVERED` 不打断录音、不弹模态框。由于 ScreenCaptureKit 流启动时普遍
  出现可在 2 秒窗口内恢复的微小缺口，该提示几乎每次必弹且对用户不可操作，v1 产品决定不在录音面板
  或停止后展示此 warning（见 commit `784bea8` 与验收计划 §3.6 的 runbook 决定）；`recording-warning`
  事件、`get_recording_state` 与 `stop_recording` 返回的 warning 聚合数据照常保留，作为诊断与验收依据

### 6.5 i18n

新增 namespace `workflow` 下的 key：

```json
{
  "input.record.start": "开始录音",
  "input.record.source.mic": "仅麦克风",
  "input.record.source.system": "仅系统声音",
  "input.record.source.mixed": "麦克风和系统声音",
  "input.record.recording": "录音中",
  "input.record.paused": "已暂停",
  "input.record.stop": "停止录音",
  "input.record.resume": "继续录音",
  "input.record.discard": "放弃录音",
  "input.record.discard.confirm": "放弃当前录音？录音文件将被删除。",
  "input.record.error.micDenied": "麦克风权限被拒绝，请在系统设置中允许 StudyMind 使用麦克风",
  "input.record.error.systemUnavailable": "系统音频不可用，请在系统设置中允许屏幕与系统音频录制权限，并返回应用重试",
  "input.record.warning.systemRecovery": "系统音频采集已恢复，期间短暂静音",
  "input.record.error.empty": "录音未检测到有效音频，请检查设备是否正常",
  "input.record.warning.noSound": "已连续 10 分钟未检测到声音"
}
```

---

## 7. 文件与目录

### 7.1 录音文件路径

```
$APPLOCALDATA/recordings/
  recording_20260817_145230.wav         ← 最终输出文件
  .tmp/
    recording_20260817_145230/
      mic.wav                           ← 中间文件（仅 mixed 模式）
      system.wav                        ← 中间文件（仅 mixed 模式）
```

### 7.2 生命周期

- **开始录音**：创建 `.tmp/` 子目录
- **停止录音**：ffmpeg 归一化 → 输出 `recording_*.wav` → 删除 `.tmp/` 子目录
- **采集失败或放弃**：停止其他音源 → 删除完整 `.tmp/` 子目录及其中所有用户音频，不保留诊断副本
- **应用启动**：清理 `.tmp/` 中不属于活动会话的陈旧目录；v1 不恢复或提交崩溃前的部分 WAV
- **提交成功**：worker 已复制文件到 task 目录（路径由 worker 管理）；v1 保留原始 `recording_*.wav`，不自动删除，保留策略另行设计
- **放弃录音**：删除 `.tmp/` 子目录和所有中间文件
- **崩溃恢复**：下次启动时清理 `.tmp/` 下所有残留文件（不做恢复提示，v1 简化）

### 7.3 assetProtocol 配置

`tauri.conf.json` 的 `assetProtocol.scope` 需新增：

```diff
  "assetProtocol": {
    "scope": [
      "$APPLOCALDATA/outputs/**",
      "$APPLOCALDATA/cache/**",
+     "$APPLOCALDATA/recordings/**"
    ]
  }
```

### 7.4 运行时目录

在 `ensure_runtime_dirs()` 中新增 `recordings` 目录的创建。

---

## 8. 安全与隐私

| 维度 | 措施 |
|------|------|
| 数据存储 | 仅 `$APPLOCALDATA/recordings/`，不经过网络 |
| 日志安全 | 错误消息不包含文件路径、设备名（错误码内部映射，前端只展示 code + 用户友好文案） |
| DRM 保护 | Windows 音频引擎自动静音受保护内容，WASAPI loopback 不录制 |
| 麦克风授权 | 系统级权限控制；Windows/macOS 首次使用按平台触发 TCC 弹窗 |
| 系统音频授权 | macOS 使用 Screen Recording TCC；UI 明确只保存音频，不保存屏幕视频 |
| 文件清理 | v1 只清理临时录音目录；最终 WAV 保留，崩溃残留由下次启动清理 |
| 多应用 | 不与其他应用共享录音目录 |

---

## 9. 性能与资源

| 指标 | 估算 | 说明 |
|------|------|------|
| 双路 48kHz 16bit 写盘 | ~192 KB/s | 1 小时 ≈ 675 MB |
| 内存 | < 1 MB | 采集回调直接写盘，无大缓冲 |
| CPU | < 0.5% | WASAPI 事件驱动，数据直通 |
| 混音耗时 | ~2s（1 小时音频） | ffmpeg 本地处理 |
| 最大录音时长 | 无硬限制 | 磁盘 < 500MB 时事件告警 |
| 崩溃恢复 | 中间文件残留 < 700MB | 下次启动自动清理 |

---

## 10. 阶段规划

### P0 — Windows 核心闭环（v1）

| 任务 | 模块 | 估时 |
|------|------|------|
| WASAPI 采集封装（mic + loopback） | `audio_capture/wasapi.rs` | 2d |
| WAV 写入器 | `audio_capture/wav_writer.rs` | 0.5d |
| 会话状态机 + 命令注册 | `audio_capture/mod.rs` | 1d |
| ffmpeg 混音封装 | `audio_capture/mixer.rs` | 0.5d |
| 错误码体系 | 各模块 | 0.5d |
| 前端 RecordingCard + useRecordingController | app/src/features/workflow/ | 2d |
| 音源选择下拉 + HeroUploadZone 集成 | app/src/features/workflow/ | 1d |
| 权限/错误 UI | RecordingCard | 0.5d |
| i18n 文案 | app/src/i18n/ | 0.5d |
| 集成测试 | 各层 | 1d |
| **合计** | | **9.5d** |

### P1 — 增强体验

- 暂停/恢复
- 双路电平条
- 10 分钟无声音告警
- 快捷键 Ctrl+Shift+R
- 设备选择下拉
- 自动清理策略

### 已立项 — macOS 录音

macOS 录音不再列入“另案评估”。实现前后的技术边界和验收门槛以
[ADR 0005](../adr/0005-macos-recording-backend.md) 为准：

- macOS 13+：cpal/CoreAudio mic、ScreenCaptureKit system、双路 mixed；
- macOS 12.x：仅 mic，system/mixed 由能力探测置灰；
- 增加 `RecordingPlatform::Macos` 和前端 `platform: "macos"`，不新增 Worker 契约；
- 补齐 TCC purpose strings、权限重启流程、x64/arm64 真机验证和签名/公证包验证；
- 验证 ScreenCaptureKit 只输出音频、不写入屏幕数据，显示器切换可在 2 秒内按媒体时间戳补齐
  并发出 `recording-warning`，mixed 双路就绪后才计时，任一路失败时整体失败且不残留临时音频。
- v1 的 2 秒恢复窗口固定不可配置；多次成功恢复不自动终止会话，warning 聚合 `count` 与
  `totalGapMs`。

### P2 — 其他跨平台 + 压缩

- Linux 支持
- AAC 编码（边录边压缩）

---

## 11. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| WASAPI loopback 在远程桌面/无音频设备时失败 | 中 | 特定模式不可用 | 探测设备存在性，灰显不可用选项 |
| 双路时钟漂移导致混音错位 | 中 | 长录音可能出现轻微错位 | v1 不承诺 sample-accurate 或数值化漂移；以 60 分钟真机录音验证无明显错位或截断；ffmpeg amix 以最长流为准 |
| 长时间录音崩溃丢数据 | 低 | 数据丢失 | WAV 格式可恢复（追加数据即使无完整头也能解析）；定期 flush |
| 麦克风权限弹窗影响体验 | 低 | 用户困惑 | 面板内引导文案 + 前往设置按钮 |
| 混音时 ffmpeg 找不到 | 低 | 功能失败 | 捆绑在 resources/bin/，路径由 `resolve_runtime_paths` 解析 |
| Windows 更新改变 WASAPI 行为 | 极低 | 采集失败 | 错误码带回 HRESULT，便于排查 |
| macOS Screen Recording 权限文案容易让用户误以为会录屏 | 中 | 不信任/授权失败 | `NSScreenCaptureUsageDescription` 与 UI 明确“只取系统音频、不保存屏幕”；授权后重新探测或提示重启 |
| macOS 双路时钟漂移或 ScreenCaptureKit 流中断 | 中 | mixed 不同步/失败 | best-effort 起点对齐；任一路失败则 mixed 整体失败；Intel/Apple Silicon 长录音真机验证 |
| macOS 显示器切换导致 filter 或 stream 暂时失效 | 中 | 系统音频短暂中断 | 优先更新 filter、必要时重建 stream；2 秒内恢复则补静音并告警，超时才失败 |
| 无法可靠排除 StudyMind 自身音频 | 中 | 录入应用提示音，违反隐私预期 | 能力探测不得标记 system/mixed 可用，直到 `excludesCurrentProcessAudio` 经真机验证 |
| macOS 绑定、SDK 或签名不匹配 | 中 | 构建或 TCC 失败 | 锁定 Rust binding 方案，x64/arm64 分别构建并验证 ad-hoc/Developer ID 包 |

---

## 12. 与既有设计的衔接

| 文档 | 关系 |
|------|------|
| 位置研究底稿（HTML 已清理） | 其「次要按钮」层级结论被 v1.1 双卡片决策覆盖，「录音面板原地切换、复用管线」部分仍有效 |
| [01-left-sidebar-navigation.md](./01-left-sidebar-navigation.md) | 不影响抽屉导航，录音是输入层动作 |
| ADR 0001 — local-only media sources | 录音仅为本地音频，不违反本地优先原则 |
| desktop-worker-contract.json v8 | 零改动，wav 已在扩展列表 |
| 录音错误码约束 | 跨平台复用稳定错误码；底层 HRESULT/OSStatus/设备名只属于内部诊断，前端映射友好文案 |
| [ADR 0003 — recording is finalized as local media](../adr/0003-windows-recording-as-local-media.md) | 录音完成后作为 `LocalMediaSource` 进入既有 Pipeline；最终 WAV v1 保留 |
| [ADR 0004 — Windows WASAPI backend](../adr/0004-windows-wasapi-recording-backend.md) | Windows 实现基线 |
| [ADR 0005 — macOS recording backend](../adr/0005-macos-recording-backend.md) | macOS 13+ 三模式方案、权限、绑定和验收边界 |
| [macOS 录音验收计划](../test-plans/macos-recording-acceptance.md) | 实现前可行性门槛、完整验收矩阵与证据记录 |

---

## 附录 A：EV录屏 对照

| EV录屏 功能 | StudyMind 实现 | 对应章节 |
|-------------|---------------|----------|
| 仅麦克风 | F3 — WASAPI capture | §5.2 |
| 仅系统声音 | F2 — WASAPI loopback | §5.2 |
| 麦和系统声音 | F4 — 双路并发 + amix | §5.4 |
| 不录声音 | 出 scope | §1.3 |
| 主按钮 + 下拉选音源 | F1 — RecordingCard 原生 select | §2.2 §6.1 |
| 录音计时 | F7 — 前端等宽字体计时 | §6.1 |
| 暂停 | F11 — P1 | §10 |
| 录音文件保存 | 复用 selectLocalMediaByPath | §4.2 |

## 附录 B：依赖变更汇总

```diff
# app/src-tauri/Cargo.toml
+ windows = { version = "0.61.3", features = [
+   "Win32_Media_Audio",
+   "Win32_System_Com",
+   "Win32_System_Com_StructuredStorage",
+   "Win32_Foundation",
+   "Win32_System_Threading",
+ ] }

# app/src-tauri/Cargo.toml（macOS target）
+ cpal = "=0.15.3"
+ screencapturekit = { version = "8", features = ["macos_13_0"] } # Issue #18，非本提交范围

# app/src-tauri/src/lib.rs
+ mod audio_capture;
  // invoke_handler 新增 5 个命令
+ audio_capture::start_recording,
+ audio_capture::stop_recording,
+ audio_capture::cancel_recording,
+ audio_capture::get_recording_capabilities,
+ audio_capture::get_recording_state,

# app/src/features/workflow/ (现有录音 UI，macOS 仅扩展能力门控)
+ RecordingCard.tsx
+ useRecordingController.ts

# macOS bundle metadata
+ NSMicrophoneUsageDescription
+ NSScreenCaptureUsageDescription

# 无改动
  contracts/desktop-worker-contract.json
  worker/studymind_worker/ (所有文件)
  app/src/workflowState.ts
  app/src/desktopWorkerProtocol.ts
```

`cpal` 使用已实现的精确版本 `=0.15.3`：CPAL 0.17/0.18 属于 CoreAudio loopback-era
版本，当前会抬高最低 macOS 兼容要求（0.18.1 文档标明 macOS 14.2），与 Issue #17 的
macOS 12 麦克风目标冲突。ADR 0005 只确定 cpal/CoreAudio 技术方案，并未锁定依赖版本。
`screencapturekit` 仍明确属于 Issue #18，不代表已包含在本提交中。
