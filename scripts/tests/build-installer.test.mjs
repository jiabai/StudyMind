import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  copyMediaBinariesFromArchive,
  copyStandalonePythonFromArchive,
  expandArchiveFile,
  findStandalonePythonRuntimeRoot,
  parseArgs,
  prepareArchiveInput,
  pruneBundledPythonRuntime,
  removePythonCaches,
  requiredMediaBinaries,
  resetDirectory,
  targetConfig,
} from '../build-installer.mjs';
import { findLeaks } from '../verify-macos-self-contained.mjs';

test('targetConfig returns the exact Windows x64 release contract', () => {
  assert.deepEqual(targetConfig('windows-x64'), {
    tauriTarget: 'x86_64-pc-windows-msvc',
    pythonExecutable: ['python.exe'],
    mediaBinaries: ['ffmpeg.exe', 'ffprobe.exe'],
    pythonEnv: 'STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64',
    ffmpegEnv: 'STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64',
    ffprobeEnv: null,
  });
  assert.deepEqual(requiredMediaBinaries('windows-x64'), [
    'ffmpeg.exe',
    'ffprobe.exe',
  ]);
});

test('targetConfig returns the exact macOS x64 release contract', () => {
  assert.deepEqual(targetConfig('macos-x64'), {
    tauriTarget: 'x86_64-apple-darwin',
    pythonExecutable: ['bin/python3'],
    mediaBinaries: ['ffmpeg', 'ffprobe'],
    pythonEnv: 'STUDYMIND_PYTHON_STANDALONE_URL_MACOS_X64',
    ffmpegEnv: 'STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_X64',
    ffprobeEnv: 'STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_X64',
  });
  assert.deepEqual(requiredMediaBinaries('macos-x64'), ['ffmpeg', 'ffprobe']);
});

test('targetConfig returns the exact macOS arm64 release contract', () => {
  assert.deepEqual(targetConfig('macos-arm64'), {
    tauriTarget: 'aarch64-apple-darwin',
    pythonExecutable: ['bin/python3'],
    mediaBinaries: ['ffmpeg', 'ffprobe'],
    pythonEnv: 'STUDYMIND_PYTHON_STANDALONE_URL_MACOS_ARM64',
    ffmpegEnv: 'STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_ARM64',
    ffprobeEnv: 'STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_ARM64',
  });
  assert.deepEqual(requiredMediaBinaries('macos-arm64'), ['ffmpeg', 'ffprobe']);
});

test('parseArgs reads target URLs and the skip-tauri-build flag', () => {
  const env = {
    STUDYMIND_PYTHON_STANDALONE_URL_MACOS_X64: 'https://example.test/python.tar.gz',
    STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_X64: 'https://example.test/ffmpeg.tar.gz',
    STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_X64: 'https://example.test/ffprobe.tar.gz',
  };

  assert.deepEqual(parseArgs(['--target', 'macos-x64', '--skip-tauri-build'], env), {
    target: 'macos-x64',
    pythonUrl: env.STUDYMIND_PYTHON_STANDALONE_URL_MACOS_X64,
    ffmpegUrl: env.STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_X64,
    ffprobeUrl: env.STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_X64,
    skipDownloads: false,
    skipTauriBuild: true,
  });
});

test('parseArgs reports the target-specific missing URL secret', () => {
  assert.throws(
    () => parseArgs(['--target', 'macos-arm64'], {}),
    (error) => error instanceof Error
      && error.message.includes('STUDYMIND_PYTHON_STANDALONE_URL_MACOS_ARM64'),
  );
});

test('parseArgs lets CLI URLs override target-specific environment values', () => {
  const env = {
    STUDYMIND_PYTHON_STANDALONE_URL_MACOS_ARM64: 'env-python',
    STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_ARM64: 'env-ffmpeg',
    STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_ARM64: 'env-ffprobe',
  };
  assert.deepEqual(parseArgs([
    '--target', 'macos-arm64',
    '--python-standalone-url', 'cli-python',
    '--ffmpeg-archive-url', 'cli-ffmpeg',
    '--ffprobe-archive-url', 'cli-ffprobe',
  ], env), {
    target: 'macos-arm64',
    pythonUrl: 'cli-python',
    ffmpegUrl: 'cli-ffmpeg',
    ffprobeUrl: 'cli-ffprobe',
    skipDownloads: false,
    skipTauriBuild: false,
  });
});

