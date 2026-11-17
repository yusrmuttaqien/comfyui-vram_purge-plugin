// NInfer Suspend Gate: self-contained for VRAM Purge plugin.
// Frees GPU memory by suspending NInfer models on queue.
//
// Feedback model (no idle polling):
// - A module-level "hold" state machine covers the whole Run flow:
//   checking -> suspending -> busy -> draining -> queued | error | cancelled
//   Every transition renders node status + chrome button synchronously.
// - Run clicks made while a hold is active join it (batched) and are
//   submitted to ComfyUI in click order once suspends complete.
// - A 250ms ticker exists only while a hold is active (elapsed seconds).
// - Model list refreshes on interaction (hover/click/URL change), on
//   hold start (always a fresh fetch), on hold end, on tab visibility,
//   and on focus-button click. Status shows the data age.
import { app } from "/scripts/app.js";

const NINFER_GATE = "NInfer Suspend Gate";
const MIN_W = 300;
const BUSY_RETRY_MS = 5000;
const TICKER_MS = 250;
const HOVER_WINDOW_MS = 1000; // hover refresh window
const TIMEOUT_OPTIONS = ["indefinite", "1", "5", "10", "15", "30", "60"];

// --- Types ---

interface NInferModel {
  id: string;
  value: string;
}

interface ForwardResult {
  status: number;
  body: unknown;
}

interface GateState {
  el: HTMLDivElement;
  urlInput: HTMLInputElement;
  timeoutSel: HTMLSelectElement;
  statusEl: HTMLDivElement;
  statusText: HTMLSpanElement;
  cancelBtn: HTMLButtonElement;
  skipBtn: HTMLButtonElement;
  bulkEl: HTMLDivElement;
  rowsEl: HTMLDivElement;
  models: NInferModel[];
  selected: Set<string>;
  modelsAt: number;
  refreshing: boolean;
}

type HoldPhase =
  | "checking"
  | "suspending"
  | "busy"
  | "draining"
  | "queued"
  | "error"
  | "cancelled";

interface Waiter {
  args: unknown[];
  done: Promise<unknown>;
  resolveDone: (v: unknown) => void;
  rejectDone: (e: unknown) => void;
  ready: Promise<void>;
  state: "waiting" | "submitting" | "settled";
}

interface Hold {
  phase: HoldPhase;
  phaseModel: string;
  phaseGate: NInferGateNode | null;
  phaseStart: number;
  waiters: Waiter[];
  intent: "none" | "cancel" | "skip";
  abort: AbortController | null;
  resultText: string;
  isError: boolean;
  covered: Set<string>;
  startedAt: number;
  drainIndex: number;
}

interface Outcome {
  text: string;
  isError: boolean;
  cancelled: boolean;
  at: number;
}

// --- API ---

async function forward(
  url: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<ForwardResult> {
  const resp =
    body === undefined
      ? await fetch("/comfort/ninfer/forward?url=" + encodeURIComponent(url), { signal })
      : await fetch("/comfort/ninfer/forward", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, body }),
          signal,
        });
  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: resp.status, body: parsed };
}

const modelCache = new Map<string, { at: number; models: NInferModel[] }>();
const inFlight = new Map<string, Promise<NInferModel[]>>();

