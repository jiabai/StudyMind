"""Compute resource throttling for the StudyMind worker.

Step 2 (ASR transcription) runs heavy neural inference. Without limits it
saturates the machine's GPU (when funasr defaults to CUDA) or all CPU cores,
which starves the Windows Desktop Window Manager (DWM) and produces the
system-wide window refresh / stutter that ordinary users see.

These helpers reserve headroom so the OS UI stays responsive:

- cap inference thread pools to ``cpu_count - RESERVED_CORES``;
- pin the PyTorch/funasr path to CPU so the discrete GPU stays free for DWM;
- lower the worker process priority on Windows (best-effort) so the OS
  scheduler always favours the interactive UI over the background worker.

It also exposes the commit-charge probe used to explain out-of-memory ASR
failures, since the same page-file ceiling that limits the worker is what
starves a multi-gigabyte model load.
"""

from __future__ import annotations

import os
import sys

# Cores left free for the OS / desktop compositor (DWM) and other apps.
RESERVED_CORES = 2

_CPU_COUNT = os.cpu_count() or 1
# Threads the inference engines are allowed to use.
RESERVED_THREADS = max(1, _CPU_COUNT - RESERVED_CORES)

# Default device for the PyTorch/funasr ASR path. Pinning to CPU keeps the
# discrete GPU free for the DWM compositor, eliminating GPU-based stutter.
# Flip to "cuda:0" only if you intentionally want GPU acceleration.
DEFAULT_ASR_DEVICE = "cpu"

# Windows process priority class that yields to the interactive UI.
BELOW_NORMAL_PRIORITY_CLASS = 0x00004000


def apply_process_throttle() -> None:
    """Call once at process entry: set thread env vars and lower priority."""
    for var in (
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
    ):
        os.environ.setdefault(var, str(RESERVED_THREADS))
    _lower_process_priority()


def _lower_process_priority() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.SetPriorityClass(
            kernel32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS
        )
    except Exception:
        # Best-effort: never let throttling break the worker.
        pass


def cap_torch_threads() -> None:
    try:
        import torch

        torch.set_num_threads(RESERVED_THREADS)
    except Exception:
        pass


def cap_onnx_threads() -> None:
    try:
        import onnxruntime as ort

        ort.set_default_intra_op_num_threads(RESERVED_THREADS)
        ort.set_default_inter_op_num_threads(1)
    except Exception:
        pass


def available_commit_bytes() -> int | None:
    """Commit charge this process can still claim, or ``None`` if unreadable.

    On Windows the commit limit is physical memory plus page file, so this is
    the figure that decides whether a multi-gigabyte ``torch`` / ``funasr``
    import can succeed. Diagnostic only, and best-effort by design.
    """

    if sys.platform != "win32":
        return None
    try:
        import ctypes

        class _MemoryStatusEx(ctypes.Structure):
            _fields_ = (
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            )

        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(_MemoryStatusEx)
        kernel32 = ctypes.windll.kernel32
        if not kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
        return int(status.ullAvailPageFile)
    except Exception:
        # Best-effort: diagnostics must never break the worker.
        return None


def describe_available_memory() -> str | None:
    """Single-line memory snapshot for diagnostics, or ``None`` if unreadable."""

    available = available_commit_bytes()
    if available is None:
        return None
    return f"Commit available when it failed: {available / (1024**3):.2f} GB"
