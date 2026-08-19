# Handoff — StudyMind macOS 录音可行性验证（E1 结论 + 下一步）

> 生成时间：2026-08-20 01:16 (GMT+8) · 会话焦点：macOS 录音可行性验证结论
> 本会话已完成 macOS 录音**实现前可行性验证**（F 矩阵 E1），供下一个 agent 接手实现或补验。

## 1. 结论速览（可直接采信）

在 **E1 环境（Intel x86_64, macOS 15.7.7, ad-hoc CLI, Rust 1.96.0）** 上，`docs/test-plans/macos-recording-acceptance.md` 的 F 矩阵：

| ID | 判定 | 一句话证据 |
|---|---|---|
| F-01 | **PASS** | `screencapturekit 8.0.1`（macos_13_0）构建成功 + `SCStream.start_capture()` 成功 |
| F-02 | **PASS** | 静音基线 rms 0.0000；afplay 0.2856；say 0.1226；两者同时 0.2892 |
| F-06 | **PASS** | 同进程 cpal 播 440Hz：不排除 0.2916 → `excludesCurrentProcessAudio` 0.0000 |
| F-07 | **PASS** | 仅注册 `.audio` 输出，6 次运行 video_buffers 恒 0 |
| F-08 | **PASS\*** | 未授权 TCC 拒绝 → 授权后重探测成功（\*CLI 形态；ad-hoc .app 待打包复验） |
| F-03 / F-04 / F-05 | **Blocked** | 需录音中 GUI 切输出设备 / 外接显示器（E3 环境），本机无外接显示器 |

**核心结论：ADR 0005 的绑定选型（screencapturekit crate）与全局系统音频、自身音频排除、audio-only fail-closed 语义在本机（Intel）全部成立，可以进入正式后端实现，无需重开 ADR。**

## 2. 已完成的工作（引用，勿重复）

- **验证 harness（throwaway）**：`scripts/macos-recording-feasibility/`
  - `probe-crate/` — Rust 探针（`SCShareableContent` → audio-only `SCStream`；`--exclude-self` / `--play-self-audio`(cpal 440Hz) / `--seconds N`；统计 audio/video/mic buffer 数与 RMS；**不落盘用户音频**）；含 vendor 依赖（构建 workaround，见 §4）
  - `report.html` — 完整证据报告（F 矩阵 + 环境元数据 + 偏差）
  - `run.sh` / `verify-toolchain.sh` / `README.md`
- **验收计划更新**：`docs/test-plans/macos-recording-acceptance.md`（F 矩阵状态/证据已填）
- **提交（已 push origin/master）**：
  - `2c82da9` feat(prototype): macOS recording feasibility validation (E1, Intel)
  - `b47e2da` chore: macOS compatibility patches（supervisor.rs 未用 Arc；prismaTestHarness.test.ts 盘符可选正则——v0.2.0 该测试在 macOS 会挂，务必保留此补丁）

## 3. 关键环境事实

- 工具链**已升级**：CLT SDK **15.5** / Swift **6.1.2**（原 Swift 5.3 / SDK 11.0 无法构建 screencapturekit，曾致 F-01 失败）
- **TCC 权限已授予 `scprobe-crate` 二进制**（用户已在系统设置授权屏幕录制）；Swift 备用探针 `scprobe.swift` **未授权且已弃用**（async API 未授权时挂起）
- 本执行环境的 `sandbox-exec` 硬不可用（`sandbox_apply: Operation not permitted`）

## 4. 可复用坑（构建 screencapturekit 时）

1. **SPM 沙箱**：`swift build` 默认用 sandbox-exec 编 manifest → 本环境失败。解法：vendor 三个带 swift-bridge 的 crate（screencapturekit / apple-cf / apple-metal）到 `probe-crate/vendor/`，build.rs 的 swift_args 加 `"--disable-sandbox"`，**必须紧跟 `"build"` 参数之后**（放前面会被拒为 unknown argument）；`[patch.crates-io]` 指向本地。
2. **apple-metal 0.8.8** 引用 macOS 26 SDK 成员（`MTLSamplerDescriptor.reductionMode/lodBias`），SDK 15.5 编译失败 → 删除该 `#available(macOS 26.0)` 块（探针不用 Metal）。
3. **Swift runtime rpath**：cargo 链接产物无 rpath → `install_name_tool -add_rpath /usr/lib/swift <bin>`（系统 shared cache）；cargo rebuild 会覆盖，`run.sh` 已内置该步。
4. SDK 15 的 ScreenCaptureKit Swift API：`sampleRate`/`channelCount`（非 audioSampleRate）、`SCContentFilter(display:excludingApplications:exceptingWindows:)`、async/await（completion handler 已移除）。

## 5. 待办 / 下一步

1. **（核心）实现 macOS 录音后端** —— 尚未开始（`bfef9cc` 仅文档：ADR 0005/验收计划/设计文档；代码侧 `audio_capture/` 仍只有 Windows）。按 ADR 0005 实现：
   - Cargo.toml 加 `screencapturekit`（macos_13_0）+ `cpal`（macOS target）
   - `audio_capture/macos.rs`：SCStream audio-only（`excludesCurrentProcessAudio=true`）+ cpal mic
   - `RecordingPlatform::Macos`（序列化 `"macos"`）+ `from_runtime_paths` macOS 分支 + 能力探测（macOS 13+ 判定、TCC 状态）
   - 错误码映射（`RECORDING_SYSTEM_AUDIO_UNAVAILABLE` / `RECORDING_STREAM_ERROR(source)` 等，复用现有错误码）
   - Info.plist：`NSScreenCaptureUsageDescription` + `NSMicrophoneUsageDescription`
   - `recording-warning` Tauri 事件（首个 code `RECORDING_SYSTEM_AUDIO_RECOVERED`）
2. **补验 F-03/F-04/F-05**：需外接显示器（E3）真机 + 录音中切换默认输出；F-05 需 stream 中断注入观察 2s 恢复窗口。
3. **F-08 打包形态**：ad-hoc .app / Developer ID 公证包，验证 Info.plist 文案与授权后重启。
4. 提醒：`scripts/macos-recording-feasibility/` 是 throwaway prototype；验证通过后按 prototype 流程将决策吸收进产品代码、harness 留在 throwaway 分支。

## 6. Suggested skills（下一个 agent 用 Skill 工具调用）

- `verification-before-completion` — 实现后按验收计划产出 fresh evidence 再宣称完成
- `tdd` — 后端实现建议测试先行（错误码/状态机/能力探测）
- `handoff` — 本会话即为此技能产物；实现完成后产出 return handoff 给原会话
- `prototype` — 若需继续补验 F-03/F-04/F-05 的临时验证工具
- `code-review` — 实现提交前走仓库代码审查流程

## 7. 安全备注

- 本会话曾出现 GitHub PAT（gh auth），已提醒用户轮换；**本文档不包含任何凭据**。用户账号：jiabai（GitHub）。
- 验证过程中未采集/保存任何用户音频；证据仅为 buffer/字节计数与 RMS 统计。