async function fetchModels(
  base: string,
  maxAgeMs: number,
  signal?: AbortSignal
): Promise<NInferModel[]> {
  const key = base + "/v1/models";
  if (maxAgeMs > 0) {
    const hit = modelCache.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.models;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const r = await forward(key, undefined, signal);
    const data = (r.body as { data?: { id: string; status?: { value?: string } }[] })?.data;
    const models: NInferModel[] = Array.isArray(data)
      ? data.map((m) => ({ id: String(m.id), value: String(m.status?.value ?? "") }))
      : [];
    modelCache.set(key, { at: Date.now(), models });
    return models;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function suspendModel(
  base: string,
  id: string,
  signal?: AbortSignal
): Promise<ForwardResult> {
  return forward(base + "/v1/models/" + encodeURIComponent(id) + "/suspend", {}, signal);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- CSS ---

const CSS = `
.comfort-ninfer { display: flex; flex-direction: column; gap: 4px; font-size: 12px; height: 100%; overflow-y: auto; }
.comfort-ninfer-url, .comfort-ninfer-timeout {
  width: 100%; padding: 4px 6px; border-radius: 4px;
  border: 1px solid #555; background: #2a2a2a; color: #eee; font-size: 12px;
}
.comfort-ninfer-status {
  display: flex; align-items: center; gap: 8px; min-height: 24px;
  font-size: 11px; color: #aaa;
}
.comfort-ninfer-status-text.ok { color: #86efac; }
.comfort-ninfer-status-text.err { color: #fca5a5; }
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
.comfort-ninfer-row .ninfer-spinner { display: none; }
.comfort-ninfer-row.suspending .ninfer-spinner { display: inline-block; }
.comfort-ninactive { opacity: 0.55; }
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
.comfort-topbar-focus.ninfer-ok { border-color: #16a34a; }
.comfort-topbar-focus.ninfer-error { border-color: #dc2626; }
.comfort-topbar-focus.ninfer-spinning .ninfer-label { display: none; }
.comfort-topbar-focus .ninfer-spinner { display: none; }
.comfort-topbar-focus.ninfer-spinning .ninfer-spinner { display: inline-block; }
.comfort-topbar-focus.ninfer-inactive { opacity: 0.6; border-style: dashed; }
.comfort-topbar-focus.ninfer-inactive:hover { opacity: 1; }
.ninfer-spinner {
  width: 12px; height: 12px; border: 2px solid #888; border-top-color: #eee;
  border-radius: 50%; animation: ninfer-spin 0.8s linear infinite; vertical-align: middle;
}
@keyframes ninfer-spin { to { transform: rotate(360deg); } }
`;

const styleEl = document.createElement("style");
styleEl.setAttribute("data-comfort-ninfer", "true");
styleEl.textContent = CSS;
document.head.appendChild(styleEl);

// --- Virtual node base (self-contained) ---

declare class LGraphNode {
  title: string;
  widgets: unknown[];
  properties: Record<string, unknown>;
  size: [number, number];
  graph: unknown;
  selected: boolean;
  constructor(title?: string);
  setSize(size: [number, number]): void;
  configure(info: Record<string, unknown>): void;
  onRemoved?(): void;
  onAdded?(): void;
  addDOMWidget?(name: string, type: string, el: HTMLElement, opts?: Record<string, unknown>): void;
}

function _findProtoPropDescriptor(
  obj: object,
  prop: string
): PropertyDescriptor | undefined {
  let proto = Object.getPrototypeOf(obj);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc) return desc;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

class ComfortVirtualNode extends LGraphNode {
  isVirtualNode = true;
  removed = false;
  configuring = false;
  declare mode: number;
  private __comfort_mode = 0;
  onModeChange?: (old: number, mode: number) => void;

  constructor(title: string) {
    super(title);
    this.widgets = this.widgets || [];
    this.properties = this.properties || {};

    const protoMode = _findProtoPropDescriptor(this, "mode");
    const readMode = () => {
      if (protoMode?.get) return (protoMode.get as () => number).call(this);
      return this.__comfort_mode;
    };
    Object.defineProperty(this, "mode", {
      configurable: true,
      enumerable: true,
      get: readMode,
      set: (mode: number) => {
        const old = readMode();
        if (protoMode?.set) (protoMode.set as (v: number) => void).call(this, mode);
        else this.__comfort_mode = mode;
        if (old !== mode) this.onModeChange?.(old, mode);
      },
    });
  }

  configure(info: Record<string, unknown>): void {
    this.configuring = true;
    super.configure(info);
    this.configuring = false;
  }

  onRemoved(): void {
    super.onRemoved?.();
    this.removed = true;
  }

  getHelp(): string {
    return "";
  }
}

// --- Hold state (module-level, shared across all gates and Run clicks) ---

let hold: Hold | null = null;
let lastOutcome: Outcome | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let ensureChain: Promise<void> = Promise.resolve();

function isActivePhase(h: Hold | null): boolean {
  return (
    !!h &&
    (h.phase === "checking" ||
      h.phase === "suspending" ||
      h.phase === "busy" ||
      h.phase === "draining")
  );
}

function _startTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    if (hold) renderHold();
  }, TICKER_MS);
}

