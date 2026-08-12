#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_PYTHON_ROOT = path.join(
  PROJECT_ROOT,
  'app',
  'src-tauri',
  'resources',
  'python',
);
const FORBIDDEN_PREFIXES = ['/usr/local/', '/opt/homebrew/', '/opt/local/'];

async function findSitePackagesDirectories(pythonRoot) {
  const directories = [];
  const windowsSitePackages = path.join(pythonRoot, 'Lib', 'site-packages');
  if (existsSync(windowsSitePackages)) directories.push(windowsSitePackages);

  const unixLib = path.join(pythonRoot, 'lib');
  if (existsSync(unixLib)) {
    for (const entry of await readdir(unixLib, { withFileTypes: true })) {
      if (entry.isDirectory() && /^python3\.\d+$/.test(entry.name)) {
        const sitePackages = path.join(unixLib, entry.name, 'site-packages');
        if (existsSync(sitePackages)) directories.push(sitePackages);
      }
    }
  }
  return directories;
}

function listDependencies(directory) {
  const result = spawnSync(
    'uvx',
    ['--from', 'delocate', 'delocate-listdeps', '--all', directory],
    { encoding: 'utf8' },
  );
  if (result.error?.code === 'ENOENT') {
    throw new Error('uvx (uv) is required to verify the StudyMind macOS runtime.');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `delocate-listdeps failed for ${directory} (exit ${result.status}).\n${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

export function findLeaks(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => FORBIDDEN_PREFIXES.some((prefix) => line.includes(prefix)));
}

export async function main(argv = process.argv.slice(2)) {
  const pythonRoot = argv[0] ? path.resolve(argv[0]) : DEFAULT_PYTHON_ROOT;
  const sitePackagesDirectories = await findSitePackagesDirectories(pythonRoot);
  if (sitePackagesDirectories.length === 0) {
    throw new Error(`No site-packages directory found under ${pythonRoot}`);
  }

  const leaks = new Set(
    sitePackagesDirectories.flatMap((directory) => findLeaks(listDependencies(directory))),
  );
  if (leaks.size > 0) {
    console.error('StudyMind macOS runtime contains non-bundled library dependencies:');
    for (const leak of [...leaks].sort()) console.error(`  ${leak}`);
    process.exitCode = 1;
    return;
  }
  console.log(`StudyMind macOS runtime is self-contained: ${sitePackagesDirectories.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
