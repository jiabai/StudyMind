use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::{RecordingError, RECORDING_WRITE_FAILED};

const RIFF_HEADER_SIZE: u64 = 12;
const MAX_RIFF_DATA_BYTES: u64 = u32::MAX as u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WaveFormat {
    bytes: Vec<u8>,
    pub(crate) channels: u16,
    pub(crate) sample_rate: u32,
    pub(crate) block_align: u16,
    pub(crate) bits_per_sample: u16,
}

impl WaveFormat {
    pub(crate) fn pcm_s16le(channels: u16, sample_rate: u32) -> Result<Self, RecordingError> {
        const FORMAT_TAG_PCM: u16 = 1;
        const BITS_PER_SAMPLE: u16 = 16;
        const BYTES_PER_SAMPLE: u16 = BITS_PER_SAMPLE / 8;

        let block_align = channels
            .checked_mul(BYTES_PER_SAMPLE)
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
        let byte_rate = sample_rate
            .checked_mul(u32::from(block_align))
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;

        let mut bytes = Vec::with_capacity(16);
        bytes.extend_from_slice(&FORMAT_TAG_PCM.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

        Self::new(bytes, channels, sample_rate, block_align, BITS_PER_SAMPLE)
    }

    pub(crate) fn new(
        bytes: Vec<u8>,
        channels: u16,
        sample_rate: u32,
        block_align: u16,
        bits_per_sample: u16,
    ) -> Result<Self, RecordingError> {
        if bytes.len() < 16
            || channels == 0
            || sample_rate == 0
            || block_align == 0
            || bits_per_sample == 0
        {
            return Err(RecordingError::new(RECORDING_WRITE_FAILED));
        }

        if bytes.len() > 16 {
            if bytes.len() < 18 {
                return Err(RecordingError::new(RECORDING_WRITE_FAILED));
            }
            let cb_size = u16::from_le_bytes([bytes[16], bytes[17]]) as usize;
            if bytes.len() != 18 + cb_size {
                return Err(RecordingError::new(RECORDING_WRITE_FAILED));
            }
        }

        Ok(Self {
            bytes,
            channels,
            sample_rate,
            block_align,
            bits_per_sample,
        })
    }

    #[cfg(windows)]
    pub(crate) unsafe fn from_wasapi(
        format: *const windows::Win32::Media::Audio::WAVEFORMATEX,
    ) -> Result<Self, RecordingError> {
        if format.is_null() {
            return Err(RecordingError::new(RECORDING_WRITE_FAILED));
        }

        let base = std::ptr::read_unaligned(format);
        let byte_len = 18usize
            .checked_add(base.cbSize as usize)
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
        let bytes = std::slice::from_raw_parts(format.cast::<u8>(), byte_len).to_vec();
        Self::new(
            bytes,
            base.nChannels,
            base.nSamplesPerSec,
            base.nBlockAlign,
            base.wBitsPerSample,
        )
    }

    fn fmt_chunk(&self) -> &[u8] {
        if self.bytes.len() == 18 && self.bytes[16] == 0 && self.bytes[17] == 0 {
            &self.bytes[..16]
        } else {
            &self.bytes
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WavCaptureSummary {
    pub(crate) path: PathBuf,
    pub(crate) valid_frame_count: u64,
    pub(crate) silent: bool,
    pub(crate) duration_ms: u64,
}

pub(crate) struct WaveWriter {
    file: File,
    path: PathBuf,
    format: WaveFormat,
    riff_size_offset: u64,
    data_size_offset: u64,
    data_bytes: u64,
    valid_frame_count: u64,
    silent: bool,
}

impl WaveWriter {
    pub(crate) fn create(
        path: impl Into<PathBuf>,
        format: WaveFormat,
    ) -> Result<Self, RecordingError> {
        let path = path.into();
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(&path)
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        let fmt = format.fmt_chunk();
        let fmt_len =
            u32::try_from(fmt.len()).map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;

        file.write_all(b"RIFF")
            .and_then(|_| file.write_all(&0u32.to_le_bytes()))
            .and_then(|_| file.write_all(b"WAVE"))
            .and_then(|_| file.write_all(b"fmt "))
            .and_then(|_| file.write_all(&fmt_len.to_le_bytes()))
            .and_then(|_| file.write_all(fmt))
            .and_then(|_| file.write_all(b"data"))
            .and_then(|_| file.write_all(&0u32.to_le_bytes()))
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;

        let data_size_offset = RIFF_HEADER_SIZE + 8 + u64::from(fmt_len) + 4;
        Ok(Self {
            file,
            path,
            format,
            riff_size_offset: 4,
            data_size_offset,
            data_bytes: 0,
            valid_frame_count: 0,
            silent: true,
        })
    }

    pub(crate) fn write_frames(
        &mut self,
        bytes: &[u8],
        frame_count: u64,
        packet_silent: bool,
    ) -> Result<(), RecordingError> {
        let expected_bytes = frame_count
            .checked_mul(u64::from(self.format.block_align))
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
        if expected_bytes != bytes.len() as u64 {
            return Err(RecordingError::new(RECORDING_WRITE_FAILED));
        }
        self.write_bytes(bytes)?;
        self.valid_frame_count = self
            .valid_frame_count
            .checked_add(frame_count)
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
        self.silent &= packet_silent || bytes.iter().all(|byte| *byte == 0);
        Ok(())
    }

    pub(crate) fn write_silence(&mut self, frame_count: u64) -> Result<(), RecordingError> {
        let bytes_per_frame = u64::from(self.format.block_align);
        let mut remaining = frame_count;
        let frames_per_chunk = (4096 / bytes_per_frame.max(1)).max(1);
        let zeroes = vec![0u8; (frames_per_chunk * bytes_per_frame) as usize];
        while remaining > 0 {
            let frames = remaining.min(frames_per_chunk);
            self.write_bytes(&zeroes[..(frames * bytes_per_frame) as usize])?;
            self.valid_frame_count = self
                .valid_frame_count
                .checked_add(frames)
                .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
            remaining -= frames;
        }
        Ok(())
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), RecordingError> {
        let next_size = self
            .data_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
        if next_size > MAX_RIFF_DATA_BYTES {
            return Err(RecordingError::new(RECORDING_WRITE_FAILED));
        }
        self.file
            .write_all(bytes)
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        self.data_bytes = next_size;
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<WavCaptureSummary, RecordingError> {
        let fmt_len = self.format.fmt_chunk().len() as u64;
        let riff_size = 4u64
            .checked_add(8 + fmt_len)
            .and_then(|value| value.checked_add(8 + self.data_bytes))
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
        if riff_size > MAX_RIFF_DATA_BYTES {
            return Err(RecordingError::new(RECORDING_WRITE_FAILED));
        }

        self.file
            .seek(SeekFrom::Start(self.riff_size_offset))
            .and_then(|_| self.file.write_all(&(riff_size as u32).to_le_bytes()))
            .and_then(|_| self.file.seek(SeekFrom::Start(self.data_size_offset)))
            .and_then(|_| self.file.write_all(&(self.data_bytes as u32).to_le_bytes()))
            .and_then(|_| self.file.flush())
            .and_then(|_| self.file.sync_all())
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;

        Ok(WavCaptureSummary {
            path: self.path,
            valid_frame_count: self.valid_frame_count,
            silent: self.silent,
            duration_ms: self
                .valid_frame_count
                .saturating_mul(1000)
                .checked_div(u64::from(self.format.sample_rate))
                .unwrap_or(0),
        })
    }

    pub(crate) fn block_align(&self) -> u16 {
        self.format.block_align
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WaveInfo {
    pub(crate) format: WaveFormat,
    pub(crate) data_bytes: u64,
}

pub(crate) fn read_wave_info(path: &Path) -> Result<WaveInfo, RecordingError> {
    let file = File::open(path).map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
    let file_len = file
        .metadata()
        .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?
        .len();
    let mut reader = BufReader::new(file);
    let mut riff = [0u8; 12];
    reader
        .read_exact(&mut riff)
        .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
    if &riff[..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(RecordingError::new(RECORDING_WRITE_FAILED));
    }

    let mut format = None;
    let mut data_bytes = None;
    loop {
        let mut chunk_header = [0u8; 8];
        match reader.read_exact(&mut chunk_header) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(_) => return Err(RecordingError::new(RECORDING_WRITE_FAILED)),
        }
        let size = u32::from_le_bytes(chunk_header[4..8].try_into().unwrap()) as u64;
        let chunk_data_start = reader
            .stream_position()
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        let chunk_end = chunk_data_start
            .checked_add(size)
            .and_then(|end| end.checked_add(size & 1))
            .ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
        if chunk_end > file_len {
            return Err(RecordingError::new(RECORDING_WRITE_FAILED));
        }
        match &chunk_header[..4] {
            b"fmt " => {
                let size_usize = usize::try_from(size)
                    .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
                if !(16..=65536).contains(&size_usize) {
                    return Err(RecordingError::new(RECORDING_WRITE_FAILED));
                }
                let mut bytes = vec![0u8; size_usize];
                reader
                    .read_exact(&mut bytes)
                    .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
                let channels = u16::from_le_bytes(bytes[2..4].try_into().unwrap());
                let sample_rate = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
                let block_align = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
                let bits_per_sample = u16::from_le_bytes(bytes[14..16].try_into().unwrap());
                let mut format_bytes = bytes[..16].to_vec();
                if size_usize > 16 {
                    if size_usize < 18 {
                        return Err(RecordingError::new(RECORDING_WRITE_FAILED));
                    }
                    let cb_size = u16::try_from(size_usize - 18)
                        .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
                    format_bytes.extend_from_slice(&cb_size.to_le_bytes());
                    format_bytes.extend_from_slice(&bytes[18..]);
                }
                format = Some(WaveFormat::new(
                    format_bytes,
                    channels,
                    sample_rate,
                    block_align,
                    bits_per_sample,
                )?);
            }
            b"data" => {
                data_bytes = Some(size);
            }
            _ => {}
        }
        reader
            .seek(SeekFrom::Start(chunk_end))
            .map_err(|_| RecordingError::new(RECORDING_WRITE_FAILED))?;
        if format.is_some() && data_bytes.is_some() {
            break;
        }
    }

    let format = format.ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
    let data_bytes = data_bytes.ok_or_else(|| RecordingError::new(RECORDING_WRITE_FAILED))?;
    if data_bytes == 0 || data_bytes % u64::from(format.block_align) != 0 {
        return Err(RecordingError::new(RECORDING_WRITE_FAILED));
    }
    Ok(WaveInfo { format, data_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_s16le_builds_canonical_pcm_format() {
        let format = WaveFormat::pcm_s16le(2, 48_000).expect("valid PCM16 format");

        assert_eq!(
            format.fmt_chunk(),
            &[1, 0, 2, 0, 0x80, 0xbb, 0, 0, 0, 0xee, 2, 0, 4, 0, 16, 0]
        );
        assert_eq!(format.bits_per_sample, 16);
        assert_eq!(format.block_align, 4);
        assert_eq!(
            u32::from_le_bytes(format.fmt_chunk()[8..12].try_into().unwrap()),
            192_000
        );
    }

    #[test]
    fn pcm_s16le_rejects_zero_channels() {
        let error = WaveFormat::pcm_s16le(0, 48_000).expect_err("zero channels must fail");

        assert_eq!(error.code, RECORDING_WRITE_FAILED);
    }

    #[test]
    fn pcm_s16le_rejects_zero_sample_rate() {
        let error = WaveFormat::pcm_s16le(2, 0).expect_err("zero sample rate must fail");

        assert_eq!(error.code, RECORDING_WRITE_FAILED);
    }

    #[test]
    fn pcm_s16le_rejects_arithmetic_overflow() {
        let block_align_error =
            WaveFormat::pcm_s16le(u16::MAX, 48_000).expect_err("block align must not overflow");
        let byte_rate_error =
            WaveFormat::pcm_s16le(2, u32::MAX).expect_err("byte rate must not overflow");

        assert_eq!(block_align_error.code, RECORDING_WRITE_FAILED);
        assert_eq!(byte_rate_error.code, RECORDING_WRITE_FAILED);
    }

    fn pcm_format(channels: u16) -> WaveFormat {
        WaveFormat::new(
            vec![
                1,
                0,
                channels as u8,
                0,
                0x80,
                0x3e,
                0,
                0,
                0,
                0,
                0,
                0,
                2,
                0,
                16,
                0,
            ],
            channels,
            16_000,
            channels * 2,
            16,
        )
        .expect("valid PCM format")
    }

    #[test]
    fn writer_patches_riff_and_data_sizes_and_preserves_frame_count() {
        let root = std::env::temp_dir().join(format!("StudyMind-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("capture.wav");
        let mut writer = WaveWriter::create(&path, pcm_format(1)).expect("create writer");
        writer
            .write_frames(&[1, 0, 2, 0], 2, false)
            .expect("write frames");
        let summary = writer.finish().expect("finish writer");

        assert_eq!(summary.valid_frame_count, 2);
        let bytes = std::fs::read(&path).expect("read wav");
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            (bytes.len() - 8) as u32
        );
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 4);
        assert_eq!(read_wave_info(&path).expect("read wav info").data_bytes, 4);

        std::fs::remove_dir_all(root).expect("remove temp root");
    }

    #[test]
    fn writer_accepts_valid_silence_but_rejects_frame_size_mismatch() {
        let root = std::env::temp_dir().join(format!("StudyMind-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("silence.wav");
        let mut writer = WaveWriter::create(&path, pcm_format(2)).expect("create writer");
        writer.write_silence(4).expect("write silence");
        assert!(writer.write_frames(&[0, 0], 2, false).is_err());
        let summary = writer.finish().expect("finish writer");
        assert!(summary.silent);
        assert_eq!(summary.valid_frame_count, 4);

        std::fs::remove_dir_all(root).expect("remove temp root");
    }

    #[test]
    fn reader_rejects_a_data_chunk_that_extends_past_the_file() {
        let root = std::env::temp_dir().join(format!("StudyMind-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("truncated.wav");
        let mut writer = WaveWriter::create(&path, pcm_format(1)).expect("create writer");
        writer
            .write_frames(&[1, 0, 2, 0], 2, false)
            .expect("write frames");
        writer.finish().expect("finish writer");

        let mut bytes = std::fs::read(&path).expect("read wav");
        bytes.truncate(bytes.len() - 2);
        std::fs::write(&path, bytes).expect("truncate wav");

        assert!(read_wave_info(&path).is_err());
        std::fs::remove_dir_all(root).expect("remove temp root");
    }
}
