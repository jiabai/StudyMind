# macOS 录音验收计划

> 状态：Issue #17 麦克风与 #18 system audio 的 E1 真机验收完成；剩余验证已暂缓，待后续具备对应硬件、凭据或恢复实现后继续 · 决策来源：[ADR 0005](../adr/0005-macos-recording-backend.md)
>
> 当前结论：Issue #17 麦克风与 #18 system audio 已在 E1（Intel、macOS 15.7.7）完成当前范围内的原生编译和真机验收；Issue #21 的原生 stream supervisor 与 recovery 状态机已实现（E1 沙箱回归 83/83，含 6 个端到端 worker 恢复测试），但恢复场景的真机运行时验收尚未取得：F-03 为 Partial，F-04/F-05 为 Blocked（2026-08-22 无人值守尝试因 TCC 授权不可自动获取而跳过，见 §3.6），C-06 已于 2026-08-22 按用户确认回填 Pass；E2、E3、混合录音、打包签名、公证和恢复场景继续暂缓，保留原状态并等待后续条件。

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
| F-03 | 默认输出变化 | 录音期间切换可用的默认输出路由，系统音频语义保持成立 | E1, E2 | **E1: Partial** / E2: Planned | E1(2026-08-21 产品级): 录音 75s 中把默认输出 扬声器↔外置耳机 切换，440Hz 连续音全程 RMS -24dB 稳定（切换后持续捕获 ✅）；但切换点出现 **1.04s 静音缺口**（macOS 输出路由切换自然中断，< 2s 恢复窗口）。产品 F-05 补静音逻辑未实现，缺口不会被补上 → 需 F-05 恢复实现后复核，暂不能标 Pass |
| F-04 | 显示器变化 | 切换主显示器、连接/拔出外接显示器；优先更新 filter，必要时重建 stream | E3 | Blocked | **实现后补验/验收阻塞项**。需 E3 外接显示器环境；当前无条件执行，不阻塞实现启动 |
| F-05 | 恢复窗口 | 单次中断不超过 2 秒时按媒体时间戳补静音并继续；超过 2 秒时失败 | E3 | Blocked | **实现后补验/验收阻塞项**。需 E3 外接显示器与 stream 中断注入；当前无条件执行，不阻塞实现启动 |
| F-06 | 排除自身音频 | `excludesCurrentProcessAudio` 经验证生效，StudyMind 自身提示音不进入 system capture | E1, E2 | **E1: Pass** / E2: Planned | E1: 同进程 cpal 播放 440Hz：不排除 rmsAvg=0.291564；`--exclude-self` → 0.000000 |
| F-07 | audio-only fail-closed | 未注册 screen output，writer/Worker 不接收视频 sample buffer | E1, E2 | **E1: Pass** / E2: Planned | E1: 仅注册 `SCStreamOutputType::Audio`；6 次运行 video_buffers 恒为 0，mic_buffers 恒为 0 |
| F-08 | TCC 基础行为（CLI 可行性探针） | CLI 形态可完成 Screen Recording 请求和授权后重探测 | E1, E2 | **E1: Pass** / E2: Planned | E1: 未授权时 `SCShareableContent::get()` 返回 TCC 拒绝；授权后重探测成功（displays=1 apps=28）且 stream 启动。真实 ad-hoc `.app` 形态（Info.plist usage description）待打包阶段复验，见 §3.2 |

> 2026-08-20 更新：E1（Intel x86_64, macOS 15.7.7, ad-hoc CLI）可行性验证完成，F-01/F-02/F-06/F-07 与 F-08（CLI 范围）通过；F-03/F-04/F-05 因环境限制 Blocked。完整证据见 `scripts/macos-recording-feasibility/report.html` 与探针输出。工具链已升级至 CLT SDK 15.5 / Swift 6.1.2（原 Swift 5.3 / SDK 11.0 无法构建 screencapturekit 8.0.1）。

## 3.1 Issue #17 实施与 E1 麦克风验收证据

