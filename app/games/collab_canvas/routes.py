import logging
import random
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import HTMLResponse, RedirectResponse
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
GAME_ID = store.GAME_ID
STATIC_URL = "/static/games/collab-canvas"
# 静态资源 ?v= 版本号；改 JS/CSS 后递增以便生产绕过浏览器缓存。
COLLAB_ASSET_VERSION = "20261016c"

game_info = {
    "id": GAME_ID,
    "name": "Inkmesh",
    "logo": "/static/img/logo.svg",
    "url": "/collab-canvas",
    "menu_order": 15,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}

# 兼容旧导入：房间表挂在 store
rooms = store.rooms
player_rooms = store.player_rooms

@router.get("/collab-canvas", response_class=HTMLResponse)
async def collab_canvas_page(request: Request, identity=Depends(get_optional_identity)):
    """渲染合作画板主页。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/collab-canvas", status_code=302)
    user_id, nickname = identity
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
            "initial_room": "",
            "asset_version": COLLAB_ASSET_VERSION,
        },
    )


@router.get("/collab-canvas/random-room")
async def random_room(identity=Depends(get_optional_identity)):
    """为随机加入挑选在线房间（跳过 P 开头），没有则生成新房间号。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    candidates = list_joinable_collab_rooms(rooms)
    if candidates:
        return {"room_id": random.choice(candidates), "created": False}
    return {"room_id": generate_random_room_id(rooms), "created": True}


@router.get("/collab-canvas/{room_id}", response_class=HTMLResponse)
async def collab_canvas_room(
    request: Request, room_id: str, identity=Depends(get_optional_identity)
):
    """带房间号的深链。"""
    if not store.is_valid_room_path_id(room_id):
        raise HTTPException(status_code=404, detail="房间链接无效")
    next_path = "/collab-canvas/" + quote(room_id, safe="")
    if identity is None:
        return RedirectResponse(url="/login?next=" + quote(next_path, safe=""), status_code=302)
    user_id, nickname = identity
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
            "initial_room": room_id,
            "asset_version": COLLAB_ASSET_VERSION,
        },
    )



@router.websocket("/collab-canvas/ws")
async def collab_websocket(websocket: WebSocket):
    """合作画板实时协议（实现见 ws_handlers.process）。"""
    await handle_collab_websocket(websocket)
