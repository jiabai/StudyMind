# E1 真机验收 Runbook — macOS 系统音频恢复（Issue #21 Task 3）

> 目标：在 E1（Intel x86_64 / macOS 15.7.7 / 单显示器）取得 native stream supervisor（`414650d`..`40a4999`）的真机运行时证据，覆盖 **F-03、F-05（短/长中断）、R-01～R-05** 与可选 **C-06**。F-04（显示器变化）需 E3 外接显示器，本轮保持 Blocked。
>
> 沙箱侧证据（本 runbook 不重复执行）：`DYLD_LIBRARY_PATH=/usr/lib/swift cargo test --lib audio_capture -- --test-threads=1` → **81/81**（含 6 个端到端 worker 恢复测试：中断不重建 / 重建 / 双中断 / deadline 判死 / anchor 变化不重建 / anchor 变化重建）。

## 0. 每轮必记的环境快照

```bash
sw_vers                                                          # 须 ≥13.0；E1 基线 15.7.7
uname -m                                                          # x86_64
git -C /Users/linn/Documents/github/StudyMind rev-parse --short HEAD  # 验收 commit（本轮 40a4999）
rustc -Vv && cargo -V
xcodebuild -version                                               # CLT 15.5 / Swift 6.1.2
ffmpeg -version | head -1                                         # brew 9.0.1
```

## 1. 构建与启动（二选一）

### 路径 A（推荐）：ad-hoc .app — TCC 归因干净、purpose strings 齐全

前置检查（本机已配置；若失效按 §7 恢复）：

```bash
ls -la app/src-tauri/resources/python   # 应为指向仓库 .venv 的软链
ls -l app/src-tauri/resources/bin/      # ffmpeg/ffprobe 软链 → brew 9.0.1
```

构建并启动：

```bash
cd /Users/linn/Documents/github/StudyMind
npm --prefix app run tauri build -- --bundles app
# 产物：app/src-tauri/target/release/bundle/macos/StudyMind.app
open app/src-tauri/target/release/bundle/macos/StudyMind.app
```

### 路径 B：tauri dev（Session B 需要 webview reload）

```bash
cd /Users/linn/Documents/github/StudyMind
npm run dev    # = scripts/tauri-dev-fresh-worker.mjs
```

注意：dev 二进制无 bundle，TCC Screen Recording 归因到父终端（iTerm/Terminal）。

## 2. TCC Screen Recording 权限

- 首次进入录音入口**不弹窗**（capabilities 只读 status）；点「开始录音」才触发 TCC 请求（P-03 已验证的懒请求行为）。
- macOS 授予 Screen Recording 后**需重启应用**才生效。

```bash
# .app 形态重置（必须在用户自己的 iTerm 跑；WorkBuddy 沙箱内 tccutil 会报 Operation not permitted）
tccutil reset ScreenCapture com.studymind.desktop
# dev 形态归因到终端，nuclear reset：
tccutil reset ScreenCapture
```

## 3. 测试音频准备

```bash
# 10 分钟连续 440Hz 长音（缺口测量用）
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=600" -c:a pcm_s16le /tmp/tone440.wav

# 独立终端循环播放
while true; do afplay /tmp/tone440.wav; done
```

可选：CLI 切换默认输出（比手点系统设置计时准）：

```bash
brew install switchaudio-osx
SwitchAudioSource -a -t output                         # 列出设备名
SwitchAudioSource -t output -s "MacBook Pro Speakers"  # 切到扬声器（按实际设备名替换）
```

## Session 0（冒烟）：无切换基线

开始「系统音频」录音 30s（播放 440Hz），停止。确认：会话成功、WAV 非静音（ffprobe + 试听）、`.tmp` 清空。**基线不过先修环境，不要进入恢复测试。**

## Session A：F-03 + F-05（短中断）+ R-01/R-03/R-04 — 输出路由切换 ×2

验证「默认输出切换 → ~1s 自然中断 → 2s 窗口内补静音恢复 + warning 聚合」。

1. 开始 System 录音 + 440Hz 循环音，记 `t0`（`date +%s`）。
2. `t0+30s`：切默认输出（扬声器↔耳机），记 `t1`。
3. `t1+20s`：切回，记 `t2`。
4. `t2+30s`：停止录音。
5. 按 §6 收集证据。

Pass 判定（全部满足）：

- [ ] 会话未失败、未静默换源（无 `RECORDING_STREAM_ERROR`）
- [ ] WAV 总时长 ≈ 80s±2s（缺口被**补齐**而非缺失）
- [ ] `silencedetect` 恰有 2 段静音，各 0.3–2s，起点对应 `t1`/`t2`（±2s）
- [ ] 停止结果/UI 含 `RECORDING_SYSTEM_AUDIO_RECOVERED`：`count=2`，`totalGapMs≈两缺口之和`（上次实测单缺口≈1040ms）
- [ ] WAV 格式 16kHz / mono / 16-bit PCM
- [ ] `.tmp` 会话目录已清理

## Session B：R-02 — 前端重挂载/事件漏收恢复（用路径 B dev 模式）

1. 开始 System 录音，`t0+30s` 切一次输出（产生第 1 个 warning）。
2. `t0+40s` 在 app 窗口按 **Cmd+R**（webview reload，模拟前端重挂载/漏收）。
3. `t0+70s` 再切一次输出。
4. `t0+100s` 停止。

Pass 判定：

- [ ] reload 后录音继续（Rust 侧不受影响）
- [ ] reload 后 UI 从 `get_recording_state` 恢复第 1 个 warning（不丢）
- [ ] 停止结果 warning：`count=2`，`totalGapMs` 为两缺口之和