以下提交记录了已落地的 macOS 麦克风实现工作；下面的 E1 更新补充了原生编译和 CLI
形态的麦克风真机验收。Windows host 证据仍不替代 E2/E3、真实 `.app` 或发布包验收：

| 范围 | Commit | 已有证据 |
|---|---|---|
| 平台/能力契约 | `ec27655` | macOS 平台和能力门控契约 |
| 清理语义 | `e62cb3f` | 会话失败、取消与临时文件清理语义 |
| PCM 构造器 | `ffa4057` | PCM/WAV 构造路径 |
| macOS 后端源码与纯逻辑测试 | `7e6d83a` | Windows host 上 8 个 focused tests；仅覆盖可在该 host 执行的纯逻辑 |
| Info.plist/workflow | `2e99add` | microphone purpose string and x64/arm64 workflow gates |
| 生命周期/mixer 回归 | `de93c8e` | frontend 41/41、mixer 3/3 |

Windows 上的 `cargo check` 不会编译 `cfg(target_os = "macos")` 下的原生 AVFoundation/CPAL
代码，因此上述 Windows host 证据不能证明 macOS native backend 可编译、可链接或可运行。

> 2026-08-20 更新：已在 **E1（Intel x86_64, macOS 15.7.7）真机**完成 macOS 原生编译与 mic 真机验收。
> 期间发现并修复了 macOS `cfg` 分支的编译错误（`audio_capture/macos.rs` 的 `RcBlock` 闭包参数缺
> `objc2::runtime::Bool` 类型标注，E0282；Windows host 编译不到该分支故漏检），见 commit
> `36e27b6`（已合入 master，含 `objc2 = "0.6"` 依赖）。修复后 `cargo build`/`cargo check` 通过，
> `audio_capture` 模块 **45/45** 测试通过，mic 的 TCC 懒请求/允许/拒绝、start/stop/cancel、
> 16 kHz 单声道 16-bit PCM WAV 均已真机验证。对应 P-01/P-02/P-06 与 C-01/C-03/C-04/C-05 在 E1
> 标记为 Pass（CLI 形态；真实 `.app` 的 Info.plist/TCC 仍见 §3.2 打包项）。

## 3.2 后续验收任务

以下任务不再作为进入规格化或启动正式实现的前置条件，但在 macOS 录音可以宣称验收完成或进入发布前必须取得证据。

| 任务 | 范围 | 完成条件 | 状态 |
|---|---|---|---|
| E2 Apple Silicon | 在 13+ Apple Silicon ad-hoc 环境重跑 F-01、F-02、F-06、F-07、F-08 | arm64 构建、全局系统音频、自身音频排除、audio-only 和 TCC 行为均有可复核证据 | Planned |
| E3 外接显示器 | 连接/拔出外接显示器并切换主显示器 | F-04 通过；显示器变化不改变“系统声音”产品语义，优先更新 filter，必要时重建 stream | Planned |
| 默认输出路由 | 在录音期间切换可用的系统默认输出设备 | F-03 通过；audio-only stream 持续捕获全局系统音频，或按恢复策略重建并恢复 | Planned |
| 恢复场景 | 注入或观察短于/超过 2 秒的 stream 中断 | F-05 通过；短中断补静音并继续，长中断按约定失败，不静默换源 | Planned |
| 打包与签名 | ad-hoc .app、Developer ID 与 notarized 包（E4/E5） | F-08、B-02、B-03、B-04 完成；权限请求、授权后重探测、重启和签名身份均可复核 | Planned |

本轮收口决定：剩余验证暂缓，不继续执行。`Partial` 表示已有不完整证据，`Blocked` 表示缺少
外接显示器、恢复注入等条件，`Planned` 表示待 Apple Silicon、mixed 或发布凭据等后续条件；
这些状态均不代表通过，也不改变“所有适用项目 Pass 后才能宣称 macOS 录音验收完成”的规则。

E1 x86_64 CLI 的原生编译与麦克风（#17）及 system audio（#18）验收已完成，不再列为阻塞项。以下项目仍为**实现后补验/验收阻塞项**，当前不得标记为 `Pass`：

