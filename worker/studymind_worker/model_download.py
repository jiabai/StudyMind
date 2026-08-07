from __future__ import annotations

import hashlib
import logging
import shutil
import stat
import tarfile
import tempfile
import urllib.request
import zipfile
from collections.abc import Callable, Mapping
from pathlib import Path
from uuid import uuid4

from modelscope.hub.callback import ProgressCallback as ModelScopeProgressCallback
from modelscope.hub.snapshot_download import snapshot_download

from studymind_worker.progress_events import (
    build_model_progress_event,
    safe_current_file_basename,
)

SENSEVOICE_MODEL_ID = "iic/SenseVoiceSmall"
VAD_MODEL_ID = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
ONNX_SENSEVOICE_MODEL_ID = "iic/SenseVoiceSmall-onnx"
ONNX_VAD_MODEL_ID = "iic/speech_fsmn_vad_zh-cn-16k-common-onnx"
ONNX_SENSEVOICE_BPE_MODEL_ID = SENSEVOICE_MODEL_ID
DEFAULT_SENSEVOICE_REVISION = "master"
MODEL_VERSION_FILE_NAME = "MODEL_VERSION.txt"
MODEL_DOWNLOAD_ERROR_CODE = "ASR_MODEL_DOWNLOAD_FAILED"
ARCHIVE_INVALID_ERROR_CODE = "ASR_MODEL_ARCHIVE_INVALID"

ModelDownloadEventCallback = Callable[[dict[str, object]], None]
SnapshotDownloader = Callable[..., str]
LOGGER = logging.getLogger(__name__)
KNOWN_MODEL_RELATIVE_DIRS = (
    Path("iic") / "SenseVoiceSmall",
    Path("iic") / "speech_fsmn_vad_zh-cn-16k-common-pytorch",
)
ONNX_CACHE_DIR_NAME = "onnx"
ONNX_BPE_FILE_NAME = "chn_jpn_yue_eng_ko_spectok.bpe.model"
ONNX_REQUIRED_ASSET_HASHES: dict[Path, str] = {
    Path("models/iic/SenseVoiceSmall-onnx/am.mvn"):
        "29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5",
    Path("models/iic/SenseVoiceSmall-onnx/config.yaml"):
        "f71e239ba36705564b5bf2d2ffd07eece07b8e3f2bbf6d2c99d8df856339ac19",
    Path("models/iic/SenseVoiceSmall-onnx/configuration.json"):
        "c57f6a580d63f7465c6a22ba95847aee05a1ae1181f5abddffb943d9febda061",
    Path("models/iic/SenseVoiceSmall-onnx/model_quant.onnx"):
        "21dc965f689a78d1604717bf561e40d5a236087c85a95584567835750549e822",
    Path("models/iic/SenseVoiceSmall-onnx/tokens.json"):
        "a2594fc1474e78973149cba8cd1f603ebed8c39c7decb470631f66e70ce58e97",
    Path(f"models/iic/SenseVoiceSmall-onnx/{ONNX_BPE_FILE_NAME}"):
        "aa87f86064c3730d799ddf7af3c04659151102cba548bce325cf06ba4da4e6a8",
    Path("models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx/model_quant.onnx"):
        "5289eb2aa3c9af2d7a4284bcfa7c3ceb81d360814ed4203239b6c5d0569da8a1",
}


class ModelDownloadError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def validate_asr_model_cache(
    cache_dir: Path,
    model_name: str = SENSEVOICE_MODEL_ID,
    onnx_asset_hashes: Mapping[Path, str] | None = None,
) -> bool:
    if model_name == ONNX_SENSEVOICE_MODEL_ID:
        return _validate_onnx_model_cache(
            Path(cache_dir) / ONNX_CACHE_DIR_NAME,
            onnx_asset_hashes,
        )
    if model_name != SENSEVOICE_MODEL_ID:
        return False
    marker = cache_dir / MODEL_VERSION_FILE_NAME
    if not marker.is_file() or not _has_required_model_files(cache_dir):
        return False

    try:
        marker_text = marker.read_text(encoding="utf-8")
    except OSError:
        return False
    return SENSEVOICE_MODEL_ID in marker_text and VAD_MODEL_ID in marker_text


