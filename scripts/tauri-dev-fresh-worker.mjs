#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "..");

export function resolveFreshWorkerPaths(repoRoot = defaultRepoRoot) {
  const root = resolve(repoRoot);
  const resourcesRoot = resolve(root, "app", "src-tauri", "resources");
  const resourceWorker = resolve(resourcesRoot, "worker");

  return {
    repoRoot: root,
    sourceWorker: resolve(root, "worker", "studymind_worker"),
    resourcesRoot,
    resourceWorker,
    resourceWorkerPackage: resolve(resourceWorker, "studymind_worker"),
  };
}

function isWithin(parent, child) {
  const childRelativePath = relative(parent, child);
  return childRelativePath !== "" && !childRelativePath.startsWith("..") && !isAbsolute(childRelativePath);
}

function assertSafeWorkerTarget(paths) {
  if (basename(paths.resourceWorker) !== "worker" || !isWithin(paths.resourcesRoot, paths.resourceWorker)) {
    throw new Error(`Refusing to remove unsafe worker resource path: ${paths.resourceWorker}`);
  }
}

async function assertDirectory(path, label) {
  try {
    const details = await stat(path);
    if (!details.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
}

function shouldCopyWorkerFile(sourcePath) {
  const name = basename(sourcePath);
  return name !== "__pycache__" && !name.endsWith(".pyc") && !name.endsWith(".pyo");
}

export async function prepareFreshWorkerResource(repoRoot = defaultRepoRoot) {
  const paths = resolveFreshWorkerPaths(repoRoot);
  assertSafeWorkerTarget(paths);
  await assertDirectory(paths.sourceWorker, "Source worker package");

  console.log(`[studymind-dev] Removing stale worker resource mirror: ${paths.resourceWorker}`);
  await rm(paths.resourceWorker, { recursive: true, force: true });
  await mkdir(paths.resourceWorker, { recursive: true });
  await writeFile(join(paths.resourceWorker, ".gitkeep"), "\n");

  console.log(`[studymind-dev] Copying fresh worker source: ${paths.sourceWorker}`);
  await cp(paths.sourceWorker, paths.resourceWorkerPackage, {
    recursive: true,
    force: true,
    filter: shouldCopyWorkerFile,
  });

  return paths;
}

export function buildTauriDevSpawnSpec(
  repoRoot = defaultRepoRoot,
  platform = process.platform,
  env = process.env,
) {
  if (platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm --prefix app run tauri dev"],
      cwd: resolve(repoRoot),
    };
  }

  return {
    command: "npm",
    args: ["--prefix", "app", "run", "tauri", "dev"],
    cwd: resolve(repoRoot),
  };
}

export function runTauriDev(repoRoot = defaultRepoRoot) {
  return new Promise((resolveExitCode, reject) => {
    const spec = buildTauriDevSpawnSpec(repoRoot);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        resolveExitCode(code);
        return;
      }

      if (signal) {
        console.error(`[studymind-dev] npm exited from signal ${signal}`);
      }
      resolveExitCode(1);
    });
  });
}

function isDirectCli() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function main() {
  await prepareFreshWorkerResource(defaultRepoRoot);
  const exitCode = await runTauriDev(defaultRepoRoot);
  process.exitCode = exitCode;
}

if (isDirectCli()) {
  main().catch((error) => {
    console.error(`[studymind-dev] ${error.message}`);
    process.exitCode = 1;
  });
}
