# StudyMind GitHub Actions Desktop Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish reproducible Windows x64 NSIS/updater artifacts and macOS Intel/Apple Silicon DMGs from one GitHub Actions workflow.

**Architecture:** A target-aware Node script rebuilds only generated `app/src-tauri/resources/{python,worker,bin}` from target archives and tracked StudyMind manifests. Tauri packages that runtime. A headless Bash script uses `hdiutil` for macOS DMGs; a preparation job creates/validates the Release before platform jobs upload assets.

**Tech Stack:** GitHub Actions, Tauri 2, Rust targets, Node.js, `uv`, Python standalone archives, Node `node:test`, Bash, GitHub CLI.

---

## File map

Create: `app/package-lock.json`, `scripts/build-installer.mjs`, `scripts/make-macos-dmg.sh`, `scripts/normalize-updater-manifest.mjs`, `scripts/tests/build-installer.test.mjs`, `scripts/tests/make-macos-dmg.test.mjs`, `scripts/tests/desktop-release-workflow.test.mjs`, `.github/workflows/desktop-release.yml`.

Modify: `.gitignore` and `README.md`.

Do not modify: `app/src-tauri/tauri.conf.json`, `app/src-tauri/resources/pyproject.toml`, or Rust runtime code; these already define the runtime contract.

## Task 1: Track the npm lockfile

**Files:** `.gitignore`, `app/package-lock.json`, `scripts/tests/desktop-release-workflow.test.mjs`.

- [ ] **Step 1: Write the failing test.** Assert `.gitignore` contains the exact exception `!app/package-lock.json`, parse `app/package-lock.json`, and assert `Number(lockfile.lockfileVersion) >= 1`.
- [ ] **Step 2: Run `node --test scripts/tests/desktop-release-workflow.test.mjs`.** It must fail because the clean worktree has no lockfile and no exception.
- [ ] **Step 3: Add `!app/package-lock.json` immediately after the broad `package-lock.json` ignore rule.** Run `npm.cmd install --package-lock-only --ignore-scripts --prefix app` to generate the lockfile.
- [ ] **Step 4: Run the test and `npm.cmd ci --ignore-scripts --prefix app`.** Both must pass.
- [ ] **Step 5: Commit with `git add .gitignore app/package-lock.json scripts/tests/desktop-release-workflow.test.mjs` and `git commit -m "build: track frontend lockfile for release CI"`.**

## Task 2: Write installer tests before implementation

**Files:** `scripts/tests/build-installer.test.mjs`; target `scripts/build-installer.mjs`.

- [ ] **Step 1: Add failing `node:test` cases importing `targetConfig`, `requiredMediaBinaries`, `parseArgs`, and `findStandalonePythonRuntimeRoot`.** Assert the exact target map:
  - `windows-x64` → `x86_64-pc-windows-msvc`, `python.exe`, `ffmpeg.exe/ffprobe.exe`, `STUDYMIND_PYTHON_STANDALONE_URL_WINDOWS_X64`, `STUDYMIND_FFMPEG_ARCHIVE_URL_WINDOWS_X64`, no separate ffprobe secret;
  - `macos-x64` → `x86_64-apple-darwin`, `bin/python3`, `ffmpeg/ffprobe`, and the `_MACOS_X64` secrets;
  - `macos-arm64` → `aarch64-apple-darwin` and the `_MACOS_ARM64` secrets.
- [ ] **Step 2: Assert `parseArgs(["--target", "macos-x64", "--skip-tauri-build"], env)` reads target-specific URLs, rejects missing URLs and rejects `linux-x64`.** Build a temporary fake `cpython/bin/python3.12` plus `cpython/lib/python3.12` tree and assert `findStandalonePythonRuntimeRoot` returns `cpython`.
- [ ] **Step 3: Run `node --test scripts/tests/build-installer.test.mjs`.** It must fail with missing module/exports, not pass immediately.

## Task 3: Implement the StudyMind runtime builder

**Files:** `scripts/build-installer.mjs`, `scripts/tests/build-installer.test.mjs`.

