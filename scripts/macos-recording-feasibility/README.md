# PROTOTYPE — macOS recording feasibility harness (throwaway)

**Do not treat any file here as production code.** This harness exists to collect
evidence for the blocking feasibility matrix `F-01`–`F-08` in
`docs/test-plans/macos-recording-acceptance.md` (decision source:
`docs/adr/0005-macos-recording-backend.md`), per
`docs/handoffs/studymind-macos-recording-feasibility-handoff.md`.

## What it answers (on THIS host)

| ID | Question | Probe |
|---|---|---|
| F-01 | `screencapturekit` Rust binding compiles/links and starts an audio-only stream | `probe-crate` build + `start_capture()` |
| F-02 | global system audio reaches the audio output | audio buffer/byte counters while other apps play audio |
| F-06 | `excludesCurrentProcessAudio` takes effect | `--exclude-self` vs default (contrast run) |
| F-07 | no `.screen` output registered, no video buffer received | only `SCStreamOutputType::Audio` registered; `video_buffers` counter must stay 0 |
| F-08 | TCC behaviour | `SCShareableContent::get()` success/error on first run |

## Rules honoured

- **No user audio is written to disk.** The probe only counts buffers/bytes.
- Throwaway: everything here is disposable; validated decisions fold back into
  `app/src-tauri/src/audio_capture/` on the real branch, this harness is captured
  on a throwaway branch only.

## How to run

```bash
./run.sh            # builds probe-crate (F-01) and runs two 8s audio-only captures
```

Direct:

```bash
cd probe-crate
cargo build --release
./target/release/scprobe-crate --exclude-self --seconds 8   # exclude StudyMind self audio
./target/release/scprobe-crate --seconds 8                  # baseline (no exclusion)
```

## Environment under test (E1-equivalent)

Captured at run time by the probe/report; record exact macOS version, arch,
Rust toolchain, `screencapturekit` version, and TCC result in the report.