- F-03、F-04、F-05；E2 与 E3。
- 在实际 arm64 macOS 主机上编译原生 AVFoundation/CPAL 代码并运行测试（E2）。
- 使用真实 `.app` 验证 TCC：进入录音入口不弹窗、允许、拒绝、撤销权限及重启后的行为。
- 验证 Tauri 的 Info.plist 合并结果，并检查最终 packaged bundle 中的 purpose strings。
- 完成 Developer ID 签名与公证验证。
- 完成默认设备变化、短中断恢复与超时失败场景。

## 3.3 Issue #18 实现阶段证据（不等同于 macOS E1 Pass）

本轮实现位于隔离分支 `codex/issue-18-macos-system-audio`，主要提交为：

- `38196c3`：锁定 `screencapturekit 8.0.1` 与 macOS 13 audio API 编译探针；
- `efabddb`：能力探测、Screen Recording 拒绝和稳定错误码 seam；
- `a7c4535`：audio-only 配置、当前进程音频排除、视频 fail-closed 和 PCM16 边界；
- `53ccf4e`：system worker、bounded queue、WAV lifecycle 和 controller 接入；
- `bcd97a6`：macOS system capability 前端门控；`5db14b2`：purpose string 与 x64/arm64 bundle 校验。

已执行的 host-side evidence：

- `cargo test --manifest-path app/src-tauri/Cargo.toml audio_capture -- --test-threads=1`：62 项通过；
- `cargo check --manifest-path app/src-tauri/Cargo.toml`：通过；
- `npm --prefix app test -- --run src/recordingClient.test.ts src/features/workflow/useRecordingController.test.ts src/features/workflow/RecordingCard.test.tsx`：133 项通过；
- `git diff --check`：通过；`Info.plist` XML 与 Screen Recording audio-only 文案检查：通过。

以上证据只证明跨平台 seam、状态机和配置边界，不能替代本次产品实现的 macOS native
runtime 验收。表格中 F-01/F-02/F-06/F-07/F-08 的 E1 Pass 是实现前 feasibility probe
的历史证据；它们仍需在本次产品实现上重跑，才能回填 #18 的实现验收。当前不得将
C-02/P-03 或本次实现对应的 F-01/F-02/F-06/F-07 的 macOS runtime 结果标记为 Pass。必须在
macOS E1/E2/E3 上重新执行 native compile、TCC、两类应用全局音频、self-audio exclusion、
真实 `.app` 和 WAV/ffprobe 检查。

