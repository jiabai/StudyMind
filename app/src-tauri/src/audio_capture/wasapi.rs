use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, E_FAIL, RPC_E_CHANGED_MODE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eRender, DEVICE_STATE_ACTIVE, EDataFlow, IMMDevice,
    IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use super::wav_writer::{WavCaptureSummary, WaveFormat, WaveWriter};
use super::{
    ActiveCapture, CaptureWorkspace, CapturedRecording, RecordingBackend, RecordingCapabilities,
    RecordingError, RecordingMode, RecordingPlatform, RecordingSourceCapability,
    RECORDING_MIC_ACCESS_DENIED, RECORDING_MIC_INIT_FAILED, RECORDING_MIX_FAILED,
    RECORDING_STREAM_ERROR, RECORDING_SYSTEM_AUDIO_UNAVAILABLE,
    RECORDING_SYSTEM_LOOPBACK_INIT_FAILED,
};

#[derive(Default)]
pub(crate) struct WasapiRecordingBackend;

#[derive(Clone, Copy)]
enum SourceKind {
    Microphone,
    SystemAudio,
}

impl SourceKind {
    fn file_name(self) -> &'static str {
        match self {
            Self::Microphone => "mic.wav",
            Self::SystemAudio => "system.wav",
        }
    }

    fn data_flow(self) -> windows::Win32::Media::Audio::EDataFlow {
        match self {
            Self::Microphone => eCapture,
            Self::SystemAudio => eRender,
        }
    }

    fn init_error(self) -> RecordingError {
        match self {
            Self::Microphone => RecordingError::new(RECORDING_MIC_INIT_FAILED),
            Self::SystemAudio => RecordingError::new(RECORDING_SYSTEM_LOOPBACK_INIT_FAILED),
        }
    }

    fn capability_error(self) -> RecordingError {
        match self {
            Self::Microphone => RecordingError::new(RECORDING_MIC_INIT_FAILED),
            Self::SystemAudio => RecordingError::new(RECORDING_SYSTEM_AUDIO_UNAVAILABLE),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::SystemAudio => "system-audio",
        }
    }
}

fn map_init_error(kind: SourceKind, error: &windows::core::Error) -> RecordingError {
    if matches!(kind, SourceKind::Microphone)
        && error.code() == windows::Win32::Foundation::E_ACCESSDENIED
    {
        return RecordingError::new(RECORDING_MIC_ACCESS_DENIED);
    }
    kind.init_error()
}

impl RecordingBackend for WasapiRecordingBackend {
    fn capabilities(&self) -> Result<RecordingCapabilities, RecordingError> {
        let microphone = match probe_source(SourceKind::Microphone) {
            Ok(()) => RecordingSourceCapability {
                available: true,
                reason_code: None,
            },
            Err(error) => RecordingSourceCapability {
                available: false,
                reason_code: Some(error.code),
            },
        };
        let system_audio = match probe_source(SourceKind::SystemAudio) {
            Ok(()) => RecordingSourceCapability {
                available: true,
                reason_code: None,
            },
            Err(error) => RecordingSourceCapability {
                available: false,
                reason_code: Some(error.code),
            },
        };
        let mixed_available = microphone.available && system_audio.available;
        let mixed = RecordingSourceCapability {
            available: mixed_available,
            reason_code: (!mixed_available).then_some(RECORDING_MIX_FAILED),
        };

        Ok(RecordingCapabilities {
            platform: RecordingPlatform::Windows,
            microphone,
            system_audio,
            mixed,
        })
    }

    fn start(
        &self,
        mode: RecordingMode,
        workspace: &CaptureWorkspace,
    ) -> Result<Box<dyn ActiveCapture>, RecordingError> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut workers: Vec<(
            JoinHandle<Result<WavCaptureSummary, RecordingError>>,
            mpsc::Receiver<Result<(), RecordingError>>,
        )> = Vec::new();
        let source_kinds = match mode {
            RecordingMode::Mic => vec![SourceKind::Microphone],
            RecordingMode::System => vec![SourceKind::SystemAudio],
            RecordingMode::Mixed => vec![SourceKind::Microphone, SourceKind::SystemAudio],
        };

        for kind in source_kinds {
            let path = workspace.temp_dir.join(kind.file_name());
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let worker_stop = Arc::clone(&stop);
            let worker = match thread::Builder::new()
                .name(format!("studymind-recording-{}", kind.file_name()))
                .spawn(move || run_source_worker(kind, path, worker_stop, ready_tx))
            {
                Ok(worker) => worker,
                Err(_) => {
                    stop.store(true, Ordering::SeqCst);
                    for (handle, _) in workers.drain(..) {
                        let _ = handle.join();
                    }
                    return Err(kind.init_error());
                }
            };
            workers.push((worker, ready_rx));
        }

