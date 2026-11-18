"""LLM engine proxy routes.

Relays GET/POST from the browser to a user-supplied engine URL, passing
through the real status code + body (so e.g. 409 model_busy reaches the
frontend as a 409). The frontend supplies the full target URL; this is a
local tool, so a generic forwarder is fine.
"""

import aiohttp
from aiohttp import web
from server import PromptServer

_FORWARD_TIMEOUT = aiohttp.ClientTimeout(total=180)
_route_registered = False


async def _forward_get(request):
    url = request.query.get("url")
    if not url:
        return web.json_response({"error": "missing url"}, status=400)
    async with aiohttp.ClientSession(timeout=_FORWARD_TIMEOUT) as session:
        async with session.get(url) as resp:
            text = await resp.text()
            return web.Response(
                body=text,
                status=resp.status,
                content_type=resp.headers.get("Content-Type", "application/json"),
            )


async def _forward_post(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    url = data.get("url")
    if not url:
        return web.json_response({"error": "missing url"}, status=400)
    async with aiohttp.ClientSession(timeout=_FORWARD_TIMEOUT) as session:
        async with session.post(url, json=data.get("body") or {}) as resp:
            text = await resp.text()
            return web.Response(
                body=text,
                status=resp.status,
                content_type=resp.headers.get("Content-Type", "application/json"),
            )


def register_llm_routes():
    global _route_registered
    if _route_registered:
        return
    routes = PromptServer.instance.routes
    routes.get("/comfort/llm/forward")(_forward_get)
    routes.post("/comfort/llm/forward")(_forward_post)
    _route_registered = True