> 2026-08-21 更新：已在 **E1（Intel x86_64, macOS 15.7.7）真机**完成 #18 产品代码的 macOS
> native 编译与 system audio 真机验收。期间发现并修复了两个编译阻断问题：
>
> 1. `audio_capture/macos.rs` 的 `with_sample_rate(spec.sample_rate)` 类型错误（`u32` 不能
>    `Into<i32>`，E0277；Windows host 编译不到该分支故漏检），修复为 `as i32`；
> 2. SPM 沙箱 + Swift back-deployment 链接失败：本机 CLT-only 环境下 `sandbox-exec` 不可用
>    且缺少 `swiftCompatibility56` 库。通过 vendor 三个 swift-bridge crate + `--disable-sandbox`
>    + `-Xswiftc -target -Xswiftc <triple>15.0`（设部署目标 15.0 避免 back-deployment）解决。
>    这些是本地构建 hack，不作为产品代码变更提交；产品正式编译应在有完整 Xcode 的 CI 环境执行。
>
> 修复后 `cargo build`/`cargo check` 通过，`audio_capture` 模块 **61/61** 测试通过（含
> `system_stream_config_is_audio_only_and_excludes_current_process`、
> `video_buffer_is_fail_closed_and_never_reaches_writer`、
> `system_capability_probe_never_requests_permission` 等 system 专项）。
>
> System audio 真机验收（一次性 harness 驱动 `RecordingMode::System`，跑完已删除）：
> - **F-01 产品级**：产品代码（含 `screencapturekit 8.0.1`）在 E1 native 编译通过；
> - **F-02 产品级**：录音中同时播放 `say` + `afplay`，产出 WAV `mean_volume: -26.7 dB /
>   max_volume: -7.2 dB`（对比静音基线 -91 dB），全局系统音频被成功捕获；
> - **F-06 产品级**：`excludes_current_process_audio=true` 在产品代码
>   `system_stream_config_is_audio_only_and_excludes_current_process` 单测覆盖（配置层面）；
>   runtime API 生效由 feasibility probe F-06 E1 Pass 证明，产品代码用同一 API；
> - **F-07 产品级**：仅注册 `SCStreamOutputType::Audio`，`video_buffer_is_fail_closed_and_never_reaches_writer`
>   单测覆盖视频 fail-closed；真机产出只有 `system.wav`，无视频文件；
> - **F-08 产品级（CLI 形态）**：`SCShareableContent::get()` 授权后返回 `displays=1 apps=29`，
>   `capabilities()` 返回 `systemAudio.available:true`，`start(System)` 成功；
> - **C-02**：`start(System)` → 录音 8s → `stop` 产出 16 kHz/单声道/16-bit PCM WAV
>  （ffprobe 验证，header 含 `Lavf63.1`）；`cancel` 后 `.tmp` 无 `system.wav` 残留；
> - **backend 层**：`valid_frame_count=192960`（4s，48kHz→16kHz finalizer 后 ≈192000 帧）。
>
> 对应 P-03/C-02 在 E1 标记为 Pass（CLI 形态；真实 `.app` 的 Info.plist/TCC 仍见 §3.2 打包项）。
> F-03/F-04/F-05 仍为 Blocked（需默认输出切换/外接显示器/中断注入）。

> 本轮验证至此暂缓。后续恢复时，优先处理 F-05 恢复补静音与 F-04 filter/stream 恢复，再复核
> F-03；随后按 §3.2 继续 E2、E3、60 分钟 C-06、Developer ID 签名和公证。当前文档中的
> `Partial`、`Blocked`、`Planned` 状态保持不变。

## 3.4 Recovery warning 与 native supervisor implementation evidence

2026-08-21 至 2026-08-22 已完成 portable recovery、warning、frontend 契约和 native
stream supervisor 实现；host-side 与 E1 沙箱证据不替代 F-03/F-04/F-05 的 macOS
恢复场景运行时验收：

| Commit | 范围 | Evidence | 结论 |
|---|---|---|---|
| `c1bdc58` | `SystemAudioRecovery` 时间轴与 2 秒 bounded state machine | 独立 `rustc --test`：6/6 通过；duration-aware gap、checked arithmetic、deadline、stop 语义 | Host-side Pass；已接入 native writer |
| `7624ee1` | warning code/source 聚合、session state/result、best-effort reporter | warning 聚合、sink 失败不丢事实、state/stop 回传测试已加入；完整 Cargo 被 `resources/python/**/*` 缺失阻塞 | Host-side implementation evidence |
| `a7f2f79` | Tauri `recording-warning` event sink | 固定 payload 只含 session/warning/source/count/totalGapMs；rustfmt 解析与 diff check 通过；Cargo 仍受同一资源缺失阻塞 | Host-side contract evidence |
| `1d54944` | TypeScript parser、事件过滤、state hydration | 当时 frontend 75 个 test files / 778 tests 通过；TypeScript/Vite build 通过 | Historical host-side Pass |
| `414650d` 及后续 recovery commits | macOS native stream supervisor 与 recovery integration | `SCStream::new_with_delegate`、Audio-only output、filter 更新优先、失败重建、CMSampleBuffer timing、stop/cancel/error/rebuild 清理；E1 沙箱回归 83/83，含 6 个端到端 worker recovery 测试 | Implementation complete；runtime recovery evidence pending |

2026-08-22 Windows host 回归：frontend 75 个 test files / **780 tests passed**；TypeScript/Vite
production build passed。