        let mut handles = Vec::with_capacity(workers.len());
        for (worker, ready_rx) in workers {
            match ready_rx.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(())) => handles.push(worker),
                Ok(Err(error)) => {
                    stop.store(true, Ordering::SeqCst);
                    let _ = worker.join();
                    for handle in handles {
                        let _ = handle.join();
                    }
                    return Err(error);
                }
                Err(_) => {
                    stop.store(true, Ordering::SeqCst);
                    let _ = worker.join();
                    for handle in handles {
                        let _ = handle.join();
                    }
                    return Err(RecordingError::new(RECORDING_STREAM_ERROR));
                }
            }
        }

        Ok(Box::new(WasapiActiveCapture {
            stop,
            workers: handles,
        }))
    }
}

struct WasapiActiveCapture {
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<Result<WavCaptureSummary, RecordingError>>>,
}

impl ActiveCapture for WasapiActiveCapture {
    fn stop(self: Box<Self>) -> Result<CapturedRecording, RecordingError> {
        self.stop.store(true, Ordering::SeqCst);
        let mut summaries = Vec::with_capacity(self.workers.len());
        for worker in self.workers {
            let summary = worker
                .join()
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))??;
            summaries.push(summary);
        }
        summarize_capture(summaries)
    }

    fn cancel(self: Box<Self>) -> Result<(), RecordingError> {
        self.stop.store(true, Ordering::SeqCst);
        for worker in self.workers {
            let _ = worker.join();
        }
        Ok(())
    }
}

fn summarize_capture(
    summaries: Vec<WavCaptureSummary>,
) -> Result<CapturedRecording, RecordingError> {
    if summaries.is_empty() {
        return Err(RecordingError::new(RECORDING_STREAM_ERROR));
    }
    let valid_frame_count = summaries.iter().try_fold(0u64, |total, summary| {
        total
            .checked_add(summary.valid_frame_count)
            .ok_or_else(|| RecordingError::new(RECORDING_STREAM_ERROR))
    })?;
    Ok(CapturedRecording {
        source_paths: summaries
            .iter()
            .map(|summary| summary.path.clone())
            .collect(),
        valid_frame_count,
        silent: summaries.iter().all(|summary| summary.silent),
        duration_ms: summaries
            .iter()
            .map(|summary| summary.duration_ms)
            .max()
            .unwrap_or(0),
    })
}

/// Resolve a usable audio endpoint for the given data flow.
///
/// Windows may expose a device only under the `eCommunications` role (common with
/// headsets / meeting software) or with no default set at all. Apps like EV录屏 enumerate
/// devices and pick one; StudyMind previously required the `eConsole` default
/// (`GetDefaultAudioEndpoint(.., eConsole)`), which returns nothing in those setups and
/// reported the whole source as unavailable. Fallback order:
/// eConsole default -> eCommunications default -> first active enumerated endpoint.
fn resolve_default_endpoint(
    enumerator: &IMMDeviceEnumerator,
    data_flow: EDataFlow,
) -> Result<IMMDevice, windows::core::Error> {
    if let Ok(device) = unsafe { enumerator.GetDefaultAudioEndpoint(data_flow, eConsole) } {
        return Ok(device);
    }
    if let Ok(device) = unsafe { enumerator.GetDefaultAudioEndpoint(data_flow, eCommunications) } {
        log::debug!("resolved endpoint via eCommunications default (eConsole default absent)");
        return Ok(device);
    }
    match unsafe { enumerator.EnumAudioEndpoints(data_flow, DEVICE_STATE_ACTIVE) } {
        Ok(collection) => {
            let count = unsafe { collection.GetCount() }.unwrap_or(0);
            if count > 0 {
                if let Ok(device) = unsafe { collection.Item(0) } {
                    log::debug!("resolved endpoint via enumeration ({} active device(s))", count);
                    return Ok(device);
                }
            } else {
                log::warn!("no active audio endpoints for data_flow");
            }
        }
        Err(error) => {
            log::warn!("EnumAudioEndpoints failed: {:#010X}", error.code().0);
        }
    }
    Err(windows::core::Error::new(
        E_FAIL,
        "no usable audio endpoint resolved",
    ))
}