def normalize_asr_model_cache_layout(cache_dir: Path) -> None:
    """Best-effort migration from legacy top-level ModelScope cache layout."""
    cache_dir = Path(cache_dir)
    canonical_root = _canonical_model_root(cache_dir)
    canonical_complete = _has_required_model_files_in_root(canonical_root)
    legacy_complete = _has_required_model_files_in_root(cache_dir)

    if not canonical_complete and legacy_complete:
        _copy_known_model_dirs(cache_dir, canonical_root)
        canonical_complete = _has_required_model_files_in_root(canonical_root)

    if canonical_complete:
        _remove_known_legacy_model_dirs(cache_dir)
        _remove_empty_legacy_vendor_dir(cache_dir)

    _remove_stale_temp_dirs(cache_dir)


def _has_required_model_files(cache_dir: Path) -> bool:
    for model_root in (cache_dir, cache_dir / "models"):
        if _has_required_model_files_in_root(model_root):
            return True
    return False


def _has_required_model_files_in_root(model_root: Path) -> bool:
    sensevoice_model = model_root / "iic" / "SenseVoiceSmall" / "model.pt"
    vad_model = model_root / "iic" / "speech_fsmn_vad_zh-cn-16k-common-pytorch" / "model.pt"
    return sensevoice_model.is_file() and vad_model.is_file()


def _canonical_model_root(cache_dir: Path) -> Path:
    return cache_dir / "models"


def _copy_known_model_dirs(source_root: Path, target_root: Path) -> None:
    for relative_dir in KNOWN_MODEL_RELATIVE_DIRS:
        source = source_root / relative_dir
        target = target_root / relative_dir
        if not source.exists():
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(source, target)
        except OSError:
            LOGGER.warning(
                "Failed to copy ASR model cache directory %s to %s.",
                source,
                target,
                exc_info=True,
            )


def _remove_known_legacy_model_dirs(cache_dir: Path) -> None:
    for relative_dir in KNOWN_MODEL_RELATIVE_DIRS:
        legacy_dir = cache_dir / relative_dir
        if not legacy_dir.exists():
            continue
        try:
            shutil.rmtree(legacy_dir)
        except OSError:
            LOGGER.warning(
                "Failed to remove duplicate legacy ASR model cache directory %s.",
                legacy_dir,
                exc_info=True,
            )


def _remove_empty_legacy_vendor_dir(cache_dir: Path) -> None:
    legacy_vendor_dir = cache_dir / "iic"
    try:
        if legacy_vendor_dir.is_dir() and not any(legacy_vendor_dir.iterdir()):
            legacy_vendor_dir.rmdir()
    except OSError:
        LOGGER.warning(
            "Failed to remove empty legacy ASR model vendor directory %s.",
            legacy_vendor_dir,
            exc_info=True,
        )


def _remove_stale_temp_dirs(cache_dir: Path) -> None:
    for temp_dir in (cache_dir / "._____temp", _canonical_model_root(cache_dir) / "._____temp"):
        if not temp_dir.is_dir():
            continue
        try:
            has_model_file = any(
                path.is_file() and path.name == "model.pt" for path in temp_dir.rglob("*")
            )
            if not has_model_file:
                shutil.rmtree(temp_dir)
        except OSError:
            LOGGER.warning(
                "Failed to remove stale ASR model temporary directory %s.",
                temp_dir,
                exc_info=True,
            )