Task 3 实现已完成，但上述证据仍不能替代恢复场景的 macOS runtime 验收：

- 默认输出/显示器变化时的全局系统声音连续捕获、媒体时间戳补静音和超过 2 秒失败尚未
  在本轮新的恢复场景中取得完整 macOS runtime 证据；
- 因此 R-01～R-05、F-03～F-05 仍保持 `Partial`/`Blocked`/`Planned` 原状态，不能标记
  为 macOS runtime `Pass`。

## 3.5 macOS 恢复与发布验收交接清单

下一阶段在 macOS + Xcode 环境补齐恢复与发布验收。Intel Mac 可用于 F-03/F-04/F-05
调试；E2 仍必须在 Apple Silicon 上单独补验。开始时记录 `sw_vers`、`uname -m`、
`xcodebuild -version`、`rustc -Vv` 和 `cargo -V`，并确认 macOS 至少为 13.0（本项目
system-audio 的当前基线；ScreenCaptureKit 整体从 12.3 引入）、Screen Recording 权限和
测试音频源可用。

Task 3 当前实现与验收边界：

- 已接入 `SCStreamDelegate`/`did_stop_with_error` 语义，由 supervisor 管理 stream、output
  handler、writer 和停止竞态；
- 主显示器只作为 `SCContentFilter` 的技术入口，不成为用户可见的录音 source，也不改变
  “系统声音”的产品语义；
- 显示器或默认输出变化时优先 `update_content_filter`，失败后才重建 audio-only stream；
  只有音频流无法恢复才报告 `systemAudio` source failure；
- 使用 sample buffer 的 presentation timestamp/duration 驱动已有 recovery 状态机：不超过
  2 秒补静音并继续且发送 warning，超过 2 秒失败；
- 补齐 stop/cancel/error/rebuild 清理和 audio-only 无视频输出验证。

E1 核心 native 验收已完成；后续按 E2 Apple Silicon → E3 外接显示器/默认输出 → 短/长中断恢复 →
真实 `.app`、60 分钟录音、Developer ID 签名和公证的顺序回填证据。每项至少记录系统版本、
架构、工具链、提交 SHA、命令输出、WAV/`ffprobe`、warning `count/totalGapMs` 和签名结果；
在证据齐全前，F-03/F-04/F-05、E2/E3、恢复及发布项保持 `Partial`/`Blocked`/`Planned`。

## 3.6 2026-08-22 E1 恢复场景无人值守验证尝试

本轮在 E1（Intel x86_64 / macOS 15.7.7 / HEAD `af90b10`）按「验证动作不依赖用户配合」的约束，
尝试执行 `e1-system-audio-recovery-runbook.md` 的 Session 0/A/C（Session B 需 GUI 操作，无
Accessibility 权限，直接跳过；Session D/C-06 用户已自行跑完并确认）。结论：

- **沙箱回归通过**：`DYLD_LIBRARY_PATH=/usr/lib/swift cargo test --lib audio_capture -- --test-threads=1`
  → **83/83**（runbook 基线 81 + 后续新增 2 项；含 6 个端到端 worker 恢复测试：中断不重建 /
  重建 / 双中断 / deadline 判死 / anchor 变化不重建 / anchor 变化重建）。
- **一次性 harness 基础设施已验证后删除**（沿用 #18 一次性 harness 先例）：由于 `open --args`
  不向 bundle 应用转发 argv，改为标记文件触发（`/tmp/e1-harness-request.json` + `open -n`），
  在 GUI 初始化前驱动真实 `RecordingController`（System 模式、真实 ffmpeg finalizer、真实
  recordings 目录），进程正常启动并自动退出。harness 代码已从源码树移除，源码与 HEAD 一致。