fn probe_source(kind: SourceKind) -> Result<(), RecordingError> {
    let _com = ComApartment::initialize().map_err(|_| {
        log::error!("{}: COM subsystem unavailable", kind.label());
        kind.capability_error()
    })?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|error| {
            log::error!(
                "{}: CoCreateInstance(MMDeviceEnumerator) failed: {:#010X}",
                kind.label(),
                error.code().0
            );
            kind.capability_error()
        })?;
    let device = resolve_default_endpoint(&enumerator, kind.data_flow()).map_err(|error| {
        log::warn!(
            "{}: no usable endpoint resolved: {:#010X}",
            kind.label(),
            error.code().0
        );
        kind.capability_error()
    })?;
    let client: IAudioClient =
        unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|error| {
            log::error!(
                "{}: Activate failed: {:#010X}",
                kind.label(),
                error.code().0
            );
            kind.capability_error()
        })?;
    let format = unsafe { client.GetMixFormat() }.map_err(|error| {
        log::error!(
            "{}: GetMixFormat failed: {:#010X}",
            kind.label(),
            error.code().0
        );
        kind.capability_error()
    })?;
    let result = unsafe { WaveFormat::from_wasapi(format) }.map(|_| ());
    unsafe { CoTaskMemFree(Some(format.cast())) };
    result.map_err(|_| kind.capability_error())
}

fn run_source_worker(
    kind: SourceKind,
    path: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    ready_tx: SyncSender<Result<(), RecordingError>>,
) -> Result<WavCaptureSummary, RecordingError> {
    let _com = match ComApartment::initialize() {
        Ok(com) => com,
        Err(_) => {
            let error = kind.init_error();
            let _ = ready_tx.send(Err(error.clone()));
            return Err(error);
        }
    };
    let setup = setup_capture_client(kind, &path);
    let (client, capture, event, mut writer) = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ = ready_tx.send(Err(error.clone()));
            return Err(error);
        }
    };

    if let Err(error) = unsafe { client.Start() } {
        let stable = map_stream_error(error);
        let _ = unsafe { CloseHandle(event) };
        let _ = ready_tx.send(Err(stable.clone()));
        return Err(stable);
    }
    if ready_tx.send(Ok(())).is_err() {
        let _ = unsafe { client.Stop() };
        let _ = unsafe { CloseHandle(event) };
        return Err(RecordingError::new(RECORDING_STREAM_ERROR));
    }

    let capture_result = capture_packets(&client, &capture, event, &stop, &mut writer);
    let stop_result = unsafe { client.Stop() };
    let _ = unsafe { CloseHandle(event) };
    if let Err(error) = capture_result {
        return Err(error);
    }
    if let Err(error) = stop_result {
        return Err(map_stream_error(error));
    }
    writer.finish()
}

fn setup_capture_client(
    kind: SourceKind,
    path: &std::path::Path,
) -> Result<
    (
        IAudioClient,
        IAudioCaptureClient,
        windows::Win32::Foundation::HANDLE,
        WaveWriter,
    ),
    RecordingError,
> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|_| kind.init_error())?;
    let device = resolve_default_endpoint(&enumerator, kind.data_flow()).map_err(|error| {
        log::error!(
            "{}: start recording, no usable endpoint resolved: {:#010X}",
            kind.label(),
            error.code().0
        );
        kind.init_error()
    })?;
    let client: IAudioClient =
        unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(|error| map_init_error(kind, &error))?;
    let format_ptr = unsafe { client.GetMixFormat() }.map_err(|_| kind.init_error())?;
    let format = unsafe { WaveFormat::from_wasapi(format_ptr) }.map_err(|_| kind.init_error());
    if format.is_err() {
        unsafe { CoTaskMemFree(Some(format_ptr.cast())) };
        return Err(kind.init_error());
    }
    let format = format.unwrap();
    let event = match unsafe { CreateEventW(None, false, false, None) } {
        Ok(event) => event,
        Err(_) => {
            unsafe { CoTaskMemFree(Some(format_ptr.cast())) };
            return Err(kind.init_error());
        }
    };
    let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | if matches!(kind, SourceKind::SystemAudio) {
            AUDCLNT_STREAMFLAGS_LOOPBACK
        } else {
            0
        };
    let initialize = unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            flags,
            10_000_000,
            0,
            format_ptr,
            None,
        )
    };
    unsafe { CoTaskMemFree(Some(format_ptr.cast())) };
    if let Err(error) = initialize {
        let _ = unsafe { CloseHandle(event) };
        return Err(map_init_error(kind, &error));
    }
    if unsafe { client.SetEventHandle(event) }.is_err() {
        let _ = unsafe { CloseHandle(event) };
        return Err(kind.init_error());
    }
    let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|_| {
        let _ = unsafe { CloseHandle(event) };
        kind.init_error()
    })?;
    let writer = WaveWriter::create(path, format).map_err(|error| {
        let _ = unsafe { CloseHandle(event) };
        error
    })?;
    Ok((client, capture, event, writer))
}