test('parseArgs lets Windows ffprobe fall back to the ffmpeg archive', () => {
  const env = {
    STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64: 'python',
    STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64: 'media',
  };
  assert.equal(
    parseArgs(['--target', 'windows-x64'], env).ffprobeUrl,
    env.STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64,
  );
});

test('parseArgs requires a separate macOS ffprobe archive', () => {
  const env = {
    STUDYMIND_PYTHON_STANDALONE_URL_MACOS_X64: 'python',
    STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_X64: 'ffmpeg',
  };
  assert.throws(
    () => parseArgs(['--target', 'macos-x64'], env),
    /STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_X64/,
  );
});

test('parseArgs treats blank required URLs as missing', () => {
  const env = {
    STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64: '   ',
    STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64: 'media',
  };
  assert.throws(
    () => parseArgs(['--target', 'windows-x64'], env),
    /STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64/,
  );
});

test('parseArgs strips a leading UTF-8 BOM from secret URLs', () => {
  const result = parseArgs(['--target', 'windows-x64'], {
    STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64: '\uFEFFhttps://example.test/python.tar.zst',
    STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64: '\uFEFFhttps://example.test/ffmpeg.zip',
  });

  assert.equal(result.pythonUrl, 'https://example.test/python.tar.zst');
  assert.equal(result.ffmpegUrl, 'https://example.test/ffmpeg.zip');
  assert.equal(result.ffprobeUrl, 'https://example.test/ffmpeg.zip');
});

test('parseArgs rejects unsupported targets', () => {
  assert.throws(
    () => parseArgs(['--target', 'linux-x64'], {}),
    /Unsupported target/,
  );
});

test('targetConfig rejects unsupported targets', () => {
  assert.throws(
    () => targetConfig('linux-x64'),
    (error) => error instanceof Error && error.message.includes('Unsupported target'),
  );
});

