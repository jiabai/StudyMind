import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'desktop-release.yml');
const readmePath = path.join(repositoryRoot, 'README.md');
const workflowExists = fs.existsSync(workflowPath);
const normalizeNewlines = (source) => source.replace(/\r\n?/g, '\n');
const workflow = workflowExists ? normalizeNewlines(fs.readFileSync(workflowPath, 'utf8')) : '';
const readme = normalizeNewlines(fs.readFileSync(readmePath, 'utf8'));
const sectionHeadingOffset = readme.indexOf('\n## 桌面发布');
const sectionStart = readme.startsWith('## 桌面发布')
  ? 0
  : sectionHeadingOffset === -1
    ? -1
    : sectionHeadingOffset + 1;
const nextSection = readme.indexOf('\n## ', sectionStart + 1);
const releaseSection = sectionStart >= 0
  ? readme.slice(sectionStart, nextSection === -1 ? readme.length : nextSection)
  : '';
const plannedSecrets = new Set([
  'STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64',
  'STUDYMIND_PYTHON_STANDALONE_URL_MACOS_X64',
  'STUDYMIND_PYTHON_STANDALONE_URL_MACOS_ARM64',
  'STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64',
  'STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_X64',
  'STUDYMIND_FFMPEG_ARCHIVE_URL_MACOS_ARM64',
  'STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_X64',
  'STUDYMIND_FFPROBE_ARCHIVE_URL_MACOS_ARM64',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
]);