def download_asr_model_cache(
    cache_dir: Path,
    model_name: str = SENSEVOICE_MODEL_ID,
    download_url: str | None = None,
    expected_sha256: str | None = None,
    revision: str | None = None,
    endpoint: str | None = None,
    snapshot_downloader: SnapshotDownloader = snapshot_download,
    progress_callback: ModelDownloadEventCallback | None = None,
    onnx_asset_hashes: Mapping[Path, str] | None = None,
) -> Path:
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    if model_name == ONNX_SENSEVOICE_MODEL_ID:
        if download_url or expected_sha256 or revision or endpoint:
            raise ModelDownloadError(
                ARCHIVE_INVALID_ERROR_CODE,
                "SenseVoiceSmall-ONNX only supports its fixed official ModelScope source.",
            )
        return _download_onnx_model_cache(
            cache_dir=cache_dir,
            endpoint=None,
            snapshot_downloader=snapshot_downloader,
            progress_callback=progress_callback,
            asset_hashes=ONNX_REQUIRED_ASSET_HASHES
            if onnx_asset_hashes is None
            else onnx_asset_hashes,
        )
    if model_name != SENSEVOICE_MODEL_ID:
        raise ModelDownloadError(ARCHIVE_INVALID_ERROR_CODE, "Unsupported ASR model.")
    _emit(
        progress_callback,
        "model.download.preparing",
        "started",
        0,
        message_args={"model": SENSEVOICE_MODEL_ID},
    )

    if download_url:
        _download_custom_archive(
            cache_dir=cache_dir,
            download_url=download_url,
            expected_sha256=expected_sha256,
            progress_callback=progress_callback,
        )
    else:
        _download_from_modelscope(
            cache_dir=cache_dir,
            revision=revision,
            endpoint=endpoint,
            snapshot_downloader=snapshot_downloader,
            progress_callback=progress_callback,
        )

    _write_model_version(cache_dir, revision=revision)
    normalize_asr_model_cache_layout(cache_dir)
    if not validate_asr_model_cache(cache_dir):
        raise ModelDownloadError(
            ARCHIVE_INVALID_ERROR_CODE,
            "Downloaded ASR model cache is incomplete.",
        )

    _emit(
        progress_callback,
        "model.download.completed",
        "completed",
        100,
        message_args={"model": SENSEVOICE_MODEL_ID},
    )
    return cache_dir


def _download_onnx_model_cache(
    cache_dir: Path,
    endpoint: str | None,
    snapshot_downloader: SnapshotDownloader,
    progress_callback: ModelDownloadEventCallback | None,
    asset_hashes: Mapping[Path, str],
) -> Path:
    ready_dir = cache_dir / ONNX_CACHE_DIR_NAME
    if _validate_onnx_model_cache(ready_dir, asset_hashes):
        return ready_dir

    _emit(
        progress_callback,
        "model.download.preparing",
        "started",
        0,
        message_args={"model": ONNX_SENSEVOICE_MODEL_ID},
    )
    staging_dir = cache_dir / f".{ONNX_CACHE_DIR_NAME}-staging-{uuid4().hex}"
    try:
        model_root = staging_dir / "models"
        _download_onnx_modelscope_assets(
            model_root=model_root,
            endpoint=endpoint,
            snapshot_downloader=snapshot_downloader,
            progress_callback=progress_callback,
        )
        _place_onnx_bpe_asset(model_root)
        _write_model_version(
            staging_dir,
            revision=DEFAULT_SENSEVOICE_REVISION,
            model_name=ONNX_SENSEVOICE_MODEL_ID,
            vad_model=ONNX_VAD_MODEL_ID,
        )
        if not _validate_onnx_model_cache(staging_dir, asset_hashes):
            raise ModelDownloadError(
                ARCHIVE_INVALID_ERROR_CODE,
                "Downloaded ONNX ASR model cache is incomplete or invalid.",
            )
        _promote_onnx_cache(staging_dir, ready_dir)
    except ModelDownloadError:
        raise
    except OSError as exc:
        raise ModelDownloadError(
            MODEL_DOWNLOAD_ERROR_CODE,
            "Failed to prepare the ONNX ASR model cache.",
        ) from exc
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

    _emit(
        progress_callback,
        "model.download.completed",
        "completed",
        100,
        message_args={"model": ONNX_SENSEVOICE_MODEL_ID},
    )
    return ready_dir