test('findStandalonePythonRuntimeRoot finds the standalone CPython root', async () => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'studymind-installer-test-'));
  const cpython = path.join(outer, 'cpython');
  const executable = path.join(cpython, 'bin', 'python3.12');
  const runtimeRoot = path.join(cpython, 'lib', 'python3.12');

  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(path.join(cpython, 'bin', 'python3'), '#!/usr/bin/env python3\n');
    await writeFile(executable, '#!/usr/bin/env python3\n');
    await mkdir(runtimeRoot, { recursive: true });

    assert.deepEqual(await findStandalonePythonRuntimeRoot(outer), {
      executable,
      runtimeRoot: cpython,
    });
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test('resetDirectory only resets generated installer directories', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'studymind-reset-test-'));
  const generated = path.join(projectRoot, 'app', 'src-tauri', 'resources', 'python');
  const source = path.join(projectRoot, 'worker');

  try {
    await mkdir(generated, { recursive: true });
    await writeFile(path.join(generated, 'stale.txt'), 'stale');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'keep.txt'), 'keep');

    await resetDirectory(generated, projectRoot);
    assert.deepEqual(await readdir(generated), []);
    await assert.rejects(() => resetDirectory(source, projectRoot), /Refusing to reset/);
    assert.equal(await readFile(path.join(source, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('prepareArchiveInput isolates local archives with the same basename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-archive-input-'));
  const firstSource = path.join(root, 'source-a');
  const secondSource = path.join(root, 'source-b');
  const staging = path.join(root, 'staging');

  try {
    await mkdir(firstSource);
    await mkdir(secondSource);
    const first = path.join(firstSource, 'runtime.tar');
    const second = path.join(secondSource, 'runtime.tar');
    await writeFile(first, 'python');
    await writeFile(second, 'media');

    const preparedPython = await prepareArchiveInput(first, staging, 'python-runtime');
    const preparedMedia = await prepareArchiveInput(second, staging, 'ffmpeg-runtime');

    assert.notEqual(preparedPython, preparedMedia);
    assert.equal(await readFile(preparedPython, 'utf8'), 'python');
    assert.equal(await readFile(preparedMedia, 'utf8'), 'media');
    assert.equal(path.basename(path.dirname(preparedPython)), 'python-runtime');
    assert.equal(path.basename(path.dirname(preparedMedia)), 'ffmpeg-runtime');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepareArchiveInput does not expose URL secrets when download fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-download-error-'));
  const secretUrl = 'https://example.test/runtime.tar.gz?token=super-secret-value';
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => ({ ok: false, status: 403, body: null });

    await assert.rejects(
      () => prepareArchiveInput(secretUrl, path.join(root, 'staging'), 'python-runtime'),
      (error) => error instanceof Error
        && !error.message.includes(secretUrl)
        && !error.message.includes('super-secret-value')
        && error.message.includes('python-runtime')
        && error.message.includes('HTTP 403'),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('expandArchiveFile stages an extensionless media binary under its requested name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-raw-media-'));
  const source = path.join(root, 'ffmpeg-darwin-arm64');
  const destination = path.join(root, 'expanded');

  try {
    await writeFile(source, 'mach-o-binary');
    await expandArchiveFile(source, destination, 'ffmpeg');
    assert.equal(await readFile(path.join(destination, 'ffmpeg'), 'utf8'), 'mach-o-binary');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expandArchiveFile includes the archive path when tar fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-expand-test-'));
  const archive = path.join(root, 'broken.tar');
  const destination = path.join(root, 'expanded');

  try {
    await writeFile(archive, 'not an archive');
    await assert.rejects(
      () => expandArchiveFile(archive, destination),
      (error) => error instanceof Error
        && error.message.includes(archive)
        && /exit code 1/i.test(error.message)
        && /error opening archive|unrecognized archive format/i.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copyStandalonePythonFromArchive creates the configured macOS python3 launcher', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-python-copy-'));
  const archiveRoot = path.join(root, 'expanded');
  const runtime = path.join(archiveRoot, 'python-install');
  const destination = path.join(root, 'resources', 'python');

  try {
    await mkdir(path.join(runtime, 'bin'), { recursive: true });
    await mkdir(path.join(runtime, 'lib', 'python3.12'), { recursive: true });
    await writeFile(path.join(runtime, 'bin', 'python3.12'), 'interpreter');

    const executable = await copyStandalonePythonFromArchive(
      archiveRoot,
      destination,
      'macos-arm64',
    );

    assert.equal(executable, path.join(destination, 'bin', 'python3'));
    assert.equal(await readFile(executable, 'utf8'), 'interpreter');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copyMediaBinariesFromArchive finds media tools by basename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-media-copy-'));
  const ffmpegArchive = path.join(root, 'ffmpeg-expanded');
  const ffprobeArchive = path.join(root, 'ffprobe-expanded');
  const destination = path.join(root, 'resources', 'bin');

  try {
    await mkdir(path.join(ffmpegArchive, 'nested'), { recursive: true });
    await mkdir(path.join(ffprobeArchive, 'another'), { recursive: true });
    await writeFile(path.join(ffmpegArchive, 'nested', 'ffmpeg'), 'ffmpeg');
    await writeFile(path.join(ffmpegArchive, 'nested', 'ffprobe'), 'wrong archive');
    await writeFile(path.join(ffprobeArchive, 'another', 'ffprobe'), 'ffprobe');

    await copyMediaBinariesFromArchive(
      [ffmpegArchive, ffprobeArchive],
      destination,
      'macos-arm64',
    );

    assert.equal(await readFile(path.join(destination, 'ffmpeg'), 'utf8'), 'ffmpeg');
    assert.equal(await readFile(path.join(destination, 'ffprobe'), 'utf8'), 'ffprobe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removePythonCaches removes cache directories and bytecode files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-cache-prune-'));
  const packageRoot = path.join(root, 'site-packages', 'example');
  const cacheRoot = path.join(packageRoot, '__pycache__');
  const sourceFile = path.join(packageRoot, 'module.py');
  const pycFile = path.join(packageRoot, 'module.pyc');
  const pyoFile = path.join(packageRoot, 'module.pyo');

  try {
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(sourceFile, 'VALUE = 1\n');
    await writeFile(path.join(cacheRoot, 'module.cpython-312.pyc'), 'cache');
    await writeFile(pycFile, 'cache');
    await writeFile(pyoFile, 'optimized');

    await removePythonCaches(root);

    await access(sourceFile);
    await assert.rejects(() => access(cacheRoot));
    await assert.rejects(() => access(pycFile));
    await assert.rejects(() => access(pyoFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneBundledPythonRuntime removes debug, header, and test artifacts only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studymind-runtime-prune-'));
  const packageRoot = path.join(root, 'lib', 'python3.12', 'site-packages', 'example');
  const testRoot = path.join(packageRoot, 'tests');

  try {
    await mkdir(testRoot, { recursive: true });
    await mkdir(path.join(root, 'include'), { recursive: true });
    await writeFile(path.join(root, 'include', 'Python.h'), 'header');
    await writeFile(path.join(root, 'python.pdb'), 'debug');
    await writeFile(path.join(testRoot, 'test_example.py'), 'test');
    await writeFile(path.join(packageRoot, 'runtime.py'), 'required');
    await writeFile(path.join(root, 'pyvenv.cfg'), 'home = .\n');

    await pruneBundledPythonRuntime(root);

    await assert.rejects(() => access(path.join(root, 'include')));
    await assert.rejects(() => access(path.join(root, 'python.pdb')));
    await assert.rejects(() => access(testRoot));
    assert.equal(await readFile(path.join(packageRoot, 'runtime.py'), 'utf8'), 'required');
    await access(path.join(root, 'pyvenv.cfg'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer source assembles only StudyMind desktop runtime resources', async () => {
  const source = await readFile(
    path.join(import.meta.dirname, '..', 'build-installer.mjs'),
    'utf8',
  );

  assert.match(source, /worker["']?,\s*["']studymind_worker/);
  assert.match(source, /resourcesRoot,\s*["']pyproject\.toml/);
  assert.match(source, /["']-m["'],\s*["']ensurepip["']/);
  assert.match(source, /["']pip["'],\s*["']compile["']/);
  assert.match(source, /["']--no-annotate["']/);
  assert.match(source, /["']--only-binary=llvmlite,cryptography["']/);
  assert.match(source, /brotli, funasr, funasr_onnx, modelscope, onnxruntime, yt_dlp, studymind_worker/);
  assert.match(source, /PYTHONDONTWRITEBYTECODE/);
  assert.match(source, /PYTHONPATH/);
  assert.match(source, /["']-version["']/);
  assert.match(source, /verify-macos-self-contained\.mjs/);
  assert.match(source, /["']tauri["'],\s*["']--["'],\s*["']build["'],\s*["']--target["']/);
  assert.match(source, /path\.join\(pythonRoot,\s*\.\.\.config\.pythonExecutable\)/);
  assert.match(source, /Missing configured Python launcher/);
  assert.doesNotMatch(source, /frameq/i);
  assert.doesNotMatch(source, /FRAMEQ_/);
  assert.doesNotMatch(source, /\.env\.example/);
  assert.doesNotMatch(source, /\bdeno\b/i);
});

test('macOS self-contained verifier is StudyMind-safe and rejects package-manager leaks', async () => {
  const source = await readFile(
    path.join(import.meta.dirname, '..', 'verify-macos-self-contained.mjs'),
    'utf8',
  );

  assert.match(source, /app["']?,\s*["']src-tauri["']?,\s*["']resources["']?,\s*["']python/);
  assert.match(source, /StudyMind/);
  assert.match(source, /uvx \(uv\) is required/);
  assert.match(source, /delocate-listdeps/);
  assert.match(source, /\/usr\/local\//);
  assert.match(source, /\/opt\/homebrew\//);
  assert.match(source, /\/opt\/local\//);
  assert.match(source, /process\.exitCode = 1/);
  assert.doesNotMatch(source, /frameq/i);
});

test('findLeaks detects all forbidden macOS package-manager prefixes', () => {
  assert.deepEqual(findLeaks([
    '/usr/local/opt/zstd/lib/libzstd.dylib',
    '/opt/homebrew/opt/openssl/lib/libssl.dylib',
    '/opt/local/lib/libffi.dylib',
  ].join('\n')), [
    '/usr/local/opt/zstd/lib/libzstd.dylib',
    '/opt/homebrew/opt/openssl/lib/libssl.dylib',
    '/opt/local/lib/libffi.dylib',
  ]);
  assert.deepEqual(findLeaks([
    '/usr/lib/libSystem.B.dylib',
    '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation',
    '@rpath/libpython3.12.dylib',
  ].join('\n')), []);
});
