from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .server_purge import register_purge_route


WEB_DIRECTORY = "./web"


class VRAMPurgeExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return []

    @override
    async def on_load(self) -> None:
        register_purge_route()


async def comfy_entrypoint() -> VRAMPurgeExtension:
    return VRAMPurgeExtension()
