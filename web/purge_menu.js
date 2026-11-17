// src/purge_menu.ts
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
var AUTO_KEY = "vram_purge_auto";
var AUTO_OPTIONS = ["off", "soft", "deep"];
function formatUsed(snap) {
  if (!snap || !snap.length) return "?";
  const d = snap[0];
  if (d.used_gb != null) return `${d.used_gb} GB`;
  return d.error ? `error: ${d.error}` : "?";
}
async function purgeVRAM(deep, silent) {
  const label = deep ? "Purge VRAM (deep)" : "Purge VRAM";
  const detail = deep ? "This unloads all models AND destroys the CUDA context, so ComfyUI is fully out of VRAM. The context is re-created on the next generation." : "This unloads all models and frees cached VRAM. The CUDA context (a few hundred MB) stays resident.";
  if (!silent && !window.confirm(`${label}

${detail}`)) return;
  try {
    let res = await api.fetchApi("/vram_purge/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deep })
    });
    if (res && typeof res.json === "function") {
      res = await res.json();
    }
    const data = res;
    console.log("VRAM purge response:", data);
    if (silent) {
      console.log(`Auto-purge done. Used: ${formatUsed(data.before)} -> ${formatUsed(data.after)}`);
      return;
    }
    const lines = [
      "Purged VRAM.",
      `Backend: ${data.backend || "?"}`,
      `Used: ${formatUsed(data.before)} -> ${formatUsed(data.after)}`
    ];
    if (data.context_reset) {
      lines.push(`Context reset: ${data.context_reset[1]}`);
    }
    if (data.driver) {
      lines.push(`Driver free: ${data.driver.free_gb} / ${data.driver.total_gb} GB`);
    }
    if ((!data.before || !data.before.length) && (!data.after || !data.after.length)) {
      lines.push("(no device snapshot) raw: " + JSON.stringify(data));
    }
    window.alert(lines.join("\n"));
  } catch (e) {
    console.error("VRAM purge failed:", e);
    if (!silent) window.alert(`VRAM purge failed: ${e}`);
  }
}
app.registerExtension({
  name: "VRAMPurge.Purge",
  commands: [
    {
      id: "VRAMPurge.Purge",
      label: "Purge VRAM",
      menubarLabel: "Purge VRAM",
      icon: "pi pi-trash",
      function: () => purgeVRAM(false, false)
    },
    {
      id: "VRAMPurge.PurgeDeep",
      label: "Purge VRAM (deep)",
      menubarLabel: "Purge VRAM (deep)",
      icon: "pi pi-trash",
      function: () => purgeVRAM(true, false)
    }
  ],
  menuCommands: [
    {
      path: [],
      commands: ["VRAMPurge.Purge", "VRAMPurge.PurgeDeep"]
    }
  ]
});
function getAutoMode() {
  const v = localStorage.getItem(AUTO_KEY);
  return AUTO_OPTIONS.includes(v) ? v : "off";
}
var autoSel = null;
var purging = false;
var prevRemaining = null;
function ensureAutoPurgeUI() {
  if (autoSel && autoSel.isConnected) return;
  const anchor = document.querySelector('[data-testid="queue-button"]');
  if (!anchor || !anchor.parentElement) return;
  if (!autoSel) {
    autoSel = document.createElement("select");
    autoSel.dataset.vramAuto = "true";
    autoSel.title = "Auto purge VRAM when queue completes";
    autoSel.style.cssText = "margin-left:8px;padding:2px 4px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;font-size:11px;";
    for (const opt of AUTO_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = "Purge: " + opt;
      autoSel.appendChild(o);
    }
    autoSel.value = getAutoMode();
    autoSel.addEventListener("change", () => {
      localStorage.setItem(AUTO_KEY, autoSel?.value ?? "off");
    });
  }
  anchor.parentElement.appendChild(autoSel);
}
function onQueueStatus(e) {
  const detail = e.detail;
  const n = detail?.exec_info?.queue_remaining ?? detail?.status?.exec_info?.queue_remaining;
  if (typeof n !== "number") return;
  const wasNonEmpty = prevRemaining !== null && prevRemaining > 0;
  prevRemaining = n;
  if (!wasNonEmpty || n !== 0) return;
  if (document.hidden) return;
  const mode = getAutoMode();
  if (mode === "off" || purging) return;
  purging = true;
  purgeVRAM(mode === "deep", true).finally(() => {
    purging = false;
  });
}
ensureAutoPurgeUI();
new MutationObserver(() => {
  if (autoSel && autoSel.isConnected) return;
  ensureAutoPurgeUI();
}).observe(document.body, { childList: true, subtree: true });
if (typeof api.addEventListener === "function") {
  api.addEventListener("status", onQueueStatus);
}
