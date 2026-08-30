# Handoff — StudyMind macOS 系统声音 RecordingSession 实现

> 更新时间：2026-08-23（GMT+8）
> 当前状态：Issue #18 system audio 已在 E1 Intel macOS 完成产品代码 native 编译和当前范围内的真机验收；Issue #21 的 native stream supervisor、recovery/warning/frontend 契约均已实现。F-03 为 Partial，F-04/F-05 的恢复场景真机运行时证据仍待补齐；C-06 已按用户确认回填 Pass。Issue #20 mixed 的共享 coordinator、Windows/macOS adapter、accepted-session failure supervisor 与前端 hydration 已完成 host-side implementation evidence；E1 mixed runtime、E2/E3、Developer ID/公证和剩余恢复场景仍待后续真机验收。

## 1. 交接结论

Issue #18 已在分支 `codex/issue-18-macos-system-audio` 完成实现切片，并接入既有
`RecordingSession`。E1 真机已验证 ScreenCaptureKit audio-only stream、TCC、全局系统音频、
audio-only fail-closed、start/stop/cancel 和 ad-hoc bundle 基础内容；剩余验证按验收计划暂缓。

本切片只开放 macOS `RecordingMode::System`；`RecordingMode::Mixed` 继续由 #20 负责：

- `SCContentFilter` 只使用当前 shareable display 作为 ScreenCaptureKit 技术入口；显示器不
  暴露为用户可见的录音 source，产品语义仍是“系统声音”；
- `SCStreamConfiguration` 只开启 `capturesAudio`，排除当前进程音频，且只注册 Audio output；
  video 或 unexpected output 走 fail-closed；
- 采集 callback 只做样本格式转换和有界 `try_send`，writer 线程独占临时 WAV 写入；
- stop/cancel/失败均执行 stream stop、writer join、临时目录清理；空录音拒绝，合法静音帧允许提交；
- 前端按显式 `systemAudio` capability 门控；system 启动不进入 microphone permission path；
- 主显示器变化、默认输出变化、短中断恢复由 native supervisor 处理；当前仍不能把尚未取得
  真机运行时证据的 F-03/F-04/F-05 宣称为最终验收通过。

主显示器不能改变“系统声音”的产品语义。默认输出/显示器变化优先更新 filter 或重建
audio-only stream；只有音频流确实无法恢复时才判定 source failure。这部分按 ADR 0005 和
验收计划中的 F-03/F-04/F-05 作为实现后补验与验收阻塞项。

Issue #20 已采用平台无关双源 ready gate，并在 2026-08-22 设计 grilling 后增加通用
accepted-session 失败 supervisor：`start_recording` 成功返回后的 runtime failure 必须通过
`recording-failed` event 立即结束前端会话，同时以 failed state 支持 hydration；native cleanup
在后台进行并以 `cleanupPending` 阻止过早重试。该契约适用于所有平台和录音模式，不改变
ScreenCaptureKit audio-only、系统声音范围或后续 E2/E3 真机验收边界。

Issue #20 当前实现只宣称 host-side completion，不宣称 macOS native runtime completion：Windows
host 未编译 `target_os = "macos"` 分支；Intel E1 的 mixed、Apple Silicon E2、外接显示器 E3、
默认输出/中断恢复、签名和公证仍需要真实 macOS/Xcode 环境按验收计划回填。

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
| `c1bdc58` | portable system-audio recovery state machine（host-side） |
| `7624ee1` | warning 聚合、reporter 与 state/result contract |
| `a7f2f79` | `recording-warning` Tauri event sink 与 setup injection |
| `1d54944` | frontend warning parser、event filtering 与 state hydration |
| `414650d` | native stream supervisor、filter 更新优先、audio-only stream 重建与 recovery 接入 |
| `72dde23` / `03ac789` / `40a4999` / `1b14124` | worker recovery 测试、显示器 anchor 测试、SCK timestamp jitter 与 warning hardening |
| `7c88660` | Issue #20 mixed coordinator、accepted-session failure supervisor、Windows/macOS adapter 与前端 failure hydration/dedup |

代码基线为当前 `master` HEAD `434402e`；Task 3 native supervisor 已合入，当前 handoff 只保留尚未完成的真机补验和发布验收事项。

## 3. 已有验证证据

Windows host 上已完成：

- `cargo test ... audio_capture -- --test-threads=1`：111 passed；
- `cargo check --manifest-path app/src-tauri/Cargo.toml`：passed；
- frontend targeted tests（recording client/controller/card）：133 passed；
- recovery state machine standalone tests：6 passed；`1d54944` 时 frontend full suite 为 778 passed，
  当前工作树复跑为 75 个 test files / 791 passed；
- TypeScript/Vite production build：passed；warning payload parser/event filtering/hydration 已有
  host-side coverage；
- frontend production build：passed；
- `git diff --check`、`Info.plist` XML 和 Screen Recording purpose string 检查：passed；
- x64/arm64 GitHub Actions bundle smoke gate 已同步，但未在 Windows host 执行 macOS native job。

当前实现提交为 `7c88660`。`cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check`
仍报告仓库既有的全量 Rust 格式漂移，本轮未做全仓格式化。

E1 Intel macOS 已补充本次产品实现的 native compile/runtime 证据，详见验收计划 §3.3：
F-01/F-02/F-07、P-03、C-02 和 ad-hoc bundle 的基础检查已回填；F-06 的 runtime 排除仍由
同一 API 的 feasibility 证据与产品配置单测共同支撑。Issue #21 的 E1 沙箱回归为 83/83，
含 6 个端到端 worker recovery 测试。F-03 仍记录 1.04 秒自然静音缺口，F-04/F-05 的
恢复场景运行时证据尚未取得；C-06 已于 2026-08-22 按用户确认回填 Pass。Windows host
上的 Cargo focused test 仍可能受工作树缺少 `resources/python/**/*` 阻塞在 Tauri build script；
没有修改生产资源配置。

