#!/usr/bin/env bash
#
# E1 真机验收一键脚本 — macOS 系统音频恢复 (Issue #21 Task 3)
# 对应 runbook: docs/test-plans/e1-system-audio-recovery-runbook.md
#
# 设计：把 runbook 里所有"命令行可自动采集"的证据做成菜单式脚本。
#       需要真人操作的(授权/听回放)会显式提示并等待按键，其余全自动断言。
#
# 用法:
#   bash scripts/e1-acceptance.sh           # 进菜单
#   bash scripts/e1-acceptance.sh env        # 直接跑环境快照
#   bash scripts/e1-acceptance.sh session0    # 直接跑冒烟
#   bash scripts/e1-acceptance.sh sessionA    # ... 以此类推
#
set -uo pipefail

REPO="/Users/linn/Documents/github/StudyMind"
APP_ID="com.studymind.desktop"
REC_DIR="$HOME/Library/Application Support/$APP_ID/recordings"
TMP_DIR="$REC_DIR/.tmp"
BUNDLE_APP="$REPO/app/src-tauri/target/release/bundle/macos/StudyMind.app"
EVIDENCE="$REPO/docs/test-plans/e1-acceptance-evidence.md"
CONFIG="$HOME/.studymind_e1_config"
TONE="/tmp/tone440.wav"