- **运行时会话被 TCC 阻塞，未执行**：ad-hoc 重签后二进制 cdhash 变化 → Screen Recording 状态
  变为 NotDetermined → `SCShareableContent::get()` 阻塞在系统授权弹窗（实测进程挂起直至被终止，
  证据 JSON 记录了 capabilities 探测与直接 SCK 调用两种路径）；验证环境（无人值守沙箱）内
  `sudo`、`tccutil`、TCC.db 读取、`osascript` System Events、unified log 全部被拒绝，无法自动
  授予或代点弹窗。既有授权属于旧二进制构建（用户当日 15:13 曾用 14:28 构建成功录音），无法
  迁移到新构建。Session 0/A/C 按约定跳过；F-03 保持 Partial，F-04/F-05 保持 Blocked，
  R-01～R-05 保持 Planned。
- **C-06 回填 Pass**（2026-08-22 用户确认完整跑完 60 分钟，见 §5 表格）。当日另做机器工件
  复核：60 分钟录音工件已不在本机（recordings 目录现存 17 个 WAV 最长 2:23，均为 16kHz/mono
  pcm_s16le；app 日志覆盖当日 01:00–16:25，无长录音会话记录；废纸篓与常见目录无 >50M WAV），
  故 C-06 证据类型为「用户确认」，无法升级为机器复核。附带正面发现：`recordings/.tmp/` 为空，
  无临时文件残留泄漏（R-04 相关旁证）。
- **runbook 断言过时提醒**：`784bea8` 已移除录音中恢复 warning 的 UI toast（SCK 启动常有亚秒
  缺口导致 toast 几乎每次必弹且不可操作）。后续按 runbook 复跑时，「录音中 warning 提示」应以
  `get_recording_state` / `stop_recording` 返回的 warnings 数据为准；Session A 的 warning
  `count` 可能包含启动缺口（如 count=3：1 启动 + 2 次切换），按设计契约如实判读。

**恢复路径**：在有用户配合的环境按 runbook 交互式复跑（每次重建 ad-hoc 包后需重新授予
Screen Recording 并重启应用），或改用 Developer ID 签名构建使 TCC 身份跨重建稳定后再补验。

## 4. 权限与能力探测

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| P-01 | 首次进入录音入口 | 不主动弹出 TCC 请求 | E1, E2 | **E1: Pass** / E2: Planned | E1: NotDetermined 下 `capabilities()` 返回 `microphone.available:true` 且不触发弹窗（permission 仍为 NotDetermined，仅读 `authorizationStatusForMediaType`）；单测 `capability_matrix_is_stable_and_probe_never_requests_permission` 亦覆盖 |
| P-02 | 首次启动 mic | 点击开始后请求麦克风权限 | E1, E2 | **E1: Pass** / E2: Planned | E1: NotDetermined 下 `start(Mic)` 触发 `requestAccessForMediaType` 弹窗，用户允许后录音成功；`start(System|Mixed)` 不请求麦克风权限（单测 `system_and_mixed_start_fail_without_prompting`） |
| P-03 | 首次启动 system | 点击开始后请求 Screen Recording 权限，并说明只保存音频 | E1, E2 | **E1: Pass** / E2: Planned | E1: `SCShareableContent::get()` 授权后返回 `displays=1 apps=29`；`capabilities()` 返回 `systemAudio.available:true`；`start(System)` 成功启动 audio-only stream |
| P-04 | 首次启动 mixed | 固定先请求麦克风，再请求 Screen Recording | E1, E2 | Planned | — |
| P-05 | mixed 部分授权 | 整体失败、清理临时文件、不回退 mic | E1, E2 | Planned | — |
| P-06 | 拒绝与系统设置 | 显示来源明确的错误和设置入口；回到前台后重新探测 | E1, E2 | **E1: Pass** / E2: Planned | E1: Denied 下 `start(Mic)` 0.11s 返回 `{"code":"RECORDING_MIC_ACCESS_DENIED","message":"Microphone access was denied."}`，不弹窗、不静默换源 |
| P-07 | 授权后重启 | 重启后能力与 TCC 状态一致 | E1, E2, E4, E5 | Planned | — |
| P-08 | 撤销权限 | option 灰显；空闲态偏好可回退，明确开始后不静默换源 | E1, E2 | Planned | — |
| P-09 | macOS 12.x | 只暴露 mic，system/mixed 不可用 | E6 | Planned | — |

