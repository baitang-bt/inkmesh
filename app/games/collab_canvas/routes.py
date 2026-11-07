import logging
import random
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.games.collab_canvas import room_store as store
from app.games.collab_canvas.ws_handlers import handle_collab_websocket
from app.games.common.lobby import (
    generate_random_room_id,
    list_joinable_collab_rooms,
)
from app.routers.auth import get_optional_identity

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))
router = APIRouter()
logger = logging.getLogger(__name__)

GAME_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = GAME_DIR.parents[2]
DEPLOY_PAGES = PROJECT_ROOT / "deploy" / "pages"
GAME_ID = store.GAME_ID
APP_PATH = "/inkmesh"
STATIC_URL = "/static/games/inkmesh"
# 静态资源 ?v= 版本号；改 JS/CSS 后递增以便生产绕过浏览器缓存。
COLLAB_ASSET_VERSION = "20261107a"

game_info = {
    "id": GAME_ID,
    "name": "Inkmesh",
    "logo": "/static/img/logo.svg",
    "url": APP_PATH,
    "menu_order": 15,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}

# 兼容旧导入：房间表挂在 store
rooms = store.rooms
player_rooms = store.player_rooms


def _render_home(request: Request, identity, initial_room: str = ""):
    """渲染 Inkmesh 首页 / 带房间号深链。"""
    user_id, nickname = identity
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
            "initial_room": initial_room,
            "asset_version": COLLAB_ASSET_VERSION,
        },
    )


@router.get("/collab-canvas", include_in_schema=False)
@router.get("/collab-canvas/{rest:path}", include_in_schema=False)
async def redirect_legacy_collab_canvas(rest: str = ""):
    """旧路径 /collab-canvas 跳到 /inkmesh。"""
    suffix = ("/" + rest) if rest else ""
    return RedirectResponse(url=APP_PATH + suffix, status_code=302)


@router.get(APP_PATH, response_class=HTMLResponse)
async def inkmesh_page(request: Request, identity=Depends(get_optional_identity)):
    """渲染 Inkmesh 大厅首页。"""
    if identity is None:
        return RedirectResponse(url="/login?next=" + APP_PATH, status_code=302)
    return _render_home(request, identity)


@router.get(APP_PATH + "/random-room")
async def random_room(identity=Depends(get_optional_identity)):
    """为随机加入挑选在线房间（跳过 P 开头），没有则生成新房间号。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    candidates = list_joinable_collab_rooms(rooms)
    if candidates:
        return {"room_id": random.choice(candidates), "created": False}
    return {"room_id": generate_random_room_id(rooms), "created": True}


@router.get(APP_PATH + "/lobby")
async def local_public_lobby(q: str = ""):
    """本机无 Worker 大厅时返回空列表；公开站走信令 Worker /inkmesh/lobby。"""
    _ = q
    return {"rooms": []}


@router.get(APP_PATH + "/config.json", include_in_schema=False)
async def inkmesh_runtime_config():
    """本机开发用运行时配置（公开站由 Pages 静态文件提供）。"""
    path = DEPLOY_PAGES / "config.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="config missing")
    return FileResponse(path, media_type="application/json")


@router.get(APP_PATH + "/manifest.webmanifest", include_in_schema=False)
async def inkmesh_manifest():
    """PWA manifest（本机从 deploy/pages 读取）。"""
    path = DEPLOY_PAGES / "manifest.webmanifest"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="manifest missing")
    return FileResponse(path, media_type="application/manifest+json")


@router.get(APP_PATH + "/icons/{name}", include_in_schema=False)
async def inkmesh_icon(name: str):
    """PWA / favicon 图标。"""
    if "/" in name or "\\" in name or name.startswith("."):
        raise HTTPException(status_code=404, detail="icon missing")
    path = DEPLOY_PAGES / "icons" / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="icon missing")
    media = "image/svg+xml" if name.endswith(".svg") else "image/png"
    return FileResponse(path, media_type=media)


@router.get(APP_PATH + "/{room_id}", response_class=HTMLResponse)
async def inkmesh_room(
    request: Request, room_id: str, identity=Depends(get_optional_identity)
):
    """带房间号的深链。"""
    if not store.is_valid_room_path_id(room_id):
        raise HTTPException(status_code=404, detail="房间链接无效")
    next_path = APP_PATH + "/" + quote(room_id, safe="")
    if identity is None:
        return RedirectResponse(url="/login?next=" + quote(next_path, safe=""), status_code=302)
    return _render_home(request, identity, initial_room=room_id)


@router.websocket(APP_PATH + "/ws")
async def inkmesh_websocket(websocket: WebSocket):
    """Inkmesh 实时协议（实现见 ws_handlers.process）。"""
    await handle_collab_websocket(websocket)
