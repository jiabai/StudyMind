# Handoff — StudyMind macOS 麦克风 RecordingSession 实现

> 更新时间：2026-08-20（GMT+8）
> 当前状态：Issue #17 代码实现完成，允许进入 macOS 原生验证；不代表 macOS 验收或发布完成。

## 1. 交接结论

Issue #17 已在隔离分支 `codex/issue-17-macos-mic` 完成实现，并通过 Windows host 上可执行的自动化验证。最终代码审查确认可进入 macOS x64/arm64 原生编译、打包、TCC 和硬件录音验证。

本切片只实现 macOS 麦克风 `RecordingMode::Mic`：

- `RecordingPlatform::Macos` 序列化为 `"macos"`，前端按 source capability 驱动模式可用性；
- `capabilities()` 不主动请求麦克风权限；`NotDetermined` 在点击开始时懒请求；
- 使用 CPAL `=0.15.3` 的 CoreAudio 默认输入设备；
- 实时回调只做样本转换和有界 `try_send`，writer 线程独占 WAV 磁盘写入；
- 临时源 WAV 使用设备协商的采样率/声道和 PCM16，既有 finalizer 继续输出 16 kHz、单声道、16-bit PCM WAV；
- 空录音拒绝，非空静音录音允许提交；stop/cancel/失败均清理 app-local 临时工作区；
- writer 的正常退出和 panic 退出均由 `WriterJoinGuard` 关闭 sender 后 join，避免清理目录时遗留写入线程。

系统声音、mixed、ScreenCaptureKit、显示器切换恢复和 `recording-warning` 不属于 Issue #17；它们由 #18 及后续验收任务负责。主显示器不能改变“系统声音”的产品语义，相关验证必须按 ADR 0005 执行。

## 2. 实现提交链

| Commit | 内容 |
|---|---|
| `39f4d45` | Issue #17 实施计划 |
| `ec27655` | macOS 平台/能力契约与前端 capability 门控 |
| `e62cb3f` | 失败、空录音、取消路径的工作区清理和错误优先级 |
| `ffa4057` | 共享 PCM16 WAV format 构造器 |
| `7e6d83a` | CPAL/AVFoundation macOS 麦克风后端与纯逻辑测试 |
| `2e99add` | `NSMicrophoneUsageDescription` 与 x64/arm64 workflow gates |
| `de93c8e` | macOS mic 生命周期与 finalizer 参数回归测试 |
| `be3ecf6` | CPAL 版本和验收证据文档同步 |
| `e5eac17` | 启动错误映射、错误优先级、readiness handshake 修复 |
| `404b1d3` | writer panic-safe RAII 所有权修复 |

建议交接使用最终提交 `404b1d3` 作为代码基线。

## 3. 已有验证证据

Windows host 上已完成：

- 前端完整测试：75 files / 769 tests passed；
- 前端 production build passed；
- Rust 完整测试：323 passed；
- Rust `cargo check` passed；
- Task 4/修复的 macOS 纯逻辑与 `audio_capture` 定向测试：46 passed；
- `git diff --check` passed；
- plist XML 与 GitHub Actions workflow 语法检查通过；
- 最终代码审查通过，没有 ScreenCaptureKit、Worker 契约或 mixed 实现越界。

这些证据不能证明 `cfg(target_os = "macos")` 分支已编译、链接或能访问真实 CoreAudio/TCC。Windows host 不具备 Apple SDK、CoreAudio runtime 或 TCC 环境。

## 4. macOS 原生验证顺序

在 macOS x64 和 arm64 runner 上分别执行：

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo check --manifest-path app/src-tauri/Cargo.toml
npm --prefix app test
npm --prefix app run build
npm --prefix app run tauri -- build --bundles app --target <target>
```

其中 `<target>` 为 `x86_64-apple-darwin` 或 `aarch64-apple-darwin`。打包后检查：

```bash
APP_PATH="app/src-tauri/target/<target>/release/bundle/macos/StudyMind.app"
/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$APP_PATH/Contents/Info.plist"
codesign --verify --deep --strict "$APP_PATH"
```

## 5. 麦克风功能验收

在稳定 bundle identity 的 ad-hoc `.app` 上记录证据：

1. 首次进入录音入口不弹麦克风 TCC；
2. 点击 mic 开始后弹出麦克风权限；
3. 允许后录音、停止，确认 LocalMediaSource 可进入既有 Pipeline；
4. 拒绝后返回 `RECORDING_MIC_ACCESS_DENIED`，不静默换源；
5. 撤销权限、重启 app 后重新探测，能力和 UI 状态一致；
6. 无输入设备、初始化失败、运行中 stream 错误分别记录稳定错误码；
7. 空录音失败、非空静音录音成功；取消和失败后确认没有临时 WAV 残留；
8. 默认输入设备变化和外接麦克风连接/断开作为实现后补验记录。

## 6. 明确的后续验收阻塞项

以下项目不能由当前工作站完成，也不能标为 Pass：

- F-03 默认输出路由变化；
- F-04 主显示器切换、外接显示器连接/拔出；
- F-05 stream 中断恢复窗口；
- E2 Apple Silicon 环境；
- E3 外接显示器与恢复场景；
- ad-hoc `.app` 的真实 TCC、授权后重启和撤销权限流程；
- Tauri 最终 plist 合并结果与打包启动；
- Developer ID 签名、公证包和稳定 bundle identity 验收；
- 默认输出变化、媒体时间戳补静音、2 秒恢复和失败清理场景；
- 60 分钟硬件录音、设备变化和长时写入稳定性。

验收计划中 F-03/F-04/F-05 必须保持“实现后的补验/验收阻塞项”，E2、E3、打包签名及恢复场景保持后续验收任务。只有取得可复核的 macOS 证据后，才能宣称 macOS 录音实现完成或进入发布。

## 7. 相关文档

- [ADR 0005](../adr/0005-macos-recording-backend.md)
- [macOS 录音验收计划](../test-plans/macos-recording-acceptance.md)
- [实现计划](../superpowers/plans/2026-08-20-macos-microphone-recording-session.md)
- [E1 可行性报告](./studymind-macos-recording-feasibility-result.md)
