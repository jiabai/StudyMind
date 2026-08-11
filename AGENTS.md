# StudyMind AI Collaboration Rules

StudyMind 是一个课堂学习辅助桌面应用，从 FrameQ 派生而来。它专注于本地音视频转写、文字稿校验和思维导图总结功能。

## 产品定位

- 本地优先的学习笔记工具
- 输入：本地音视频文件（课堂录音、讲座录像）
- 输出：带时间戳的文字稿 + AI 生成的知识点摘要/思维导图
- 不包含网络视频 URL 抓取功能
- 不包含社交平台 fallback 解析

## 架构概览

```
StudyMind/
├── app/                    # Tauri 桌面应用
│   ├── src/                # React 前端
│   └── src-tauri/          # Rust Tauri 后端
├── worker/                 # Python Worker
│   └── studymind_worker/   # 核心处理逻辑
├── server/                 # 独立服务器
├── contracts/              # Worker 通信契约
└── docs/                   # 设计文档
```

## 核心模块边界

- `studymind_worker/asr_runtime/` - ASR 引擎（SenseVoice ONNX）
- `studymind_worker/media.py` - 媒体探测和音频提取（ffmpeg/ffprobe）
- `studymind_worker/media_preparation.py` - 本地媒体预处理（无 URL 路径）
- `studymind_worker/task_store.py` - 任务持久化
- `studymind_worker/pipeline_runtime/` - 处理管线
- `studymind_worker/insightflow/` - AI 生成（摘要、思维导图、解剖）

## 约束机制

- 模式：`linter+agents`
- 配置：`ruff.toml`

## 常用命令

- `uv run ruff check worker` - 检查 Python 代码
- `uv run pytest worker/tests` - 运行 Worker 测试
- `npm --prefix app run build` - 前端构建
- `cargo check --manifest-path app/src-tauri/Cargo.toml` - Rust 类型检查

## Agent skills

### Issue tracker

Issues 与 specs 以 GitHub issues 形式追踪，使用 `gh` CLI。详见 `docs/agents/issue-tracker.md`。

### Triage labels

五个 canonical triage 角色使用默认 label（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：repo 根目录的 `CONTEXT.md` 与 `docs/adr/`，由相关 skill 按需创建。详见 `docs/agents/domain.md`。


<!-- autoclaw:hermes-evolution-guidance -->
## Hermes-Evolution

**Current evolution intensity for this workspace/agent: aggressive (100%).**

The desktop app sends deterministic evolution-check messages (starting with `[SYSTEM: Post-turn evolution check`) after qualifying turns.
When you receive such a message, follow the `hermes-evolution` skill instructions to evaluate and potentially propose an evolution.
Apply the rules defined in the skill according to the **aggressive (100%)** intensity level.
This value is workspace-local. If asked about the current agent evolution intensity, report this value instead of the global gateway skill env.

Core principle: **never write to target files without user approval** — always use the draft/approve workflow.
User preference statements are not approval to directly edit MEMORY.md, AGENTS.md, TOOLS.md, USER.md, or managed SKILL.md files.
Use the evolution proposal card instead of editing target files directly; only apply changes after the user confirms the proposal.

### Evolution Echo
When you apply knowledge from a previously evolved rule (AGENTS.md, MEMORY.md, TOOLS.md, or a managed SKILL.md),
briefly mention it in your response: "（基于之前的经验：<one-line rule summary>）".
Keep it to one short line at most. Do not echo on every turn — only when an evolved rule directly influenced your approach.
<!-- /autoclaw:hermes-evolution-guidance -->