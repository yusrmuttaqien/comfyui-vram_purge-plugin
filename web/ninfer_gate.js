// NInfer Suspend Gate (comfort) — self-contained for VRAM Purge plugin.
// Frees GPU memory by suspending NInfer models on queue.
import { app } from "../../scripts/app.js";

const NINFER_GATE = "NInfer Suspend Gate";
const FIELD_H = 30;
const STATUS_H = 24;
const BULK_H = 32;
const ROW_H = 30;
const PAD_Y = 10;
const MIN_W = 300;
const AMBIENT_MS = 3000;
const ELAPSED_MS = 500;
const BUSY_RETRY_MS = 2000;
const TIMEOUT_OPTIONS = ["indefinite", "1", "5", "10", "15", "30", "60"];
const MODEL_CACHE_MS = 1000;

// --- API ---

async function forward(url, body, signal) {
  const resp = body === undefined
    ? await fetch("/comfort/ninfer/forward?url=" + encodeURIComponent(url), { signal })
    : await fetch("/comfort/ninfer/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, body }),
        signal,
      });
  const text = await resp.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: resp.status, body: parsed };
}

const modelCache = new Map();
const inFlight = new Map();

async function fetchModels(base, useCache, signal) {
  const key = base + "/v1/models";
  if (useCache) {
    const hit = modelCache.get(key);
    if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.models;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const r = await forward(key, undefined, signal);
    const data = r.body?.data;
    const models = Array.isArray(data)
      ? data.map((m) => ({ id: String(m.id), value: String(m.status?.value ?? "") }))
      : [];
    modelCache.set(key, { at: Date.now(), models });
    return models;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function suspendModel(base, id, signal) {
  return forward(base + "/v1/models/" + encodeURIComponent(id) + "/suspend", {}, signal);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CSS ---

const CSS = `
.comfort-ninfer { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.comfort-ninfer-url, .comfort-ninfer-timeout {
  width: 100%; padding: 4px 6px; border-radius: 4px;
  border: 1px solid #555; background: #2a2a2a; color: #eee; font-size: 12px;
}
.comfort-ninfer-status {
  display: flex; align-items: center; gap: 8px; min-height: 24px;
  font-size: 11px; color: #aaa;
}
.comfort-ninfer-ctrl {
  padding: 2px 8px; border-radius: 4px; border: 1px solid #555;
  background: #333; color: #eee; cursor: pointer; font-size: 11px;
}
.comfort-ninfer-ctrl:hover { background: #444; }
.comfort-ninfer-bulk { display: flex; gap: 8px; }
.comfort-bulk {
  padding: 2px 8px; border-radius: 4px; border: 1px solid #555;
  background: #333; color: #ccc; cursor: pointer; font-size: 11px;
}
.comfort-bulk:hover { background: #444; }
.comfort-ninfer-row {
  display: flex; align-items: center; gap: 6px; padding: 2px 4px;
  border-radius: 4px;
}
.comfort-ninfer-row:hover { background: rgba(255,255,255,0.05); }
.comfort-ninfer-row.off { opacity: 0.5; }
.comfort-node-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.comfort-ninfer-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 3px;
  background: #444; color: #aaa;
}
.comfort-ninfer-badge.loaded { background: #7f1d1d; color: #fca5a5; }
.comfort-ninfer-badge.suspended { background: #1d3a7f; color: #93c5fd; }
.comfort-node-empty { color: #777; font-size: 11px; padding: 4px; }
.comfort-topbar-focus {
  padding: 4px 10px; border-radius: 4px; border: 1px solid #555;
  background: #333; color: #eee; cursor: pointer; font-size: 12px;
  margin-left: 8px;
}
.comfort-topbar-focus:hover { background: #444; }
`;

const styleEl = document.createElement("style");
styleEl.setAttribute("data-comfort-ninfer", "true");
styleEl.textContent = CSS;
document.head.appendChild(styleEl);

// --- Virtual node base (minimal, self-contained) ---

class ComfortVirtualNode extends LGraphNode {
  constructor(title) {
    super();
    this.title = title || "virtual";
    this.isVirtualNode = true;
    this.size = [200, 100];
    this.color = null;
    this.backgroundColor = null;
    this._modeField = LGraphEventMode.ALWAYS;
  }
  get mode() { return this._modeField; }
  set mode(v) {
    const old = this._modeField;
    this._modeField = v;
    if (old !== v) this.onModeChange?.(v, old);
  }
  onModeChange() {}
  get title() { return this._title; }
  set title(v) { this._title = v; }
}

// --- NInfer Gate Node ---

const registry = new Set();
let hooksInstalled = false;
let ambientTimer = null;
let elapsedTimer = null;

class NInferGateNode extends ComfortVirtualNode {
  constructor() {
    super(NINFER_GATE);
    this.properties = { url: "", timeout: "indefinite", selected: null };
    this.st = this._setupWidget();
    registry.add(this);
    _ensureTimers();
    _installHooks();
  }

  configure(info) {
    super.configure(info);
    this._syncFields();
  }
  onAdded() {
    super.onAdded?.();
    this._syncFields();
    this.refresh();
  }
  onRemoved() {
    registry.delete(this);
    if (!registry.size) {
      clearInterval(ambientTimer); ambientTimer = null;
      clearInterval(elapsedTimer); elapsedTimer = null;
    }
    super.onRemoved?.();
  }

  updateLiveStatus() {
    if (this.st.phase === "suspending" || this.st.phase === "busy") this._renderStatus();
  }

  _baseUrl() {
    return String(this.properties.url || "").trim().replace(/\/+$/, "");
  }
  _timeoutMs() {
    const t = String(this.properties.timeout || "indefinite");
    if (t === "indefinite") return Infinity;
    const m = parseInt(t, 10);
    return Number.isFinite(m) && m > 0 ? m * 60000 : Infinity;
  }
  _computeSelected(models) {
    const saved = this.properties.selected;
    if (saved == null) return new Set(models.filter((m) => m.value === "loaded").map((m) => m.id));
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  }

  _setupWidget() {
    const el = document.createElement("div");
    el.className = "comfort-ninfer";

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "comfort-ninfer-url";
    urlInput.placeholder = "NInfer URL  (http://host:30001)";
    el.appendChild(urlInput);

    const timeoutSel = document.createElement("select");
    timeoutSel.className = "comfort-ninfer-timeout";
    for (const opt of TIMEOUT_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt === "indefinite" ? "Busy timeout: indefinite" : `Busy timeout: ${opt} min`;
      timeoutSel.appendChild(o);
    }
    el.appendChild(timeoutSel);

    const statusEl = document.createElement("div");
    statusEl.className = "comfort-ninfer-status";
    const statusText = document.createElement("span");
    statusText.className = "comfort-ninfer-status-text";
    statusText.textContent = "Set NInfer URL to enable";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "comfort-ninfer-ctrl";
    cancelBtn.textContent = "Cancel";
    cancelBtn.hidden = true;
    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "comfort-ninfer-ctrl";
    skipBtn.textContent = "Skip";
    skipBtn.hidden = true;
    statusEl.appendChild(statusText);
    statusEl.appendChild(cancelBtn);
    statusEl.appendChild(skipBtn);
    el.appendChild(statusEl);

    const bulkEl = document.createElement("div");
    bulkEl.className = "comfort-ninfer-bulk";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "comfort-bulk";
    allBtn.dataset.bulk = "all";
    allBtn.textContent = "Select all";
    const noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.className = "comfort-bulk";
    noneBtn.dataset.bulk = "none";
    noneBtn.textContent = "Deselect all";
    bulkEl.appendChild(allBtn);
    bulkEl.appendChild(noneBtn);
    el.appendChild(bulkEl);

    const rowsEl = document.createElement("div");
    rowsEl.className = "comfort-ninfer-rows";
    el.appendChild(rowsEl);

    const st = {
      el, urlInput, timeoutSel, statusEl, statusText, cancelBtn, skipBtn, bulkEl, rowsEl,
      models: [], selected: new Set(), phase: "idle", phaseModel: "", phaseStart: 0,
      resultText: "", resultHold: 0, polling: false, cancel: false, skip: false, abort: null,
    };

    cancelBtn.addEventListener("click", () => { st.cancel = true; st.abort?.abort(); });
    skipBtn.addEventListener("click", () => { st.skip = true; st.abort?.abort(); });

    rowsEl.addEventListener("change", (e) => {
      const cb = e.target;
      if (cb.type !== "checkbox" || !cb.dataset.id) return;
      const sel = new Set(st.selected);
      if (cb.checked) sel.add(cb.dataset.id); else sel.delete(cb.dataset.id);
      st.selected = sel;
      this.properties.selected = Array.from(sel);
    });

    bulkEl.addEventListener("click", (e) => {
      const action = e.target?.dataset?.bulk;
      if (action === "all") {
        const ids = st.models.filter((m) => m.value === "loaded").map((m) => m.id);
        st.selected = new Set(ids);
        this.properties.selected = ids;
      } else if (action === "none") {
        st.selected = new Set();
        this.properties.selected = [];
      } else return;
      this._renderRows();
    });

    urlInput.addEventListener("input", () => { this.properties.url = urlInput.value.trim(); });
    urlInput.addEventListener("change", () => {
      this.properties.url = urlInput.value.trim();
      this.properties.selected = null;
      st.phase = "idle";
      st.resultText = "";
      st.models = [];
      st.selected = new Set();
      this.refresh();
    });
    timeoutSel.addEventListener("change", () => { this.properties.timeout = timeoutSel.value; });

    if (typeof this.addDOMWidget === "function") {
      this.addDOMWidget("ninfer", "comfort_ninfer_list", el, {
        serialize: false,
        hideOnZoom: true,
      });
    }
    return st;
  }

  _syncFields() {
    const st = this.st;
    st.urlInput.value = String(this.properties.url || "");
    const t = String(this.properties.timeout || "indefinite");
    st.timeoutSel.value = TIMEOUT_OPTIONS.includes(t) ? t : "indefinite";
    st.selected = this._computeSelected(st.models);
  }

  _renderRows() {
    const st = this.st;
    st.rowsEl.innerHTML = "";
    if (!st.models.length) {
      const empty = document.createElement("div");
      empty.className = "comfort-node-empty";
      empty.textContent = this._baseUrl() ? "Loading…" : "Set NInfer URL above";
      st.rowsEl.appendChild(empty);
      return;
    }
    for (const m of st.models) {
      const loaded = m.value === "loaded";
      const rowEl = document.createElement("div");
      rowEl.className = "comfort-ninfer-row" + (loaded ? "" : " off");
      rowEl.dataset.id = m.id;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = st.selected.has(m.id);
      cb.dataset.id = m.id;
      rowEl.appendChild(cb);
      const title = document.createElement("span");
      title.className = "comfort-node-title";
      title.textContent = m.id;
      title.title = m.id;
      rowEl.appendChild(title);
      const state = m.value || "unknown";
      const badge = document.createElement("span");
      badge.className = "comfort-ninfer-badge " + (state === "loaded" ? "loaded" : state === "sleeping" ? "suspended" : "other");
      badge.textContent = state === "sleeping" ? "suspended" : state;
      rowEl.appendChild(badge);
      st.rowsEl.appendChild(rowEl);
    }
  }

  _idleSummary() {
    if (!this._baseUrl()) return "Set NInfer URL to enable";
    const m = this.st.models;
    if (!m.length) return "Loading models…";
    const loaded = m.filter((x) => x.value === "loaded").length;
    if (!loaded) return "No loaded models";
    return `${loaded} loaded · ${m.length - loaded} other`;
  }

  _renderStatus() {
    const st = this.st;
    const elapsed = Math.max(0, Math.round((Date.now() - st.phaseStart) / 1000));
    let text;
    switch (st.phase) {
      case "suspending": text = `Suspending ${st.phaseModel}… ${elapsed}s`; break;
      case "busy": text = `NInfer busy — waiting… ${elapsed}s`; break;
      case "done": text = `✓ ${st.resultText}`; break;
      case "error": text = `✗ ${st.resultText}`; break;
      default: text = this._idleSummary();
    }
    st.statusText.textContent = text;
    const active = st.phase === "suspending" || st.phase === "busy";
    st.cancelBtn.hidden = !active;
    st.skipBtn.hidden = !active;
  }

  _layout() {
    const n = this.st.models.length;
    const h = PAD_Y * 2 + FIELD_H + FIELD_H + STATUS_H + BULK_H + n * ROW_H;
    const w = Math.max(this.size?.[0] || 0, MIN_W);
    const cur = this.size;
    if (!cur || cur[1] !== h || cur[0] !== w) this.setSize?.([w, h]);
  }

  async refresh(fresh = false) {
    const st = this.st;
    if (st.polling) return;
    if (st.phase === "suspending" || st.phase === "busy") return;
    const base = this._baseUrl();
    if (!base) {
      st.models = [];
      st.selected = new Set();
      this._renderRows();
      this._renderStatus();
      this._layout();
      return;
    }
    st.polling = true;
    try {
      const models = await fetchModels(base, !fresh);
      st.models = models;
      if (this.properties.selected == null) {
        this.properties.selected = models.filter((m) => m.value === "loaded").map((m) => m.id);
      }
      st.selected = this._computeSelected(models);
      this._renderRows();
      this._layout();
      if ((st.phase === "done" || st.phase === "error") && st.resultHold > 0) {
        st.resultHold--;
      } else if (st.phase !== "idle") {
        st.phase = "idle";
        st.resultText = "";
      }
      this._renderStatus();
    } catch {
      if (st.phase === "idle") {
        st.phase = "error";
        st.resultText = "NInfer unreachable";
      }
      this._renderStatus();
    } finally {
      st.polling = false;
    }
  }

  async suspendChecked() {
    const st = this.st;
    const base = this._baseUrl();
    if (!base) return { proceed: true };
    st.cancel = false;
    st.skip = false;
    st.abort = null;
    let models;
    try {
      models = await fetchModels(base, false);
    } catch {
      this._finish("NInfer unreachable", true);
      return { proceed: false };
    }
    st.models = models;
    const selected = this._computeSelected(models);
    st.selected = selected;
    this._renderRows();
    const targets = models.filter((m) => m.value === "loaded" && selected.has(m.id));
    if (!targets.length) {
      this._finish("Ready (nothing to suspend)", false);
      return { proceed: true };
    }
    const t0 = Date.now();
    const timeoutMs = this._timeoutMs();
    try {
      for (const m of targets) {
        if (st.cancel || st.skip) break;
        const mStart = Date.now();
        this._beginSuspending(m.id, mStart);
        for (;;) {
          if (st.cancel || st.skip) break;
          const ac = new AbortController();
          st.abort = ac;
          let r;
          try {
            r = await suspendModel(base, m.id, ac.signal);
          } catch {
            if (ac.signal.aborted) break;
            throw new Error("suspend request failed");
          }
          if (r.status === 200) break;
          if (r.status === 409) {
            this._setBusy(m.id, mStart);
            await sleep(BUSY_RETRY_MS);
            if (st.cancel || st.skip) break;
            if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for NInfer to idle");
            continue;
          }
          throw new Error(`suspend failed (HTTP ${r.status})`);
        }
      }
      st.abort = null;
      if (st.cancel) { this._finish("Cancelled", false); return { proceed: false }; }
      if (st.skip) { this._finish("Skipped — running now", false); return { proceed: true }; }
      const total = Math.round((Date.now() - t0) / 1000);
      this._finish(`Suspended ${targets.length} model${targets.length === 1 ? "" : "s"} (${total}s)`, false);
      st.resultHold = 2;
      try { await this.refresh(true); } catch {}
      return { proceed: true };
    } catch (e) {
      this._finish(e instanceof Error ? e.message : String(e), true);
      return { proceed: false };
    } finally {
      st.abort = null;
    }
  }

  _beginSuspending(model, start) {
    this.st.phase = "suspending";
    this.st.phaseModel = model;
    this.st.phaseStart = start;
    this._renderStatus();
  }
  _setBusy(model, start) {
    this.st.phase = "busy";
    this.st.phaseModel = model;
    this.st.phaseStart = start;
    this._renderStatus();
  }
  _finish(text, isError) {
    this.st.phase = isError ? "error" : "done";
    this.st.resultText = text;
    this._renderStatus();
  }

  getHelp() {
    return `<p>Frees GPU memory for ComfyUI by suspending selected NInfer models on queue.</p>`;
  }
}

// --- Timers ---

function _ensureTimers() {
  if (!ambientTimer) {
    ambientTimer = setInterval(() => {
      if (document.hidden) return;
      for (const n of registry) {
        if (n.removed) continue;
        try { n.refresh(); } catch {}
      }
    }, AMBIENT_MS);
  }
  if (!elapsedTimer) {
    elapsedTimer = setInterval(() => {
      for (const n of registry) {
        if (n.removed) continue;
        try { n.updateLiveStatus(); } catch {}
      }
    }, ELAPSED_MS);
  }
}

// --- Queue hook ---

function _installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const orig = app.queuePrompt;
  app.queuePrompt = async function (...args) {
    let proceed = true;
    for (const gate of Array.from(registry)) {
      if (gate.removed) continue;
      const v = await gate.suspendChecked();
      if (!v.proceed) { proceed = false; break; }
    }
    if (!proceed) return Promise.resolve();
    return orig.apply(app, args);
  };
}

// --- Focus button ---

let focusBtn = null;

function _currentGraph() {
  return app.canvas?.graph ?? app.graph ?? null;
}

function _findFocusableGate() {
  const g = _currentGraph();
  if (!g) return null;
  for (const gate of registry) {
    if (!gate.removed && gate.graph === g) return gate;
  }
  return null;
}

function _ensureFocusButton() {
  if (focusBtn && focusBtn.isConnected) return;
  const anchor = document.querySelector('[data-testid="queue-button"]');
  if (!anchor || !anchor.parentElement) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "comfort-topbar-focus";
  btn.title = "Focus NInfer gate";
  btn.textContent = "NInfer";
  btn.addEventListener("click", () => {
    const gate = _findFocusableGate();
    if (!gate) return;
    const graph = gate.graph;
    if (graph) {
      for (const n of graph._nodes || []) n.selected = false;
      gate.selected = true;
    }
    const canvas = app.canvas;
    if (!canvas) return;
    const size = gate.size || [200, 150];
    const cEl = canvas.canvas;
    const vw = (cEl && cEl.clientWidth) || window.innerWidth;
    const vh = (cEl && cEl.clientHeight) || window.innerHeight;
    const fit = Math.min((vw * 0.5) / (size[0] || 200), (vh * 0.5) / (size[1] || 150));
    canvas.ds.scale = Math.min(Math.max(fit, 0.75), 2.0);
    canvas.centerOnNode(gate);
    canvas.setDirty(true);
  });
  anchor.parentElement.insertBefore(btn, anchor.nextSibling);
  focusBtn = btn;
}

setInterval(() => {
  _ensureFocusButton();
  if (focusBtn) focusBtn.style.display = _findFocusableGate() ? "" : "none";
}, 500);

// --- Register ---

LiteGraph.registerNodeType(NINFER_GATE, NInferGateNode);
