import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const purgeVRAM = async (deep) => {
    const label = deep ? "Purge VRAM (deep)" : "Purge VRAM";
    const detail = deep
        ? "This unloads all models AND destroys the CUDA context, so ComfyUI is fully out of VRAM. The context is re-created on the next generation."
        : "This unloads all models and frees cached VRAM. The CUDA context (a few hundred MB) stays resident.";
    if (!window.confirm(`${label}\n\n${detail}`)) {
        return;
    }

    try {
        let res = await api.fetchApi("/vram_purge/purge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deep }),
        });
        // Some ComfyUI builds hand back a raw Response; normalize to JSON.
        if (res && typeof res.json === "function") {
            res = await res.json();
        }
        console.log("VRAM purge response:", res);

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
        // If we got no usable snapshot, dump the raw response so it's debuggable.
        if ((!res.before || !res.before.length) && (!res.after || !res.after.length)) {
            lines.push("(no device snapshot) raw: " + JSON.stringify(res));
        }
        window.alert(lines.join("\n"));
    } catch (e) {
        console.error("VRAM purge failed:", e);
        window.alert(`VRAM purge failed: ${e}`);
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
