// PROTOTYPE — throwaway macOS feasibility probe (Rust, screencapturekit crate)
// Answers F-01 (binding compiles/links), F-02 (global system audio),
// F-06 (self-audio exclusion), F-07 (audio-only fail-closed) on THIS host.
// Evidence collection only. NEVER writes user audio to disk.
//
// Build:  cargo build --release
// Run:    ./target/release/scprobe-crate [--exclude-self] [--play-self-audio] [--seconds N]

use screencapturekit::cm::{CMSampleBuffer, CMSampleBufferExt};
use screencapturekit::prelude::*;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Counters {
    audio_buffers: AtomicUsize,
    video_buffers: AtomicUsize,
    mic_buffers: AtomicUsize,
    audio_bytes: AtomicU64,
    rms: Mutex<(f64, usize)>, // (sum of per-buffer RMS, count)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let exclude_self = args.iter().any(|a| a == "--exclude-self");
    let play_self = args.iter().any(|a| a == "--play-self-audio");
    let seconds: u64 = args
        .windows(2)
        .find(|w| w[0] == "--seconds")
        .and_then(|w| w[1].parse().ok())
        .unwrap_or(8);

    // 1) SCShareableContent — TCC probe (fails without Screen Recording permission)
    let content = SCShareableContent::get()?;
    let displays = content.displays();
    println!(
        "STEP shareable ok displays={} apps={} windows={}",
        displays.len(),
        content.applications().len(),
        content.windows().len()
    );
    for d in &displays {
        println!("  display id={} {}x{}", d.display_id(), d.width(), d.height());
    }
    let display = displays.into_iter().next().ok_or("NO_DISPLAY")?;

    // 2) audio-only capture: register ONLY .audio output (F-07), no video
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let config = SCStreamConfiguration::new()
        .with_width(1)
        .with_height(1)
        .with_captures_audio(true)
        .with_sample_rate(48000)
        .with_channel_count(2)
        .with_excludes_current_process_audio(exclude_self);

    let counters = Arc::new(Counters::default());
    let mut stream = SCStream::new(&filter, &config);
    {
        let c = counters.clone();
        stream.add_output_handler(
            move |sample: CMSampleBuffer, of_type: SCStreamOutputType| match of_type {
                SCStreamOutputType::Audio => {
                    c.audio_buffers.fetch_add(1, Ordering::Relaxed);
                    if let Some(list) = sample.audio_buffer_list() {
                        for i in 0..list.num_buffers() {
                            if let Some(b) = list.buffer(i) {
                                let data = b.data();
                                c.audio_bytes
                                    .fetch_add(data.len() as u64, Ordering::Relaxed);
                                // RMS over up to 1s worth of i16 samples
                                let n = (data.len() / 2).min(48000);
                                if n > 0 {
                                    let mut sum = 0.0;
                                    for j in 0..n {
                                        let v = i16::from_le_bytes([data[2 * j], data[2 * j + 1]]) as f64 / 32768.0;
                                        sum += v * v;
                                    }
                                    let mut r = c.rms.lock().unwrap();
                                    r.0 += sum / n as f64;
                                    r.1 += 1;
                                }
                            }
                        }
                    }
                }
                SCStreamOutputType::Screen => {
                    c.video_buffers.fetch_add(1, Ordering::Relaxed);
                }
                SCStreamOutputType::Microphone => {
                    c.mic_buffers.fetch_add(1, Ordering::Relaxed);
                }
                _ => {}
            },
            SCStreamOutputType::Audio,
        );
    }

    // 3) optional self-audio playback via cpal (F-06): a 440Hz tone from THIS process
    let _tone_stream = if play_self {
        println!("EVT self_audio_playing (cpal)");
        play_tone()
    } else {
        None
    };

    stream.start_capture()?;
    println!("STEP start ok excludeSelf={} playSelf={}", exclude_self, play_self);
    std::thread::sleep(Duration::from_secs(seconds));
    stream.stop_capture()?;

    let (rms_sum, rms_count) = *counters.rms.lock().unwrap();
    let rms_avg = if rms_count > 0 { rms_sum / rms_count as f64 } else { 0.0 };
    println!(
        "STEP capture ok audio_buffers={} audio_bytes={} video_buffers={} mic_buffers={} rmsAvg={:.6}",
        counters.audio_buffers.load(Ordering::Relaxed),
        counters.audio_bytes.load(Ordering::Relaxed),
        counters.video_buffers.load(Ordering::Relaxed),
        counters.mic_buffers.load(Ordering::Relaxed),
        rms_avg
    );
    Ok(())
}

fn play_tone() -> Option<cpal::Stream> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let config = device.default_output_config().ok()?;
    let sample_rate = config.sample_rate().0 as f32;
    let channels = config.channels() as usize;
    let mut phase = 0.0f32;
    let stream = device
        .build_output_stream(
            &config.into(),
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                for sample in data.iter_mut() {
                    *sample = (phase * 2.0 * std::f32::consts::PI).sin() * 0.4;
                    phase += 440.0 / sample_rate;
                }
            },
            |err| eprintln!("EVT cpal error: {err}"),
            None,
        )
        .ok()?;
    stream.play().ok()?;
    Some(stream)
}
