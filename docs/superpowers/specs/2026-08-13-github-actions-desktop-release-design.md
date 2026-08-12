# StudyMind GitHub Actions Desktop Release Design

## 目标

将 Windows 安装包、Tauri updater 元数据和 macOS DMG 统一迁移到 GitHub Actions 构建与发布，保持 `D:\Github\FrameQ` 的发布形态，并解决 GitHub 新 runner 上没有本地 `resources` 运行时的问题。

本次发布覆盖：

- Windows x64 NSIS 安装包和 updater 签名产物
- macOS Intel（x86_64）DMG
- macOS Apple Silicon（arm64）DMG
- GitHub Release 资产上传与已有版本的重复上传覆盖

不在本次范围内：Linux、Apple Developer ID 签名、公证、把 ASR 模型预装进安装包、改变应用运行时或 updater 协议。

## 已确认的现状与约束

- `app/src-tauri/tauri.conf.json` 已启用 `nsis`、`dmg` 和 updater artifacts，资源目录期望包含 `python`、`worker`、`bin`、`pyproject.toml` 和 `.env.template`。
- `worker/studymind_worker` 是要复制进安装包的 Worker 源码；不能使用 FrameQ 的 `frameq_worker` 包名。
- Rust 运行时在 Windows 启动 `resources/python/python.exe`，在 macOS 启动 `resources/python/bin/python3`，并将 `resources/bin` 加入 PATH。
- `app/src-tauri/resources/*` 的运行时内容被 `.gitignore` 忽略，因此 CI 必须从可复现的下载地址和仓库源码构建资源。
- macOS Intel 依赖 `torch==2.2.2`、`torchaudio==2.2.2`、`numpy<2`、`llvmlite==0.45.1`、`numba==0.62.1` 和 `cryptography<49`，Python standalone 必须使用 CPython 3.11 或 3.12；Apple Silicon 和 Windows 使用当前依赖约束。
- macOS runner 使用无 GUI 的构建环境，DMG 使用命令行 `hdiutil` 创建，避免 Tauri/Finder 自动打包在 runner 上卡住。

## 方案与取舍

### 方案 A：直接复制 FrameQ workflow（不采用）

改动最少，但会带入 FrameQ 的包名、Worker 模块、环境变量和资源路径，且 StudyMind 当前没有对应的跨平台构建脚本。结果是 Workflow 看起来完整，实际会在资源准备或 macOS smoke test 阶段失败。

### 方案 B：新增 StudyMind 专用资源构建脚本 + 统一发布 Workflow（采用）

保留 FrameQ 已验证的 job 结构和 DMG 制作方式，但将产品相关部分抽成 StudyMind 版本：

- `scripts/build-installer.mjs` 负责按目标平台准备完整资源；
- `scripts/make-macos-dmg.sh` 只负责把已验证的 `.app` 制成 DMG；
- `.github/workflows/desktop-release.yml` 负责触发、构建、校验和上传。

这个方案比复制一个简单 Tauri workflow 多一个资源构建层，但能在干净 runner 上复现本地运行时，且以后升级依赖时只需更新脚本和资源依赖声明。

### 方案 C：把本地 `resources` 运行时提交到仓库（不采用）

能减少 CI 下载逻辑，但运行时约 1 GiB，混入平台二进制和 Python 包后会显著放大仓库、失去可维护性，也无法同时安全覆盖三个目标平台。

## 发布流程

### 触发

Workflow 支持两种入口：

1. 推送 `v*` 标签：自动构建 Windows、macOS Intel 和 macOS arm64，并发布对应 Release。
2. `workflow_dispatch`：输入已有或待发布的标签，并可分别选择 Windows、Intel DMG、arm64 DMG；适合补发某个架构或给现有 `v0.1.0` 增加 macOS 资产。

Workflow 会先准备目标 Release，随后 Windows job 负责 updater 产物，两个 macOS job 在其后分别上传 DMG。每个上传都使用 `--clobber`，重复运行不会留下同名旧资产。

标签必须已存在于当前仓库；手工运行时如果标签不存在，准备 Release 步骤直接失败并给出标签提示，不隐式创建指向未知提交的标签。

### Windows job

`windows-latest` 上执行：

1. checkout、Node.js、Rust `x86_64-pc-windows-msvc`、uv；
2. `npm ci --prefix app`；
3. `node scripts/build-installer.mjs --target windows-x64 --skip-tauri-build`；
4. Tauri Action 构建 NSIS，并使用 `TAURI_SIGNING_PRIVATE_KEY` 生成 updater 签名；
5. 创建或更新 GitHub Release，上传 `.exe`、`.sig` 和 `latest.json`；
6. 对 updater manifest 做 UTF-8/格式校验，避免 Windows 默认编码污染 JSON。

