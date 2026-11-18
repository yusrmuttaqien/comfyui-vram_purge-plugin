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
    server_llm.py
    pyproject.toml
    web/
        purge_menu.js
        llm_gate.js
```

Restart ComfyUI once (to load the extension), then the two buttons appear in the
main menu bar.

## LLM Unload

A node that frees GPU memory for ComfyUI by unloading selected models from a
local LLM engine on queue. Two engines are supported, chosen by the **Engine**
dropdown on the node:

| Engine | Address one model | Effect on the GPU |
| --- | --- | --- |
| `ninfer-all` | `POST /v1/models/{id}/suspend` | weights and persistent state move to a host snapshot |
| `basalt/adamant` | `POST /v1/unload` with `{"model": "<id>"}` | the engine stops; the next request loads the model again |

Both engines list models the same way (`GET /v1/models`, each row carrying
`status.value`), and both answer `409 model_busy` when a request is running.
Adamant is a fork of Basalt, so one option covers both.

- Pick the **Engine** and set the **Engine URL** (e.g. `http://host:30001`).
- The node lists the engine's models with their status. **loaded** models are
  selectable (checked by default). **Select all** / **Deselect all** for bulk
  control. Model state is refreshed on demand (hover, URL or engine change, Run,
  hold start/end) - it is never polled.
- On Run, each checked loaded model is unloaded one at a time and the prompt is
  held until every unload completes. Several nodes in one graph share a single
  hold, and the same engine plus model is never sent twice.
- Further Run clicks during a hold **join** it: all held prompts are queued in
  click order as soon as the last unload finishes.
- If the engine is busy (`409 model_busy`) the node waits and retries every 5 s
  until it idles or the **busy timeout** elapses (default *indefinite*, or a
  number of minutes).
- While a hold is active, the node and the top-bar button show live status
  ("Unloading <model>…", "NInfer-all busy - waiting…", "✓ Queued N prompt(s) ·
  waited Ns"). **Cancel** drops the held prompts; **Skip** queues them without
  unloading.
- Unloaded models stay unloaded: this plugin never loads one back. NInfer-all
  reloads a model when its own `auto_resume` fires, and the next Run unloads it
  again. Basalt/Adamant loads on the next request to the engine.
- Engine calls go through a Python proxy (`/comfort/llm/forward`) to avoid
  CORS between the browser and the engine.
- A top-bar **LLM Unload** button appears while a node is in the current graph.
  Clicking it focuses and zooms to the node; a spinner and live label show
  while a hold is in progress.
- Workflows saved when the node was called **NInfer Suspend Gate** still load.
  That old name is registered as a hidden alias, so those graphs open unchanged
  and only show the old title on that one node.
- **Bypass / mute deactivates a node.** When the node's mode is anything but
  *Always* (right-click → *Bypass*, or mute), it no longer holds Run: the
  prompt goes straight to ComfyUI and no unload calls are made. The node
  shows "Inactive (bypassed/muted)" and is dimmed. The top-bar button stays
  visible for as long as the node is in the workflow, shows "⚡ LLM Unload · off"
  (dashed, dimmed) when every node in the graph is inactive, and still focuses
  the node on click. Restoring *Always* reactivates the node immediately -
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
