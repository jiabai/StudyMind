import { createWriteStream } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

export const TARGETS = new Map([
  ['windows-x64', {
    tauriTarget: 'x86_64-pc-windows-msvc',
    pythonExecutable: ['python.exe'],
    mediaBinaries: ['ffmpeg.exe', 'ffprobe.exe'],
    pythonEnv: 'STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64',
    ffmpegEnv: 'STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64',
    ffprobeEnv: null,
  }],
  ['macos-x64', {
    tauriTarget: 'x86_64-apple-darwin',
    pythonExecutable: ['bin/python3'],
    mediaBinaries: ['ffmpeg', 'ffprobe'],
    pythonEnv: 'STUDYMIND_PYTHON_STANDALONE_URL_MACOS_X64',
    ffmpegEnv: 'STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_X64',
    ffprobeEnv: 'STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_X64',
  }],
  ['macos-arm64', {
    tauriTarget: 'aarch64-apple-darwin',
    pythonExecutable: ['bin/python3'],
    mediaBinaries: ['ffmpeg', 'ffprobe'],
    pythonEnv: 'STUDYMIND_PYTHON_STANDALONE_URL_MACOS_ARM64',
    ffmpegEnv: 'STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_ARM64',
    ffprobeEnv: 'STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_ARM64',
  }],
]);

export function targetConfig(target) {
  const config = TARGETS.get(target);
  if (!config) {
    throw new Error(`Unsupported target: ${target}`);
  }
  return config;
}

export function requiredMediaBinaries(target) {
  return [...targetConfig(target).mediaBinaries];
}

function normalizeSecretValue(value) {
  return typeof value === 'string' ? value.replace(/^\uFEFF/, '') : value;
}

export function parseArgs(argv, env = process.env) {
  const values = new Map();
  const valueOptions = new Set([
    '--target',
    '--python-standalone-url',
    '--ffmpeg-archive-url',
    '--ffprobe-archive-url',
  ]);
  let skipDownloads = false;
  let skipTauriBuild = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--skip-downloads') {
      skipDownloads = true;
    } else if (argument === '--skip-tauri-build') {
      skipTauriBuild = true;
    } else if (argument.startsWith('--')) {
      if (!valueOptions.has(argument)) {
        throw new Error(`Unknown option: ${argument}`);
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      values.set(argument, value);
      index += 1;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  const target = values.get('--target');
  const config = targetConfig(target);
  const pythonUrl = normalizeSecretValue(
    values.get('--python-standalone-url') ?? env[config.pythonEnv],
  );
  const ffmpegUrl = normalizeSecretValue(
    values.get('--ffmpeg-archive-url') ?? env[config.ffmpegEnv],
  );
  const ffprobeUrl = normalizeSecretValue(
    values.get('--ffprobe-archive-url')
    ?? (config.ffprobeEnv ? env[config.ffprobeEnv] : ffmpegUrl),
  );

  if (!skipDownloads) {
    for (const [value, variable] of [
      [pythonUrl, config.pythonEnv],
      [ffmpegUrl, config.ffmpegEnv],
      [ffprobeUrl, config.ffprobeEnv],
    ]) {
      if (variable && (typeof value !== 'string' || value.trim() === '')) {
        throw new Error(`Missing required URL: ${variable}`);
      }
    }
  }

  return {
    target,
    pythonUrl,
    ffmpegUrl,
    ffprobeUrl,
    skipDownloads,
    skipTauriBuild,
  };
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export async function resetDirectory(directory, projectRoot = PROJECT_ROOT) {
  const resourcesRoot = path.join(projectRoot, 'app', 'src-tauri', 'resources');
  const allowed = [
    path.join(resourcesRoot, 'python'),
    path.join(resourcesRoot, 'worker'),
    path.join(resourcesRoot, 'bin'),
    ...[...TARGETS.keys()].map((target) => (
      path.join(projectRoot, 'build', 'installer-runtime', target)
    )),
  ];
  if (!allowed.some((candidate) => samePath(candidate, directory))) {
    throw new Error(`Refusing to reset non-generated directory: ${directory}`);
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

function archiveBasename(input, fallbackName) {
  if (/^https?:\/\//i.test(input)) {
    return path.basename(new URL(input).pathname) || `${fallbackName}.archive`;
  }
  return path.basename(input);
}

export async function prepareArchiveInput(input, stagingRoot, fallbackName) {
  if (!input) throw new Error(`Missing archive input for ${fallbackName}`);
  if (path.basename(fallbackName) !== fallbackName) {
    throw new Error(`Invalid archive fallback name: ${fallbackName}`);
  }

  const isolatedRoot = path.join(stagingRoot, fallbackName);
  await rm(isolatedRoot, { recursive: true, force: true });
  await mkdir(isolatedRoot, { recursive: true });
  const destination = path.join(isolatedRoot, archiveBasename(input, fallbackName));

  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input);
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download ${fallbackName}: HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  } else {
    await copyFile(path.resolve(input), destination);
  }
  return destination;
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    let stderr = '';
    const maxCapturedStderr = 64 * 1024;
    if (child.stdout) child.stdout.on('data', () => {});
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxCapturedStderr) {
          stderr += chunk.toString().slice(0, maxCapturedStderr - stderr.length);
        }
      });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const stderrDetail = stderr.trim();
        reject(new Error(
          `${command} ${args.join(' ')} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`
          + (stderrDetail ? `. stderr: ${stderrDetail}` : ''),
        ));
      }
    });
  });
}

