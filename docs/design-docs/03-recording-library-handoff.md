# 录音停止与导入解耦设计

## 目标

把「停止录音即自动导入」改成两段式：停止录音后文件落盘并进入「本机录音」列表，用户从列表里主动点击「导入」才把它交给转写流程。

这样做的收益有三点。

- 用户可以在导入前确认录音内容、时长是否正常，避免录砸了还要走一遍转写。
- 录音文件成为可管理的资产，支持回看、重复导入、后续补做删除与清理。
- 停止动作变轻，失败面缩小，自动导入这条链路上的 `RECORDING_HANDOFF_FAILED` 不再阻塞「录音成功」这件事。

## 现状的耦合点

耦合发生在前端控制器，不在 Rust 侧。

- `app/src/features/workflow/useRecordingController.ts` 第 753 行起的 `stop()`：拿到 `stopRecording` 结果后立刻调用 `completeHandoff(result)`。
- 同文件第 733 行起的 `completeHandoff()`：调用 `selectLocalMediaByPath(result.path)`，再 `recordRecent()` 与 `onLocalMediaSelected()`，把录音直接变成当前选中的媒体。
- `App.tsx` 第 190 行把 `onLocalMediaSelected` 接到 `setLocalMediaSelection`。

也就是说，Rust 侧已经把成品 WAV 落在 `recordings/` 目录，只是前端立刻消费掉了它，用户没有机会看到它。解耦所需的数据其实已经具备：`RecordingResult` 里有 `path`、`displayName`、`durationMs`、`sizeBytes`。

## 目标流程

录制 → 停止 → 落盘进 `recordings/` → 列表出现新条目并高亮 → 用户点「导入」→ 走既有的媒体选择链路 → 选中该录音 → 用户再点开始处理。

停止这一步不再有任何「交接」语义，它只负责「把文件保存下来」。

## 数据契约

### 新增 Rust 命令

建议在 `app/src-tauri/src/audio_capture/` 下新增 `recording_library.rs`，避免继续撑大 `mod.rs`。

```rust
pub(crate) struct RecordingLibraryEntry {
    pub(crate) recording_id: String,   // 文件名，稳定且唯一
    pub(crate) path: String,           // 绝对路径
    pub(crate) display_name: String,
    pub(crate) size_bytes: u64,
    pub(crate) duration_ms: u64,       // 由 WAV 头算出
    pub(crate) created_at_ms: u64,     // 由文件名时间戳解析，失败回退 mtime
    pub(crate) imported: bool,         // 暂不持久化，见下文取舍
}

pub(crate) struct RecordingLibraryView {
    pub(crate) entries: Vec<RecordingLibraryEntry>,
    pub(crate) total_bytes: u64,
}
```

两个命令。

- `list_local_recordings()`：扫描 `recordings/` 目录，跳过 `.tmp` 与所有以点开头的文件，按 `created_at_ms` 倒序返回。
- `delete_local_recording(recording_id)`：阶段二再加，见「落地顺序」。

时长不要用文件名时间戳相减，直接读 WAV 头。项目里已有 `audio_capture/wav_writer.rs` 的 `read_wave_info()`，它返回 `WaveInfo { format, data_bytes }`，套公式即可：

```
duration_ms = data_bytes / (sample_rate * block_align) * 1000
```

这样不用起 ffmpeg，也不用解析整个文件。

### 前端契约文件

新增 `app/src/recordingLibraryContract.ts`，照 `localMediaContract.ts` 的写法：导出 `RECORDING_LIBRARY_CONTRACT_VERSION = 1`、类型定义、`parseRecordingLibraryView()` 校验函数，未知字段与新版本一律降级为 `invalid`，错误码 `RECORDING_LIBRARY_INVALID`。

新增 `app/src/recordingLibraryClient.ts`，提供 `listLocalRecordings()`，错误码收敛为三种。

- `RECORDING_LIBRARY_UNAVAILABLE`：目录不可读，通常是权限或路径问题。
- `RECORDING_LIBRARY_INVALID`：IPC 返回结构不符合契约。
- `RECORDING_IMPORT_FAILED`：导入时 `selectLocalMediaByPath` 失败，可重试。

## 状态机

会话状态沿用现有的 `idle / starting / recording / stopping / error`，只是 `stopping` 之后不再有 `handoff` 分支，直接回 `idle`。

