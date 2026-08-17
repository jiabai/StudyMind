# StudyMind 内置录音功能设计文档

> 状态：**设计定稿 v1.4** · 日期：2026-08-17 · 经用户确认
> 对标：EV录屏 音源选择模式 · 三模式：仅系统声音 / 仅麦克风 / 两者混合
>
> **定稿范围**：UI/UX 设计（§2 需求与交互、§6 前端设计）已定稿；技术实现章节（§3–§5、§7–§11）为配套实现方案，开发时可在其基础上细化，不影响 UI 定稿决策。
>
> 变更历史：
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

**不在定稿范围**（P1/P2 开放项，后续单独确认）：暂停/恢复、麦克风设备选择、全局快捷键、双路电平条真实数据、macOS/Linux 支持、录音压缩（AAC）。

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
3. **Windows 优先**：v1 仅支持 Windows（WASAPI 原生 loopback），macOS/Linux 标为 P2
4. **隐私本地**：录音数据仅存本地 appdata 目录，不经过网络，不写入日志

### 1.3 不做什么（显式排除）

- 不录声音（EV 第四种模式）—— 出 scope，有需要时加一行 radio 即可
- 视频录制 —— 不属于本次需求
- macOS / Linux 系统声音采集 —— P2 另案
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
| F8 | 录音中视觉反馈（脉冲红点） | P0 | 沿用 record-button-placement 的 UI 面板 |
| F9 | 权限/设备错误提示 | P0 | 麦克风被拒、无系统音频设备等 |
| F10 | 10 分钟无声音告警 | P1 | 提示用户可能麦克风/扬声器静音 |
| F11 | 暂停 / 恢复 | P1 | 停止采集线程，恢复时重新打开设备 |
| F12 | 双路电平条 | P1 | 100ms 间隔 RMS 电平，前端可视化 |
| F13 | 录制中音量过低告警 | P1 | 连续 30s 低于阈值提示 |
| F14 | 快捷键（Ctrl+Shift+R） | P1 | 全局唤起录音 |
| F15 | 麦克风设备选择 | P1 | 默认设备，下拉切换 |
| F16 | macOS / Linux 支持 | P2 | 另案评估 |

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
- 系统音频不可用时（如远程桌面），「仅系统声音」「麦克风和系统声音」两个 option 置灰禁用，当前选中值自动回退为仅麦克风
- 窗口最小宽度 720px 时两卡片并排无压力；≤700px 预览环境降级为上下堆叠

---

## 3. 平台可行性分析（核心技术决策）

### 3.1 方案对比

| 方案 | 麦克风 | 系统声音 | 实时电平 | 依赖 | 结论 |
|------|--------|----------|----------|------|------|
| Web MediaRecorder (getUserMedia) | ✅ | ❌ WebView2 不暴露 loopback | ✅ | 无 | 排除 |
| ffmpeg dshow 采集 | ✅ | ❌ 需虚拟声卡驱动 | ❌ | 捆绑 ffmpeg | 备选 |
| **Rust WASAPI（windows crate）** | ✅ | ✅ 原生 loopback | ✅ | windows crate（编译时） | **采用** |

### 3.2 技术原理

#### Windows WASAPI Loopback（系统声音）

Windows 10 1803+ 原生支持。通过 `IAudioClient::Initialize` 时传入 `AUDCLNT_STREAMFLAGS_LOOPBACK` 标志，以默认输出设备（扬声器）的 mix format 采集系统播放的所有音频。不需要安装任何虚拟声卡驱动。

**与 EV录屏 一致**：EV 在 Windows 上就是 WASAPI loopback。DRM 保护内容会被 Windows 音频引擎静音，不会录制到。

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
| macOS | 需虚拟声卡（BlackHole）或 ScreenCaptureKit（macOS 12.3+） | P2 |
| Linux | PulseAudio monitor source | P2 |

v1 在非 Windows 平台上隐藏「仅系统声音」和「混合」选项，仅显示麦克风模式。

---

## 4. 总体架构

### 4.1 模块划分

```text
app/src-tauri/src/audio_capture/     ← 新增 Rust 模块
  mod.rs           — 会话状态机 RecordingSession + 命令注册
  wasapi.rs        — WASAPI 采集/loopback 封装
  wav_writer.rs    — WAV 文件写入（数据块追加 + 最终封头）
  mixer.rs         — ffmpeg 混音/归一化调用封装

app/src/features/workflow/
  RecordPanel.tsx           ← 新增组件（录音面板）
  useRecordingController.ts ← 新增 hook（前端录音状态）

app/src/uiPreferences.ts  ← 扩展 recording.audioSourceMode
app/src/i18n/             ← 新增 input.record.* 文案
```

### 4.2 数据流