def _download_onnx_modelscope_assets(
    model_root: Path,
    endpoint: str | None,
    snapshot_downloader: SnapshotDownloader,
    progress_callback: ModelDownloadEventCallback | None,
) -> None:
    _emit(
        progress_callback,
        "model.primary.downloading",
        "downloading",
        8,
        message_args={"model": ONNX_SENSEVOICE_MODEL_ID},
    )
    snapshot_downloader(
        model_id=ONNX_SENSEVOICE_MODEL_ID,
        revision=DEFAULT_SENSEVOICE_REVISION,
        cache_dir=model_root,
        endpoint=endpoint,
        progress_callbacks=[_make_modelscope_progress_callback(progress_callback, 10, 58)],
    )
    _emit(
        progress_callback,
        "model.vad.downloading",
        "downloading",
        70,
        message_args={"model": ONNX_VAD_MODEL_ID},
    )
    snapshot_downloader(
        model_id=ONNX_VAD_MODEL_ID,
        revision=DEFAULT_SENSEVOICE_REVISION,
        cache_dir=model_root,
        endpoint=endpoint,
        progress_callbacks=[_make_modelscope_progress_callback(progress_callback, 70, 18)],
    )
    _emit(
        progress_callback,
        "model.bpe.downloading",
        "downloading",
        88,
        message_args={"model": ONNX_SENSEVOICE_BPE_MODEL_ID},
    )
    snapshot_downloader(
        model_id=ONNX_SENSEVOICE_BPE_MODEL_ID,
        revision=DEFAULT_SENSEVOICE_REVISION,
        cache_dir=model_root,
        endpoint=endpoint,
        allow_patterns=[ONNX_BPE_FILE_NAME],
        progress_callbacks=[_make_modelscope_progress_callback(progress_callback, 88, 10)],
    )


def _place_onnx_bpe_asset(model_root: Path) -> None:
    source = model_root / "iic" / "SenseVoiceSmall" / ONNX_BPE_FILE_NAME
    destination = model_root / "iic" / "SenseVoiceSmall-onnx" / ONNX_BPE_FILE_NAME
    if not source.is_file() or not destination.parent.is_dir():
        raise ModelDownloadError(
            ARCHIVE_INVALID_ERROR_CODE,
            "Official SenseVoice BPE asset was unavailable.",
        )
    shutil.copy2(source, destination)
    source_dir = source.parent
    if source_dir.exists():
        shutil.rmtree(source_dir)


def _validate_onnx_model_cache(
    cache_dir: Path,
    asset_hashes: Mapping[Path, str] | None = None,
) -> bool:
    marker = cache_dir / MODEL_VERSION_FILE_NAME
    required_files = (
        cache_dir / "models/iic/SenseVoiceSmall-onnx/model_quant.onnx",
        cache_dir / "models/iic/SenseVoiceSmall-onnx/config.yaml",
        cache_dir / "models/iic/SenseVoiceSmall-onnx/am.mvn",
        cache_dir / "models/iic/SenseVoiceSmall-onnx/tokens.json",
        cache_dir / "models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx/model_quant.onnx",
        cache_dir / "models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx/config.yaml",
        cache_dir / "models/iic/speech_fsmn_vad_zh-cn-16k-common-onnx/am.mvn",
        cache_dir / f"models/iic/SenseVoiceSmall-onnx/{ONNX_BPE_FILE_NAME}",
    )
    if not marker.is_file() or not all(path.is_file() for path in required_files):
        return False
    try:
        marker_text = marker.read_text(encoding="utf-8")
    except OSError:
        return False
    if ONNX_SENSEVOICE_MODEL_ID not in marker_text or ONNX_VAD_MODEL_ID not in marker_text:
        return False
    hashes = ONNX_REQUIRED_ASSET_HASHES if asset_hashes is None else asset_hashes
    return all(
        _file_sha256(cache_dir / relative_path) == expected_hash
        for relative_path, expected_hash in hashes.items()
    )