## 4. 后续 macOS 原生与发布验证顺序

本轮代码实现与 E1 核心真机验收已完成。恢复验收时先复跑/补齐 F-03 默认输出变化、F-04
filter/stream 恢复与 F-05 短长中断恢复；随后在 E2 Apple Silicon、E3 外接显示器和发布环境继续执行：

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

## 4.1 macOS 开发执行清单

下一阶段应在 macOS + Xcode 环境继续。Intel Mac 可以承担 Task 3 的编码、编译和功能调试；
但 E2 明确要求 Apple Silicon，不能用 Intel 结果替代。开始前记录：

```bash
sw_vers
uname -m
xcodebuild -version
rustc -Vv
cargo -V
```

确认 macOS 至少为 13.0（本项目 system-audio 的当前基线；ScreenCaptureKit 整体从 12.3
引入）、Screen Recording 权限可用，并在独立终端准备两个会发声的应用、
内置/外接输出设备和可连接/拔出的外接显示器。当前分支只实现 `RecordingMode::System`，
不要在本任务中扩大到 #20 的 `Mixed`。

### Task 3：native stream supervisor（已实现；待恢复场景补验）

以下行为已落地并有 host/E1 证据；后续只需在具备对应硬件、TCC 和中断注入条件的环境补齐运行时验收：

1. 将当前无 delegate 的 `SCStream` 创建路径接入 `SCStreamDelegate`，处理
   `did_stop_with_error`，并把 stream 生命周期、输出 handler 和 writer join 收拢到 supervisor。
2. 保持 `SCContentFilter` 的产品语义边界：主显示器只是 ScreenCaptureKit 的技术入口，不能
   作为用户可见的录音 source，也不能因为显示器变化静默切换到麦克风或其他来源。
3. 监听或重新探测显示器/输出环境变化。优先对现有 stream 调用
   `update_content_filter`；更新失败、stream 被停止或 audio-only stream 无法继续时，才用
   当前 filter 重建 stream，并重新挂接 Audio output。只有音频流确实无法恢复才报告
   `systemAudio` source failure。
4. 从 `CMSampleBuffer` 读取 presentation timestamp 和 duration，接入已有
   `SystemAudioRecovery`：单次缺口不超过 2 秒时按媒体时间戳补零帧、继续录音并发送
   `RECORDING_SYSTEM_AUDIO_RECOVERED` warning；超过 2 秒或恢复失败时返回稳定的 stream error。
5. 覆盖 stop/cancel/error/rebuild 竞态：停止 supervisor、停止 stream、关闭 writer、join
   worker，并保证正常/失败/取消都不残留临时 WAV。验证 audio-only stream 不产生视频数据。

### macOS 上必须回填的验证顺序

| 顺序 | 环境/场景 | 必须回填 |
|---|---|---|
| 1 | Intel E1 | Task 3 native 编译；两个应用同时发声；audio-only；start/stop/cancel；默认输出切换；warning 与 WAV 时间轴 |
| 2 | Apple Silicon E2 | 重跑 F-01、F-02、F-06、F-07、F-08；记录 arm64 构建与运行证据 |
| 3 | 外接显示器 E3 | 连接/拔出显示器、切换主显示器；确认“系统声音”语义不变；优先 filter 更新、必要时 stream 重建 |
| 4 | 恢复场景 | 分别验证小于 2 秒中断补静音并继续，以及超过 2 秒中断失败；确认 R-01～R-05 |
| 5 | 发布验收 | 真实 `.app` 的 TCC、重启/撤销权限、60 分钟录音、Developer ID 签名与公证 |

每次回填至少记录 macOS 版本、架构、Xcode/SDK、提交 SHA、命令输出、场景时间线、WAV 的
`ffprobe` 结果、warning 的 `count/totalGapMs`，以及 `codesign`/公证结果。没有这些证据时，
不得把 F-03/F-04/F-05、E2/E3 或发布项改为 `Pass`。

## 5. 系统声音功能验收范围

以下是已回填或仍需在 macOS native 环境继续回填的范围；本轮剩余项目暂缓：

- 首次进入录音入口不主动请求 Screen Recording；点击 system 开始时按系统权限流程处理；
- 同时播放两个独立应用的音频，两者均进入 system audio output；
- StudyMind 自身播放不进入 system capture；不注册 screen/microphone output；
- 允许后完成 system start/stop/cancel，空录音失败，合法静音录音成功，临时 WAV 无残留；
- 最终产物经过既有 finalizer 产出 16 kHz、单声道、16-bit PCM WAV；
- 显示器和默认输出变化不改变“系统声音”产品语义；只有音频流确实无法恢复才报告
  `RECORDING_STREAM_ERROR`/system source failure。

以下仍不计入最终验收 Pass，待暂缓解除后在真实 macOS `.app`、E2/E3 或后续验收环境中补验：

- 撤销 Screen Recording 权限、重启 app 后重新探测，能力和 UI 状态一致；
- 初始化失败、运行中 stream 错误分别返回稳定错误码；
- 确认 system `LocalMediaSource` 可进入既有 Pipeline；
- 默认输出变化、显示器变化、短中断恢复与超时失败。

## 6. 明确的后续验收阻塞项

以下项目尚未完成，不能标为 Pass；本轮先暂缓：

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
