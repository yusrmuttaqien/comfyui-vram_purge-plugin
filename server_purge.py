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


def _load_cuda_driver():
    """Load the CUDA driver library (libcuda.so.1).

    Returns a ctypes CDLL, or None if it cannot be loaded.
    """
    import ctypes

    for name in ("libcuda.so.1", "libcuda.so"):
        try:
            return ctypes.CDLL(name)
        except OSError:
            continue
    return None


def _driver_mem():
    """Ground-truth VRAM from the CUDA driver, bypassing PyTorch.

    Important: querying PyTorch after a device reset would lazily
    re-create the context and inflate the number. The driver call does
    not, so this is the honest 'what is actually in VRAM' reading.

    Tries the Runtime API (cudaMemGetInfo) first, then the Driver API
    (cuMemGetInfo_v2) -- some builds of libcuda.so.1 only export the
    latter.
    """
    lib = _load_cuda_driver()
    if lib is None:
        return None
    try:
        import ctypes

        free = ctypes.c_size_t(0)
        total = ctypes.c_size_t(0)
        if hasattr(lib, "cudaMemGetInfo"):
            rc = lib.cudaMemGetInfo(ctypes.byref(free), ctypes.byref(total))
        elif hasattr(lib, "cuMemGetInfo_v2"):
            rc = lib.cuMemGetInfo_v2(ctypes.byref(free), ctypes.byref(total))
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


def _reset_cuda_context():
    """Aggressively release the CUDA context.

    A normal unload frees model weights and PyTorch's cached blocks, but
    the CUDA context itself (a few hundred MB) stays resident for the
    life of the process -- that is the 'squatting'. A device reset drops
    it. Best effort: returns (ok, note).

    Tries the Runtime API (cudaDeviceReset) first, then the Driver API
    (cuDeviceReset) -- some builds of libcuda.so.1 only export the
    latter.
    """
    import torch

    if not torch.cuda.is_available():
        return False, "CUDA not available"
    try:
        torch.cuda.synchronize()
        lib = _load_cuda_driver()
        if lib is None:
            return False, "could not load libcuda.so.1"
        if hasattr(lib, "cudaDeviceReset"):
            rc = lib.cudaDeviceReset()
            name = "cudaDeviceReset()"
        elif hasattr(lib, "cuDeviceReset"):
            rc = lib.cuDeviceReset()
            name = "cuDeviceReset()"
        else:
            return False, "neither cudaDeviceReset nor cuDeviceReset available"
        # cudaSuccess / CUDA_SUCCESS == 0
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
        context_reset = _reset_cuda_context()
        driver = _driver_mem()

    after = _snapshot()

    return {
        "status": "purged",
        "deep": deep,
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
