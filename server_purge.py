import gc

from aiohttp import web
from server import PromptServer

PURGE_ROUTE = "/vram_purge/purge"
_route_registered = False


def _gb(nbytes):
    """Bytes -> GB, rounded to 2 decimals."""
    return round(nbytes / (1024 ** 3), 2)


def _snapshot():
    """Per-device VRAM snapshot (PyTorch view), in GB.

    This is what ComfyUI itself sees: model weights + PyTorch's cached
    allocations + the live CUDA context.
    """
    import comfy.model_management as mm

    out = []
    for dev in mm.get_all_torch_devices():
        try:
            free = mm.get_free_memory(dev)
            total = mm.get_total_memory(dev)
            out.append({
                "device": str(dev),
                "total_gb": _gb(total),
                "free_gb": _gb(free),
                "used_gb": _gb(max(total - free, 0)),
            })
        except Exception as e:  # keep going if one device misbehaves
            out.append({"device": str(dev), "error": str(e)})
    return out


def _detect_backend():
    """Detect the GPU backend ComfyUI is using.

    Returns 'nvidia', 'amd', or 'other'. Reuses ComfyUI's own detection so
    it stays in sync with how ComfyUI sees the hardware.
    """
    try:
        import comfy.model_management as mm

        if mm.is_nvidia():
            return "nvidia"
        if mm.is_amd():
            return "amd"
    except Exception:
        pass
    return "other"


def _load_driver_lib(backend):
    """Load the vendor driver library for the given backend.

    NVIDIA: libcuda.so.1 (Driver + Runtime API).
    AMD:    libhip.so / libhiphost.so (HIP runtime, CUDA-compatible).
    Returns a ctypes CDLL, or None if it cannot be loaded.
    """
    import ctypes

    candidates = {
        "nvidia": ("libcuda.so.1", "libcuda.so"),
        "amd": ("libhip.so", "libhiphost.so"),
    }.get(backend, ())
    for name in candidates:
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


def _driver_mem():
    """Ground-truth VRAM from the vendor driver, bypassing PyTorch.

    Important: querying PyTorch after a device reset would lazily
    re-create the context and inflate the number. The driver call does
    not, so this is the honest 'what is actually in VRAM' reading.

    NVIDIA: cudaMemGetInfo / cuMemGetInfo_v2.
    AMD:    hipMemGetInfo.
    """
    backend = _detect_backend()
    if backend not in ("nvidia", "amd"):
        return None
    lib = _load_driver_lib(backend)
    if lib is None:
        return None
    try:
        import ctypes

        free = ctypes.c_size_t(0)
        total = ctypes.c_size_t(0)
        if backend == "nvidia":
            if hasattr(lib, "cudaMemGetInfo"):
                rc = lib.cudaMemGetInfo(ctypes.byref(free), ctypes.byref(total))
            elif hasattr(lib, "cuMemGetInfo_v2"):
                rc = lib.cuMemGetInfo_v2(ctypes.byref(free), ctypes.byref(total))
            else:
                return None
        else:  # amd
            if hasattr(lib, "hipMemGetInfo"):
                rc = lib.hipMemGetInfo(ctypes.byref(free), ctypes.byref(total))
            else:
                return None
        if rc == 0:
            return {
                "free_gb": _gb(free.value),
                "total_gb": _gb(total.value),
                "used_gb": _gb(max(total.value - free.value, 0)),
            }
    except Exception:
        pass
    return None


def _reset_context():
    """Aggressively release the GPU context (deep purge).

    A normal unload frees model weights and PyTorch's cached blocks, but
    the GPU context itself (a few hundred MB) stays resident for the
    life of the process -- that is the 'squatting'. A device reset drops
    it. Best effort: returns (ok, note).

    NVIDIA: cudaDeviceReset / cuDeviceReset via libcuda.so.1.
    AMD:    hipDeviceReset via libhip.so.
    Others: no C-level reset available, so deep == soft there.
    """
    backend = _detect_backend()
    if backend not in ("nvidia", "amd"):
        return False, f"context reset not available on this backend ({backend})"
    import torch

    try:
        torch.cuda.synchronize()
        lib = _load_driver_lib(backend)
        if lib is None:
            return False, f"could not load driver library for {backend}"
        if backend == "nvidia":
            if hasattr(lib, "cudaDeviceReset"):
                rc, name = lib.cudaDeviceReset(), "cudaDeviceReset()"
            elif hasattr(lib, "cuDeviceReset"):
                rc, name = lib.cuDeviceReset(), "cuDeviceReset()"
            else:
                return False, "neither cudaDeviceReset nor cuDeviceReset available"
        else:  # amd
            if hasattr(lib, "hipDeviceReset"):
                rc, name = lib.hipDeviceReset(), "hipDeviceReset()"
            else:
                return False, "hipDeviceReset not available"
        # cudaSuccess / HIP_SUCCESS == 0
        if rc == 0:
            return True, f"{name} succeeded"
        return False, f"{name} returned code {rc}"
    except Exception as e:
        return False, f"device reset failed: {e}"


def _purge(deep):
    """Do the actual (blocking) purge work off the event loop."""
    import comfy.model_management as mm

    before = _snapshot()

    # 1. Unload every loaded model: checkpoint, CLIP, VAE, diffusion,
    #    LoRA, controlnet, adapter, upscaler, ...
    mm.unload_all_models()

    # 2. Force Python GC to drop lingering references to CUDA tensors.
    gc.collect()

    # 3. Return PyTorch's cached CUDA blocks to the driver.
    mm.soft_empty_cache(force=True)

    context_reset = None
    driver = None
    if deep:
        context_reset = _reset_context()
        driver = _driver_mem()

    after = _snapshot()

    return {
        "status": "purged",
        "deep": deep,
        "backend": _detect_backend(),
        "context_reset": context_reset,
        "before": before,
        "after": after,
        "driver": driver,
    }


async def _handle_purge(request):
    deep = False
    try:
        data = await request.json()
        deep = bool(data.get("deep", False))
    except Exception:
        deep = False

    # Run directly in the handler (like the restart pack does). A deep
    # purge can block briefly during synchronize/cudaDeviceReset; that is
    # acceptable for a one-off action and avoids torch-in-a-thread edge cases.
    result = _purge(deep)
    return web.json_response(result)


def register_purge_route():
    global _route_registered
    if _route_registered:
        return
    PromptServer.instance.routes.post(PURGE_ROUTE)(_handle_purge)
    _route_registered = True