function _stopTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function renderHold(): void {
  for (const g of Array.from(registry)) {
    if (g.removed) continue;
    try {
      g._renderStatus();
    } catch {}
  }
  _renderFocusButton();
}

// --- NInfer Gate Node ---

const registry = new Set<NInferGateNode>();
let hooksInstalled = false;
let origQueue: ((...a: unknown[]) => Promise<unknown>) | null = null;

class NInferGateNode extends ComfortVirtualNode {
  st: GateState;

  // Bypass/mute (or restore) of this gate: re-render state without a
  // model fetch. During deserialization, onAdded/refresh renders.
  onModeChange = (_old: number, _mode: number): void => {
    if (this.configuring || !this.st) return;
    this._renderStatus();
    _renderFocusButton();
  };

  constructor() {
    super(NINFER_GATE);
    this.properties = { url: "", timeout: "indefinite", selected: null };
    this.setSize([MIN_W, 200]);
    this.st = this._setupWidget();
    registry.add(this);
    _installHooks();
  }

  configure(info: Record<string, unknown>): void {
    super.configure(info);
    this._syncFields();
  }
  onAdded(): void {
    super.onAdded?.();
    this._syncFields();
    this.refresh(true);
    _updateFocusVisibility();
  }
  onRemoved(): void {
    registry.delete(this);
    _updateFocusVisibility();
    super.onRemoved?.();
  }

  _baseUrl(): string {
    return String(this.properties.url || "").trim().replace(/\/+$/, "");
  }
  _timeoutMs(): number {
    const t = String(this.properties.timeout || "indefinite");
    if (t === "indefinite") return Infinity;
    const m = parseInt(t, 10);
    return Number.isFinite(m) && m > 0 ? m * 60000 : Infinity;
  }
  _computeSelected(models: NInferModel[]): Set<string> {
    const saved = this.properties.selected as string[] | null;
    if (saved == null)
      return new Set(models.filter((m) => m.value === "loaded").map((m) => m.id));
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  }