export async function expandArchiveFile(archiveFile, destination) {
  await mkdir(destination, { recursive: true });
  try {
    await runCommand('tar', ['-xf', archiveFile, '-C', destination], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to expand archive ${archiveFile}: ${error.message}`, { cause: error });
  }
}

async function walkDirectories(root) {
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        directories.push(path.join(directory, entry.name));
      }
    }
  }
  return directories;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function findStandalonePythonRuntimeRoot(archiveRoot) {
  for (const runtimeRoot of await walkDirectories(archiveRoot)) {
    const hasLandmark = await Promise.any([
      stat(path.join(runtimeRoot, 'Lib')),
      stat(path.join(runtimeRoot, 'lib')),
      stat(path.join(runtimeRoot, 'pyvenv.cfg')),
    ].map((candidate) => candidate.then(() => true))).catch(() => false);
    if (!hasLandmark) continue;

    const windowsExecutable = path.join(runtimeRoot, 'python.exe');
    if (await isFile(windowsExecutable)) {
      return { executable: windowsExecutable, runtimeRoot };
    }

    const binDirectory = path.join(runtimeRoot, 'bin');
    try {
      const entries = await readdir(binDirectory, { withFileTypes: true });
      const versioned = entries
        .filter((entry) => entry.isFile() && /^python3\.\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .at(-1);
      const executable = versioned
        ? path.join(binDirectory, versioned)
        : path.join(binDirectory, 'python3');
      if (await isFile(executable)) {
        return { executable, runtimeRoot };
      }
    } catch {
      // Not a Unix standalone runtime root.
    }
  }
  throw new Error(`Could not find a standalone Python runtime in ${archiveRoot}`);
}

export async function copyStandalonePythonFromArchive(archiveRoot, destination, target) {
  const config = targetConfig(target);
  const { executable, runtimeRoot } = await findStandalonePythonRuntimeRoot(archiveRoot);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(runtimeRoot, destination, { recursive: true, force: true });
  const copiedExecutable = path.join(destination, path.relative(runtimeRoot, executable));
  const configuredExecutable = path.join(destination, ...config.pythonExecutable);
  if (!samePath(copiedExecutable, configuredExecutable)) {
    await rm(configuredExecutable, { force: true });
    await mkdir(path.dirname(configuredExecutable), { recursive: true });
    await copyFile(copiedExecutable, configuredExecutable);
    if (target.startsWith('macos-')) await chmod(configuredExecutable, 0o755);
  }
  return configuredExecutable;
}

async function findFileByBasename(root, basename) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.name === basename && await isFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export async function copyMediaBinariesFromArchive(archiveRoots, destination, target) {
  const config = targetConfig(target);
  await mkdir(destination, { recursive: true });
  for (const [index, binary] of config.mediaBinaries.entries()) {
    let source = null;
    const candidateRoots = archiveRoots.length === config.mediaBinaries.length
      ? [archiveRoots[index]]
      : archiveRoots;
    for (const archiveRoot of candidateRoots) {
      source = await findFileByBasename(archiveRoot, binary);
      if (source) break;
    }
    if (!source) {
      throw new Error(`Could not find ${binary} in media archives`);
    }
    const output = path.join(destination, binary);
    await copyFile(source, output);
    if (target.startsWith('macos-')) await chmod(output, 0o755);
  }
}

export async function removePythonCaches(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') {
          await rm(candidate, { recursive: true, force: true });
        } else {
          await visit(candidate);
        }
      } else if (/\.(?:pyc|pyo)$/i.test(entry.name)) {
        await rm(candidate, { force: true });
      }
    }
  }
  await visit(root);
}

export async function pruneBundledPythonRuntime(root) {
  const removableDirectories = new Set([
    '__pycache__',
    'include',
    'Include',
    'test',
    'tests',
  ]);
  const removableExtensions = new Set([
    '.debug',
    '.h',
    '.hpp',
    '.lib',
    '.pdb',
    '.pyc',
    '.pyo',
  ]);

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (removableDirectories.has(entry.name) || entry.name.endsWith('.dSYM')) {
          await rm(candidate, { recursive: true, force: true });
        } else {
          await visit(candidate);
        }
      } else if (
        removableExtensions.has(path.extname(entry.name))
        || /_d\.(?:dll|pyd)$/i.test(entry.name)
        || /^python_d\.exe$/i.test(entry.name)
      ) {
        await rm(candidate, { force: true });
      }
    }
  }

  await visit(root);
}

function commandName(name) {
  return process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name;
}

async function copyWorkerRuntime(workerRoot) {
  await cp(
    path.join(PROJECT_ROOT, 'worker', 'studymind_worker'),
    path.join(workerRoot, 'studymind_worker'),
    { recursive: true, force: true },
  );
}

async function prepareExpandedArchive(input, buildRoot, name) {
  const archive = await prepareArchiveInput(
    input,
    path.join(buildRoot, 'archives'),
    name,
  );
  const expanded = path.join(buildRoot, 'expanded', name);
  await mkdir(expanded, { recursive: true });
  await expandArchiveFile(archive, expanded);
  return expanded;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  const config = targetConfig(options.target);
  const resourcesRoot = path.join(PROJECT_ROOT, 'app', 'src-tauri', 'resources');
  const pythonRoot = path.join(resourcesRoot, 'python');
  const workerRoot = path.join(resourcesRoot, 'worker');
  const binRoot = path.join(resourcesRoot, 'bin');
  const buildRoot = path.join(PROJECT_ROOT, 'build', 'installer-runtime', options.target);

  await resetDirectory(buildRoot);
  await resetDirectory(workerRoot);

  const configuredPythonExecutable = path.join(pythonRoot, ...config.pythonExecutable);
  if (options.skipDownloads) {
    await findStandalonePythonRuntimeRoot(pythonRoot);
    for (const binary of config.mediaBinaries) {
      if (!await isFile(path.join(binRoot, binary))) {
        throw new Error(`Missing bundled media binary: ${path.join(binRoot, binary)}`);
      }
    }
  } else {
    await resetDirectory(pythonRoot);
    await resetDirectory(binRoot);

    const pythonArchiveRoot = await prepareExpandedArchive(
      options.pythonUrl,
      buildRoot,
      'python-standalone',
    );
    await copyStandalonePythonFromArchive(
      pythonArchiveRoot,
      pythonRoot,
      options.target,
    );

    const ffmpegArchiveRoot = await prepareExpandedArchive(
      options.ffmpegUrl,
      buildRoot,
      'ffmpeg',
    );
    const ffprobeArchiveRoot = options.ffprobeUrl === options.ffmpegUrl
      ? ffmpegArchiveRoot
      : await prepareExpandedArchive(options.ffprobeUrl, buildRoot, 'ffprobe');
    await copyMediaBinariesFromArchive(
      [ffmpegArchiveRoot, ffprobeArchiveRoot],
      binRoot,
      options.target,
    );
  }

  if (!await isFile(configuredPythonExecutable)) {
    throw new Error(`Missing configured Python launcher: ${configuredPythonExecutable}`);
  }
  const pythonExecutable = configuredPythonExecutable;

  await copyWorkerRuntime(workerRoot);
  await removePythonCaches(workerRoot);

  const pyproject = path.join(resourcesRoot, 'pyproject.toml');
  const requirements = path.join(buildRoot, 'requirements.txt');
  const commandOptions = { cwd: PROJECT_ROOT };
  await runCommand(pythonExecutable, ['-m', 'ensurepip', '--upgrade'], commandOptions);
  await runCommand(
    pythonExecutable,
    ['-m', 'pip', 'install', '--upgrade', 'pip'],
    commandOptions,
  );
  await runCommand(commandName('uv'), [
    'pip',
    'compile',
    pyproject,
    '--python',
    pythonExecutable,
    '--output-file',
    requirements,
    '--no-annotate',
  ], commandOptions);
  await runCommand(commandName('uv'), [
    'pip',
    'install',
    '--python',
    pythonExecutable,
    '--only-binary=llvmlite,cryptography',
    '-r',
    requirements,
  ], commandOptions);

  await pruneBundledPythonRuntime(pythonRoot);
  await runCommand(pythonExecutable, [
    '-c',
    'import brotli, funasr, funasr_onnx, modelscope, onnxruntime, yt_dlp, studymind_worker',
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: workerRoot,
    },
  });
  for (const binary of config.mediaBinaries) {
    await runCommand(path.join(binRoot, binary), ['-version'], commandOptions);
  }
  await removePythonCaches(pythonRoot);
  await removePythonCaches(workerRoot);

  if (options.target.startsWith('macos-')) {
    await runCommand(process.execPath, [
      path.join(SCRIPT_DIR, 'verify-macos-self-contained.mjs'),
      pythonRoot,
    ], commandOptions);
  }

  if (!options.skipTauriBuild) {
    await runCommand(commandName('npm'), [
      '--prefix',
      'app',
      'run',
      'tauri',
      '--',
      'build',
      '--target',
      config.tauriTarget,
    ], commandOptions);
  }

  console.log(`StudyMind installer resources prepared at ${resourcesRoot}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
