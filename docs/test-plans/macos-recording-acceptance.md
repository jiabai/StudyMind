# macOS 录音验收计划

> 状态：实现规格可启动；后续真机与发布验收未完成 · 决策来源：[ADR 0005](../adr/0005-macos-recording-backend.md)
>
> 当前结论：E1（Intel、macOS 15.7.7、ad-hoc CLI）已完成核心可行性验证，允许进入正式后端实现。F-03/F-04/F-05 因缺少可执行环境，明确作为实现后的补验与验收阻塞项；E2、E3、打包签名及恢复场景属于后续验收任务。

## 1. 使用规则

- 本文档是 macOS 录音实现前可行性验证和实现完成验收的证据清单。
- 每项状态只能为 `Planned`、`Pass`、`Fail` 或 `Blocked`；未经执行不得填写 `Pass`。
- `F-*` 同时覆盖实现前核心可行性与实现后验收证据。F-01、F-02、F-06、F-07 的 binding、全局
  系统音频和 audio-only 核心语义未成立时，停止实现并重开 ADR 0005，不得静默更换
  ScreenCaptureKit binding、桥接方式或产品语义。
- F-03、F-04、F-05 是依赖真实输出路由、外接显示器或中断注入的实现后补验项。由于当前没有
  相应条件而处于 `Blocked` 时，不重开 ADR，也不阻塞规格化和实现启动；它们会阻塞 macOS
  录音的验收完成与发布结论，直到取得可复核证据。
- 实现完成要求所有适用的 `F-*`、`P-*`、`C-*`、`M-*`、`D-*`、`R-*` 和 `B-*` 项为 `Pass`。
- Evidence 填写可复核材料，例如构建日志路径、测试记录、截图、WAV 探测结果或签名验证输出；
  不在本文档中保存用户录音内容。

## 2. 测试环境

| 环境 ID | macOS | 架构 | 包类型 | 硬件/显示器 | 状态 | Evidence |
|---|---|---|---|---|---|---|
| E1 | 15.7.7 | Intel x86_64 | ad-hoc CLI | 内置/单显示器 | Pass | `scripts/macos-recording-feasibility/report.html` |
| E2 | 13+ | Apple Silicon arm64 | ad-hoc | 内置/单显示器 | Planned | — |
| E3 | 13+ | Intel 或 arm64 | ad-hoc | 外接显示器 | Planned | — |
| E4 | 13+ | Intel x86_64 | Developer ID + notarized | 按发布配置 | Planned | — |
| E5 | 13+ | Apple Silicon arm64 | Developer ID + notarized | 按发布配置 | Planned | — |
| E6 | 12.x | Intel 或 arm64 | ad-hoc | 任意 | Planned | — |

记录执行时的精确系统版本、StudyMind commit、Rust toolchain、Xcode/SDK、`screencapturekit`
版本、ffmpeg/ffprobe 架构和 bundle identifier。

## 3. 实现前可行性门槛

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| F-01 | Rust binding 编译与链接 | Intel、arm64 均能构建并启动最小 audio-only stream | E1, E2 | **E1: Pass** / E2: Planned | E1: `cargo build --release` Finished in 12.92s（screencapturekit 8.0.1, macos_13_0, Rust 1.96.0, CLT SDK 15.5 / Swift 6.1.2）；`SCStream.start_capture()` 成功。见 `scripts/macos-recording-feasibility/report.html` |
| F-02 | 全局系统音频 | 同时播放两个独立应用的音频，两者均进入 audio output | E1, E2 | **E1: Pass** / E2: Planned | E1: 静音基线 rmsAvg=0.000000；afplay 播放 440Hz → 0.285581；say 语音 → 0.122613；两者同时 → 0.289172 |
| F-03 | 默认输出变化 | 录音期间切换可用的默认输出路由，系统音频语义保持成立 | E1, E2 | Blocked | **实现后补验/验收阻塞项**。需在录音中人工切换系统默认输出；当前无条件执行，探针与流程就绪 |
| F-04 | 显示器变化 | 切换主显示器、连接/拔出外接显示器；优先更新 filter，必要时重建 stream | E3 | Blocked | **实现后补验/验收阻塞项**。需 E3 外接显示器环境；当前无条件执行，不阻塞实现启动 |
| F-05 | 恢复窗口 | 单次中断不超过 2 秒时按媒体时间戳补静音并继续；超过 2 秒时失败 | E3 | Blocked | **实现后补验/验收阻塞项**。需 E3 外接显示器与 stream 中断注入；当前无条件执行，不阻塞实现启动 |
| F-06 | 排除自身音频 | `excludesCurrentProcessAudio` 经验证生效，StudyMind 自身提示音不进入 system capture | E1, E2 | **E1: Pass** / E2: Planned | E1: 同进程 cpal 播放 440Hz：不排除 rmsAvg=0.291564；`--exclude-self` → 0.000000 |
| F-07 | audio-only fail-closed | 未注册 screen output，writer/Worker 不接收视频 sample buffer | E1, E2 | **E1: Pass** / E2: Planned | E1: 仅注册 `SCStreamOutputType::Audio`；6 次运行 video_buffers 恒为 0，mic_buffers 恒为 0 |
| F-08 | TCC 基础行为 | ad-hoc 包可完成麦克风、Screen Recording 请求和授权后重探测 | E1, E2 | **E1: Pass\*** / E2: Planned | E1: 未授权时 `SCShareableContent::get()` 返回 TCC 拒绝；授权后重探测成功（displays=1 apps=28）且 stream 启动。\*CLI 形态验证；ad-hoc .app 形态（Info.plist usage description）待打包阶段复验 |