### macOS jobs

Intel 使用 `macos-15-intel` 和 `x86_64-apple-darwin`，Apple Silicon 使用 `macos-15` 和 `aarch64-apple-darwin`。每个 job 执行：

1. checkout、Node.js、对应 Rust target、uv；
2. `npm ci --prefix app`；
3. `node scripts/build-installer.mjs --target <target> --skip-tauri-build`；
4. 仅构建 `.app`，不调用 Tauri 的 GUI DMG 打包；
5. 在签名后的 app bundle 内使用 bundled Python 导入 `funasr`、`funasr_onnx`、`modelscope`、`onnxruntime`、`yt_dlp` 和 `studymind_worker`，并执行 ffmpeg/ffprobe 版本探针；
6. 检查资源包不包含 `__pycache__` 或 `*.pyc`，执行 `codesign --verify --deep --strict`；
7. 使用 `scripts/make-macos-dmg.sh` 通过 `hdiutil` 创建 DMG，并用 `gh release upload` 上传。

StudyMind 当前的 `signingIdentity: "-"` 保持不变，因此本次只验证 app bundle 完整性，不声称具备 Apple 身份签名或公证能力。

## 资源构建脚本

新增的 `scripts/build-installer.mjs` 只接受三个目标：`windows-x64`、`macos-x64`、`macos-arm64`。脚本按目标完成以下工作：

- 清理并重建 `app/src-tauri/resources/python`、`worker`、`bin`，避免残留当前机器的文件；
- 下载并解压目标平台的 Python standalone；
- 复制 `worker/studymind_worker`、`app/src-tauri/resources/pyproject.toml` 和 `.env.template`；
- 使用目标解释器和 uv 安装 `pyproject.toml` 中的发布依赖；
- 下载目标平台的 ffmpeg/ffprobe，统一放入 `resources/bin`，并设置 macOS 可执行权限；
- 执行无写入 smoke test，禁止生成 Python 缓存；
- 在资源完成后才允许 Tauri build 继续。

下载地址通过 GitHub Actions secrets 注入，脚本在本地或 CI 缺少地址时立即失败。平台归属由显式 target 决定，不依赖 runner 的 `process.platform` 推断，避免交叉构建时准备错误资源。

建议使用以下 Secrets：

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

Windows 的 ffmpeg archive 若同时包含 `ffmpeg.exe` 和 `ffprobe.exe`，只配置一个 archive URL；macOS 继续支持分别下载两个二进制 archive。`GITHUB_TOKEN` 使用 Actions 自动提供的仓库写权限，不新增个人访问令牌。

## 错误处理与安全边界

- 必需的 URL、目标架构、Python 可执行文件、Worker 包和 ffmpeg/ffprobe 缺失时，脚本返回非零状态并说明具体路径。
- Python 依赖安装和 import smoke test 使用目标解释器，不使用 runner 的系统 Python，防止“构建成功但安装后不能启动”。
- macOS DMG 脚本拒绝打包不存在、架构不匹配、含 Python 缓存或未通过 codesign 验证的 `.app`。
- Release 上传只操作当前 Workflow 计算出的 `RELEASE_TAG`，所有资产路径都来自当前构建目录。
- 私钥只通过 Actions secret 传入，不写入仓库、构建脚本日志或资源目录。
- 不把 ASR 模型缓存打进安装包；首次使用仍由应用现有的模型下载流程处理。

## 测试与验收

本地和 CI 需要覆盖：

- Node 脚本单元测试：目标解析、目标到 Python/二进制路径映射、必需环境变量校验、清理/防缓存逻辑；
- DMG 脚本静态/参数测试：缺少 `.app`、错误架构、含缓存时必须失败；
- `npm --prefix app run build`；
- `cargo check --manifest-path app/src-tauri/Cargo.toml`；
- Worker 现有 ruff/pytest 检查；
- Windows CI：NSIS 安装包和 `latest.json` 均存在，签名文件与安装包匹配；
- macOS CI：三个关键依赖和 Worker 可导入、ffmpeg/ffprobe 可执行、app bundle 校验通过、DMG 文件生成并上传。

## 交付与迁移

实现完成后先在隔离分支验证 Workflow 配置和本地脚本，再合并回 `master`。首次可用 `workflow_dispatch` 指定 `v0.1.0`，只勾选 macOS 架构来补发 DMG；后续发布只需提交并推送新的 `v*` 标签。

如果没有配置签名私钥，Windows job 会在 updater 构建阶段明确失败；届时可以先补齐 `TAURI_SIGNING_PRIVATE_KEY` 和密码后重跑，不改变代码结构。