## 5. 采集与产物

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| C-01 | mic start/stop/cancel | 状态机正确，成功停止产出规范 WAV，取消不留产物 | E1, E2 | **E1: Pass** / E2: Planned | E1: 录音 3s→stop 产出 WAV，`.tmp` session 目录清空；cancel 后 `.tmp` 无 mic.wav 残留（`cancel_temp_wav_residue=0`） |
| C-02 | system start/stop/cancel | 捕获全局系统音频，不产生屏幕视频数据 | E1, E2 | **E1: Pass** / E2: Planned | E1: 录音 8s（同时 say+afplay）→ stop 产出 WAV `mean_volume:-26.7dB/max:-7.2dB`（对比静音 -91dB），格式 16kHz/mono/16-bit PCM；cancel 后 `.tmp` 无 system.wav 残留；产物无视频文件 |
| C-03 | SilentRecording | 有有效零振幅帧时允许提交 | E1, E2 | **E1: Pass** / E2: Planned | E1: 单测确定性覆盖（`empty_capture_is_rejected_but_valid_silent_capture_is_finalized`、`stop_drains_blocks_and_returns_valid_silent_or_non_silent_summary` 静音分支）；真机后端实测环境有底噪 `silent=false`（`valid_frame_count=95744`），静音帧允许提交逻辑已由单测证明 |
| C-04 | EmptyRecording | 没有有效音频帧时拒绝提交 | E1, E2 | **E1: Pass** / E2: Planned | E1: 单测 `empty_capture_is_rejected_but_valid_silent_capture_is_finalized`（`valid_frame_count=0` → `RECORDING_EMPTY`）；真机 CoreAudio 持续送帧，空录音不可自然复现 |
| C-05 | 输出格式 | 最终文件为 16 kHz、单声道、16-bit PCM WAV | E1, E2 | **E1: Pass** / E2: Planned | E1: ffprobe 验证 `pcm_s16le / 16000Hz / 1ch / 16bit / 2.976s / 95310B`，header 含 `Lavf63.1`（真实 ffmpeg finalizer 产物） |
| C-06 | 60 分钟录音 | 无明显错位、截断、写入中断或不可解释残留 | E1, E2 | **E1: Pass** / E2: Planned | E1(2026-08-22): 用户确认已在 E1 环境完整跑完 60 分钟系统录音，无截断、错位、写入中断或不可解释残留（用户确认，2026-08-22）。2026-08-21 的 16.5 分钟外部终止记录为历史过程，已被本次完整运行取代 |
| C-07 | 低磁盘空间 | 低于 500 MB 时发出既有 warning，写入边界保持一致 | E1, E2 | Planned | — |

## 6. mixed 原子性与竞态

