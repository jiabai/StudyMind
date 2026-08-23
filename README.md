# StudyMind

课堂学习辅助桌面应用（Tauri + React + Python Worker），专注于本地音视频转写和 AI 学习辅助功能。

## 功能

- **本地音视频导入** - 支持 mp4/mov/mkv/webm/mp3/wav/m4a 等格式
- **高精度转写** - SenseVoice ONNX 本地推理，流式 VAD 分块
- **文字稿校验** - 逐段回放对齐、原子保存、版本恢复
- **AI 知识点摘要** - 自动生成课堂要点总结
- **思维导图大纲** - 输出 Mermaid 格式的知识点结构图
- **文字稿解剖** - 对已保存文字稿做结构化拆解

## 下载与发布

公开版本和 Windows 安装包发布在 [GitHub Releases](https://github.com/jiabai/StudyMind/releases)。构建流程见 [Desktop release workflow](.github/workflows/desktop-release.yml)。

## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

StudyMind is distributed under the MIT License. SignPath-signed releases are built from the public source repository and require manual approval before signing.

### Project roles

This is currently a single-maintainer project:

- Committer and reviewer: [Aaron Bi](https://github.com/jiabai)
- Approver: [Aaron Bi](https://github.com/jiabai)

### Privacy

StudyMind is designed as a local-first desktop application. Local media and generated transcripts are processed by the application on the user’s device. AI-assisted synthesis may use the local or cloud LLM endpoint selected by the user. See the [StudyMind privacy policy](https://studymind.8xf.pro/privacy) for the current details.

For the complete signing-policy record, see [docs/code-signing-policy.md](docs/code-signing-policy.md).

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

## 桌面发布

发布 Workflow 位于 `.github/workflows/desktop-release.yml`。推送版本标签会自动构建并上传以下产物：

- Windows x64 NSIS/updater
- macOS Intel x64 DMG
- Apple Silicon arm64 DMG

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

也可以在 GitHub Actions 中使用 `workflow_dispatch`：填写已有的 `vX.Y.Z` tag，并勾选 Windows、macOS Intel x64 和 macOS Apple Silicon arm64 架构；例如可为已有的 `v0.1.0` 补发 DMG。

### 必需的 Secrets

仅需配置以下十个 Secret 名称：

- `STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64`
- `STUDYMIND_PYTHON_STANDALONE_URL_MACOS_X64`
- `STUDYMIND_PYTHON_STANDALONE_URL_MACOS_ARM64`
- `STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64`
- `STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_X64`
- `STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_ARM64`
- `STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_X64`
- `STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_ARM64`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Python standalone archive 必须提供可运行的 Python。Windows ffmpeg archive 必须同时包含 `ffmpeg.exe` 和 `ffprobe.exe`；macOS 的 ffmpeg 与 ffprobe archive 可以分开提供。

macOS Intel 使用 CPython 3.11/3.12，因为 `torch==2.2.2` 的兼容性要求。当前 macOS 构建为 ad-hoc signed / not notarized。
