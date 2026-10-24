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
        const res = await api.fetchApi("/vram_purge/purge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deep }),
        });

        const used = (snap) =>
            snap && snap.length ? `${snap[0].used_gb} GB` : "?";
        const lines = [`Purged VRAM.`, `Used: ${used(res.before)} -> ${used(res.after)}`];
        if (res.context_reset) {
            lines.push(`CUDA context: ${res.context_reset[1]}`);
        }
        if (res.driver) {
            lines.push(`Driver free: ${res.driver.free_gb} / ${res.driver.total_gb} GB`);
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