> 2026-08-20 更新：E1（Intel x86_64, macOS 15.7.7, ad-hoc CLI）可行性验证完成，F-01/F-02/F-06/F-07 通过、F-08 部分通过（授权后重探测）；F-03/F-04/F-05 因环境限制 Blocked。完整证据见 `scripts/macos-recording-feasibility/report.html` 与探针输出。工具链已升级至 CLT SDK 15.5 / Swift 6.1.2（原 Swift 5.3 / SDK 11.0 无法构建 screencapturekit 8.0.1）。

## 3.1 后续验收任务

以下任务不再作为进入规格化或启动正式实现的前置条件，但在 macOS 录音可以宣称验收完成或进入发布前必须取得证据。

| 任务 | 范围 | 完成条件 | 状态 |
|---|---|---|---|
| E2 Apple Silicon | 在 13+ Apple Silicon ad-hoc 环境重跑 F-01、F-02、F-06、F-07、F-08 | arm64 构建、全局系统音频、自身音频排除、audio-only 和 TCC 行为均有可复核证据 | Planned |
| E3 外接显示器 | 连接/拔出外接显示器并切换主显示器 | F-04 通过；显示器变化不改变“系统声音”产品语义，优先更新 filter，必要时重建 stream | Planned |
| 默认输出路由 | 在录音期间切换可用的系统默认输出设备 | F-03 通过；audio-only stream 持续捕获全局系统音频，或按恢复策略重建并恢复 | Planned |
| 恢复场景 | 注入或观察短于/超过 2 秒的 stream 中断 | F-05 通过；短中断补静音并继续，长中断按约定失败，不静默换源 | Planned |
| 打包与签名 | ad-hoc .app、Developer ID 与 notarized 包（E4/E5） | F-08、B-02、B-03、B-04 完成；权限请求、授权后重探测、重启和签名身份均可复核 | Planned |

## 4. 权限与能力探测

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| P-01 | 首次进入录音入口 | 不主动弹出 TCC 请求 | E1, E2 | Planned | — |
| P-02 | 首次启动 mic | 点击开始后请求麦克风权限 | E1, E2 | Planned | — |
| P-03 | 首次启动 system | 点击开始后请求 Screen Recording 权限，并说明只保存音频 | E1, E2 | Planned | — |
| P-04 | 首次启动 mixed | 固定先请求麦克风，再请求 Screen Recording | E1, E2 | Planned | — |
| P-05 | mixed 部分授权 | 整体失败、清理临时文件、不回退 mic | E1, E2 | Planned | — |
| P-06 | 拒绝与系统设置 | 显示来源明确的错误和设置入口；回到前台后重新探测 | E1, E2 | Planned | — |
| P-07 | 授权后重启 | 重启后能力与 TCC 状态一致 | E1, E2, E4, E5 | Planned | — |
| P-08 | 撤销权限 | option 灰显；空闲态偏好可回退，明确开始后不静默换源 | E1, E2 | Planned | — |
| P-09 | macOS 12.x | 只暴露 mic，system/mixed 不可用 | E6 | Planned | — |