```
用户点击「开始录音」
  │
  ▼
前端 RecordPanel
  │ invoke("start_recording", { mode, micDevice? })
  ▼
Rust audio_capture::start_recording()
  │ 创建 RecordingSession { id: UUID, mode, start_time }
  │ 双路 WASAPI 线程启动
  │ 线程回调：数据块 → wav_writer.append()
  │ 每 100ms: emit("recording-level", { mic, system })
  │ emit("recording-started", { sessionId })
  ▼
前端显示计时、电平、脉冲红点
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

### 5.2 WASAPI 采集（wasapi.rs）

使用 `windows` crate，所需 features：

```toml
windows = { version = "0.58", features = [
  "Win32_Media_Audio",
  "Win32_System_Com",
  "Win32_System_Com_StructuredStorage",
  "Win32_Foundation",
  "Win32_System_Threading",
] }
```

当前 `windows-sys` 0.61.2 也可用，但需要额外声明 COM 相关的 unsafe 绑定；`windows` crate 的 COM 封装更安全。建议换用 `windows` crate 或扩展 `windows-sys` features。

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

### 5.3 WAV 文件写入（wav_writer.rs）

简单 append-only 设计：采集回调直接追加原始字节，停止时重建 WAV 头。

思路：先写一个占位 44 字节 WAV 头，数据追加在末尾。停止时 `seek(0)` 回写正确的 `data_size`、`file_size` 字段。

输出格式：48kHz 16bit mono（设备 mix format 可能是 stereo，需按需降混？—— 简化：用设备 mix format，归一化步骤统一处理格式转换）。

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
        format!("amix=inputs={}:duration=longest", input_paths.len())
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

遵循 MEMORY.md 偏好：错误码带出底层原因。

| 错误码 | 含义 | 附带信息 |
|--------|------|----------|
| `RECORDING_ALREADY_ACTIVE` | 已有录音会话，不可新建 | session_id |
| `RECORDING_MIC_INIT_FAILED` | 麦克风设备初始化失败 | HRESULT, device_name |
| `RECORDING_MIC_ACCESS_DENIED` | 麦克风权限被拒绝 | — |
| `RECORDING_SYSTEM_LOOPBACK_INIT_FAILED` | 系统音频 loopback 初始化失败 | HRESULT |
| `RECORDING_SYSTEM_AUDIO_UNAVAILABLE` | 无默认输出设备（如远程桌面） | — |
| `RECORDING_STREAM_ERROR` | 采集流中断 | HRESULT, source (mic/system) |
| `RECORDING_MIX_FAILED` | ffmpeg 混音/归一化失败 | exit_code, stderr_summary |
| `RECORDING_WRITE_FAILED` | 磁盘写入失败 | std::io::Error |
| `RECORDING_DISK_SPACE_LOW` | 剩余磁盘空间不足 | free_bytes |
| `RECORDING_EMPTY` | 录音文件无有效数据（0字节） | — |
| `RECORDING_SESSION_INVALID` | 会话 ID 无效或已过期 | session_id |

### 5.6 Tauri 命令注册

```rust
// lib.rs 新增
mod audio_capture;

// invoke_handler 新增
audio_capture::start_recording,
audio_capture::stop_recording,
audio_capture::cancel_recording,
audio_capture::list_audio_input_devices,
audio_capture::get_recording_state,
```

**命令签名**：

| 命令 | 参数 | 返回 |
|------|------|------|
| `start_recording` | `{ mode: "mic"\|"system"\|"mixed", micDeviceId?: string }` | `{ sessionId: string }` |
| `stop_recording` | `{ sessionId: string }` | `{ path, displayName, durationMs, sizeBytes }` |
| `cancel_recording` | `{ sessionId: string }` | `void` |
| `list_audio_input_devices` | — | `{ id, name, isDefault }[]` |
| `get_recording_state` | — | `{ sessionId, mode, elapsedMs } \| null` |

**事件**（Rust → 前端）：

| 事件 | payload | 频率 |
|------|---------|------|
| `recording-started` | `{ sessionId, mode }` | 一次 |
| `recording-level` | `{ mic: number, system: number }` | ~100ms |
| `recording-warning` | `{ code, message }` | 按需 |
| `recording-stopped` | `{ path, durationMs }` | 一次 |

---

## 6. 前端设计

### 6.1 组件结构

```text
HeroUploadZone (现有)
  ├── [idle] EntryGrid：两个并排等宽入口卡片
  │     ├── UploadCard：SVG 插图 + 上传文件（整卡可点击/拖拽）
  │     └── RecordCard：SVG 插图 + 开始录音
  │           └── 音源下拉框（原生 select）+ 常规尺寸「开始录音」按钮同排（零面板层级）
  └── [recording] RecordPanel 原地替换
        ├── 脉冲红点 +「录音中」+ 计时 HH:MM:SS
        ├── 双路电平条（mixed 模式两条）
        ├── 暂停/恢复
        ├── 停止
        └── 放弃（二次确认）