  _setupWidget(): GateState {
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
      o.textContent =
        opt === "indefinite" ? "Busy timeout: indefinite" : `Busy timeout: ${opt} min`;
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

    const st: GateState = {
      el,
      urlInput,
      timeoutSel,
      statusEl,
      statusText,
      cancelBtn,
      skipBtn,
      bulkEl,
      rowsEl,
      models: [],
      selected: new Set(),
      modelsAt: 0,
      refreshing: false,
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

    rowsEl.addEventListener("change", (e: Event) => {
      const cb = e.target as HTMLInputElement;
      if (cb.type !== "checkbox" || !cb.dataset.id) return;
      const sel = new Set(st.selected);
      if (cb.checked) sel.add(cb.dataset.id);
      else sel.delete(cb.dataset.id);
      st.selected = sel;
      this.properties.selected = Array.from(sel);
    });

    bulkEl.addEventListener("click", (e: Event) => {
      const action = (e.target as HTMLElement)?.dataset?.bulk;
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

    urlInput.addEventListener("input", () => {
      this.properties.url = urlInput.value.trim();
    });
    urlInput.addEventListener("change", () => {
      this.properties.url = urlInput.value.trim();
      this.properties.selected = null;
      st.models = [];
      st.modelsAt = 0;
      st.selected = new Set();
      lastOutcome = null;
      this.refresh(true);
    });
    timeoutSel.addEventListener("change", () => {
      this.properties.timeout = timeoutSel.value;
    });

    // Interaction-driven refresh: hover uses a 1s window, press is fresh.
    el.addEventListener("pointerenter", () => {
      this.refresh(false);
    });
    el.addEventListener("pointerdown", () => {
      this.refresh(true);
    });

    if (typeof this.addDOMWidget === "function") {
      this.addDOMWidget("ninfer", "comfort_ninfer_list", el, {
        serialize: false,
        hideOnZoom: true,
      });
    }
    return st;
  }

  _syncFields(): void {
    const st = this.st;
    st.urlInput.value = String(this.properties.url || "");
    const t = String(this.properties.timeout || "indefinite");
    st.timeoutSel.value = TIMEOUT_OPTIONS.includes(t) ? t : "indefinite";
    st.selected = this._computeSelected(st.models);
  }

  _setModels(models: NInferModel[]): void {
    const st = this.st;
    st.models = models;
    st.modelsAt = Date.now();
    if (this.properties.selected == null) {
      this.properties.selected = models
        .filter((m) => m.value === "loaded")
        .map((m) => m.id);
    }
    st.selected = this._computeSelected(models);
    this._renderRows();
  }

  _renderRows(): void {
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
      const spinner = document.createElement("span");
      spinner.className = "ninfer-spinner";
      rowEl.appendChild(spinner);
      const title = document.createElement("span");
      title.className = "comfort-node-title";
      title.textContent = m.id;
      title.title = m.id;
      rowEl.appendChild(title);
      const state = m.value || "unknown";
      const badge = document.createElement("span");
      badge.className =
        "comfort-ninfer-badge " +
        (state === "loaded" ? "loaded" : state === "sleeping" ? "suspended" : "other");
      badge.textContent = state === "sleeping" ? "suspended" : state;
      rowEl.appendChild(badge);
      st.rowsEl.appendChild(rowEl);
    }
    this._updateRowSpinners();
  }

  _updateRowSpinners(): void {
    const active =
      hold?.phase === "suspending" &&
      hold.phaseGate === this &&
      !!hold.phaseModel;
    const rows = this.st.rowsEl.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      if (!row.dataset?.id) continue;
      row.classList.toggle(
        "suspending",
        active && row.dataset.id === hold!.phaseModel
      );
    }
  }

  _idleSummary(): string {
    if (!this._baseUrl()) return "Set NInfer URL to enable";
    const m = this.st.models;
    if (!m.length) return "Loading models…";
    const loaded = m.filter((x) => x.value === "loaded").length;
    const age = this.st.modelsAt
      ? ` · checked ${Math.max(0, Math.round((Date.now() - this.st.modelsAt) / 1000))}s ago`
      : "";
    if (!loaded) return `No loaded models${age}`;
    return `${loaded} loaded · ${m.length - loaded} other${age}`;
  }

  _renderStatus(): void {
    const st = this.st;
    const h = hold;
    let text: string;
    let tone: "info" | "ok" | "err" = "info";
    const inactive = this.mode !== 0;
    if (isActivePhase(h)) {
      const s = Math.max(0, Math.round((Date.now() - h!.phaseStart) / 1000));
      const waiting = h!.waiters.length > 1 ? ` · ${h!.waiters.length - 1} waiting` : "";
      switch (h!.phase) {
        case "checking":
          text = "Checking NInfer…" + waiting;
          break;
        case "suspending":
          text = `Suspending ${h!.phaseModel}… ${s}s` + waiting;
          break;
        case "busy":
          text = `NInfer busy - waiting… ${s}s` + waiting;
          break;
        case "draining":
          text = `Submitting ${Math.min(h!.drainIndex + 1, h!.waiters.length)}/${h!.waiters.length} prompt(s)…`;
          break;
        default:
          text = this._idleSummary();
      }
    } else if (inactive) {
      text = "Inactive (bypassed/muted)";
    } else if (lastOutcome) {
      text = (lastOutcome.cancelled ? "↩ " : lastOutcome.isError ? "✗ " : "✓ ") + lastOutcome.text;
      tone = lastOutcome.isError ? "err" : lastOutcome.cancelled ? "info" : "ok";
    } else {
      text = this._idleSummary();
    }
    st.statusText.textContent = text;
    st.statusText.className =
      "comfort-ninfer-status-text" + (tone === "err" ? " err" : tone === "ok" ? " ok" : "");
    const active = isActivePhase(h);
    st.cancelBtn.hidden = !active;
    st.skipBtn.hidden = !active;
    st.el.classList.toggle("comfort-ninactive", inactive && !active);
    this._updateRowSpinners();
  }

  async refresh(fresh: boolean, keepOutcome = false): Promise<void> {
    const st = this.st;
    if (st.refreshing) return;
    // Don't disturb an in-progress suspend.
    if (hold && (hold.phase === "checking" || hold.phase === "suspending" || hold.phase === "busy"))
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
        lastOutcome = { text: "NInfer unreachable", isError: true, cancelled: false, at: Date.now() };
      }
      this._renderStatus();
    } finally {
      st.refreshing = false;
    }
  }
}

