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
