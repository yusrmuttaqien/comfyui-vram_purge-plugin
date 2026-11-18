// src/llm_gate.ts
import { app } from "/scripts/app.js";
var NODE_NAME = "LLM Unload";
var LEGACY_NAME = "NInfer Suspend Gate";
var MIN_W = 300;
var BUSY_RETRY_MS = 5e3;
var TICKER_MS = 250;
var HOVER_WINDOW_MS = 1e3;
var TIMEOUT_OPTIONS = ["indefinite", "1", "5", "10", "15", "30", "60"];
var PROVIDERS = ["ninfer-all", "basalt/adamant"];
async function forward(url, body, signal) {
  const resp = body === void 0 ? await fetch("/comfort/llm/forward?url=" + encodeURIComponent(url), { signal }) : await fetch("/comfort/llm/forward", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, body }),
    signal
  });
  const text = await resp.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
  }
  return { status: resp.status, body: parsed };
}
var modelCache = /* @__PURE__ */ new Map();
var inFlight = /* @__PURE__ */ new Map();
async function fetchModels(base, maxAgeMs, signal) {
  const key = base + "/v1/models";
  if (maxAgeMs > 0) {
    const hit = modelCache.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.models;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const r = await forward(key, void 0, signal);
    const data = r.body?.data;
    const models = Array.isArray(data) ? data.map((m) => ({ id: String(m.id), value: String(m.status?.value ?? "") })) : [];
    modelCache.set(key, { at: Date.now(), models });
    return models;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
function unloadModel(base, provider, id, signal) {
  if (provider === "basalt/adamant") {
    return forward(base + "/v1/unload", { model: id }, signal);
  }
  return forward(base + "/v1/models/" + encodeURIComponent(id) + "/suspend", {}, signal);
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var CSS = `
.comfort-llm { display: flex; flex-direction: column; gap: 4px; font-size: 12px; height: 100%; overflow-y: auto; }
.comfort-llm-provider, .comfort-llm-url, .comfort-llm-timeout {
  width: 100%; padding: 4px 6px; border-radius: 4px;
  border: 1px solid #555; background: #2a2a2a; color: #eee; font-size: 12px;
}
.comfort-llm-status {
  display: flex; align-items: center; gap: 8px; min-height: 24px;
  font-size: 11px; color: #aaa;
}
.comfort-llm-status-text.ok { color: #86efac; }
.comfort-llm-status-text.err { color: #fca5a5; }
.comfort-llm-ctrl {
  padding: 2px 8px; border-radius: 4px; border: 1px solid #555;
  background: #333; color: #eee; cursor: pointer; font-size: 11px;
}
.comfort-llm-ctrl:hover { background: #444; }
.comfort-llm-bulk { display: flex; gap: 8px; }
.comfort-bulk {
  padding: 2px 8px; border-radius: 4px; border: 1px solid #555;
  background: #333; color: #ccc; cursor: pointer; font-size: 11px;
}
.comfort-bulk:hover { background: #444; }
.comfort-llm-row {
  display: flex; align-items: center; gap: 6px; padding: 2px 4px;
  border-radius: 4px;
}
.comfort-llm-row:hover { background: rgba(255,255,255,0.05); }
.comfort-llm-row.off { opacity: 0.5; }
.comfort-llm-row .llm-spinner { display: none; }
.comfort-llm-row.unloading .llm-spinner { display: inline-block; }
.comfort-ninactive { opacity: 0.55; }
.comfort-node-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.comfort-llm-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 3px;
  background: #444; color: #aaa;
}
.comfort-llm-badge.loaded { background: #7f1d1d; color: #fca5a5; }
.comfort-llm-badge.suspended { background: #1d3a7f; color: #93c5fd; }
.comfort-node-empty { color: #777; font-size: 11px; padding: 4px; }
.comfort-topbar-focus {
  padding: 4px 10px; border-radius: 4px; border: 1px solid #555;
  background: #333; color: #eee; cursor: pointer; font-size: 12px;
  margin-left: 8px;
}
.comfort-topbar-focus:hover { background: #444; }
.comfort-topbar-focus.llm-ok { border-color: #16a34a; }
.comfort-topbar-focus.llm-error { border-color: #dc2626; }
.comfort-topbar-focus.llm-spinning .llm-label { display: none; }
.comfort-topbar-focus .llm-spinner { display: none; }
.comfort-topbar-focus.llm-spinning .llm-spinner { display: inline-block; }
.comfort-topbar-focus.llm-inactive { opacity: 0.6; border-style: dashed; }
.comfort-topbar-focus.llm-inactive:hover { opacity: 1; }
.llm-spinner {
  width: 12px; height: 12px; border: 2px solid #888; border-top-color: #eee;
  border-radius: 50%; animation: llm-spin 0.8s linear infinite; vertical-align: middle;
}
@keyframes llm-spin { to { transform: rotate(360deg); } }
`;
var styleEl = document.createElement("style");
styleEl.setAttribute("data-comfort-llm", "true");
styleEl.textContent = CSS;
document.head.appendChild(styleEl);
function _findProtoPropDescriptor(obj, prop) {
  let proto = Object.getPrototypeOf(obj);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc) return desc;
    proto = Object.getPrototypeOf(proto);
  }
  return void 0;
}
var ComfortVirtualNode = class extends LGraphNode {
  constructor(title) {
    super(title);
    this.isVirtualNode = true;
    this.removed = false;
    this.configuring = false;
    this.__comfort_mode = 0;
    this.widgets = this.widgets || [];
    this.properties = this.properties || {};
    const protoMode = _findProtoPropDescriptor(this, "mode");
    const readMode = () => {
      if (protoMode?.get) return protoMode.get.call(this);
      return this.__comfort_mode;
    };
    Object.defineProperty(this, "mode", {
      configurable: true,
      enumerable: true,
      get: readMode,
      set: (mode) => {
        const old = readMode();
        if (protoMode?.set) protoMode.set.call(this, mode);
        else this.__comfort_mode = mode;
        if (old !== mode) this.onModeChange?.(old, mode);
      }
    });
  }
  configure(info) {
    this.configuring = true;
    super.configure(info);
    this.configuring = false;
  }
  onRemoved() {
    super.onRemoved?.();
    this.removed = true;
  }
  getHelp() {
    return "";
  }
};
var hold = null;
var lastOutcome = null;
var ticker = null;
var ensureChain = Promise.resolve();
function isActivePhase(h) {
  return !!h && (h.phase === "checking" || h.phase === "unloading" || h.phase === "busy" || h.phase === "draining");
}
function _startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (hold) renderHold();
  }, TICKER_MS);
}
function _stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
function renderHold() {
  for (const g of Array.from(registry)) {
    if (g.removed) continue;
    try {
      g._renderStatus();
    } catch {
    }
  }
  _renderFocusButton();
}
var registry = /* @__PURE__ */ new Set();
var hooksInstalled = false;
var origQueue = null;
var LLMGateNode = class extends ComfortVirtualNode {
  constructor() {
    super(NODE_NAME);
    // Bypass/mute (or restore) of this node: re-render state without a
    // model fetch. During deserialization, onAdded/refresh renders.
    this.onModeChange = (_old, _mode) => {
      if (this.configuring || !this.st) return;
      this._renderStatus();
      _renderFocusButton();
    };
    this.properties = { url: "", provider: "ninfer-all", timeout: "indefinite", selected: null };
    this.setSize([MIN_W, 200]);
    this.st = this._setupWidget();
    registry.add(this);
    _installHooks();
  }
  configure(info) {
    super.configure(info);
    this._syncFields();
  }
  onAdded() {
    super.onAdded?.();
    this._syncFields();
    this.refresh(true);
    _updateFocusVisibility();
  }
  onRemoved() {
    registry.delete(this);
    _updateFocusVisibility();
    super.onRemoved?.();
  }
  _baseUrl() {
    return String(this.properties.url || "").trim().replace(/\/+$/, "");
  }
  _provider() {
    const p = String(this.properties.provider || "");
    return PROVIDERS.includes(p) ? p : "ninfer-all";
  }
  _engineLabel() {
    const p = this._provider();
    return p === "basalt/adamant" ? "Basalt/Adamant" : "NInfer-all";
  }
  _timeoutMs() {
    const t = String(this.properties.timeout || "indefinite");
    if (t === "indefinite") return Infinity;
    const m = parseInt(t, 10);
    return Number.isFinite(m) && m > 0 ? m * 6e4 : Infinity;
  }
  _computeSelected(models) {
    const saved = this.properties.selected;
    if (saved == null)
      return new Set(models.filter((m) => m.value === "loaded").map((m) => m.id));
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  }
  _setupWidget() {
    const el = document.createElement("div");
    el.className = "comfort-llm";
    const providerSel = document.createElement("select");
    providerSel.className = "comfort-llm-provider";
    for (const prov of PROVIDERS) {
      const o = document.createElement("option");
      o.value = prov;
      o.textContent = `Engine: ${prov}`;
      providerSel.appendChild(o);
    }
    el.appendChild(providerSel);
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "comfort-llm-url";
    urlInput.placeholder = "Engine URL  (http://host:30001)";
    el.appendChild(urlInput);
    const timeoutSel = document.createElement("select");
    timeoutSel.className = "comfort-llm-timeout";
    for (const opt of TIMEOUT_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt === "indefinite" ? "Busy timeout: indefinite" : `Busy timeout: ${opt} min`;
      timeoutSel.appendChild(o);
    }
    el.appendChild(timeoutSel);
    const statusEl = document.createElement("div");
    statusEl.className = "comfort-llm-status";
    const statusText = document.createElement("span");
    statusText.className = "comfort-llm-status-text";
    statusText.textContent = "Set an engine URL to enable";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "comfort-llm-ctrl";
    cancelBtn.textContent = "Cancel";
    cancelBtn.hidden = true;
    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "comfort-llm-ctrl";
    skipBtn.textContent = "Skip";
    skipBtn.hidden = true;
    statusEl.appendChild(statusText);
    statusEl.appendChild(cancelBtn);
    statusEl.appendChild(skipBtn);
    el.appendChild(statusEl);
    const bulkEl = document.createElement("div");
    bulkEl.className = "comfort-llm-bulk";
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
    rowsEl.className = "comfort-llm-rows";
    el.appendChild(rowsEl);
    const st = {
      el,
      providerSel,
      urlInput,
      timeoutSel,
      statusEl,
      statusText,
      cancelBtn,
      skipBtn,
      bulkEl,
      rowsEl,
      models: [],
      selected: /* @__PURE__ */ new Set(),
      modelsAt: 0,
      refreshing: false
    };
    cancelBtn.addEventListener("click", () => {
      if (!hold) return;
      hold.intent = "cancel";
      hold.abort?.abort();
    });
    skipBtn.addEventListener("click", () => {
      if (!hold) return;
      hold.intent = "skip";
      hold.abort?.abort();
    });
    rowsEl.addEventListener("change", (e) => {
      const cb = e.target;
      if (cb.type !== "checkbox" || !cb.dataset.id) return;
      const sel = new Set(st.selected);
      if (cb.checked) sel.add(cb.dataset.id);
      else sel.delete(cb.dataset.id);
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
        st.selected = /* @__PURE__ */ new Set();
        this.properties.selected = [];
      } else return;
      this._renderRows();
    });
    providerSel.addEventListener("change", () => {
      this.properties.provider = providerSel.value;
      this.properties.selected = null;
      st.models = [];
      st.modelsAt = 0;
      st.selected = /* @__PURE__ */ new Set();
      lastOutcome = null;
      this._renderRows();
      this._renderStatus();
      this.refresh(true);
    });
    urlInput.addEventListener("input", () => {
      this.properties.url = urlInput.value.trim();
    });
    urlInput.addEventListener("change", () => {
      this.properties.url = urlInput.value.trim();
      this.properties.selected = null;
      st.models = [];
      st.modelsAt = 0;
      st.selected = /* @__PURE__ */ new Set();
      lastOutcome = null;
      this.refresh(true);
    });
    timeoutSel.addEventListener("change", () => {
      this.properties.timeout = timeoutSel.value;
    });
    el.addEventListener("pointerenter", () => {
      this.refresh(false);
    });
    el.addEventListener("pointerdown", () => {
      this.refresh(true);
    });
    if (typeof this.addDOMWidget === "function") {
      this.addDOMWidget("llm_unload", "comfort_llm_unload_list", el, {
        serialize: false,
        hideOnZoom: true
      });
    }
    return st;
  }
  _syncFields() {
    const st = this.st;
    st.providerSel.value = this._provider();
    st.urlInput.value = String(this.properties.url || "");
    const t = String(this.properties.timeout || "indefinite");
    st.timeoutSel.value = TIMEOUT_OPTIONS.includes(t) ? t : "indefinite";
    st.selected = this._computeSelected(st.models);
  }
  _setModels(models) {
    const st = this.st;
    st.models = models;
    st.modelsAt = Date.now();
    if (this.properties.selected == null) {
      this.properties.selected = models.filter((m) => m.value === "loaded").map((m) => m.id);
    }
    st.selected = this._computeSelected(models);
    this._renderRows();
  }
  _renderRows() {
    const st = this.st;
    st.rowsEl.innerHTML = "";
    if (!st.models.length) {
      const empty = document.createElement("div");
      empty.className = "comfort-node-empty";
      empty.textContent = this._baseUrl() ? "Loading\u2026" : "Set an engine URL above";
      st.rowsEl.appendChild(empty);
      return;
    }
    for (const m of st.models) {
      const loaded = m.value === "loaded";
      const rowEl = document.createElement("div");
      rowEl.className = "comfort-llm-row" + (loaded ? "" : " off");
      rowEl.dataset.id = m.id;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = st.selected.has(m.id);
      cb.dataset.id = m.id;
      rowEl.appendChild(cb);
      const spinner = document.createElement("span");
      spinner.className = "llm-spinner";
      rowEl.appendChild(spinner);
      const title = document.createElement("span");
      title.className = "comfort-node-title";
      title.textContent = m.id;
      title.title = m.id;
      rowEl.appendChild(title);
      const state = m.value || "unknown";
      const badge = document.createElement("span");
      badge.className = "comfort-llm-badge " + (state === "loaded" ? "loaded" : state === "sleeping" ? "suspended" : "other");
      badge.textContent = state;
      rowEl.appendChild(badge);
      st.rowsEl.appendChild(rowEl);
    }
    this._updateRowSpinners();
  }
  _updateRowSpinners() {
    const active = hold?.phase === "unloading" && hold.phaseNode === this && !!hold.phaseModel;
    const rows = this.st.rowsEl.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.dataset?.id) continue;
      row.classList.toggle(
        "unloading",
        active && row.dataset.id === hold.phaseModel
      );
    }
  }
  _idleSummary() {
    if (!this._baseUrl()) return "Set an engine URL to enable";
    const m = this.st.models;
    if (!m.length) return "Loading models\u2026";
    const loaded = m.filter((x) => x.value === "loaded").length;
    const age = this.st.modelsAt ? ` \xB7 checked ${Math.max(0, Math.round((Date.now() - this.st.modelsAt) / 1e3))}s ago` : "";
    if (!loaded) return `No loaded models${age}`;
    return `${loaded} loaded \xB7 ${m.length - loaded} other${age}`;
  }
  _renderStatus() {
    const st = this.st;
    const h = hold;
    let text;
    let tone = "info";
    const inactive = this.mode !== 0;
    if (isActivePhase(h)) {
      const s = Math.max(0, Math.round((Date.now() - h.phaseStart) / 1e3));
      const waiting = h.waiters.length > 1 ? ` \xB7 ${h.waiters.length - 1} waiting` : "";
      switch (h.phase) {
        case "checking":
          text = `Checking ${this._engineLabel()}\u2026` + waiting;
          break;
        case "unloading":
          text = `Unloading ${h.phaseModel}\u2026 ${s}s` + waiting;
          break;
        case "busy":
          text = `${this._engineLabel()} busy - waiting\u2026 ${s}s` + waiting;
          break;
        case "draining":
          text = `Submitting ${Math.min(h.drainIndex + 1, h.waiters.length)}/${h.waiters.length} prompt(s)\u2026`;
          break;
        default:
          text = this._idleSummary();
      }
    } else if (inactive) {
      text = "Inactive (bypassed/muted)";
    } else if (lastOutcome) {
      text = (lastOutcome.cancelled ? "\u21A9 " : lastOutcome.isError ? "\u2717 " : "\u2713 ") + lastOutcome.text;
      tone = lastOutcome.isError ? "err" : lastOutcome.cancelled ? "info" : "ok";
    } else {
      text = this._idleSummary();
    }
    st.statusText.textContent = text;
    st.statusText.className = "comfort-llm-status-text" + (tone === "err" ? " err" : tone === "ok" ? " ok" : "");
    const active = isActivePhase(h);
    st.cancelBtn.hidden = !active;
    st.skipBtn.hidden = !active;
    st.el.classList.toggle("comfort-ninactive", inactive && !active);
    this._updateRowSpinners();
  }
  async refresh(fresh, keepOutcome = false) {
    const st = this.st;
    if (st.refreshing) return;
    if (hold && (hold.phase === "checking" || hold.phase === "unloading" || hold.phase === "busy"))
      return;
    const base = this._baseUrl();
    if (!base) {
      st.models = [];
      st.modelsAt = 0;
      this._renderRows();
      this._renderStatus();
      return;
    }
    st.refreshing = true;
    try {
      const models = await fetchModels(base, fresh ? 0 : HOVER_WINDOW_MS);
      this._setModels(models);
      if (!keepOutcome) lastOutcome = null;
      this._renderStatus();
    } catch {
      if (!hold && !keepOutcome) {
        lastOutcome = { text: `${this._engineLabel()} unreachable`, isError: true, cancelled: false, at: Date.now() };
      }
      this._renderStatus();
    } finally {
      st.refreshing = false;
    }
  }
};
function _intent(h) {
  return h.intent;
}
function _makeWaiter(args) {
  let resolveDone = () => {
  };
  let rejectDone = () => {
  };
  const done = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  return {
    args,
    done,
    resolveDone,
    rejectDone,
    ready: Promise.resolve(),
    state: "waiting"
  };
}
async function _unloadOne(h, node, base, m) {
  const key = base + "|" + m.id;
  if (h.covered.has(key)) return true;
  h.phase = "unloading";
  h.phaseModel = m.id;
  h.phaseNode = node;
  h.phaseStart = Date.now();
  renderHold();
  const mStart = Date.now();
  for (; ; ) {
    if (h.intent !== "none") break;
    const ac = new AbortController();
    h.abort = ac;
    let r;
    try {
      r = await unloadModel(base, node._provider(), m.id, ac.signal);
    } catch {
      if (ac.signal.aborted) break;
      throw new Error("engine request failed");
    }
    if (r.status === 200 && !basaltRefused(r)) {
      h.covered.add(key);
      return true;
    }
    if (r.status === 409) {
      h.phase = "busy";
      renderHold();
      await sleep(BUSY_RETRY_MS);
      if (h.intent !== "none") break;
      if (Date.now() - mStart > node._timeoutMs())
        throw new Error(`timed out waiting for ${node._engineLabel()} to idle`);
      continue;
    }
    throw new Error(basaltRefused(r) || `engine refused to unload (HTTP ${r.status})`);
  }
  return false;
}
function basaltRefused(r) {
  const st = r.body?.status;
  if (typeof st !== "string" || r.status !== 200) return null;
  if (st === "unloaded" || st === "not loaded") return null;
  if (st === "busy") return "engine is busy";
  return `engine cannot unload this model (${st})`;
}
async function _ensureTargets(h) {
  for (const node of Array.from(registry)) {
    if (node.removed || node.mode !== 0 || h.intent !== "none") continue;
    const base = node._baseUrl();
    if (!base) continue;
    let models;
    try {
      models = await fetchModels(base, 0);
    } catch {
      continue;
    }
    node._setModels(models);
    for (const m of models) {
      if (h.intent !== "none") break;
      if (m.value !== "loaded" || !node.st.selected.has(m.id)) continue;
      if (h.covered.has(base + "|" + m.id)) continue;
      await _unloadOne(h, node, base, m);
    }
  }
}
async function _runEnginePass(h) {
  for (const node of Array.from(registry)) {
    if (node.removed || node.mode !== 0) continue;
    if (h.intent === "cancel" || h.intent === "skip") break;
    const base = node._baseUrl();
    if (!base) continue;
    let models;
    try {
      models = await fetchModels(base, 0);
    } catch {
      h.resultText = `${node._engineLabel()} unreachable`;
      h.isError = true;
      return false;
    }
    node._setModels(models);
    for (const m of models) {
      if (h.intent !== "none") break;
      if (m.value !== "loaded" || !node.st.selected.has(m.id)) continue;
      if (h.covered.has(base + "|" + m.id)) continue;
      await _unloadOne(h, node, base, m);
    }
  }
  return h.intent !== "cancel";
}
async function _drainWaiters(h) {
  for (const w of h.waiters) {
    if (w.state !== "waiting") continue;
    if (_intent(h) === "cancel") break;
    await w.ready;
    if (_intent(h) === "cancel") break;
    if (w.state !== "waiting") continue;
    w.state = "submitting";
    h.phase = "draining";
    h.drainIndex = h.waiters.filter((x) => x.state !== "waiting").length - 1;
    renderHold();
    try {
      const r = await origQueue.apply(
        app,
        w.args
      );
      w.resolveDone(r);
    } catch (e) {
      w.rejectDone(e);
    }
    w.state = "settled";
  }
}
function _endHold(h) {
  const total = Math.round((Date.now() - h.startedAt) / 1e3);
  if (h.phase === "queued") h.resultText += ` \xB7 node ${total}s`;
  lastOutcome = {
    text: h.resultText,
    isError: h.phase === "error",
    cancelled: h.phase === "cancelled",
    at: Date.now()
  };
  hold = null;
  renderHold();
  _stopTicker();
  for (const g of Array.from(registry)) {
    if (!g.removed) g.refresh(true, true).catch(() => {
    });
  }
}
async function _startHold(args) {
  const h = {
    phase: "checking",
    phaseModel: "",
    phaseNode: null,
    phaseStart: Date.now(),
    waiters: [],
    intent: "none",
    abort: null,
    resultText: "",
    isError: false,
    covered: /* @__PURE__ */ new Set(),
    startedAt: Date.now(),
    drainIndex: 0
  };
  hold = h;
  lastOutcome = null;
  const w = _makeWaiter(args);
  h.waiters.push(w);
  _startTicker();
  renderHold();
  try {
    const pass = await _runEnginePass(h);
    if (_intent(h) === "cancel") {
      h.phase = "cancelled";
      h.resultText = "Cancelled";
    } else if (!pass) {
      h.phase = "error";
      if (!h.resultText) h.resultText = "Unload failed";
    } else {
      await _drainWaiters(h);
      if (_intent(h) === "cancel") {
        h.phase = "cancelled";
        h.resultText = "Cancelled";
      } else {
        h.phase = "queued";
        h.resultText = `Queued ${h.waiters.length} prompt(s)`;
      }
    }
  } catch (e) {
    h.phase = "error";
    h.resultText = e instanceof Error ? e.message : String(e);
  }
  for (const wtr of h.waiters) {
    if (wtr.state === "settled") continue;
    wtr.state = "settled";
    wtr.resolveDone(void 0);
  }
  _endHold(h);
  return w.done;
}
function _joinHold(args) {
  const h = hold;
  const w = _makeWaiter(args);
  h.waiters.push(w);
  const p = ensureChain.then(() => _ensureTargets(h));
  ensureChain = p.catch(() => {
  });
  w.ready = p.catch(() => {
  });
  renderHold();
  return w.done;
}
function _installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  origQueue = app.queuePrompt;
  app.queuePrompt = async function(...args) {
    const active = Array.from(registry).filter(
      (g) => !g.removed && g.mode === 0 && g._baseUrl()
    );
    if (!active.length) return origQueue.apply(app, args);
    if (!hold) return _startHold(args);
    return _joinHold(args);
  };
  const canvas = app.canvas;
  if (canvas && typeof canvas.setGraph === "function") {
    const origSetGraph = canvas.setGraph;
    canvas.setGraph = function(g) {
      const r = origSetGraph.call(this, g);
      _updateFocusVisibility();
      return r;
    };
  }
}
var focusBtn = null;
var focusLabel = null;
function _currentGraph() {
  return app.canvas?.graph ?? app.graph ?? null;
}
function _findFocusableNode() {
  const g = _currentGraph();
  if (!g) return null;
  for (const node of registry) {
    if (!node.removed && node.graph === g) return node;
  }
  return null;
}
function _ensureFocusButton() {
  if (focusBtn && focusBtn.isConnected) return;
  const anchor = document.querySelector('[data-testid="queue-button"]');
  if (!anchor || !anchor.parentElement) return;
  if (!focusBtn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comfort-topbar-focus";
    btn.title = "LLM Unload";
    const spinner = document.createElement("span");
    spinner.className = "llm-spinner";
    focusLabel = document.createElement("span");
    focusLabel.className = "llm-label";
    focusLabel.textContent = "\u26A1 LLM Unload";
    btn.appendChild(spinner);
    btn.appendChild(focusLabel);
    btn.addEventListener("click", () => {
      const node = _findFocusableNode();
      if (!node) return;
      node.refresh(true);
      const graph = node.graph;
      if (graph) {
        for (const n of graph._nodes || []) n.selected = false;
        node.selected = true;
      }
      const canvas = app.canvas;
      if (!canvas) return;
      const size = node.size || [200, 150];
      const cEl = canvas.canvas;
      const vw = cEl && cEl.clientWidth || window.innerWidth;
      const vh = cEl && cEl.clientHeight || window.innerHeight;
      const fit = Math.min(vw * 0.5 / (size[0] || 200), vh * 0.5 / (size[1] || 150));
      canvas.ds.scale = Math.min(Math.max(fit, 0.75), 2);
      canvas.centerOnNode(node);
      canvas.setDirty(true);
    });
    focusBtn = btn;
  }
  anchor.parentElement.appendChild(focusBtn);
  _updateFocusVisibility();
  _renderFocusButton();
}
function _updateFocusVisibility() {
  if (!focusBtn) return;
  const node = _findFocusableNode();
  focusBtn.style.display = node ? "" : "none";
}
function _allNodesInactive() {
  const g = _currentGraph();
  if (!g) return false;
  let any = false;
  for (const node of registry) {
    if (node.removed || node.graph !== g) continue;
    any = true;
    if (node.mode === 0) return false;
  }
  return any;
}
function _renderFocusButton() {
  if (!focusBtn || !focusBtn.isConnected || !focusLabel) return;
  const h = hold;
  let cls = "comfort-topbar-focus";
  let title = "LLM Unload";
  if (isActivePhase(h)) {
    const s = Math.max(0, Math.round((Date.now() - h.phaseStart) / 1e3));
    focusLabel.textContent = h.phase === "draining" ? "queueing\u2026" : `${s}s`;
    cls += " llm-spinning";
    const label = h.phaseNode ? h.phaseNode._engineLabel() : "engine";
    title = h.phase === "unloading" ? `Unloading ${h.phaseModel}\u2026` : h.phase === "busy" ? `${label} busy - waiting` : h.phase === "draining" ? "Submitting to ComfyUI" : `Checking ${label}`;
    if (h.waiters.length > 1) title += ` \xB7 ${h.waiters.length - 1} waiting`;
  } else if (_allNodesInactive()) {
    focusLabel.textContent = "\u26A1 LLM Unload \xB7 off";
    cls += " llm-inactive";
    title = "LLM Unload is bypassed/muted - click to focus";
  } else if (lastOutcome) {
    focusLabel.textContent = lastOutcome.cancelled ? "\u21A9 Unload" : lastOutcome.isError ? "\u2717 Unload" : "\u2713 Unload";
    cls += lastOutcome.isError ? " llm-error" : lastOutcome.cancelled ? "" : " llm-ok";
    title = lastOutcome.text;
  } else {
    focusLabel.textContent = "\u26A1 LLM Unload";
  }
  focusBtn.className = cls;
  focusBtn.title = title;
}
_ensureFocusButton();
new MutationObserver(() => {
  if (focusBtn && focusBtn.isConnected) return;
  _ensureFocusButton();
}).observe(document.body, { childList: true, subtree: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  for (const g of Array.from(registry)) {
    if (!g.removed) g.refresh(true);
  }
});
var LegacyLLMGateNode = class extends LLMGateNode {
  constructor() {
    super();
    this.type = LEGACY_NAME;
    this.title = LEGACY_NAME;
  }
  static {
    this.type = LEGACY_NAME;
  }
};
LiteGraph.registerNodeType(NODE_NAME, LLMGateNode);
LiteGraph.registerNodeType(LEGACY_NAME, LegacyLLMGateNode);