// --- Hold lifecycle (queue hook + batched waiters) ---

// Fresh property read each call: TS's control-flow analysis otherwise
// carries pre-await narrowing across async boundaries and flags the
// "cancel" comparison as impossible.
function _intent(h: Hold): Hold["intent"] {
  return h.intent;
}

function _makeWaiter(args: unknown[]): Waiter {
  let resolveDone: (v: unknown) => void = () => {};
  let rejectDone: (e: unknown) => void = () => {};
  const done = new Promise<unknown>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  return {
    args,
    done,
    resolveDone,
    rejectDone,
    ready: Promise.resolve(),
    state: "waiting",
  };
}

async function _suspendOne(
  h: Hold,
  gate: NInferGateNode,
  base: string,
  m: NInferModel
): Promise<boolean> {
  const key = base + "|" + m.id;
  if (h.covered.has(key)) return true;
  h.phase = "suspending";
  h.phaseModel = m.id;
  h.phaseGate = gate;
  h.phaseStart = Date.now();
  renderHold();
  const mStart = Date.now();
  for (;;) {
    if (h.intent !== "none") break;
    const ac = new AbortController();
    h.abort = ac;
    let r: ForwardResult;
    try {
      r = await suspendModel(base, m.id, ac.signal);
    } catch {
      if (ac.signal.aborted) break;
      throw new Error("suspend request failed");
    }
    if (r.status === 200) {
      h.covered.add(key);
      return true;
    }
    if (r.status === 409) {
      h.phase = "busy";
      renderHold();
      await sleep(BUSY_RETRY_MS);
      if (h.intent !== "none") break;
      if (Date.now() - mStart > gate._timeoutMs())
        throw new Error("timed out waiting for NInfer to idle");
      continue;
    }
    throw new Error(`suspend failed (HTTP ${r.status})`);
  }
  return false;
}

async function _ensureTargets(h: Hold): Promise<void> {
  // Re-check for models that became loaded since the pass (auto-resume).
  for (const gate of Array.from(registry)) {
    if (gate.removed || gate.mode !== 0 || h.intent !== "none") continue;
    const base = gate._baseUrl();
    if (!base) continue;
    let models: NInferModel[];
    try {
      // Always fresh: the gate must see the current model state, not a
      // cached snapshot (auto-resume can load a model at any time).
      models = await fetchModels(base, 0);
    } catch {
      continue;
    }
    gate._setModels(models);
    for (const m of models) {
      if (h.intent !== "none") break;
      if (m.value !== "loaded" || !gate.st.selected.has(m.id)) continue;
      if (h.covered.has(base + "|" + m.id)) continue;
      await _suspendOne(h, gate, base, m);
    }
  }
}

async function _runGatePass(h: Hold): Promise<boolean> {
  for (const gate of Array.from(registry)) {
    if (gate.removed || gate.mode !== 0) continue;
    if (h.intent === "cancel" || h.intent === "skip") break;
    const base = gate._baseUrl();
    if (!base) continue;
    let models: NInferModel[];
    try {
      // Always fresh: the gate must see the current model state, not a
      // cached snapshot (auto-resume can load a model at any time).
      models = await fetchModels(base, 0);
    } catch {
      h.resultText = "NInfer unreachable";
      h.isError = true;
      return false;
    }
    gate._setModels(models);
    for (const m of models) {
      if (h.intent !== "none") break;
      if (m.value !== "loaded" || !gate.st.selected.has(m.id)) continue;
      if (h.covered.has(base + "|" + m.id)) continue;
      await _suspendOne(h, gate, base, m);
    }
  }
  return h.intent !== "cancel";
}