def _file_sha256(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _promote_onnx_cache(staging_dir: Path, ready_dir: Path) -> None:
    backup_dir = ready_dir.with_name(f".{ready_dir.name}-backup-{uuid4().hex}")
    if ready_dir.exists():
        ready_dir.replace(backup_dir)
    try:
        staging_dir.replace(ready_dir)
    except OSError:
        if backup_dir.exists() and not ready_dir.exists():
            backup_dir.replace(ready_dir)
        raise
    if backup_dir.exists():
        shutil.rmtree(backup_dir, ignore_errors=True)


def _download_from_modelscope(
    cache_dir: Path,
    revision: str | None,
    endpoint: str | None,
    snapshot_downloader: SnapshotDownloader,
    progress_callback: ModelDownloadEventCallback | None,
) -> None:
    sensevoice_revision = revision or DEFAULT_SENSEVOICE_REVISION
    modelscope_cache_dir = _canonical_model_root(cache_dir)
    _emit(
        progress_callback,
        "model.primary.downloading",
        "downloading",
        8,
        message_args={"model": SENSEVOICE_MODEL_ID},
    )
    snapshot_downloader(
        model_id=SENSEVOICE_MODEL_ID,
        revision=sensevoice_revision,
        cache_dir=modelscope_cache_dir,
        endpoint=endpoint,
        progress_callbacks=[_make_modelscope_progress_callback(progress_callback, 10, 72)],
    )

    _emit(
        progress_callback,
        "model.vad.downloading",
        "downloading",
        82,
        message_args={"model": VAD_MODEL_ID},
    )
    snapshot_downloader(
        model_id=VAD_MODEL_ID,
        revision=DEFAULT_SENSEVOICE_REVISION,
        cache_dir=modelscope_cache_dir,
        endpoint=endpoint,
        progress_callbacks=[_make_modelscope_progress_callback(progress_callback, 82, 14)],
    )


def _download_custom_archive(
    cache_dir: Path,
    download_url: str,
    expected_sha256: str | None,
    progress_callback: ModelDownloadEventCallback | None,
) -> None:
    with tempfile.TemporaryDirectory(prefix="StudyMind-asr-model-") as temp_dir_text:
        temp_dir = Path(temp_dir_text)
        archive_path = _resolve_archive(download_url, temp_dir, progress_callback)
        if expected_sha256:
            _verify_sha256(archive_path, expected_sha256)

        extract_dir = temp_dir / "extract"
        extract_dir.mkdir()
        _emit(progress_callback, "model.archive.extracting", "extracting", 76)
        _extract_archive_safely(archive_path, extract_dir)
        if not (extract_dir / "models" / "iic" / "SenseVoiceSmall" / "model.pt").is_file():
            raise ModelDownloadError(
                ARCHIVE_INVALID_ERROR_CODE,
                "Custom ASR archive must contain models/iic/SenseVoiceSmall/model.pt.",
            )
        if not (
            extract_dir
            / "models"
            / "iic"
            / "speech_fsmn_vad_zh-cn-16k-common-pytorch"
            / "model.pt"
        ).is_file():
            raise ModelDownloadError(
                ARCHIVE_INVALID_ERROR_CODE,
                "Custom ASR archive must contain the SenseVoice VAD model cache.",
            )

        _copy_directory_contents(extract_dir, cache_dir)


def _resolve_archive(
    download_url: str,
    temp_dir: Path,
    progress_callback: ModelDownloadEventCallback | None,
) -> Path:
    local_path = Path(download_url)
    if local_path.is_file():
        _emit(progress_callback, "model.archive.reading", "downloading", 20)
        return local_path

    archive_path = temp_dir / "model-archive"
    _emit(progress_callback, "model.archive.downloading", "downloading", 20)
    try:
        urllib.request.urlretrieve(download_url, archive_path)
    except OSError as exc:
        raise ModelDownloadError(
            MODEL_DOWNLOAD_ERROR_CODE,
            f"Failed to download ASR model archive: {exc}",
        ) from exc
    return archive_path


def _verify_sha256(path: Path, expected_sha256: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)

    actual = digest.hexdigest().lower()
    if actual != expected_sha256.lower():
        raise ModelDownloadError(
            ARCHIVE_INVALID_ERROR_CODE,
            f"ASR model archive SHA256 mismatch: expected {expected_sha256}, got {actual}.",
        )


def _extract_archive_safely(archive_path: Path, destination: Path) -> None:
    if zipfile.is_zipfile(archive_path):
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                _ensure_safe_member_path(destination, member.filename)
                _ensure_supported_zip_member(member)
            archive.extractall(destination)
        return

    try:
        with tarfile.open(archive_path) as archive:
            for member in archive.getmembers():
                _ensure_safe_member_path(destination, member.name)
                _ensure_supported_tar_member(member)
            archive.extractall(destination)
    except tarfile.TarError as exc:
        raise ModelDownloadError(
            ARCHIVE_INVALID_ERROR_CODE,
            f"ASR model archive is not a supported zip/tar file: {exc}",
        ) from exc


def _ensure_safe_member_path(destination: Path, member_name: str) -> None:
    target = (destination / member_name).resolve()
    destination_root = destination.resolve()
    if destination_root != target and destination_root not in target.parents:
        raise ModelDownloadError(
            ARCHIVE_INVALID_ERROR_CODE,
            f"ASR model archive contains an unsafe path: {member_name}",
        )


def _ensure_supported_zip_member(member: zipfile.ZipInfo) -> None:
    mode = (member.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type in (0, stat.S_IFREG, stat.S_IFDIR):
        return

    raise ModelDownloadError(
        ARCHIVE_INVALID_ERROR_CODE,
        f"ASR model archive contains an unsupported zip member: {member.filename}",
    )


def _ensure_supported_tar_member(member: tarfile.TarInfo) -> None:
    if member.isfile() or member.isdir():
        return

    raise ModelDownloadError(
        ARCHIVE_INVALID_ERROR_CODE,
        f"ASR model archive contains an unsupported tar member: {member.name}",
    )


def _copy_directory_contents(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for source_path in source.iterdir():
        target_path = destination / source_path.name
        if source_path.is_dir():
            if target_path.exists():
                shutil.rmtree(target_path)
            shutil.copytree(source_path, target_path)
        else:
            shutil.copy2(source_path, target_path)


def _write_model_version(
    cache_dir: Path,
    revision: str | None,
    model_name: str = SENSEVOICE_MODEL_ID,
    vad_model: str = VAD_MODEL_ID,
) -> None:
    cache_dir.joinpath(MODEL_VERSION_FILE_NAME).write_text(
        "\n".join(
            [
                f"model={model_name}",
                f"vad={vad_model}",
                f"revision={revision or DEFAULT_SENSEVOICE_REVISION}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _make_modelscope_progress_callback(
    progress_callback: ModelDownloadEventCallback | None,
    start: int,
    span: int,
) -> type[ModelScopeProgressCallback]:
    class StudyMindModelScopeProgressCallback(ModelScopeProgressCallback):
        def __init__(self, filename: str, file_size: int) -> None:
            super().__init__(filename, file_size)
            self.downloaded = 0

        def update(self, size: int) -> None:
            if progress_callback is None:
                return
            self.downloaded += size
            if self.file_size > 0:
                file_progress = min(1.0, self.downloaded / self.file_size)
                progress = start + int(span * file_progress)
            else:
                progress = start
            _emit(
                progress_callback,
                "model.file.downloading",
                "downloading",
                min(99, progress),
                current_file=safe_current_file_basename(self.filename),
            )

        def end(self) -> None:
            if progress_callback is None:
                return
            _emit(
                progress_callback,
                "model.file.completed",
                "downloading",
                min(99, start + span),
                current_file=safe_current_file_basename(self.filename),
            )

    return StudyMindModelScopeProgressCallback


def _emit(
    callback: ModelDownloadEventCallback | None,
    message_code: str,
    status: str,
    progress: int,
    current_file: str | None = None,
    message_args: dict[str, str | int] | None = None,
) -> None:
    if callback is None:
        return
    event = build_model_progress_event(
        message_code,
        status=status,
        progress=progress,
        current_file=current_file,
        message_args=message_args,
    )
    callback(event)