function job(name, source = workflow) {
  const normalized = normalizeNewlines(source);
  const match = normalized.match(
    new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:|(?![\\s\\S]))`, 'm'),
  );
  assert.ok(match, `workflow must define the ${name} job`);
  return match[0];
}

function input(name, source = workflow) {
  const normalized = normalizeNewlines(source);
  const match = normalized.match(
    new RegExp(`^      ${name}:\\n[\\s\\S]*?(?=^      [A-Za-z0-9_-]+:|^permissions:|(?![\\s\\S]))`, 'm'),
  );
  assert.ok(match, `workflow_dispatch must define the ${name} input`);
  return match[0];
}

function step(jobText, name) {
  const match = jobText.match(
    new RegExp(`^      - name: ${name}\\n[\\s\\S]*?(?=^      - name: |(?![\\s\\S]))`, 'm'),
  );
  assert.ok(match, `job must define the ${name} step`);
  return match[0];
}

function assertBuildSetup(jobText, runner, target) {
  const stepsIndex = jobText.indexOf('    steps:\n');
  assert.notEqual(stepsIndex, -1, 'build job must define steps');
  assert.doesNotMatch(jobText.slice(0, stepsIndex), /secrets\./);
  assert.match(jobText, new RegExp(`runs-on: ${runner.replaceAll('-', '\\-')}`));
  assert.match(jobText, /uses: actions\/checkout@v5/);
  assert.match(
    jobText,
    /uses: actions\/checkout@v5\n\s+with:\n\s+ref: \$\{\{ needs\.prepare-release\.outputs\.release_tag \}\}/,
  );
  assert.match(jobText, /uses: actions\/setup-node@v5/);
  assert.match(jobText, /node-version: lts\/\*/);
  assert.match(jobText, /cache: npm/);
  assert.match(jobText, /cache-dependency-path: app\/package-lock\.json/);
  assert.match(jobText, /uses: astral-sh\/setup-uv@[0-9a-f]{40}\b/);
  assert.doesNotMatch(jobText, /uses: astral-sh\/setup-uv@v\d+/);
  assert.match(jobText, /uses: dtolnay\/rust-toolchain@stable/);
  assert.match(jobText, new RegExp(`targets: ${target}`));
  assert.match(jobText, /run: npm ci --prefix app/);
  assert.match(jobText, /RELEASE_TAG: \$\{\{ needs\.prepare-release\.outputs\.release_tag \}\}/);
}

test('desktop release workflow exists', () => {
  assert.ok(workflowExists, '.github/workflows/desktop-release.yml must exist');
});

test('block helpers handle CRLF and do not depend on declaration order', () => {
  const probe = [
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      second_input:',
    '        type: boolean',
    '      first_input:',
    '        type: string',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  second-job:',
    '    runs-on: ubuntu-latest',
    '  first-job:',
    '    runs-on: windows-latest',
  ].join('\r\n');

  assert.match(input('first_input', probe), /type: string/);
  assert.match(job('first-job', probe), /runs-on: windows-latest/);
});

test('supports version-tag pushes and typed manual release inputs', () => {
  if (!workflowExists) return;

  assert.match(workflow, /^on:\n  push:\n    tags:\n      - 'v\*'/m);
  assert.match(workflow, /^  workflow_dispatch:\n    inputs:/m);

  const tag = input('tag');
  assert.match(tag, /required: true/);
  assert.match(tag, /type: string/);

  for (const name of [
    'release_draft',
    'build_windows_updater',
    'build_macos_x64',
    'build_macos_arm64',
  ]) {
    const block = input(name);
    assert.match(block, /type: boolean/);
    assert.match(block, /default: true/);
  }

  assert.match(workflow, /^permissions:\n  contents: write/m);
  assert.match(workflow, /^concurrency:\n  group: desktop-release-\$\{\{ .*inputs\.tag.*github\.ref_name.* \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/m);
});

test('prepares an existing tag and preserves an existing release state', () => {
  if (!workflowExists) return;

  const prepare = job('prepare-release');
  assert.match(prepare, /runs-on: ubuntu-latest/);
  assert.match(prepare, /release_tag: \$\{\{ steps\.release\.outputs\.release_tag \}\}/);
  assert.match(prepare, /release_draft: \$\{\{ steps\.release\.outputs\.release_draft \}\}/);
  assert.match(prepare, /release_id: \$\{\{ steps\.release\.outputs\.release_id \}\}/);
  assert.match(prepare, /^\s+RELEASE_TAG="\$(?:PUSH_TAG|INPUT_TAG)"$/m);
  assert.match(prepare, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(prepare, /\[\[ "\$EVENT_NAME" == "push" \]\]/);
  assert.match(prepare, /github\.ref_name/);
  assert.match(prepare, /inputs\.tag/);
  assert.match(prepare, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(prepare, /gh api .*git\/ref\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(prepare, /gh api --paginate .*releases\?per_page=100/);
  assert.match(prepare, /matching_releases/);
  assert.match(prepare, /Multiple releases already use tag/);
  assert.doesNotMatch(prepare, /releases\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(prepare, /release_draft="\$existing_release_draft"/);
  assert.match(prepare, /gh api --method POST .*releases/);
  assert.doesNotMatch(prepare, /target_commitish/);
  assert.match(prepare, /release_id=.*\.id/);
  assert.match(prepare, /release_draft="\$REQUESTED_RELEASE_DRAFT"/);
  assert.match(prepare, /echo "release_draft=\$release_draft" >> "\$GITHUB_OUTPUT"/);
  assert.match(prepare, /echo "release_id=\$release_id" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(prepare, /gh release view/);
  assert.doesNotMatch(prepare, /gh release edit/);
});

test('pins release tags to the checked-out desktop application version', () => {
  if (!workflowExists) return;

  const prepare = job('prepare-release');
  assert.match(prepare, /uses: actions\/checkout@v5/);
  assert.match(
    prepare,
    /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref \}\}/,
  );
  assert.match(prepare, /APP_VERSION=.*app\/package\.json/);
  assert.match(prepare, /TAURI_VERSION=.*app\/src-tauri\/tauri\.conf\.json/);
  assert.match(prepare, /CARGO_VERSION=.*app\/src-tauri\/Cargo\.toml/);
  assert.match(prepare, /Desktop versions must match/);
  assert.match(prepare, /Release tag must match desktop version/);

  for (const name of ['windows-updater-artifacts', 'macos-x64', 'macos-arm64']) {
    const buildJob = job(name);
    assert.match(
      buildJob,
      /ref: \$\{\{ needs\.prepare-release\.outputs\.release_tag \}\}/,
    );
  }

  const windows = job('windows-updater-artifacts');
  assert.match(
    windows,
    /releaseCommitish: \$\{\{ needs\.prepare-release\.outputs\.release_tag \}\}/,
  );
});

test('builds and publishes signed Windows updater artifacts', () => {
  if (!workflowExists) return;

  const windows = job('windows-updater-artifacts');
  assert.match(windows, /needs: prepare-release/);
  assert.match(windows, /if:.*github\.event_name == 'push'.*inputs\.build_windows_updater/);
  assertBuildSetup(windows, 'windows-latest', 'x86_64-pc-windows-msvc');
  const prepareRuntime = step(windows, 'Prepare bundled runtime');
  const tauriAction = step(windows, 'Build and upload NSIS updater artifacts');
  const normalizeManifest = step(windows, 'Normalize and replace updater manifest');
  assert.match(prepareRuntime, /STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64: \$\{\{ secrets\.STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64 \}\}/);
  assert.match(prepareRuntime, /STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64: \$\{\{ secrets\.STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64 \}\}/);
  assert.doesNotMatch(prepareRuntime, /GITHUB_TOKEN|TAURI_SIGNING_/);
  assert.match(tauriAction, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(tauriAction, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/);
  assert.match(tauriAction, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(tauriAction, /STUDYMIND_.*_URL/);
  assert.match(normalizeManifest, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(normalizeManifest, /STUDYMIND_.*_URL|TAURI_SIGNING_/);
  const windowsWithoutSecretSteps = windows
    .replace(prepareRuntime, '')
    .replace(tauriAction, '')
    .replace(normalizeManifest, '');
  assert.doesNotMatch(windowsWithoutSecretSteps, /secrets\./);
  assert.match(windows, /node scripts\\build-installer\.mjs --target windows-x64 --skip-tauri-build/);
  assert.match(windows, /uses: tauri-apps\/tauri-action@v0/);
  assert.match(windows, /projectPath: app/);
  assert.match(windows, /tauriScript: npm run tauri/);
  assert.match(windows, /tagName: \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(windows, /releaseName: StudyMind \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(windows, /releaseBody:/);
  assert.match(windows, /releaseDraft: \$\{\{ needs\.prepare-release\.outputs\.release_draft == 'true' \}\}/);
  assert.doesNotMatch(windows, /releaseDraft:.*(?:github\.event_name|inputs\.release_draft)/);
  assert.match(windows, /prerelease: false/);
  assert.match(windows, /releaseCommitish: \$\{\{ needs\.prepare-release\.outputs\.release_tag \}\}/);
  assert.match(windows, /includeUpdaterJson: true/);
  assert.match(windows, /updaterJsonPreferNsis: true/);
  assert.match(windows, /args: --bundles nsis --target x86_64-pc-windows-msvc/);
  assert.match(windows, /gh release download "\$RELEASE_TAG" --pattern latest\.json --dir \. --clobber/);
  assert.match(windows, /node scripts\/normalize-updater-manifest\.mjs latest\.json/);
  assert.match(windows, /gh release upload "\$RELEASE_TAG" latest\.json --clobber/);
  assert.equal((windows.match(/GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/g) ?? []).length, 2);
});

test('builds, smoke-tests, packages, and uploads both macOS architectures', () => {
  if (!workflowExists) return;

  const cases = [
    {
      name: 'macos-x64',
      runner: 'macos-15-intel',
      target: 'x86_64-apple-darwin',
      installerTarget: 'macos-x64',
      urlSuffix: 'MACOS_X64',
    },
    {
      name: 'macos-arm64',
      runner: 'macos-15',
      target: 'aarch64-apple-darwin',
      installerTarget: 'macos-arm64',
      urlSuffix: 'MACOS_ARM64',
    },
  ];

  for (const item of cases) {
    const mac = job(item.name);
    assert.match(mac, /needs: \[prepare-release, windows-updater-artifacts\]/);
    assert.match(mac, /if:.*always\(\).*needs\.prepare-release\.result == 'success'.*windows-updater-artifacts\.result == 'success'.*windows-updater-artifacts\.result == 'skipped'/);
    assert.match(mac, new RegExp(`inputs\\.build_${item.name.replace('-', '_')}`));
    assertBuildSetup(mac, item.runner, item.target);
    const prepareRuntime = step(mac, 'Prepare bundled runtime');
    const buildApp = step(mac, 'Build app bundle');
    const uploadDmg = step(mac, 'Upload DMG');
    for (const secret of ['PYTHON_STANDALONE', 'FFMPEG_ARCHIVE', 'FFPROBE_ARCHIVE']) {
      const name = `STUDYMIND_${secret}_URL_${item.urlSuffix}`;
      assert.match(prepareRuntime, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
    }
    assert.doesNotMatch(prepareRuntime, /GITHUB_TOKEN|TAURI_SIGNING_/);
    assert.match(buildApp, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
    assert.match(buildApp, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/);
    assert.match(uploadDmg, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    assert.doesNotMatch(uploadDmg, /STUDYMIND_.*_URL|TAURI_SIGNING_/);
    const macWithoutSecretSteps = mac.replace(prepareRuntime, '').replace(buildApp, '').replace(uploadDmg, '');
    assert.doesNotMatch(macWithoutSecretSteps, /secrets\./);
    assert.match(mac, new RegExp(`node scripts/build-installer\\.mjs --target ${item.installerTarget} --skip-tauri-build`));
    assert.match(mac, new RegExp(`npm --prefix app run tauri -- build --bundles app --target ${item.target}`));
    assert.match(mac, new RegExp(`app/src-tauri/target/${item.target}/release/bundle/macos/StudyMind\\.app`));
    assert.match(mac, /\$APP_PATH\/Contents\/Resources\/resources/);
    assert.match(mac, /python\/bin\/python3/);
    assert.match(mac, /PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="\$RESOURCES\/worker"/);
    assert.match(mac, /PYTHONPATH="\$RESOURCES\/worker"/);
    assert.match(mac, /import brotli, funasr, funasr_onnx, modelscope, onnxruntime, yt_dlp, studymind_worker/);
    assert.match(mac, /bin\/ffmpeg" -version/);
    assert.match(mac, /bin\/ffprobe" -version/);
    assert.match(mac, /__pycache__/);
    assert.match(mac, /\*\.pyc/);
    assert.match(mac, /codesign --verify --deep --strict/);
    assert.match(mac, new RegExp(`bash scripts/make-macos-dmg\\.sh ${item.target} StudyMind`));
    assert.match(mac, new RegExp(`gh release upload "\\$RELEASE_TAG" app/src-tauri/target/${item.target}/release/bundle/dmg/\\*\\.dmg --clobber`));
  }
});

test('contains no legacy product, Deno, notarization, or Linux release identifiers', () => {
  if (!workflowExists) return;

  assert.doesNotMatch(workflow, /FrameQ|frameq_worker|FRAMEQ_|Deno/i);
  assert.doesNotMatch(workflow, /notar/i);
  assert.doesNotMatch(workflow, /^  (?:linux|ubuntu)[^:]*:|linux-x64/m);
});

test('documents the desktop release workflow and its required runtime inputs', () => {
  assert.ok(sectionStart >= 0, 'README must define a desktop release section');
  assert.match(releaseSection, /\.github\/workflows\/desktop-release\.yml/);
  assert.match(releaseSection, /git tag vX\.Y\.Z/);
  assert.match(releaseSection, /git push origin vX\.Y\.Z/);
  assert.match(releaseSection, /Windows x64 NSIS\/updater/);
  assert.match(releaseSection, /macOS Intel x64 DMG/);
  assert.match(releaseSection, /Apple Silicon arm64 DMG/);
  const manualReleaseParagraph = releaseSection
    .split(/\n\n+/)
    .find((paragraph) => paragraph.includes('workflow_dispatch')) ?? '';
  for (const phrase of ['workflow_dispatch', 'tag', 'v0.1.0', 'Windows', 'Intel', 'Apple Silicon', '补发 DMG']) {
    assert.match(manualReleaseParagraph, new RegExp(phrase));
  }

  const documentedSecrets = new Set(
    releaseSection.match(/(?:STUDYMIND_[A-Z0-9_]+|TAURI_SIGNING_[A-Z0-9_]+)/g) ?? [],
  );
  assert.deepEqual(documentedSecrets, plannedSecrets);

  assert.match(releaseSection, /Python standalone/);
  assert.match(releaseSection, /Windows ffmpeg archive.*ffmpeg\.exe.*ffprobe\.exe/s);
  assert.match(releaseSection, /macOS.*ffmpeg.*ffprobe.*分开/s);
  assert.match(releaseSection, /CPython 3\.11\/3\.12/);
  assert.match(releaseSection, /torch==2\.2\.2/);
  assert.match(releaseSection, /ad-hoc signed/);
  assert.match(releaseSection, /not notarized/);
  assert.match(releaseSection, /GitHub Release preview/);
  assert.match(releaseSection, /Gatekeeper/);
  assert.doesNotMatch(releaseSection, /Secret value|Secret 值/i);
  assert.doesNotMatch(releaseSection, /TAURI_SIGNING_PRIVATE_KEY=/);
  assert.doesNotMatch(releaseSection, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD=/);
  assert.doesNotMatch(releaseSection, /https:\/\/[^\s)]+/i);
  assert.doesNotMatch(releaseSection, /BEGIN [A-Z0-9 ]+PRIVATE KEY/);
});
