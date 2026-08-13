import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dmgScript = join(scriptsDir, 'make-macos-dmg.sh');
const normalizerScript = join(scriptsDir, 'normalize-updater-manifest.mjs');
const bashAvailable = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

function readScript(name) {
  return readFileSync(join(scriptsDir, name), 'utf8');
}

function makeStubBin(root) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const stubs = {
    codesign: '#!/usr/bin/env bash\nexit 0\n',
    lipo: '#!/usr/bin/env bash\necho "Non-fat file: $2 is architecture: ${STUB_ARCH}"\n',
    ditto: '#!/usr/bin/env bash\ncp -R "$1" "$2"\n',
    ln: '#!/usr/bin/env bash\nexit 0\n',
    hdiutil: '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$STUB_HDIUTIL_LOG"\nlast=""\nfor arg in "$@"; do last="$arg"; done\n: > "$last"\n',
  };
  for (const [name, source] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
  }
  return bin;
}

function makeAppRoot({ cache = false, executableName = 'StudyMind' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'studymind-dmg-test-'));
  const app = join(root, 'app', 'src-tauri');
  const appBundle = join(app, 'target', 'x86_64-apple-darwin', 'release', 'bundle', 'macos', 'StudyMind.app');
  mkdirSync(join(appBundle, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(appBundle, 'Contents', 'Resources', 'resources'), { recursive: true });
  writeFileSync(join(appBundle, 'Contents', 'MacOS', executableName), 'stub executable');
  if (cache) {
    mkdirSync(join(appBundle, 'Contents', 'Resources', 'resources', '__pycache__'));
  }
  writeFileSync(join(app, 'tauri.conf.json'), JSON.stringify({ version: '9.8.7' }));
  return { root, appBundle };
}

function runDmg(root, args, { arch = 'x86_64', bin, log } = {}) {
  const env = {
    ...process.env,
    PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    STUDYMIND_REPO_ROOT: root,
    STUB_ARCH: arch,
  };
  if (log) env.STUB_HDIUTIL_LOG = log;
  return spawnSync('bash', [dmgScript, ...args], { encoding: 'utf8', env });
}

test('macOS DMG script is headless and checks the selected architecture', () => {
  const script = readScript('make-macos-dmg.sh');

  assert.match(script, /^#!\/usr\/bin\/env bash/m);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /lipo[\s\S]*-info/);
  assert.match(script, /Contents\/MacOS/);
  assert.match(script, /main_executable_dir=.*Contents\/MacOS/);
  assert.doesNotMatch(script, /main_executable=\"\$app_path\/Contents\/MacOS\/StudyMind\"/);
  assert.match(script, /x86_64-apple-darwin/);
  assert.match(script, /x86_64/);
  assert.match(script, /aarch64-apple-darwin/);
  assert.match(script, /arm64/);
  assert.match(script, /invalid volume name|volume name/i);
  assert.match(script, /staging\/StudyMind\.app|staging.*StudyMind\.app/s);
  assert.match(script, /hdiutil\s+create/);
  assert.doesNotMatch(script, /osascript|Finder/);
});

test('DMG behavior tests run with macOS command stubs', { skip: !bashAvailable }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'studymind-dmg-behavior-'));
  const bin = makeStubBin(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const missing = runDmg(root, ['x86_64-apple-darwin'], { bin });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /application bundle not found/);

  const wrongArchRoot = makeAppRoot();
  t.after(() => rmSync(wrongArchRoot.root, { recursive: true, force: true }));
  const wrongArch = runDmg(wrongArchRoot.root, ['x86_64-apple-darwin'], { arch: 'arm64', bin });
  assert.notEqual(wrongArch.status, 0);
  assert.match(wrongArch.stderr, /architecture|x86_64/);

  const cacheRoot = makeAppRoot({ cache: true });
  t.after(() => rmSync(cacheRoot.root, { recursive: true, force: true }));
  const cache = runDmg(cacheRoot.root, ['x86_64-apple-darwin'], { bin });
  assert.notEqual(cache.status, 0);
  assert.match(cache.stderr, /Python cache files/);

  const traversalRoot = makeAppRoot();
  t.after(() => rmSync(traversalRoot.root, { recursive: true, force: true }));
  const traversal = runDmg(traversalRoot.root, ['x86_64-apple-darwin', '..\\escape'], { bin });
  assert.notEqual(traversal.status, 0);
  assert.match(traversal.stderr, /volume name|invalid/i);

  const log = join(root, 'hdiutil.log');
  const valid = runDmg(traversalRoot.root, ['x86_64-apple-darwin', 'Lecture'], { bin, log });
  assert.equal(valid.status, 0, valid.stderr);
  const hdiutilArgs = readFileSync(log, 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(hdiutilArgs.slice(0, 2), ['-volname', 'Lecture']);
  assert.equal(hdiutilArgs[hdiutilArgs.indexOf('-srcfolder') + 1].includes('Lecture'), false);

  const packageNamedRoot = makeAppRoot({ executableName: 'studymind-app' });
  t.after(() => rmSync(packageNamedRoot.root, { recursive: true, force: true }));
  const packageNamed = runDmg(packageNamedRoot.root, ['x86_64-apple-darwin'], { bin });
  assert.equal(packageNamed.status, 0, packageNamed.stderr);
});

test('updater manifest normalizer handles valid BOM input and rejects invalid input', () => {
  const root = mkdtempSync(join(tmpdir(), 'studymind-manifest-test-'));
  try {
    const validPath = join(root, 'valid.json');
    writeFileSync(validPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"version":1}', 'utf8')]));
    const valid = spawnSync(process.execPath, [normalizerScript, validPath], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    const output = readFileSync(validPath);
    assert.notDeepEqual([...output.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.deepEqual(JSON.parse(output.toString('utf8')), { version: 1 });

    for (const [name, bytes] of [
      ['invalid-utf8.json', Buffer.from([0x7B, 0x22, 0x6B, 0x22, 0x3A, 0x22, 0xC3, 0x28, 0x22, 0x7D])],
      ['invalid-json.json', Buffer.from('{not json', 'utf8')],
    ]) {
      const path = join(root, name);
      writeFileSync(path, bytes);
      const result = spawnSync(process.execPath, [normalizerScript, path], { encoding: 'utf8' });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.notEqual(result.stderr, '');
    }

    for (const args of [[], [join(root, 'missing.json')]]) {
      const result = spawnSync(process.execPath, [normalizerScript, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.notEqual(result.stderr, '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
