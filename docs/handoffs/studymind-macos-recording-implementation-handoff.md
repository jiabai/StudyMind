# Handoff — StudyMind macOS 系统声音 RecordingSession 实现

> 更新时间：2026-08-20（GMT+8）
> 当前状态：Issue #18 系统声音实现已落地到 ScreenCaptureKit audio-only adapter、bounded writer 和 RecordingSession lifecycle；Windows host 证据已完成，但本次产品实现尚未在 macOS native 环境重编译/运行。#17 麦克风 E1 已完成；mixed、E2/E3、打包签名与恢复验收未完成。

## 1. 交接结论

Issue #18 已在隔离分支 `codex/issue-18-macos-system-audio` 完成实现切片，并接入既有
`RecordingSession`。实现包含 ScreenCaptureKit audio-only stream、显式 system capability
gate、当前进程音频排除、PCM16 conversion、有界 writer queue、启动握手、停止/取消/失败
清理和稳定错误映射。Windows host 自动化证据已通过；macOS native compile、TCC、全局系统
音频和真实 `.app` 仍待重验。

本切片只开放 macOS `RecordingMode::System`；`RecordingMode::Mixed` 继续由 #20 负责：

- `SCContentFilter` 只使用当前 shareable display 作为 ScreenCaptureKit 技术入口；显示器不
  暴露为用户可见的录音 source，产品语义仍是“系统声音”；
- `SCStreamConfiguration` 只开启 `capturesAudio`，排除当前进程音频，且只注册 Audio output；
  video 或 unexpected output 走 fail-closed；
- 采集 callback 只做样本格式转换和有界 `try_send`，writer 线程独占临时 WAV 写入；
- stop/cancel/失败均执行 stream stop、writer join、临时目录清理；空录音拒绝，合法静音帧允许提交；
- 前端按显式 `systemAudio` capability 门控；system 启动不进入 microphone permission path；
- 主显示器变化、默认输出变化、短中断恢复尚未实现，不能由当前切片宣称已支持。

主显示器不能改变“系统声音”的产品语义。默认输出/显示器变化优先更新 filter 或重建
audio-only stream；只有音频流确实无法恢复时才判定 source failure。这部分按 ADR 0005 和
验收计划中的 F-03/F-04/F-05 作为实现后补验与验收阻塞项。

## 2. 实现提交链

| Commit | 内容 |
|---|---|
| `7c04d4d` | 显式 `mixed` capability gate，保持 #18 macOS mixed 不开放 |
| `38196c3` | 锁定 ScreenCaptureKit 8.0.1 与 macOS 13 audio API compile probe |
| `efabddb` | system capability/TCC seam 与稳定错误码映射 |
| `a7c4535` | audio-only stream 配置、视频 fail-closed 和 PCM16 边界 |
| `53ccf4e` | system worker、bounded queue、WAV lifecycle |
| `bcd97a6` | 接入 `RecordingSession` 与前端 system capability 门控 |
| `5db14b2` | `NSScreenCaptureUsageDescription` 与 x64/arm64 bundle smoke gates |

代码基线为 `5db14b2`；文档收口提交将在本交接更新后补充。

## 3. 已有验证证据

Windows host 上已完成：

- `cargo test ... audio_capture -- --test-threads=1`：62 passed；
- `cargo check --manifest-path app/src-tauri/Cargo.toml`：passed；
- frontend targeted tests（recording client/controller/card）：133 passed；
- frontend production build：passed；
- `git diff --check`、`Info.plist` XML 和 Screen Recording purpose string 检查：passed；
- x64/arm64 GitHub Actions bundle smoke gate 已同步，但未在 Windows host 执行 macOS native job。

