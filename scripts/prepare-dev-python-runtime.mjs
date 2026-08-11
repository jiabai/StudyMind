#!/usr/bin/env node

/**
 * prepare-dev-python-runtime.mjs
 *
 * 为 StudyMind 桌面端开发环境准备嵌入式 Python 运行时。
 *
 * Rust 侧（app/src-tauri/src/runtime.rs）固定从 <resource_dir>/python/python.exe
 * 启动 worker 子进程（python -m studymind_worker）。开发模式下 resource_dir
 * 解析为 target/debug/resources（或其中的 resources 子目录），因此该目录下
 * 必须存在可用的嵌入式 Python（含 modelscope/funasr 等依赖），否则所有 worker
 * 操作（模型下载、转写）都会以 SpawnFailed 秒失败，前端只显示误导性的
 * "模型下载失败，请检查网络后重试"。
 *
 * 本脚本负责：
 *   1. 检测 app/src-tauri/resources/python 是否已有可用运行时
 *   2. 缺失时：优先从 FrameQ 安装目录拷贝（Windows，已验证可行）；
 *      否则从 python.org 下载 embeddable 包并安装依赖
 *   3. 同步到 target/debug/resources（如果 debug 构建已存在）
 *   4. 验证 import 关键依赖
 *
 * 用法：
 *   node scripts/prepare-dev-python-runtime.mjs            # 全流程
 *   node scripts/prepare-dev-python-runtime.mjs --no-deps  # 只准备解释器，不装依赖
 *   node scripts/prepare-dev-python-runtime.mjs --check    # 只检查现状
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const PYTHON_VERSION = "3.12.13"; // 与发布版运行时一致
const EMBEDDABLE_URL = (version) =>
  `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;

// Windows 依赖集合（与 app/src-tauri/resources/pyproject.toml 的 Windows 分支一致；
// qwen 为可选依赖，不在此安装）
const WINDOWS_DEPS = [
  "brotli>=1.2.0",
  "funasr>=1.2.7",
  "funasr-onnx==0.4.2",
  "modelscope>=1.37.1",
  "onnxruntime>=1.17.0",
  "torch>=2.10.0",
  "torchaudio>=2.10.0",
  "yt-dlp>=2026.6.9",
];

const FRAMEQ_PYTHON_CANDIDATES = [
  "D:\\Program Files\\FrameQ\\resources\\python",
];

const paths = {
  resourcesRoot: resolve(repoRoot, "app", "src-tauri", "resources"),
  pythonDir: resolve(repoRoot, "app", "src-tauri", "resources", "python"),
  targetDebugResources: resolve(repoRoot, "app", "src-tauri", "target", "debug", "resources"),
  tmpDir: resolve(repoRoot, ".openclaw", "tmp", "python-runtime-prep"),
};

function log(message) {
  console.log(`[studymind-dev] ${message}`);
}

function warn(message) {
  console.warn(`[studymind-dev][warn] ${message}`);
}

function pythonExe(pythonDir) {
  return process.platform === "win32"
    ? join(pythonDir, "python.exe")
    : join(pythonDir, "bin", "python3");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function isUsableRuntime(pythonDir) {
  const exe = pythonExe(pythonDir);
  if (!(await exists(exe))) return { usable: false, reason: `missing ${exe}` };
  try {
    const probe = spawnSync(exe, ["-c", "import sys, modelscope, funasr; print(sys.version.split()[0])"], {
      encoding: "utf-8",
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status !== 0) {
      return {
        usable: false,
        reason: `interpreter runs but dependencies missing: ${probe.stderr?.trim() || "unknown"}`,
      };
    }
    return { usable: true, reason: `Python ${probe.stdout.trim()} with modelscope/funasr` };
  } catch (error) {
    return { usable: false, reason: `probe failed: ${error.message}` };
  }
}

async function copyFromFrameQ(pythonDir) {
  for (const candidate of FRAMEQ_PYTHON_CANDIDATES) {
    if (process.platform !== "win32") break;
    if (!(await exists(join(candidate, "python.exe")))) continue;
    log(`Copying embedded Python from FrameQ: ${candidate}`);
    await cp(candidate, pythonDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

async function downloadEmbeddable(pythonDir) {
  if (process.platform !== "win32") {
    throw new Error(
      "Non-Windows platforms are not automated yet: please place a standalone Python " +
        "(python-build-standalone) at app/src-tauri/resources/python manually, " +
        "keeping CPython 3.11/3.12 for macOS x86_64 (torch 2.2.2 wheel constraint).",
    );
  }
  const url = EMBEDDABLE_URL(PYTHON_VERSION);
  const zipPath = join(paths.tmpDir, `python-${PYTHON_VERSION}-embed.zip`);
  await mkdir(paths.tmpDir, { recursive: true });

  log(`Downloading embeddable Python ${PYTHON_VERSION} from python.org`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));

  await mkdir(pythonDir, { recursive: true });
  log(`Extracting to ${pythonDir}`);
  const extractDir = join(paths.tmpDir, `python-${PYTHON_VERSION}-embed`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  spawnSync("tar", ["-xf", zipPath, "-C", extractDir], { stdio: "inherit" });
  await cp(extractDir, pythonDir, { recursive: true, force: true });

  // 启用 site-packages（embeddable 默认隔离 site）
  const pthFiles = (await readdir(pythonDir)).filter((name) => /^python\d+\._pth$/.test(name));
  for (const pth of pthFiles) {
    const pthPath = join(pythonDir, pth);
    const content = await readFile(pthPath, "utf-8");
    if (!content.includes("import site")) {
      await writeFile(pthPath, content.replace(/^#import site$/m, "import site"));
      log(`Enabled import site in ${pth}`);
    }
  }
  return true;
}

async function installDeps(pythonDir) {
  const exe = pythonExe(pythonDir);
  const getPip = join(paths.tmpDir, "get-pip.py");
  log("Installing pip (get-pip.py)");
  const download = await fetch("https://bootstrap.pypa.io/get-pip.py");
  if (!download.ok) throw new Error(`get-pip.py download failed: HTTP ${download.status}`);
  await writeFile(getPip, await download.text());
  run(exe, [getPip, "--no-warn-script-location"]);

  log("Installing worker dependencies (this downloads ~1GB of wheels, be patient)");
  run(exe, ["-m", "pip", "install", "--no-warn-script-location", ...WINDOWS_DEPS]);
}

function run(exe, args) {
  const result = spawnSync(exe, args, {
    stdio: "inherit",
    windowsHide: true,
    timeout: 30 * 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${exe} ${args.join(" ")}`);
  }
}

async function syncToDebugResources() {
  if (!(await exists(paths.targetDebugResources))) return false;
  if (!(await exists(join(paths.targetDebugResources, "worker")))) return false;
  const targetPython = join(paths.targetDebugResources, "python");
  if (!(await exists(targetPython))) {
    log(`Syncing runtime to debug resources: ${targetPython}`);
    await cp(paths.pythonDir, targetPython, { recursive: true, force: true });
  }
  return true;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has("--check");
  const skipDeps = args.has("--no-deps");

  const status = await isUsableRuntime(paths.pythonDir);
  log(`resources/python: ${status.usable ? "READY" : "MISSING"} (${status.reason})`);

  if (checkOnly) {
    process.exitCode = status.usable ? 0 : 1;
    return;
  }

  if (!status.usable) {
    const copied = await copyFromFrameQ(paths.pythonDir);
    if (!copied) await downloadEmbeddable(paths.pythonDir);
    if (!skipDeps) await installDeps(paths.pythonDir);
    const after = await isUsableRuntime(paths.pythonDir);
    if (!after.usable) throw new Error(`Runtime still not usable: ${after.reason}`);
    log(`resources/python: READY (${after.reason})`);
  }

  await syncToDebugResources();

  const finalExe = pythonExe(paths.pythonDir);
  const probe = spawnSync(
    finalExe,
    ["-c", "import modelscope, funasr, funasr_onnx, onnxruntime, torch; print('imports OK')"],
    { encoding: "utf-8", timeout: 60_000, windowsHide: true },
  );
  if (probe.status !== 0) {
    throw new Error(`Dependency import verification failed: ${probe.stderr?.trim()}`);
  }
  log(probe.stdout.trim());
  log("Done. Restart the desktop app (or rebuild with `npm --prefix app run tauri build --debug`)");
}

main().catch((error) => {
  console.error(`[studymind-dev][error] ${error.message}`);
  process.exitCode = 1;
});