```

### 6.2 录音状态管理

前端 `useRecordingController` hook 独立管理录音状态，不进入 `WorkflowState`：

```typescript
type RecordingState =
  | { kind: "idle" }
  | { kind: "selecting_source" }      // 下拉展开中
  | { kind: "starting" }              // 等待 Rust 初始化
  | { kind: "recording"; sessionId: string; elapsedMs: number }
  | { kind: "paused"; sessionId: string; elapsedMs: number }
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

- 首次调用 `start_recording` 时，Windows 会弹出麦克风隐私授权框（桌面应用首次使用麦克风触发）
- 如果用户拒绝 → Rust 返回 `RECORDING_MIC_ACCESS_DENIED` → 前端在面板内展示错误消息 + 按钮「前往系统设置」
- 系统声音不可用时，下拉箭头中「仅系统声音」和「混合」选项灰显并附带 tooltip 说明原因

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
  "input.record.error.systemUnavailable": "未检测到系统音频输出设备",
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
- **提交成功**：worker 已复制文件到 task 目录（路径由 worker 管理），原始 `recording_*.wav` 可删除
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
| 麦克风授权 | 系统级权限控制，首次触发 Windows 隐私弹窗 |
| 文件清理 | 提交成功后删除原始录音；崩溃残留由下次启动清理 |
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
| 前端 RecordPanel + useRecordingController | app/src/features/workflow/ | 2d |
| 音源选择下拉 + HeroUploadZone 集成 | app/src/features/workflow/ | 1d |
| 权限/错误 UI | RecordPanel | 0.5d |
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

### P2 — 跨平台 + 压缩

- macOS 支持（BlackHole / ScreenCaptureKit）
- Linux 支持
- AAC 编码（边录边压缩）

---

## 11. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| WASAPI loopback 在远程桌面/无音频设备时失败 | 中 | 特定模式不可用 | 探测设备存在性，灰显不可用选项 |
| 双路时钟漂移导致混音错位 | 低 | 音画不同步 | 两路同一设备主时钟，漂移 < 10ms/hr；ffmpeg amix 以最长流为准 |
| 长时间录音崩溃丢数据 | 低 | 数据丢失 | WAV 格式可恢复（追加数据即使无完整头也能解析）；定期 flush |
| 麦克风权限弹窗影响体验 | 低 | 用户困惑 | 面板内引导文案 + 前往设置按钮 |
| 混音时 ffmpeg 找不到 | 低 | 功能失败 | 捆绑在 resources/bin/，路径由 `resolve_runtime_paths` 解析 |
| Windows 更新改变 WASAPI 行为 | 极低 | 采集失败 | 错误码带回 HRESULT，便于排查 |

---

## 12. 与既有设计的衔接

| 文档 | 关系 |
|------|------|
| 位置研究底稿（HTML 已清理） | 其「次要按钮」层级结论被 v1.1 双卡片决策覆盖，「录音面板原地切换、复用管线」部分仍有效 |
| [01-left-sidebar-navigation.md](./01-left-sidebar-navigation.md) | 不影响抽屉导航，录音是输入层动作 |
| ADR 0001 — local-only media sources | 录音仅为本地音频，不违反本地优先原则 |
| desktop-worker-contract.json v8 | 零改动，wav 已在扩展列表 |
| MEMORY.md — 错误码偏好 | 所有错误码带底层上下文（HRESULT、设备名），前端映射友好文案 |

---

## 附录 A：EV录屏 对照

| EV录屏 功能 | StudyMind 实现 | 对应章节 |
|-------------|---------------|----------|
| 仅麦克风 | F3 — WASAPI capture | §5.2 |
| 仅系统声音 | F2 — WASAPI loopback | §5.2 |
| 麦和系统声音 | F4 — 双路并发 + amix | §5.4 |
| 不录声音 | 出 scope | §1.3 |
| 主按钮 + 下拉选音源 | F1 — RecordButton 下拉箭头 | §2.2 §6.1 |
| 录音计时 | F7 — 前端等宽字体计时 | §6.1 |
| 暂停 | F11 — P1 | §10 |
| 录音文件保存 | 复用 selectLocalMediaByPath | §4.2 |

## 附录 B：依赖变更汇总

```diff
# app/src-tauri/Cargo.toml
+ windows = { version = "0.58", features = [
+   "Win32_Media_Audio",
+   "Win32_System_Com",
+   "Win32_System_Com_StructuredStorage",
+   "Win32_Foundation",
+   "Win32_System_Threading",
+ ] }

# app/src-tauri/src/lib.rs
+ mod audio_capture;
  // invoke_handler 新增 5 个命令
+ audio_capture::start_recording,
+ audio_capture::stop_recording,
+ audio_capture::cancel_recording,
+ audio_capture::list_audio_input_devices,
+ audio_capture::get_recording_state,

# app/src/features/workflow/ (新增)
+ RecordPanel.tsx
+ useRecordingController.ts
+ RecordButton.tsx

# 无改动
  contracts/desktop-worker-contract.json
  worker/studymind_worker/ (所有文件)
  app/src/workflowState.ts
  app/src/desktopWorkerProtocol.ts
```