fn capture_packets(
    _client: &IAudioClient,
    capture: &IAudioCaptureClient,
    event: windows::Win32::Foundation::HANDLE,
    stop: &AtomicBool,
    writer: &mut WaveWriter,
) -> Result<(), RecordingError> {
    while !stop.load(Ordering::SeqCst) {
        let mut packet_frames = unsafe { capture.GetNextPacketSize() }
            .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
        while packet_frames > 0 {
            let mut data = ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = Default::default();
            unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
            let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            let write_result = if silent {
                writer.write_silence(u64::from(frames))
            } else {
                if data.is_null() {
                    Err(RecordingError::new(RECORDING_STREAM_ERROR))
                } else {
                    let byte_len = usize::try_from(frames)
                        .ok()
                        .and_then(|frames| frames.checked_mul(usize::from(writer.block_align())));
                    match byte_len {
                        Some(byte_len) => {
                            let bytes =
                                unsafe { std::slice::from_raw_parts(data.cast::<u8>(), byte_len) };
                            writer.write_frames(bytes, u64::from(frames), false)
                        }
                        None => Err(RecordingError::new(RECORDING_STREAM_ERROR)),
                    }
                }
            };
            let release_result = unsafe { capture.ReleaseBuffer(frames) };
            if let Err(error) = write_result {
                let _ = release_result;
                return Err(error);
            }
            release_result.map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
            packet_frames = unsafe { capture.GetNextPacketSize() }
                .map_err(|_| RecordingError::new(RECORDING_STREAM_ERROR))?;
        }

        let wait = unsafe { WaitForSingleObject(event, 100) };
        if wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT {
            return Err(RecordingError::new(RECORDING_STREAM_ERROR));
        }
    }
    Ok(())
}

struct ComApartment {
    owned: bool,
}

impl ComApartment {
    fn initialize() -> Result<Self, ()> {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_ok() {
            Ok(Self { owned: true })
        // Thread already initialized in another apartment model (e.g. STA). WASAPI
        // endpoint access is apartment-agnostic, so proceed without re-initializing.
        // We must NOT call CoUninitialize on drop in this case, or we would tear down
        // COM for the thread that actually owns it.
        } else if hr == RPC_E_CHANGED_MODE {
            log::debug!(
                "ComApartment: thread already in another apartment (RPC_E_CHANGED_MODE); proceeding"
            );
            Ok(Self { owned: false })
        } else {
            log::error!("ComApartment::initialize failed: {:#010X}", hr.0);
            Err(())
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.owned {
            unsafe { CoUninitialize() };
        }
    }
}

fn map_stream_error(_error: windows::core::Error) -> RecordingError {
    RecordingError::new(RECORDING_STREAM_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_probe_uses_the_native_windows_contract() {
        let capabilities = WasapiRecordingBackend::default()
            .capabilities()
            .expect("capability probe returns a stable response");

        assert_eq!(capabilities.platform, RecordingPlatform::Windows);
        let expected_mixed =
            capabilities.microphone.available && capabilities.system_audio.available;
        let payload = serde_json::to_value(&capabilities).expect("serialize capabilities");
        assert_eq!(payload["mixed"]["available"], expected_mixed);

        for source in [&capabilities.microphone, &capabilities.system_audio] {
            if !source.available {
                assert!(source.reason_code.is_some());
            }
        }
    }

    #[test]
    fn com_apartment_initialize_tolerates_existing_apartment() {
        // Reproduces the field bug: when the calling thread is already initialized in
        // STA, CoInitializeEx(.., COINIT_MULTITHREADED) returns RPC_E_CHANGED_MODE. The
        // old ComApartment treated any error as fatal, so both mic and system-audio
        // probes failed even though a working device existed (cf. EV录屏 working).
        let owned_by_us =
            unsafe { CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED) }
                .is_ok();
        let result = ComApartment::initialize();
        if owned_by_us {
            unsafe {
                CoUninitialize();
            }
        }
        assert!(
            result.is_ok(),
            "ComApartment must tolerate an already-initialized apartment (RPC_E_CHANGED_MODE)"
        );
    }
}
