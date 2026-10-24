# ComfyUI-VRAM-Purge

Adds a **Purge VRAM** button to the ComfyUI main menu. It clears ComfyUI out of
VRAM **without restarting** the server — unlike the restart-menu pack, this one
just frees memory in place.

## Why two buttons

A normal "unload all models" frees the model weights and PyTorch's cached
allocations, but the **CUDA context** (a few hundred MB) stays resident for the
life of the process. That residual is the "VRAM squatting" you want gone.

| Button | What it does | What stays in VRAM |
| --- | --- | --- |
| **Purge VRAM** | Unload all models + `gc.collect()` + `torch.cuda.empty_cache()` + `ipc_collect()` | CUDA context (~0.2–1 GB) |
| **Purge VRAM (deep)** | Everything above **plus** `cudaDeviceReset()` to destroy the CUDA context | ~nothing (re-created on next generation) |

Use **deep** when you want ComfyUI *completely* out of VRAM (e.g. to hand the GPU
to another app). The context is lazily re-created the next time you generate, so
there is no penalty beyond a one-time re-init.

## How it works

The endpoint (`POST /vram_purge/purge`) runs, in order:

1. `comfy.model_management.unload_all_models()` — unloads every loaded model
   (checkpoint, CLIP, VAE, diffusion model, LoRA, controlnet, adapter,
   upscaler, ...).
2. `gc.collect()` — drops lingering Python references to CUDA tensors.
3. `comfy.model_management.soft_empty_cache(force=True)` — returns PyTorch's
   cached CUDA blocks to the driver (`synchronize` + `empty_cache` +
   `ipc_collect`).
4. *(deep only)* `cudaDeviceReset()` via ctypes — releases the CUDA context.
5. Reports a before/after VRAM snapshot. In deep mode it also reports a
   **driver-level** free/total reading (`cudaMemGetInfo`) so you can verify the
   context is actually gone — querying PyTorch after the reset would re-create
   the context and inflate the number.

All of this runs off the aiohttp event loop (`asyncio.to_thread`), so a slow
`cudaDeviceReset()` won't stall the UI.

## Install

Drop the folder into your `custom_nodes/` directory:

```
custom_nodes/ComfyUI-VRAM-Purge/
    __init__.py
    server_purge.py
    pyproject.toml
    web/
        purge_menu.js
```

Restart ComfyUI once (to load the extension), then the two buttons appear in the
main menu bar.

## Notes / caveats

- **NVIDIA only for deep mode.** `cudaDeviceReset()` and `libcuda.so.1` are
  NVIDIA. On AMD/ROCm the deep button will report that CUDA reset was skipped;
  the soft purge still works.
- **Deep mode is best-effort.** `cudaDeviceReset()` blocks until outstanding GPU
  work finishes. Click it when ComfyUI is idle (not mid-generation) to avoid a
  hang. If it fails, the response says so and nothing is broken — you just keep
  the context.
- **No restart.** The server keeps running; your workflow, queue, and loaded
  settings are untouched. Only GPU memory is released.
- The soft purge is the safe default and matches what ComfyUI's own "unload all
  models" machinery does.