- [ ] **Step 1: Define one exported `TARGETS` contract.** `targetConfig(target)` returns the records above; `requiredMediaBinaries(target)` returns Windows `.exe` names or macOS names; `parseArgs(argv, env = process.env)` validates target, URL inputs, `--skip-downloads`, and `--skip-tauri-build` before changing files.
- [ ] **Step 2: Make target tests green.** Run `node --test scripts/tests/build-installer.test.mjs`.
- [ ] **Step 3: Implement bounded helpers.** Add `resetDirectory`, isolated `prepareArchiveInput`, `expandArchiveFile` via `tar -xf`, standalone-root discovery/copy, media-binary discovery/copy with macOS executable bits, and recursive `removePythonCaches`. Only generated `resources/python`, `resources/worker`, `resources/bin`, and `build/installer-runtime/<target>` may be removed.
- [ ] **Step 4: Add and run real temporary-directory tests for archive-root selection and removal of `__pycache__`, `.pyc`, and `.pyo`.** They must fail before the helpers and pass after them.
- [ ] **Step 5: Implement resource assembly.** Copy `worker/studymind_worker` to `resources/worker/studymind_worker`; preserve tracked `resources/pyproject.toml` and `.env.template`; compile/install with the bundled interpreter using `uv pip compile app/src-tauri/resources/pyproject.toml --python <python> --output-file build/installer-runtime/<target>/requirements.txt --no-annotate`, `python -m ensurepip --upgrade`, `python -m pip install --upgrade pip`, and `uv pip install --python <python> --only-binary=llvmlite,cryptography -r <requirements>`.
- [ ] **Step 6: Smoke-test with `PYTHONDONTWRITEBYTECODE=1` and `PYTHONPATH=resources/worker`: import `brotli`, `funasr`, `funasr_onnx`, `modelscope`, `onnxruntime`, `yt_dlp`, and `studymind_worker`; prune caches again; validate ffmpeg/ffprobe. Add a macOS native-library self-contained check, either an adapted `verify-macos-self-contained.mjs` or an `otool -L` implementation, and test the chosen boundary.
- [ ] **Step 7: Add static source tests requiring `studymind_worker`, the StudyMind resource manifest/template, and all StudyMind secret names while forbidding `frameq_worker`, `FRAMEQ_`, and root `.env.example`. Run the full installer test file.
- [ ] **Step 8: Commit `scripts/build-installer.mjs` and its tests with `build: add StudyMind release runtime builder`.**

## Task 4: Implement DMG and updater-manifest packaging

**Files:** `scripts/make-macos-dmg.sh`, `scripts/normalize-updater-manifest.mjs`, `scripts/tests/make-macos-dmg.test.mjs`.

- [ ] **Step 1: Write failing static tests.** Assert the DMG script accepts `<target-triple> [StudyMind]`, resolves `StudyMind.app`, rejects Python caches, runs strict `codesign`, uses `ditto`, `/Applications`, and CLI-only `hdiutil create -format UDZO`, maps x64/aarch64 suffixes, and contains no AppleScript/Finder. Assert the normalizer uses fatal UTF-8 decoding and `JSON.parse`.
- [ ] **Step 2: Run `node --test scripts/tests/make-macos-dmg.test.mjs`;** confirm it fails because the scripts do not exist.
- [ ] **Step 3: Implement the scripts.** DMG output must be `app/src-tauri/target/<triple>/release/bundle/dmg/StudyMind_<version>_<suffix>.dmg`; staging cleanup uses a trap. Normalizer strips an optional UTF-8 BOM, validates JSON, writes UTF-8 bytes, and exits `1` for missing args, invalid encoding, invalid JSON, or I/O errors.
- [ ] **Step 4: Run the static tests and commit with `build: add headless macOS DMG packaging`.**

## Task 5: Add the unified GitHub Actions workflow

**Files:** `.github/workflows/desktop-release.yml`, `scripts/tests/desktop-release-workflow.test.mjs`.