录音条目新增一套状态。

- `saved`：已落盘，未导入。这是默认态。
- `importing`：导入中，按钮进入加载态。
- `imported`：已导入过，显示文字标记，仍可再次导入。
- `importFailed`：导入失败，条目上给出「重试」。

列表整体状态：`loading`、`ready`、`empty`、`refreshing`、`error`。

## 界面结构

录音库面板放在录音卡片下方，作为一个独立区块，标题「本机录音」。它和上传区、录音卡同属输入区，不要塞进侧边栏，也不要做成弹窗，因为用户要在录制结束后立刻看到它。

单条记录的布局，从左到右依次是：

1. 主信息：创建时间（本地化格式）、时长、文件大小。
2. 副信息：状态标记，用文字而不是只用颜色，比如「未导入」「已导入」。
3. 操作区：主按钮「导入」，次要按钮「删除」（阶段二）。

条目高度控制在 64 至 72 px，一屏能看 5 到 7 条，超出滚动。

停止录音后的三个即时反馈。

- 列表顶部插入新条目，背景高亮 2 秒后淡出，动画只用 `opacity`，时长 0.2 至 0.3 秒。
- 录音卡片上出现一行轻提示「已保存到本机录音」，不弹对话框。
- 页面滚动到列表位置，但不自动导入，也不自动聚焦导入按钮（避免用户误按回车直接导入）。

空态文案要给出下一步动作，比如「还没有录音，开始录制后会保存在这里」。

## 交互取舍

关于导入是替换还是追加，保持现有语义，即替换当前选中的媒体。当已有选中媒体时，在导入按钮下方显示一行小字「将替换当前选中的 xxx」，不弹确认框，避免打断。

关于「已导入」标记的持久化，建议只放内存，不写进 `ui-preferences.json`。代价是重启应用后标记消失，收益是不用为一条辅助状态引入持久化与清理逻辑。重复导入的后果只是重新选中同一个文件，可接受。

关于来源模式（麦克风、系统声音、混音）是否显示，建议 v1 不显示。它不在文件名里，要显示得额外写一个 sidecar 元数据文件，等于给 finalize 加一个失败点。如果后续确实需要，再加 `recording_<ts>.json` 并降级显示「未记录」。

## 无障碍要点

- 列表用 `ul` / `li` 语义，条目内的时间作为可访问名称的一部分。
- 按钮的 `aria-label` 带上文件名或时间，比如「导入 9月12日 15:15 的录音」，避免屏幕阅读器只念出一串「导入」。
- 状态不能只用颜色区分，必须同时有文字。
- 导入中按钮禁用并保留焦点，失败后焦点回到「重试」。

## 落地顺序

阶段一，最小闭环。

1. Rust 新增 `list_local_recordings` 命令并在 `lib.rs` 注册。
2. 新增 `recordingLibraryContract.ts` 与 `recordingLibraryClient.ts`。
3. 新增 `useRecordingLibraryController.ts`，负责列表、刷新、导入。
4. 改 `useRecordingController.stop()`：删掉 `completeHandoff`，改为调用回调 `onRecordingSaved?.(result)`，并把 `handoff` 相关状态移交出去。
5. 新增 `RecordingLibraryPanel.tsx` 与条目组件，接进 `App.tsx`，补 i18n 文案。

阶段二，资产管理。

6. 新增 `delete_local_recording`，删除前校验路径在 `recordings/` 内、不是 `.tmp`、不是符号链接或重解析点，复用 `runtime.rs` 里已有的安全检查思路。
7. 总占用超过阈值（建议 1 GB）时，列表顶部显示提示条。
8. 删除二次确认，文案里说明「该录音若已生成任务，删除后任务将无法重新处理」。

## 风险与对策

- 录音只增不减，磁盘被占满。阶段二提供删除与占用提示，且录制时的磁盘探测已经存在，可复用。
- 用户忘记导入，录完就走。对策是停止时的轻提示与列表高亮，而不是自动导入，否则等于退回耦合。
- 用户手动删了 `recordings/` 里的文件。列表每次显示前刷新，导入时 `selectLocalMediaByPath` 会失败并给出可重试的错误，不会静默出错。
- 旧版本遗留的文件没有元数据。列表只依赖文件名与 WAV 头，历史文件同样能正确显示，无需迁移脚本。