async function _drainWaiters(h: Hold): Promise<void> {
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
      const r = await (origQueue as (...a: unknown[]) => Promise<unknown>).apply(
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

function _endHold(h: Hold): void {
  const total = Math.round((Date.now() - h.startedAt) / 1000);
  if (h.phase === "queued") h.resultText += ` · gate ${total}s`;
  lastOutcome = {
    text: h.resultText,
    isError: h.phase === "error",
    cancelled: h.phase === "cancelled",
    at: Date.now(),
  };
  hold = null;
  renderHold();
  _stopTicker();
  // Hold end is an event: refresh model lists (the gate just changed
  // them) without wiping the outcome text shown above.
  for (const g of Array.from(registry)) {
    if (!g.removed) g.refresh(true, true).catch(() => {});
  }
}

async function _startHold(args: unknown[]): Promise<unknown> {
  const h: Hold = {
    phase: "checking",
    phaseModel: "",
    phaseGate: null,
    phaseStart: Date.now(),
    waiters: [],
    intent: "none",
    abort: null,
    resultText: "",
    isError: false,
    covered: new Set(),
    startedAt: Date.now(),
    drainIndex: 0,
  };
  hold = h;
  lastOutcome = null;
  const w = _makeWaiter(args);
  h.waiters.push(w);
  _startTicker();
  renderHold();
  try {
    const pass = await _runGatePass(h);
    if (_intent(h) === "cancel") {
      h.phase = "cancelled";
      h.resultText = "Cancelled";
    } else if (!pass) {
      h.phase = "error";
      if (!h.resultText) h.resultText = "Gate failed";
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
  // Settle any waiters not settled by the drain (cancel/error paths).
  for (const wtr of h.waiters) {
    if (wtr.state === "settled") continue;
    wtr.state = "settled";
    wtr.resolveDone(undefined);
  }
  _endHold(h);
  return w.done;
}

function _joinHold(args: unknown[]): Promise<unknown> {
  const h = hold!;
  const w = _makeWaiter(args);
  h.waiters.push(w);
  // Re-check for models that became loaded since the pass's fetch (e.g.
  // NInfer auto-resume) before this waiter is submitted. Serialized so
  // concurrent joins don't overlap; safe to run while the pass is active
  // (covered set + 409 handling dedupe).
  const p = ensureChain.then(() => _ensureTargets(h));
  ensureChain = p.catch(() => {});
  // A recheck failure must not fail the drain; the pass already covered
  // what it saw.
  w.ready = p.catch(() => {});
  renderHold();
  return w.done;
}

function _installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  origQueue = app.queuePrompt as (...a: unknown[]) => Promise<unknown>;
  app.queuePrompt = async function (...args: unknown[]): Promise<unknown> {
    const active = Array.from(registry).filter(
      (g) => !g.removed && g.mode === 0 && g._baseUrl()
    );
    if (!active.length) return origQueue!.apply(app, args);
    if (!hold) return _startHold(args);
    return _joinHold(args);
  };
  // Graph switch: update focus-button visibility (event-driven).
  const canvas = (app as unknown as { canvas?: { setGraph?: (g: unknown) => unknown } }).canvas;
  if (canvas && typeof canvas.setGraph === "function") {
    const origSetGraph = canvas.setGraph;
    canvas.setGraph = function (g: unknown) {
      const r = origSetGraph.call(this, g);
      _updateFocusVisibility();
      return r;
    };
  }
}

// --- Chrome focus button (created once, event-driven) ---

let focusBtn: HTMLButtonElement | null = null;
let focusLabel: HTMLSpanElement | null = null;

function _currentGraph(): unknown {
  return (app as unknown as { canvas?: { graph?: unknown }; graph?: unknown }).canvas?.graph ??
    (app as unknown as { graph?: unknown }).graph ??
    null;
}

function _findFocusableGate(): NInferGateNode | null {
  const g = _currentGraph();
  if (!g) return null;
  for (const gate of registry) {
    if (!gate.removed && gate.graph === g) return gate;
  }
  return null;
}

function _ensureFocusButton(): void {
  if (focusBtn && focusBtn.isConnected) return;
  const anchor = document.querySelector('[data-testid="queue-button"]');
  if (!anchor || !anchor.parentElement) return;
  if (!focusBtn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comfort-topbar-focus";
    btn.title = "NInfer gate";
    const spinner = document.createElement("span");
    spinner.className = "ninfer-spinner";
    focusLabel = document.createElement("span");
    focusLabel.className = "ninfer-label";
    focusLabel.textContent = "⚡ NInfer";
    btn.appendChild(spinner);
    btn.appendChild(focusLabel);
    btn.addEventListener("click", () => {
      const gate = _findFocusableGate();
      if (!gate) return;
      gate.refresh(true);
      const graph = gate.graph as { _nodes?: { selected: boolean }[] } | null;
      if (graph) {
        for (const n of graph._nodes || []) n.selected = false;
        gate.selected = true;
      }
      const canvas = (app as unknown as { canvas?: CanvasLike }).canvas;
      if (!canvas) return;
      const size = gate.size || [200, 150];
      const cEl = canvas.canvas as HTMLCanvasElement | null;
      const vw = (cEl && cEl.clientWidth) || window.innerWidth;
      const vh = (cEl && cEl.clientHeight) || window.innerHeight;
      const fit = Math.min((vw * 0.5) / (size[0] || 200), (vh * 0.5) / (size[1] || 150));
      canvas.ds.scale = Math.min(Math.max(fit, 0.75), 2.0);
      canvas.centerOnNode(gate);
      canvas.setDirty(true);
    });
    focusBtn = btn;
  }
  anchor.parentElement.appendChild(focusBtn);
  _updateFocusVisibility();
  _renderFocusButton();
}

function _updateFocusVisibility(): void {
  if (!focusBtn) return;
  const gate = _findFocusableGate();
  focusBtn.style.display = gate ? "" : "none";
}

// True when the current graph has gate nodes but none of them is active
// (all bypassed/muted). The chrome button stays visible in that state.
function _allGatesInactive(): boolean {
  const g = _currentGraph();
  if (!g) return false;
  let any = false;
  for (const gate of registry) {
    if (gate.removed || gate.graph !== g) continue;
    any = true;
    if (gate.mode === 0) return false;
  }
  return any;
}

function _renderFocusButton(): void {
  if (!focusBtn || !focusBtn.isConnected || !focusLabel) return;
  const h = hold;
  let cls = "comfort-topbar-focus";
  let title = "NInfer gate";
  if (isActivePhase(h)) {
    const s = Math.max(0, Math.round((Date.now() - h!.phaseStart) / 1000));
    focusLabel.textContent = h!.phase === "draining" ? "queueing…" : `${s}s`;
    cls += " ninfer-spinning";
    title = h!.phase === "suspending"
      ? `Suspending ${h!.phaseModel}…`
      : h!.phase === "busy"
        ? "NInfer busy - waiting"
        : h!.phase === "draining"
          ? "Submitting to ComfyUI"
          : "Checking NInfer";
    if (h!.waiters.length > 1) title += ` · ${h!.waiters.length - 1} waiting`;
  } else if (_allGatesInactive()) {
    focusLabel.textContent = "⚡ NInfer · off";
    cls += " ninfer-inactive";
    title = "NInfer gate is bypassed/muted — click to focus";
  } else if (lastOutcome) {
    focusLabel.textContent = lastOutcome.cancelled
      ? "↩ NInfer"
      : lastOutcome.isError
        ? "✗ NInfer"
        : "✓ NInfer";
    cls += lastOutcome.isError ? " ninfer-error" : lastOutcome.cancelled ? "" : " ninfer-ok";
    title = lastOutcome.text;
  } else {
    focusLabel.textContent = "⚡ NInfer";
  }
  focusBtn.className = cls;
  focusBtn.title = title;
}

interface CanvasLike {
  canvas: HTMLCanvasElement | null;
  ds: { scale: number };
  centerOnNode(node: unknown): void;
  setDirty(dirty: boolean): void;
}

// --- Event wiring ---

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

// --- Register ---

declare const LiteGraph: { registerNodeType(name: string, ctor: new () => unknown): void };

LiteGraph.registerNodeType(NINFER_GATE, NInferGateNode);