- [ ] **Step 1: Write failing workflow tests.** Assert `push` tags `v*`, `workflow_dispatch` inputs `tag/release_draft/build_windows_updater/build_macos_x64/build_macos_arm64`, `contents: write`, `windows-latest`, `macos-15-intel`, `macos-15`, all three target triples, `npm ci --prefix app`, `includeUpdaterJson: true`, `gh release upload`, all StudyMind URL secrets, pinned checkout/setup-node/setup-uv actions, and no FrameQ identifiers.
- [ ] **Step 2: Run the tests;** confirm failure because the workflow is absent.
- [ ] **Step 3: Implement `prepare-release` on `ubuntu-latest`.** Compute `RELEASE_TAG`, verify the remote tag via `gh api`, and create the Release with `gh release create --verify-tag` only if it does not exist. This supports manual macOS-only reruns for existing `v0.1.0`.
- [ ] **Step 4: Implement `windows-updater-artifacts`.** Depend on `prepare-release`; install with checkout@v5, setup-node@v5/npm cache using `app/package-lock.json`, Rust Windows target, pinned setup-uv, and `npm ci --prefix app`; run `node scripts\\build-installer.mjs --target windows-x64 --skip-tauri-build`; invoke `tauri-apps/tauri-action@v0` with NSIS, target triple, updater JSON, StudyMind release title/body, URL secrets, and Tauri signing secrets; normalize and re-upload `latest.json` with `--clobber`.
- [ ] **Step 5: Implement Intel and arm64 jobs.** Depend on `prepare-release` and Windows, use `always()` so a manually skipped Windows job does not block macOS, install with npm ci, prepare the matching target, build only `.app`, import the bundled Python modules and `studymind_worker`, probe media binaries, scan caches, run strict codesign, call `bash scripts/make-macos-dmg.sh <triple> StudyMind`, and upload DMG assets with `gh release upload "$RELEASE_TAG" ... --clobber`.
- [ ] **Step 6: Run workflow tests and inspect YAML for tag/manual behavior, skip behavior, secrets only in env, and absence of FrameQ names. Commit with `ci: publish desktop releases on GitHub Actions`.**

## Task 6: Document and verify the release

**Files:** `README.md`, release test file.

- [ ] **Step 1: Add failing README assertions for the workflow path, manual dispatch, architecture labels, all ten secrets, tag command, manual `v0.1.0` rerun, and ad-hoc/not-notarized macOS status.**
- [ ] **Step 2: Document archive formats, CPython 3.11/3.12 Intel constraint, secret names without values, `git tag vX.Y.Z; git push origin vX.Y.Z`, and Actions manual selection of architectures.**
- [ ] **Step 3: Run `node --test scripts/tests/build-installer.test.mjs scripts/tests/make-macos-dmg.test.mjs scripts/tests/desktop-release-workflow.test.mjs`; commit docs.**
- [ ] **Step 4: Run `uv run ruff check worker`, `uv run pytest worker/tests`, `npm.cmd --prefix app run lint`, `npm.cmd --prefix app run build`, `npm.cmd --prefix app test`, and `cargo check --manifest-path app/src-tauri/Cargo.toml`.**
- [ ] **Step 5: Run `git status --short` and `git check-ignore -v app/src-tauri/resources/python app/src-tauri/resources/worker app/src-tauri/resources/bin`; confirm only intended files are tracked and generated runtime directories remain ignored.**
- [ ] **Step 6: Review `git diff master...HEAD -- .github/workflows scripts README.md .gitignore`, push `codex/github-actions-desktop-release`, and after review merge. Configure Secrets before pushing a release tag; first run is manual `v0.1.0` with Windows unchecked and both macOS architectures checked.**

## Self-review

The plan covers the design's runtime preparation, target-specific archives, Worker/resource boundaries, updater manifest, Windows updater, both macOS DMGs, Release coordination, manual reruns, documentation, tests, and repository verification. No `TBD`/`TODO` placeholders remain. Target names, triples, executable paths, and secret names are defined once in `TARGETS` and asserted by tests. Scope excludes Linux, notarization, ASR model bundling, and runtime behavior changes.