> 证据约定：`Host` 表示可移植的 deterministic fake/Controller 测试；`E1`/`E2` 表示 macOS
> native runtime。Host-side evidence 可以证明共享契约，但不得升级 E1/E2 的 runtime 状态。

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| M-01 | 双路就绪屏障 | 两路 ready 后才定义 audio time zero，屏障前帧不进入产物 | Host, E1, E2 | Planned | — |
| M-02 | 不同源格式 | 两路临时 WAV header 有效；ffmpeg 正确重采样并混音 | Host, E1, E2 | Planned | — |
| M-03 | 一路静音 | 两路均有有效帧时正常提交 | Host, E1, E2 | Planned | — |
| M-04 | 一路无帧或提前结束 | mixed 整体失败，不提交另一条路 | Host, E1, E2 | Planned | — |
| M-05 | 初始化/运行/停止失败 | 停止另一条路，整体失败并清理 | Host, E1, E2 | Planned | — |
| M-06 | writer 队列溢出 | 返回 `RECORDING_STREAM_ERROR` 与准确 `source` | Host, E1, E2 | Planned | — |
| M-07 | stop/error 竞态 | 两路正常停止完成前已确定的 source failure 优先 | Host, E1, E2 | Planned | — |
| M-08 | accepted-session runtime failure | 无需用户 stop 即终止计时和整个会话；不提交部分媒体 | Host, E1, E2 | Planned | — |
| M-09 | TCC 与 ready timeout | 权限交互不计入三秒 ready deadline；权限完成后 timeout 生效 | Host, E1, E2 | Planned | — |
| M-10 | stop/cancel/finalizer 竞态 | join 完成前 cancel 可覆盖 stop；进入 finalizer 后 cancel 被拒绝且不打断提交 | Host, E1, E2 | Planned | — |

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
| D-06 | 失败 event 与 hydration | `recording-failed` 与 failed state 共用 `RecordingFailureView`；漏收 event 后仍恢复同一失败 | Host, E1, E2 | Planned | — |
| D-07 | 重复失败交付 | event、stop 返回和 hydration 按 session/code/source 去重，只显示一次错误 | Host, E1, E2 | Planned | — |
| D-08 | 后台 cleanup | 首次失败立即可见；`cleanupPending` 完成更新不重复报错，pending 期间不能确认或重启录音 | Host, E1, E2 | Planned | — |
| D-09 | cleanup 风险分级 | 临时文件删除失败不阻塞；native teardown 未确认时本进程持续阻塞并提示重启 | Host, E1, E2 | Planned | — |
| D-10 | 失败确认与替换 | 匹配 session 的确认幂等；旧 session 无法清除新失败；新会话原子替换旧快照 | Host, E1, E2 | Planned | — |

## 9. 打包与发布

| ID | 场景 | 预期结果 | 环境 | 状态 | Evidence |
|---|---|---|---|---|---|
| B-01 | ffmpeg/ffprobe 资源 | 架构匹配、可执行位正确、运行时路径可解析 | E1, E2, E4, E5 | **E1: Pass**（ad-hoc .app） / E2, E4, E5: Planned | E1(2026-08-21): `tauri build --bundles app` 产出 StudyMind.app（x86_64），内含 ffmpeg/ffprobe 资源；codesign `--verify --deep --strict` PASS |
| B-02 | Info.plist | 两个 purpose string 均存在且文案说明 audio-only | E4, E5 | **E1: Pass**（ad-hoc .app 形态） / E4, E5: Planned | E1(2026-08-21): `NSMicrophoneUsageDescription`="StudyMind records microphone audio for local transcription and study notes."；`NSScreenCaptureUsageDescription`="StudyMind records system audio for local transcription and study notes. Screen content is not saved."；bundle id `com.studymind.desktop` |
| B-03 | Developer ID 签名 | bundle identity 稳定，签名验证通过 | E4, E5 | Blocked | ad-hoc 签名（identity "-"）验证通过；Developer ID 签名需证书，无凭据 |
| B-04 | 公证包 | notarization、启动、TCC、重启流程均通过 | E4, E5 | Blocked | 无 APPLE_ID/APPLE_API_KEY，notarization 未执行 |

## 10. 完成判定

- `Accepted` ADR 与验收结果相互独立：ADR 记录批准的技术决策，本文档记录事实验证。
- F-01、F-02、F-06、F-07 的核心语义未通过时，不进入正式后端实现；若 binding 或全局系统
  音频语义不成立，重开 ADR 0005。
- F-03、F-04、F-05 的 `Blocked` 仅表示当前环境无法补验；它们会阻塞验收完成与发布，不
  阻塞正式后端实现启动。
- 所有适用项目为 `Pass` 且 Evidence 可复核后，才能宣称 macOS 录音实现完成。
- Issue #17 麦克风与 #18 system audio 的 E1 原生编译与 CLI 真机验收已有证据；E2、E3、
  混合录音相关补验、打包签名、默认输出变化和恢复场景仍为后续验收任务。本文档不代表
  整个 macOS 录音能力已完成。
- 本轮已明确将剩余验收暂缓；恢复工作时应从现有 Evidence 继续，不得将暂缓自动解释为
  `Pass`。