## Session C：F-05（长中断）+ R-05 — 超窗 fail-closed

注入 >2s 音频中断，二选一：

- **C1（推荐）**：`sudo killall coreaudiod` —— coreaudiod 自动重启需数秒，期间全局无音频输出，loopback 停止送帧 → 恢复窗口超时。
- **C2**：把默认输出切到需长连接的 AirPlay 设备（连接期间无输出）。

步骤：开始录音 + 440Hz → `t0+30s` 注入（记 `t1`）→ 等待会话自行失败。

Pass 判定：

- [ ] 会话失败：`RECORDING_STREAM_ERROR` + source `systemAudio`（不静默换源、不无限挂起）
- [ ] 失败时间 ≈ `t1+2~3s`（2s 窗口 + 轮询间隔，而非立即失败或永不失败）
- [ ] 无部分产物提交（`recordings/` 无新文件），`.tmp` 清理
- [ ] UI 显示来源明确的失败

⚠️ `killall coreaudiod` 是系统级音频中断（所有应用静音数秒）；先保存其他应用工作。coreaudiod 自动拉起，属正常自愈。

## Session D（可选）：C-06 — 60 分钟连续录音

**必须独立终端 + 独立 .app**（不要在 WorkBuddy 会话跑——上轮 16.5min 被会话回收终止）：

```bash
caffeinate -dims open app/src-tauri/target/release/bundle/macos/StudyMind.app
```

Pass 判定：60min 无截断错位；WAV 时长 ≈3600s；写入速率稳定（中途 `ls -la` 观察 `.tmp` 的 system.wav 增长）；正常 stop 后 `.tmp` 清空。

## §5.5 一键脚本（替代手动敲命令）

所有命令行证据采集已封装为 `scripts/e1-acceptance.sh`（commit cc40616）。进菜单跑或直跑子命令：

```bash
bash scripts/e1-acceptance.sh            # 菜单
bash scripts/e1-acceptance.sh env        # 环境快照
bash scripts/e1-acceptance.sh session0   # 冒烟
bash scripts/e1-acceptance.sh sessionA   # 输出切换×2
bash scripts/e1-acceptance.sh sessionB   # 前端重挂载(dev)
bash scripts/e1-acceptance.sh sessionC   # 超窗失败
bash scripts/e1-acceptance.sh sessionD   # 60min 提示
```

脚本首次运行会让你填音频输出设备名（brew 装 `switchaudio-osx` 后自动列出）。每条断言自动打 ✅/❌，结果落盘 `docs/test-plans/e1-acceptance-evidence.md` —— 跑完把该文件发回即可回填验收表。

## §6 证据收集命令

```bash
WAV="<停止后 UI 显示的产物路径>"   # 或：ls -t ~/Library/Application\ Support/com.studymind.desktop/recordings/ | head
ffprobe -v error -show_entries stream=codec_name,sample_rate,channels \
  -show_entries format=duration,size -of default=noprint_wrappers=1 "$WAV"
ffmpeg -i "$WAV" -af silencedetect=noise=-50dB:d=0.3 -f null - 2>&1 | grep -E "silence_(start|end)"
ls -la ~/Library/Application\ Support/com.studymind.desktop/recordings/.tmp/   # 成功与失败后均应为空
```

另截图：录音中 warning 非阻塞提示（role=status）、停止后 warning 提示、Session C 失败错误态。

## §7 已知坑（前车之鉴）

1. **权限操作一律在用户自己的 iTerm 跑**：WorkBuddy 沙箱内 `tccutil` 报 `Operation not permitted`；dev 二进制 TCC 归因到父终端。
2. macOS 授予 Screen Recording 后需**重启进程**才生效。
3. 构建期报 `Permission denied (os error 13)`：brew ffmpeg/ffprobe 只读位被带进 target，`chmod u+w` brew 源与 `target/**/resources/bin/{ffmpeg,ffprobe}` 后重建。
4. `.venv` 被 `uv sync` 重建后软链失效：重新 `ln -s /Users/linn/Documents/github/StudyMind/.venv app/src-tauri/resources/python`（不要 cp -R，省 1.2GB）。
5. 60min 测试避免 WorkBuddy 会话回收与系统休眠（C-06 上轮教训；用 caffeinate）。
6. CLT-only 构建依赖 `~/.cargo/registry` 本地 hack（`--disable-sandbox` + triple `x86_64-apple-macosx15.0` + apple-metal State.swift 注释）；registry 被清理时按 2026-08-21 项目日志恢复，改完必须 `cargo clean -p apple-cf -p apple-metal -p screencapturekit`。正式产品构建应在有完整 Xcode 的 CI 执行。

## §8 状态回填指引

| 验收项 | 本 runbook 覆盖 | 回填动作 |
|---|---|---|
| F-03 | Session A | E1 列 Pass（若全部满足）；E2 仍 Planned |
| F-05 | Session A（短）+ Session C（长） | 计划表环境列为 E3；如接受 E1 注入证据可回填并注明注入方式，或保留 E3 复验 |
| R-01 / R-03 / R-04 | Session A | E1 证据；按计划表原环境列（E3）酌情回填 |
| R-02 | Session B | 同上 |
| R-05 | Session C | 同上 |
| F-04 | 不覆盖（需外接显示器） | 保持 Blocked，E3 执行 |
| C-06 | Session D（可选） | 独立终端跑满 60min 后回填 |

回填规则：Evidence 必须可复核（命令输出 / 截图 / WAV 探测结果）；不得以「沙箱单测通过」直接标 Pass；`Partial`/`Blocked`/`Planned` 不因暂缓自动转 Pass。