E1 Intel macOS 的历史 feasibility probe 已证明 ScreenCaptureKit 8.0.1 的 audio-only
选择、全局音频、自身音频排除和 Audio-only fail-closed 方向可行；该证据保存在
`docs/handoffs/studymind-macos-recording-feasibility-result.md` 与验收计划 §3。它不是
`codex/issue-18-macos-system-audio` 产品实现的 native compile/runtime 证据，因此必须
对本次产品 bundle 重新执行 F-01/F-02/F-06/F-07/F-08。

## 4. 后续 macOS 原生与发布验证顺序

先在 E1 Intel macOS 对本次 #18 产品实现重跑 system runtime，再在 E2 Apple Silicon、E3
外接显示器和发布环境继续执行：

```bash
cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1
cargo check --manifest-path app/src-tauri/Cargo.toml
npm --prefix app test
npm --prefix app run build
npm --prefix app run tauri -- build --bundles app --target <target>
```

其中 `<target>` 为 `x86_64-apple-darwin` 或 `aarch64-apple-darwin`。除已有 mic 场景外，
system runtime 必须重跑 TCC、双应用全局音频、self-audio exclusion、audio-only output、
start/stop/cancel、空录音和 ffprobe；打包后检查：

```bash
APP_PATH="app/src-tauri/target/<target>/release/bundle/macos/StudyMind.app"
/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :NSScreenCaptureUsageDescription' "$APP_PATH/Contents/Info.plist"
codesign --verify --deep --strict "$APP_PATH"
```

## 5. 系统声音功能验收范围

以下是 #18 实现后必须在 macOS native 环境回填的范围：

- 首次进入录音入口不主动请求 Screen Recording；点击 system 开始时按系统权限流程处理；
- 同时播放两个独立应用的音频，两者均进入 system audio output；
- StudyMind 自身播放不进入 system capture；不注册 screen/microphone output；
- 允许后完成 system start/stop/cancel，空录音失败，合法静音录音成功，临时 WAV 无残留；
- 最终产物经过既有 finalizer 产出 16 kHz、单声道、16-bit PCM WAV；
- 显示器和默认输出变化不改变“系统声音”产品语义；只有音频流确实无法恢复才报告
  `RECORDING_STREAM_ERROR`/system source failure。

以下不计入当前 Windows host 的 Pass，需在真实 macOS `.app`、E1/E2/E3 或后续验收环境中补验：

- 撤销 Screen Recording 权限、重启 app 后重新探测，能力和 UI 状态一致；
- 初始化失败、运行中 stream 错误分别返回稳定错误码；
- 确认 system `LocalMediaSource` 可进入既有 Pipeline；
- 默认输出变化、显示器变化、短中断恢复与超时失败。

## 6. 明确的后续验收阻塞项

以下项目尚未完成，不能标为 Pass：

- F-03 默认输出路由变化：实现后补验/验收阻塞项；
- F-04 主显示器切换、外接显示器连接/拔出：实现后补验/验收阻塞项；
- F-05 stream 中断恢复窗口：实现后补验/验收阻塞项；
- E2 Apple Silicon；
- E3 外接显示器与恢复场景；
- ad-hoc `.app` 的真实 TCC、授权后重启和撤销权限流程；
- Tauri 最终 plist 合并结果与打包启动；
- Developer ID 签名、公证包和稳定 bundle identity 验收；
- 默认输出变化、媒体时间戳补静音、2 秒恢复和失败清理场景；
- 60 分钟 system 录音、设备变化和长时写入稳定性。

验收计划中 F-03/F-04/F-05 必须保持“实现后的补验/验收阻塞项”，E2、E3、打包签名及恢复场景保持后续验收任务。只有取得可复核的 macOS 证据后，才能宣称 macOS 录音实现完成或进入发布。

## 7. 相关文档

- [ADR 0005](../adr/0005-macos-recording-backend.md)
- [macOS 录音验收计划](../test-plans/macos-recording-acceptance.md)
- [#18 实现计划](../superpowers/plans/2026-08-20-macos-system-audio-recording.md)
- [E1 可行性报告](./studymind-macos-recording-feasibility-result.md)