# 颜色(终端直接可见)
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[0;34m'; NC='\033[0m'
ok(){ echo -e "${G}✅ $1${NC}"; }
no(){ echo -e "${R}❌ $1${NC}"; }
warn(){ echo -e "${Y}⚠️  $1${NC}"; }
info(){ echo -e "${B}ℹ️  $1${NC}"; }
hr(){ echo "────────────────────────────────────────"; }

# 断言计数
PASS=0; FAIL=0
assert(){ if [ "$2" = "0" ]; then ok "$1"; PASS=$((PASS+1)); else no "$1"; FAIL=$((FAIL+1)); fi; }

# 把证据追加写入 markdown
log(){ echo "$1" >> "$EVIDENCE"; }
logsec(){ echo "" >> "$EVIDENCE"; echo "## $1" >> "$EVIDENCE"; echo "" >> "$EVIDENCE"; echo "时间: $(date '+%Y-%m-%d %H:%M:%S')" >> "$EVIDENCE"; echo "" >> "$EVIDENCE"; }

pause_for_human(){
  # $1 = 提示语
  echo ""
  warn "👉 $1"
  warn "   完成上面的操作后，回到此终端按 [Enter] 继续证据采集…"
  read -r _ </dev/tty
}

# ─────────────────────────────────────────────
# 配置: 设备名探测
# ─────────────────────────────────────────────
ensure_config(){
  if [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    source "$CONFIG"
  fi
  if [ -z "${DEV_SPEAKER:-}" ] || [ -z "${DEV_HEADPHONE:-}" ]; then
    echo ""
    info "首次运行需要确认你机器上的音频输出设备名(SwitchAudioSource 列出如下):"
    if ! command -v SwitchAudioSource >/dev/null 2>&1; then
      warn "未找到 SwitchAudioSource，正在 brew 安装…"
      brew install switchaudio-osx || { no "brew install switchaudio-osx 失败，请手动安装后重跑"; exit 1; }
    fi
    echo ""
    SwitchAudioSource -a -t output
    echo ""
    read -r -p "请输入『扬声器/内置输出』类设备名(原样粘贴): " DEV_SPEAKER
    read -r -p "请输入『耳机/外接』类设备名(原样粘贴, 没有就填和上面一样): " DEV_HEADPHONE
    if [ -z "$DEV_SPEAKER" ]; then no "设备名不能为空"; exit 1; fi
    [ -z "$DEV_HEADPHONE" ] && DEV_HEADPHONE="$DEV_SPEAKER"
    cat > "$CONFIG" <<EOF
DEV_SPEAKER='$DEV_SPEAKER'
DEV_HEADPHONE='$DEV_HEADPHONE'
EOF
    ok "已写入配置 $CONFIG"
  fi
  info "当前设备: 扬声器=[$DEV_SPEAKER] 耳机=[$DEV_HEADPHONE]"
}

switch_out(){ # $1 = 目标设备名
  SwitchAudioSource -t output -s "$1" && info "已切输出 → $1" || warn "切换失败: $1 (可能设备名不对)"
}

# ─────────────────────────────────────────────
# 0. 环境快照
# ─────────────────────────────────────────────
do_env(){
  logsec "环境快照 (Session Env)"
  log '```'
  echo ""; info "== 环境快照 =="; hr
  sw_vers 2>/dev/null | tee -a "$EVIDENCE"; log '```'; log '```'
  echo -n "arch: "; uname -m | tee -a "$EVIDENCE"
  echo -n "commit: "; git -C "$REPO" rev-parse --short HEAD | tee -a "$EVIDENCE"
  echo -n "cargo: "; cargo -V 2>/dev/null | tee -a "$EVIDENCE"
  echo -n "xcodebuild: "; xcodebuild -version 2>/dev/null | head -1 | tee -a "$EVIDENCE"
  echo -n "ffmpeg: "; ffmpeg -version 2>/dev/null | head -1 | tee -a "$EVIDENCE"
  log '```'
  # 前置资源检查
  hr; info "== 前置资源检查 =="
  if [ -L "$REPO/app/src-tauri/resources/python" ]; then ok "resources/python 是软链 → $(readlink "$REPO/app/src-tauri/resources/python")"; else no "resources/python 非软链(应为 .venv 软链)"; fi
  if [ -e "$REPO/app/src-tauri/resources/bin/ffmpeg" ] && [ -e "$REPO/app/src-tauri/resources/bin/ffprobe" ]; then ok "resources/bin ffmpeg+ffprobe 存在"; else no "resources/bin 缺 ffmpeg/ffprobe(见 runbook §7.3)"; fi
  log ""
  log "前置: resources/python=$([ -L "$REPO/app/src-tauri/resources/python" ] && echo OK || echo MISSING)  resources/bin=$([ -e "$REPO/app/src-tauri/resources/bin/ffmpeg" ] && echo OK || echo MISSING)"
}

# ─────────────────────────────────────────────
# 准备测试长音
# ─────────────────────────────────────────────
prep_tone(){
  if [ ! -f "$TONE" ]; then
    info "生成 440Hz 测试长音(600s)…"
    ffmpeg -y -f lavfi -i "sine=frequency=440:duration=600" -c:a pcm_s16le "$TONE" >/dev/null 2>&1 && ok "已生成 $TONE" || no "测试音生成失败"
  else
    info "测试音已存在: $TONE"
  fi
}

loop_tone(){
  # 后台循环播放
  nohup bash -c "while true; do afplay '$TONE'; done" >/dev/null 2>&1 &
  echo $! > /tmp/e1_tone.pid
  info "循环播放 440Hz 已启动 (pid $(cat /tmp/e1_tone.pid))"
}
stop_tone(){
  if [ -f /tmp/e1_tone.pid ]; then kill "$(cat /tmp/e1_tone.pid)" 2>/dev/null; rm -f /tmp/e1_tone.pid; fi
  pkill -f "afplay $TONE" 2>/dev/null
  info "已停止测试音循环"
}

# ─────────────────────────────────────────────
# 证据采集: WAV 探测
# ─────────────────────────────────────────────
collect_wav_evidence(){
  # $1 = wav 路径
  local WAV="$1"
  log ""
  log "产物: \`$WAV\`"
  log '```'
  if [ ! -f "$WAV" ]; then
    no "产物不存在: $WAV"; log "WAV: MISSING"; log '```'; return 1
  fi
  ffprobe -v error -show_entries stream=codec_name,sample_rate,channels \
    -show_entries format=duration,size -of default=noprint_wrappers=1 "$WAV" | tee -a "$EVIDENCE"
  log '```'
  log '```'
  info "== 静音段检测 =="
  local SIL
  SIL=$(ffmpeg -i "$WAV" -af silencedetect=noise=-50dB:d=0.3 -f null - 2>&1 | grep -E "silence_(start|end)")
  echo "$SIL" | tee -a "$EVIDENCE"
  log '```'
  # 格式断言
  local SR CH
  SR=$(ffprobe -v error -show_entries stream=sample_rate -of default=noprint_wrappers=1:nokey=1 "$WAV")
  CH=$(ffprobe -v error -show_entries stream=channels -of default=noprint_wrappers=1:nokey=1 "$WAV")
  [ "$SR" = "16000" ] && assert "采样率 16kHz ($SR)" 0 || assert "采样率应为 16kHz, 实际 $SR" 1
  [ "$CH" = "1" ] && assert "单声道 ($CH)" 0 || assert "应为单声道, 实际 $CH" 1
  # .tmp 清理断言
  if [ -z "$(ls -A "$TMP_DIR" 2>/dev/null)" ]; then assert ".tmp 会话目录已清理" 0; else assert ".tmp 未清理: $(ls -A "$TMP_DIR")" 1; fi
  return 0
}

latest_wav(){
  ls -t "$REC_DIR"/*.wav 2>/dev/null | head -1
}

# ─────────────────────────────────────────────
# Session 0: 冒烟
# ─────────────────────────────────────────────
do_session0(){
  logsec "Session 0 — 冒烟基线"
  ensure_config
  info "== Session 0: 无切换基线冒烟 =="
  pause_for_human "请在 App 中选择『系统音频』源, 开始录音 30s (不要切任何输出), 结束后回到这里按 Enter。"
  local WAV
  WAV=$(latest_wav)
  if [ -z "$WAV" ]; then no "未找到产物 WAV, 请确认录音成功"; return; fi
  collect_wav_evidence "$WAV"
  warn "请人工试听 $WAV 确认非静音、声音连续, 并在 UI 确认会话成功(无错误态)。"
  read -r -p "试听结论(成功=y / 失败=n): " A
  if [ "$A" = "y" ]; then assert "人工试听: 会话成功非静音" 0; else assert "人工试听: 失败或静音" 1; fi
}

# ─────────────────────────────────────────────
# Session A: F-03 + F-05短 + R-01/R-03/R-04
# ─────────────────────────────────────────────
do_sessionA(){
  logsec "Session A — 输出路由切换×2 (F-03/F-05短/R-01/R-03/R-04)"
  ensure_config
  prep_tone; loop_tone
  info "== Session A: 输出切换 ×2 =="
  pause_for_human "请在 App 选『系统音频』开始录音, 确认 440Hz 在播, 然后回来按 Enter 记 t0。"
  local t0; t0=$(date +%s)
  info "t0=$t0 — 30s 后自动切第1次输出"
  sleep 30; switch_out "$DEV_HEADPHONE"; local t1; t1=$(date +%s); info "t1=$t1 已切→$DEV_HEADPHONE"
  sleep 20; switch_out "$DEV_SPEAKER"; local t2; t2=$(date +%s); info "t2=$t2 已切回→$DEV_SPEAKER"
  sleep 30; stop_tone
  pause_for_human "请在 App 停止录音(总时长约 80s), 停止后回来按 Enter 采集证据。"
  local WAV; WAV=$(latest_wav)
  [ -z "$WAV" ] && { no "未找到产物"; return; }
  collect_wav_evidence "$WAV"
  # 时长断言 ≈80s±2s
  local DUR; DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$WAV" 2>/dev/null | cut -d. -f1)
  if [ -n "$DUR" ] && [ "$DUR" -ge 78 ] && [ "$DUR" -le 82 ]; then assert "WAV 时长≈80s (实际 ${DUR}s)" 0; else assert "WAV 时长应≈80s±2s, 实际 ${DUR}s" 1; fi
  warn "请在停止结果/UI 确认含 RECORDING_SYSTEM_AUDIO_RECOVERED: count=2, totalGapMs≈两缺口之和(上次实测单缺口≈1040ms)。"
  warn "请人工试听确认缺口被补齐(2 段静音, 各 0.3–2s)而非缺失。"
  read -r -p "UI warning 显示 count=2 且试听缺口补齐? (y/n): " A
  [ "$A" = "y" ] && assert "UI recovered warning count=2 + 试听缺口补齐" 0 || assert "UI/试听未达预期" 1
}

# ─────────────────────────────────────────────
# Session B: R-02 前端重挂载 (dev 模式)
# ─────────────────────────────────────────────
do_sessionB(){
  logsec "Session B — 前端重挂载恢复 (R-02, 需路径B dev 模式)"
  ensure_config
  prep_tone; loop_tone
  info "== Session B: webview reload 漏收恢复 =="
  warn "本 Session 必须用 dev 模式(npm run dev), 否则 Cmd+R 不影响已 bundle 的 webview 状态。"
  pause_for_human "请在『dev 模式 App』中选系统音频开始录音, 440Hz 在播, 回来按 Enter 记 t0。"
  local t0; t0=$(date +%s)
  sleep 30; switch_out "$DEV_HEADPHONE"; info "t0+30s 切输出(第1个 warning)"
  sleep 10; info "t0+40s 请在 App 窗口按 Cmd+R (webview reload)"
  sleep 30; switch_out "$DEV_SPEAKER"; info "t0+70s 再切回(第2个 warning)"
  sleep 30; stop_tone
  pause_for_human "请停止录音, 并在 reload 后确认 UI 仍能恢复第1个 warning(不丢), 回来按 Enter 采集。"
  local WAV; WAV=$(latest_wav)
  [ -z "$WAV" ] && { no "未找到产物"; return; }
  collect_wav_evidence "$WAV"
  warn "请确认: reload 后录音继续(Rust 侧不受影响) + UI 从 get_recording_state 恢复第1个 warning + 停止 warning count=2。"
  read -r -p "上述均满足? (y/n): " A
  [ "$A" = "y" ] && assert "R-02: reload 后 warning 不丢 + 录音继续" 0 || assert "R-02 未达预期" 1
}

# ─────────────────────────────────────────────
# Session C: F-05长 + R-05 超窗 fail-closed
# ─────────────────────────────────────────────
do_sessionC(){
  logsec "Session C — 超窗 fail-closed (F-05长/R-05)"
  ensure_config
  prep_tone; loop_tone
  info "== Session C: killall coreaudiod 注入 >2s 中断 =="
  warn "⚠️ killall coreaudiod 会让本机所有音频静音数秒(系统级), 请先保存其他应用工作!"
  pause_for_human "请在 App 选系统音频开始录音, 440Hz 在播, 回来按 Enter 记 t0。"
  local t0; t0=$(date +%s); info "t0=$t0"
  sleep 30
  warn "即将 sudo killall coreaudiod (需输入密码)…"
  local t1; t1=$(date +%s)
  sudo killall coreaudiod && info "t1=$t1 已注入 coreaudiod kill, 等待会话自行失败(.tmp 清空即失败信号)…"
  # 轮询 .tmp: fail-closed 后 supervisor 清理 .tmp 并停止; 最多等 25s
  local waited=0; local failed=0
  while [ $waited -lt 25 ]; do
    sleep 2; waited=$((waited+2))
    if [ -z "$(ls -A "$TMP_DIR" 2>/dev/null)" ]; then
      # .tmp 清空: 可能是成功停止, 也可能是失败清理; 用"是否出现新产物"区分
      if [ -z "$(ls -t "$REC_DIR"/*.wav 2>/dev/null | head -1)" ] || \
         [ "$(stat -f %m "$(ls -t "$REC_DIR"/*.wav 2>/dev/null | head -1)" 2>/dev/null)" -lt "$t0" ]; then
        failed=1; info "t1+${waited}s 检测到 .tmp 清空且无新产物 → 判定 fail-closed 生效"; break
      fi
    fi
  done
  [ $failed -eq 0 ] && warn "25s 内未检测到明确失败信号, 请人工确认 UI 状态"
  stop_tone
  pause_for_human "请确认会话已失败(UI 显示 RECORDING_STREAM_ERROR + source systemAudio), 回来按 Enter 采集。"
  # 失败判定: 不应有新提交产物
  local NEW
  NEW=$(ls -t "$REC_DIR"/*.wav 2>/dev/null | head -1)
  if [ -z "$NEW" ]; then assert "失败: 无部分产物提交 (recordings/ 无新 WAV)" 0; else
    # 看时间戳是否在 t0 前
    local mt; mt=$(stat -f %m "$NEW" 2>/dev/null)
    if [ -n "$mt" ] && [ "$mt" -lt "$t0" ]; then assert "失败: 无新产物(最新 WAV 早于本会话)" 0; else assert "失败: 却出现了新产物 $NEW" 1; fi
  fi
  if [ -z "$(ls -A "$TMP_DIR" 2>/dev/null)" ]; then assert "失败: .tmp 已清理" 0; else assert ".tmp 未清理" 1; fi
  warn "请确认失败时间 ≈ t1+2~3s(2s 窗口+轮询), 而非立即或永不失败。"
  read -r -p "UI 显示来源明确的失败(systemAudio)? (y/n): " A
  [ "$A" = "y" ] && assert "R-05: 来源明确失败态" 0 || assert "R-05 失败态不明确" 1
}

# ─────────────────────────────────────────────
# Session D: C-06 60min (独立终端提示)
# ─────────────────────────────────────────────
do_sessionD(){
  logsec "Session D — 60min 连续录音 (C-06, 可选)"
  warn "本 Session 必须在【独立终端】+【独立 .app】跑, 不能用 WorkBuddy 会话(会被回收)。"
  warn "正确命令(你自己在 iTerm 粘贴):"
  echo ""
  echo "    caffeinate -dims open \"$BUNDLE_APP\""
  echo ""
  warn "打开后开始系统音频录音, 静候 60min, 中途可另开终端 ls -la \"$TMP_DIR\" 观察 system.wav 增长。"
  warn "60min 后正常 stop, 回来跑: bash scripts/e1-acceptance.sh collectD"
}

collectD(){
  local WAV; WAV=$(latest_wav)
  [ -z "$WAV" ] && { no "未找到产物"; return; }
  logsec "Session D — 60min 产物证据"
  collect_wav_evidence "$WAV"
  local DUR; DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$WAV" 2>/dev/null | cut -d. -f1)
  if [ -n "$DUR" ] && [ "$DUR" -ge 3580 ] && [ "$DUR" -le 3620 ]; then assert "60min WAV 时长≈3600s (实际 ${DUR}s)" 0; else assert "60min 时长应≈3600s±20s, 实际 ${DUR}s" 1; fi
}

# ─────────────────────────────────────────────
# 菜单
# ─────────────────────────────────────────────
show_menu(){
  echo ""
  echo -e "${B}═══ E1 真机验收菜单 ═══${NC}"
  echo " 0) 环境快照 (Env)         — 先跑这个确认机器就绪"
  echo " 1) Session 0 冒烟基线"
  echo " 2) Session A 输出切换×2   (F-03/F-05短/R-01/R-03/R-04)"
  echo " 3) Session B 前端重挂载   (R-02, 需 dev 模式)"
  echo " 4) Session C 超窗失败     (F-05长/R-05, killall coreaudiod)"
  echo " 5) Session D 60min        (C-06, 看提示自己在独立终端跑)"
  echo " 6) 汇总并打印证据文件路径"
  echo " q) 退出"
  echo -e "${B}═══════════════════════${NC}"
  read -r -p "选择: " C
  case "$C" in
    0|env) do_env;;
    1|session0) do_session0;;
    2|sessionA) do_sessionA;;
    3|sessionB) do_sessionB;;
    4|sessionC) do_sessionC;;
    5|sessionD) do_sessionD;;
    6|summary) echo "证据文件: $EVIDENCE"; cat "$EVIDENCE" 2>/dev/null | tail -40;;
    q|Q) exit 0;;
    *) echo "无效选择";;
  esac
}

# ─────────────────────────────────────────────
# main
# ─────────────────────────────────────────────
mkdir -p "$(dirname "$EVIDENCE")"
# 直接模式
case "${1:-}" in
  env) do_env;;
  session0) do_session0;;
  sessionA) do_sessionA;;
  sessionB) do_sessionB;;
  sessionC) do_sessionC;;
  sessionD) do_sessionD;;
  collectD) collectD;;
  "") while true; do show_menu; done;;
  *) echo "未知参数: $1"; exit 1;;
esac

# 收尾统计(非菜单模式下也给出)
echo ""
hr
info "本轮断言: ${G}通过 $PASS${NC} / ${R}失败 $FAIL${NC}"
info "证据已写入: $EVIDENCE"
hr
