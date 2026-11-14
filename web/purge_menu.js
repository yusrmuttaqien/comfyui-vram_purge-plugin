import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const AUTO_KEY = "vram_purge_auto";
const AUTO_OPTIONS = ["off", "soft", "deep"];

const purgeVRAM = async (deep, silent) => {
    const label = deep ? "Purge VRAM (deep)" : "Purge VRAM";
    const detail = deep
        ? "This unloads all models AND destroys the CUDA context, so ComfyUI is fully out of VRAM. The context is re-created on the next generation."
        : "This unloads all models and frees cached VRAM. The CUDA context (a few hundred MB) stays resident.";
    if (!silent && !window.confirm(`${label}\n\n${detail}`)) {
        return;
    }

    try {
        let res = await api.fetchApi("/vram_purge/purge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deep }),
        });
        if (res && typeof res.json === "function") {
            res = await res.json();
        }
        console.log("VRAM purge response:", res);

        if (silent) {
            const used = (snap) => {
                if (!snap || !snap.length) return "?";
                const d = snap[0];
                if (d.used_gb != null) return `${d.used_gb} GB`;
                return d.error ? `error: ${d.error}` : "?";
            };
            console.log(`Auto-purge done. Used: ${used(res.before)} -> ${used(res.after)}`);
            return;
        }

        const used = (snap) => {
            if (!snap || !snap.length) return "?";
            const d = snap[0];
            if (d.used_gb != null) return `${d.used_gb} GB`;
            return d.error ? `error: ${d.error}` : "?";
        };
        const lines = [`Purged VRAM.`, `Backend: ${res.backend || "?"}`, `Used: ${used(res.before)} -> ${used(res.after)}`];
        if (res.context_reset) {
            lines.push(`Context reset: ${res.context_reset[1]}`);
        }
        if (res.driver) {
            lines.push(`Driver free: ${res.driver.free_gb} / ${res.driver.total_gb} GB`);
        }
        if ((!res.before || !res.before.length) && (!res.after || !res.after.length)) {
            lines.push("(no device snapshot) raw: " + JSON.stringify(res));
        }
        window.alert(lines.join("\n"));
    } catch (e) {
        console.error("VRAM purge failed:", e);
        if (!silent) window.alert(`VRAM purge failed: ${e}`);
    }
};

app.registerExtension({
    name: "VRAMPurge.Purge",
    commands: [
        {
            id: "VRAMPurge.Purge",
            label: "Purge VRAM",
            menubarLabel: "Purge VRAM",
            icon: "pi pi-trash",
            function: () => purgeVRAM(false),
        },
        {
            id: "VRAMPurge.PurgeDeep",
            label: "Purge VRAM (deep)",
            menubarLabel: "Purge VRAM (deep)",
            icon: "pi pi-trash",
            function: () => purgeVRAM(true),
        },
    ],
    menuCommands: [
        {
            path: [],
            commands: ["VRAMPurge.Purge", "VRAMPurge.PurgeDeep"],
        },
    ],
});

// --- Auto-purge on queue complete ---

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
            /* server unreachable, skip this tick */
        }
    }, 3000);
}

setupAutoPurge();
setInterval(setupAutoPurge, 5000); // re-attach if the menu bar re-renders
