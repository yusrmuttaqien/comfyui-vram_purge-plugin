# ComfyUI-VRAM-Purge

Adds a **Purge VRAM** button to the ComfyUI main menu. It clears ComfyUI out of
VRAM **without restarting** the server - unlike the restart-menu pack, this one
just frees memory in place.

## Why two buttons

A normal "unload all models" frees the model weights and PyTorch's cached
allocations, but the **CUDA context** (a few hundred MB) stays resident for the
life of the process. That residual is the "VRAM squatting" you want gone.

| Button | What it does | What stays in VRAM |
| --- | --- | --- |
| **Purge VRAM** | Unload all models + `gc.collect()` + `torch.cuda.empty_cache()` + `ipc_collect()` | GPU context (~0.2–1 GB) |
| **Purge VRAM (deep)** | Everything above **plus** a device reset to destroy the GPU context | ~nothing (re-created on next generation) |

Use **deep** when you want ComfyUI *completely* out of VRAM (e.g. to hand the GPU
to another app). The context is lazily re-created the next time you generate, so
there is no penalty beyond a one-time re-init.

## How it works

The endpoint (`POST /vram_purge/purge`) runs, in order:

1. `comfy.model_management.unload_all_models()` - unloads every loaded model
   (checkpoint, CLIP, VAE, diffusion model, LoRA, controlnet, adapter,
   upscaler, ...).
2. `gc.collect()` - drops lingering Python references to CUDA tensors.
3. `comfy.model_management.soft_empty_cache(force=True)` - returns PyTorch's
   cached CUDA blocks to the driver (`synchronize` + `empty_cache` +
   `ipc_collect`).
4. *(deep only)* a device reset via ctypes - releases the GPU context.
   NVIDIA: `cuDeviceReset` / `cudaDeviceReset` via `libcuda.so.1`.
   AMD: `hipDeviceReset` via `libhip.so`.
   Other backends: skipped (no C-level reset), so deep == soft there.
5. Reports a before/after VRAM snapshot. In deep mode it also reports a
   **driver-level** free/total reading (`cuMemGetInfo_v2` / `hipMemGetInfo`) so
   you can verify the context is actually gone - querying PyTorch after the reset
   would re-create the context and inflate the number.

## Install

Drop the folder into your `custom_nodes/` directory:

```
custom_nodes/ComfyUI-VRAM-Purge/
    __init__.py
    server_purge.py
    server_ninfer.py
    pyproject.toml
    web/
        purge_menu.js
        ninfer_gate.js
```

Restart ComfyUI once (to load the extension), then the two buttons appear in the
main menu bar.

## NInfer Suspend Gate

A node that frees GPU memory for ComfyUI by suspending selected NInfer models on queue.

- Set the **NInfer URL** (e.g. `http://host:30001`).
- The node lists NInfer models with their status. **loaded** models are
  selectable (checked by default). **Select all** / **Deselect all** for bulk
  control. Model state is refreshed on demand (hover, URL change, Run, hold
  start/end) - it is never polled.
- On Run, each checked loaded model is suspended
  (`POST /v1/models/{id}/suspend`) and the prompt is held until every suspend
  completes.
- Further Run clicks during a hold **join** it: all held prompts are queued in
  click order as soon as the last suspend finishes.
- If NInfer is busy (`409 model_busy`) the gate waits and retries every 5 s
  until it idles or the **busy timeout** elapses (default *indefinite*, or a
  number of minutes).
- While a hold is active, the node and the top-bar button show live status
  ("Suspending…", "NInfer busy - waiting…", "✓ Queued N prompt(s) · gate Ns").
  **Cancel** drops the held prompts; **Skip** queues them without suspending.
- Suspended models stay suspended (this plugin never resumes them). If NInfer's
  `auto_resume` reloads a model later, the next Run suspends it again.
- NInfer calls go through a Python proxy (`/comfort/ninfer/forward`) to avoid
  CORS between the browser and NInfer.
- A top-bar **NInfer** button appears while a gate is in the current graph.
  Clicking it focuses and zooms to the gate; a spinner and live label show
  while a hold is in progress.
- **Bypass / mute deactivates a gate.** When the node's mode is anything but
  *Always* (right-click → *Bypass*, or mute), it no longer holds Run: the
  prompt goes straight to ComfyUI and no suspend calls are made. The node
  shows "Inactive (bypassed/muted)" and is dimmed. The top-bar button stays
  visible for as long as the node is in the workflow, shows "⚡ NInfer · off"
  (dashed, dimmed) when every gate in the graph is inactive, and still focuses
  the node on click. Restoring *Always* reactivates the gate immediately -
  mode changes are picked up as events, no polling.

## Auto-purge on queue drain

A top-bar dropdown (**Auto purge VRAM**: off / soft / deep) purges VRAM
automatically the moment the queue drains. The >0 → 0 transition is read from
ComfyUI's `status` websocket event - no background polling. It fires only while
the tab is visible, and your choice persists across reloads (localStorage).

## Notes / caveats

- **Soft purge works on every backend** ComfyUI supports (NVIDIA, AMD/ROCm,
  Apple MPS, Intel XPU, Ascend NPU, MLU, DirectML, CPU) - it only uses
  ComfyUI's backend-agnostic unload/cache functions.
- **Deep mode's context reset is NVIDIA + AMD.** It calls the vendor driver
  directly (`libcuda.so.1` / `libhip.so`). On other backends (MPS, XPU, ...) the
  reset is skipped and deep behaves like soft. The response says so.
- **Deep mode is best-effort.** The device reset blocks until outstanding GPU
  work finishes. Click it when ComfyUI is idle (not mid-generation) to avoid a
  hang. If it fails, the response says so and nothing is broken - you just keep
  the context.
- **No restart.** The server keeps running. Your workflow, queue, and loaded
  settings are untouched. Only GPU memory is released.
- The soft purge is the safe default and matches what ComfyUI's own "unload all
  models" machinery does.