## 5. 采集与产物

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| C-01 | mic start/stop/cancel | 状态机正确，成功停止产出规范 WAV，取消不留产物 | E1, E2 | Planned | — |
| C-02 | system start/stop/cancel | 捕获全局系统音频，不产生屏幕视频数据 | E1, E2 | Planned | — |
| C-03 | SilentRecording | 有有效零振幅帧时允许提交 | E1, E2 | Planned | — |
| C-04 | EmptyRecording | 没有有效音频帧时拒绝提交 | E1, E2 | Planned | — |
| C-05 | 输出格式 | 最终文件为 16 kHz、单声道、16-bit PCM WAV | E1, E2 | Planned | — |
| C-06 | 60 分钟录音 | 无明显错位、截断、写入中断或不可解释残留 | E1, E2 | Planned | — |
| C-07 | 低磁盘空间 | 低于 500 MB 时发出既有 warning，写入边界保持一致 | E1, E2 | Planned | — |

## 6. mixed 原子性与竞态

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| M-01 | 双路就绪屏障 | 两路 ready 后才定义 audio time zero，屏障前帧不进入产物 | E1, E2 | Planned | — |
| M-02 | 不同源格式 | 两路临时 WAV header 有效；ffmpeg 正确重采样并混音 | E1, E2 | Planned | — |
| M-03 | 一路静音 | 两路均有有效帧时正常提交 | E1, E2 | Planned | — |
| M-04 | 一路无帧或提前结束 | mixed 整体失败，不提交另一条路 | E1, E2 | Planned | — |
| M-05 | 初始化/运行/停止失败 | 停止另一条路，整体失败并清理 | E1, E2 | Planned | — |
| M-06 | writer 队列溢出 | 返回 `RECORDING_STREAM_ERROR` 与准确 `source` | E1, E2 | Planned | — |
| M-07 | stop/error 竞态 | 两路正常停止完成前已确定的 source failure 优先 | E1, E2 | Planned | — |

## 7. warning 连续性

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| R-01 | 单次可恢复中断 | 发出 `recording-warning` / `RECORDING_SYSTEM_AUDIO_RECOVERED`，录音不中断，缺口补静音 | E3 | Planned | — |
| R-02 | 前端漏收事件 | `get_recording_state.warnings` 可恢复累计 warning | E3 | Planned | — |
| R-03 | 停止后提示 | `stop_recording.warnings` 保留累计 warning | E3 | Planned | — |
| R-04 | 多次可恢复中断 | 按 code/source 去重，`count` 和 `totalGapMs` 正确累计 | E3 | Planned | — |
| R-05 | 单次恢复超时 | 超过 2 秒返回 `RECORDING_STREAM_ERROR` + `systemAudio` | E3 | Planned | — |

## 8. 数据与失败清理

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| D-01 | 正常停止 | finalizer 成功后删除 session 临时目录 | E1, E2 | Planned | — |
| D-02 | 失败或放弃 | 删除全部临时源 WAV，不保留诊断副本 | E1, E2 | Planned | — |
| D-03 | 崩溃后重启 | 清理不属于活动会话的陈旧 `.tmp` 目录，不恢复部分录音 | E1, E2 | Planned | — |
| D-04 | 路径 containment | 录音和清理操作均限制在 `$APPLOCALDATA/recordings/**` | E1, E2 | Planned | — |
| D-05 | 日志边界 | 日志不含音频数据、用户路径、OSStatus 细节或设备名 | E1, E2 | Planned | — |

## 9. 打包与发布

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| B-01 | ffmpeg/ffprobe 资源 | 架构匹配、可执行位正确、运行时路径可解析 | E1, E2, E4, E5 | Planned | — |
| B-02 | Info.plist | 两个 purpose string 均存在且文案说明 audio-only | E4, E5 | Planned | — |
| B-03 | Developer ID 签名 | bundle identity 稳定，签名验证通过 | E4, E5 | Planned | — |
| B-04 | 公证包 | notarization、启动、TCC、重启流程均通过 | E4, E5 | Planned | — |

## 10. 完成判定

- `Accepted` ADR 与验收结果相互独立：ADR 记录批准的技术决策，本文档记录事实验证。
- F-01、F-02、F-06、F-07 的核心语义未通过时，不进入正式后端实现；若 binding 或全局系统
  音频语义不成立，重开 ADR 0005。
- F-03、F-04、F-05 的 `Blocked` 仅表示当前环境无法补验；它们会阻塞验收完成与发布，不
  阻塞正式后端实现启动。
- 所有适用项目为 `Pass` 且 Evidence 可复核后，才能宣称 macOS 录音实现完成。
- 当前仅 E1 核心可行性验证有证据；E2、E3、打包签名、默认输出变化和恢复场景仍为后续
  验收任务。本文档不代表 macOS 后端实现已经完成。
