# ADR 0004: Use native Windows WASAPI for built-in recording

## Status

Accepted

## Context

The recording entry and IPC façade already expose microphone, system loopback, and mixed modes, but production currently injects an unavailable backend. The installer already ships ffmpeg binaries, and the product is local-first with no network media capture.

The backend must bind the default endpoints, support Windows loopback, preserve endpoint-native formats while capturing, produce one stable WAV media artifact, and keep device and filesystem diagnostics out of the public contract.

## Decision

Implement the production backend as three Windows-only Rust modules:

- `wasapi.rs` for COM/WASAPI endpoint probing and event-driven microphone/loopback packet capture, using the target-specific `windows` projection;
- `wav_writer.rs` for native-format temporary WAV files and header patching;
- `mixer.rs` for structured invocation of the bundled ffmpeg executable, equal-weight mixed-mode normalization, output validation, and atomic finalization.

Inject the production controller during Tauri setup with resolved runtime paths. Keep the unavailable backend on non-Windows and in tests. Store temporary artifacts under protected app-local `recordings/.tmp/<session-id>` and finalized WAVs under app-local `recordings/`.

Mixed mode is transactional: failure of either source fails the whole session. The existing local-media handoff remains the downstream integration point.

## Alternatives considered

### cpal for microphone plus native loopback for system audio

Rejected because it introduces two device abstractions and still requires native Windows code for loopback, increasing format and lifecycle mismatch risk.

### ffmpeg DirectShow for all sources

Rejected because device discovery and loopback depend on driver-visible names and vary across machines. It also makes capability probing and privacy behavior less deterministic.

### Keep the fake backend and only enable the UI

Rejected because it reproduces the reported failure: the UI can render the controls, but no actual recording can start.

## Consequences

Positive:

- Windows capability probing reflects actual endpoint availability.
- System-only mode can avoid microphone initialization.
- Native endpoint formats are preserved during capture, while final media has a stable 16 kHz mono contract.
- Structured process arguments and path containment reduce command-injection and cleanup risks.
- The Worker and existing local-media contracts remain unchanged.

Costs and risks:

- WASAPI COM/resource lifecycle code is Windows-specific and requires Windows integration testing.
- Capture-thread shutdown and endpoint-loss handling need careful bounded joins.
- ffmpeg remains a packaged runtime dependency for finalization.
- At the time of this ADR, other platforms report unsupported until a separate backend is designed. macOS is no longer covered by this forward-looking constraint; its backend is approved separately by [ADR 0005](./0005-macos-recording-backend.md). Linux remains unsupported pending its own decision.
