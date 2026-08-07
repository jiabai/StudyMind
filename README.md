# StudyMind

课堂学习辅助桌面应用。基于 FrameQ 的核心技术栈（Tauri + React + Python Worker），专注于本地音视频转写和 AI 学习辅助功能。

## 功能

- **本地音视频导入** - 支持 mp4/mov/mkv/webm/mp3/wav/m4a 等格式
- **高精度转写** - SenseVoice ONNX 本地推理，流式 VAD 分块
- **文字稿校验** - 逐段回放对齐、原子保存、版本恢复
- **AI 知识点摘要** - 自动生成课堂要点总结
- **思维导图大纲** - 输出 Mermaid 格式的知识点结构图
- **文字稿解剖** - 对已保存文字稿做结构化拆解

## 开发

```bash
# Python Worker
uv sync
uv run ruff check worker
uv run pytest worker/tests

# 前端 + Tauri
npm --prefix app install
npm --prefix app run dev        # 前端开发模式
npm --prefix app run tauri:dev  # Tauri 桌面开发模式

# 构建
npm --prefix app run build
cargo build --manifest-path app/src-tauri/Cargo.toml

# 服务器
npm --prefix server install
npm --prefix server run dev
```

## 技术栈

- **桌面框架**: Tauri 2.x
- **前端**: React 19 + TypeScript + Vite
- **后端**: Rust (Tauri)
- **Worker**: Python 3.11+
- **ASR**: SenseVoice ONNX
- **AI**: LLM API（本地/云端）

## 与 FrameQ 的关系

StudyMind 从 FrameQ v0.3.1 派生而来，复用其核心架构和处理管线。FrameQ 保持独立演进，专注于视频转译场景。
