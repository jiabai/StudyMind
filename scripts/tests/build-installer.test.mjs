import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findStandalonePythonRuntimeRoot,
  parseArgs,
  requiredMediaBinaries,
  targetConfig,
} from '../build-installer.mjs';

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
