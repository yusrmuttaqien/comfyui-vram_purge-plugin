"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // src/purge_menu.ts
  var import_app = __require("../../scripts/app.js");
  var import_api = __require("../../scripts/api.js");
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
      let res = await import_api.api.fetchApi("/vram_purge/purge", {
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
  import_app.app.registerExtension({
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
  function setupAutoPurge() {
    const anchor = document.querySelector('[data-testid="queue-button"]');
    if (!anchor || !anchor.parentElement) return;
    const existing = anchor.parentElement.querySelector("[data-vram-auto]");
    if (existing) existing.remove();
    const sel = document.createElement("select");
    sel.dataset.vramAuto = "true";
    sel.title = "Auto purge VRAM when queue completes";
    sel.style.cssText = "margin-left:8px;padding:2px 4px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;font-size:11px;";
    for (const opt of AUTO_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = "Purge: " + opt;
      sel.appendChild(o);
    }
    sel.value = getAutoMode();
    sel.addEventListener("change", () => {
      localStorage.setItem(AUTO_KEY, sel.value);
    });
    anchor.parentElement.appendChild(sel);
    let hadItems = false;
    let purging = false;
    setInterval(async () => {
      if (document.hidden) return;
      const mode = getAutoMode();
      if (mode === "off" || purging) return;
      try {
        const res = await fetch("/queue");
        const data = await res.json();
        const queue = data.queue;
        if (!queue) return;
        const pending = (queue.pending || []).length;
        const running = (queue.running || []).length;
        const hasItems = pending > 0 || running > 0;
        if (hasItems) {
          hadItems = true;
        } else if (hadItems) {
          hadItems = false;
          purging = true;
          try {
            await purgeVRAM(mode === "deep", true);
          } finally {
            purging = false;
          }
        }
      } catch {
      }
    }, 3e3);
  }
  setupAutoPurge();
  setInterval(setupAutoPurge, 5e3);
})();
