"""合作画板房间内存态、序列化与广播辅助。"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import unicodedata
import uuid
from typing import Dict, List, Optional, Set
from urllib.parse import quote

from fastapi import WebSocket

from app.games.collab_canvas.protocol import (
    BOARD_CREATE_COOLDOWN_SEC,
    DEFAULT_BOARD_ID,
    DEFAULT_LAYER_ID,
    DISCONNECT_GRACE_SECONDS,
    MAX_BOARDS_PER_ROOM,
    MAX_LAYERS_PER_BOARD,
    MAX_PLAYERS_PER_ROOM,
    PROTOCOL_VERSION,
)
from app.games.common.drawing_board import (
    clear_layer_strokes,
    create_board_layer,
    default_layers,
    default_background_strokes,
    DEFAULT_BG_STROKE_ID,
    SYSTEM_STROKE_OWNER,
    default_vector_canvas,
    duplicate_board_layer,
    ensure_drawable_paint_layer,
    get_layer,
    is_group_layer,
    is_layer_locked,
    is_paint_layer,
    layer_has_strokes,
    layer_parent_id,
    migrate_board_layers,
    normalize_canvas_mode,
    normalize_layer_kind,
    normalize_segment,
    reparent_group_children,
    serialize_canvas,
    serialize_layers,
    serialize_strokes,
    top_paint_layer_id,
)
from app.games.common.lobby import (
    MAX_ROOM_ID_LENGTH,
    is_valid_deep_link_room_id,
)
from app.games.common.room_registry import evict_from_other_games, register_game
from app.error_codes import create_error_code

logger = logging.getLogger(__name__)

GAME_ID = "collab_canvas"

RESERVED_SEGMENTS = frozenset({"random-room", "ws", "lobby"})

rooms: Dict[str, Dict] = {}
player_rooms: Dict[str, str] = {}
timed_out_rooms: Dict[str, str] = {}


def is_valid_room_path_id(room_id: str) -> bool:
    """校验可放进 /inkmesh/{room} 路径的房间号。"""
    return is_valid_deep_link_room_id(room_id, RESERVED_SEGMENTS)


def create_board(title: str, board_id: Optional[str] = None, created_by: Optional[str] = None) -> Dict:
    """创建一块独立画板的状态容器。"""
    return {
        "board_id": board_id or ("b_" + uuid.uuid4().hex[:10]),
        "title": str(title or "画板")[:40],
        "layers": default_layers(),
        "strokes": default_background_strokes(),
        "redo": {},
        "canvas": default_vector_canvas(),
        "created_at": time.time(),
        "created_by": created_by,
    }


def create_room(room_id: str) -> Dict:
    """创建合作画板房间，含默认画板。"""
    default_board = create_board("画板 1", DEFAULT_BOARD_ID)
    return {
        "room_id": room_id,
        "owner_id": None,
        "players": {},
        "boards": {DEFAULT_BOARD_ID: default_board},
        "board_order": [DEFAULT_BOARD_ID],
    }


def get_board(room: Dict, board_id: str) -> Optional[Dict]:
    """按 id 取画板；不存在时返回 None。"""
    board = room.get("boards", {}).get(str(board_id or ""))
    if board:
        ensure_board(board)
    return board


def serialize_boards_meta(room: Dict) -> List[Dict[str, object]]:
    """返回画板列表元数据（不含 strokes）。"""
    result: List[Dict[str, object]] = []
    for board_id in room.get("board_order", []):
        board = get_board(room, board_id)
        if not board:
            continue
        result.append(
            {
                "board_id": board["board_id"],
                "title": board["title"],
                "canvas": serialize_canvas(board.get("canvas") or default_vector_canvas()),
                "created_at": board.get("created_at", 0),
                "created_by": board.get("created_by") or "",
            }
        )
    return result


def serialize_players(room: Dict) -> List[Dict[str, object]]:
    """序列化房间成员列表。"""
    owner_id = room.get("owner_id")
    return [
        {
            "uid": pid,
            "name": pdata["name"],
            "is_host": pid == owner_id,
            "connected": pdata["connected"],
            "active_board_id": pdata.get("active_board_id", DEFAULT_BOARD_ID),
            "label_color": str(pdata.get("label_color") or ""),
            "can_draw": bool(pdata.get("can_draw", True)),
            "can_save": bool(pdata.get("can_save", True)),
        }
        for pid, pdata in room["players"].items()
    ]


def is_room_host(room: Dict, player_id: str) -> bool:
    """判断玩家是否为当前房主。"""
    return str(room.get("owner_id") or "") == str(player_id)


def player_can_draw(room: Dict, player_id: str) -> bool:
    """房主始终可画；房客读 can_draw。"""
    if is_room_host(room, player_id):
        return True
    pdata = room.get("players", {}).get(player_id) or {}
    return bool(pdata.get("can_draw", True))


def player_can_save(room: Dict, player_id: str) -> bool:
    """房主始终可保存；房客读 can_save。"""
    if is_room_host(room, player_id):
        return True
    pdata = room.get("players", {}).get(player_id) or {}
    return bool(pdata.get("can_save", True))


_DISPLAY_NAME_MAX = 12
_DISPLAY_NAME_PUNCT = set(
    "。．.？?！!、，,：:；;·…—–-_/~～@#%&+=（）()【】[]「」『』《》<>\"'“”‘’"
)


def parse_display_name(value: object) -> str:
    """校验显示名：最长 12；字母/数字/汉字/空格 + 常用标点。"""
    raw = str(value or "").strip()
    out: list[str] = []
    for ch in raw:
        if len(out) >= _DISPLAY_NAME_MAX:
            break
        cat = unicodedata.category(ch)
        if cat.startswith("L") or cat.startswith("N") or ch == " " or ch in _DISPLAY_NAME_PUNCT:
            out.append(ch)
    return "".join(out).strip()


def parse_label_color(value: object) -> str:
    """校验联机用户名标签底色（#RRGGBB）。"""
    color = str(value or "").strip().lower()
    if len(color) == 7 and color.startswith("#"):
        try:
            int(color[1:], 16)
            return color
        except ValueError:
            return ""
    return ""


def players_on_board(room: Dict, board_id: str) -> Set[str]:
    """返回正在查看指定画板的在线玩家 id。"""
    target = str(board_id or DEFAULT_BOARD_ID)
    return {
        pid
        for pid, pdata in room["players"].items()
        if pdata["connected"] and pdata.get("active_board_id", DEFAULT_BOARD_ID) == target
    }


def ensure_board(board: Dict) -> None:
    """确保画板含 layers 且 strokes 带 layer_id。"""
    migrate_board_layers(board)


def top_layer_id(board: Dict) -> str:
    """返回 order 最高的图层 id。"""
    ensure_board(board)
    layers = sorted(board.get("layers") or [], key=lambda item: int(item.get("order", 0)))
    if not layers:
        return DEFAULT_LAYER_ID
    return str(layers[-1]["layer_id"])


def build_drawing_sync(board: Dict, board_id: str) -> Dict[str, object]:
    """构造单画板快照（含图层）。"""
    ensure_board(board)
    return {
        "type": "drawing_sync",
        "board_id": board_id,
        "layers": serialize_layers(board.get("layers") or []),
        "strokes": serialize_strokes(board.get("strokes") or []),
        "canvas": serialize_canvas(board.get("canvas") or default_vector_canvas()),
    }


def resolve_layer_id(board: Dict, pdata: Dict, data: Dict) -> str:
    """解析本次操作的目标图层 id（可为组）。"""
    ensure_board(board)
    layer_id = str(data.get("layer_id") or pdata.get("active_layer_id") or top_layer_id(board))
    if get_layer(board, layer_id):
        return layer_id
    return top_layer_id(board)


def resolve_draw_layer_id(board: Dict, pdata: Dict, data: Dict) -> str:
    """解析绘制类操作的目标绘画图层 id。"""
    layer_id = resolve_layer_id(board, pdata, data)
    layer = get_layer(board, layer_id)
    if layer and is_group_layer(layer):
        return top_paint_layer_id(board)
    return layer_id


def build_room_state(room: Dict, player_id: str, *, include_strokes: bool = True) -> Dict:
    """构造进房/重连时的全量房间状态。"""
    pdata = room["players"][player_id]
    board_id = pdata.get("active_board_id", DEFAULT_BOARD_ID)
    board = get_board(room, board_id) or room["boards"][DEFAULT_BOARD_ID]
    ensure_board(board)
    active_layer = pdata.get("active_layer_id") or top_layer_id(board)
    if not get_layer(board, active_layer):
        active_layer = top_layer_id(board)
        pdata["active_layer_id"] = active_layer
    state: Dict[str, object] = {
        "type": "room_state",
        "protocolVersion": PROTOCOL_VERSION,
        "room_id": room["room_id"],
        "self_id": player_id,
        "owner_id": room.get("owner_id") or "",
        "players": serialize_players(room),
        "boards": serialize_boards_meta(room),
        "board_order": list(room.get("board_order", [])),
        "active_board_id": board["board_id"],
        "active_layer_id": active_layer,
        "layers": serialize_layers(board.get("layers") or []),
        "canvas": serialize_canvas(board.get("canvas") or default_vector_canvas()),
        "last_board_create_at": float(pdata.get("last_board_create_at") or 0),
    }
    if include_strokes:
        state["strokes"] = serialize_strokes(board.get("strokes") or [])
    return state


async def send_json(websocket: WebSocket, message: Dict) -> None:
    """向单个连接发送 JSON。"""
    await websocket.send_text(json.dumps(message, ensure_ascii=False))


async def send_error(
    websocket: WebSocket, message: str, error_code: Optional[str] = None
) -> None:
    """发送业务错误。"""
    payload: Dict[str, object] = {"type": "error", "message": message}
    if error_code:
        payload["code"] = error_code
    await send_json(websocket, payload)


async def broadcast(room_id: str, message: Dict, exclude_id: Optional[str] = None) -> None:
    """向房间全员广播。"""
    room = rooms.get(room_id)
    if not room:
        return
    for pid, pdata in list(room["players"].items()):
        if pid == exclude_id or not pdata["connected"]:
            continue
        try:
            await send_json(pdata["ws"], message)
        except Exception:
            continue


async def broadcast_to_board(
    room_id: str,
    board_id: str,
    message: Dict,
    exclude_id: Optional[str] = None,
) -> None:
    """仅向正在查看同一画板的玩家广播。"""
    room = rooms.get(room_id)
    if not room:
        return
    targets = players_on_board(room, board_id)
    for player_id in targets:
        if player_id == exclude_id:
            continue
        player = room["players"].get(player_id)
        if not player or not player["connected"]:
            continue
        try:
            await send_json(player["ws"], message)
        except Exception:
            continue


def close_room_if_empty(room_id: str) -> None:
    """最后一人离开时销毁房间并释放占用。"""
    room = rooms.get(room_id)
    if not room or room["players"]:
        return
    rooms.pop(room_id, None)


async def remove_player_from_room(room_id: str, player_id: str, message: str) -> None:
    """从房间移除玩家并处理房主转移。"""
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        return
    removed_name = str(room["players"][player_id].get("name") or "玩家")
    was_owner = room.get("owner_id") == player_id
    await broadcast(
        room_id,
        {
            "type": "player_leave",
            "player_id": player_id,
            "name": removed_name,
            "message": message,
        },
        exclude_id=player_id,
    )
    del room["players"][player_id]
    if player_rooms.get(player_id) == room_id:
        del player_rooms[player_id]
    if was_owner:
        connected = [
            pid for pid, p in room["players"].items() if p["connected"]
        ]
        room["owner_id"] = random.choice(connected) if connected else None
    close_room_if_empty(room_id)
    if room_id in rooms:
        await broadcast_room_state_light(room)


async def broadcast_room_state_light(room: Dict) -> None:
    """向所有在线玩家推送轻量 room_state（不含 strokes）。"""
    room_id = room["room_id"]
    for pid, pdata in list(room["players"].items()):
        if not pdata["connected"]:
            continue
        try:
            await send_json(pdata["ws"], build_room_state(room, pid, include_strokes=False))
        except Exception:
            continue


async def evict_player_for_other_game(player_id: str) -> None:
    """玩家加入其他游戏时移出本游戏房间。"""
    room_id = player_rooms.get(player_id)
    if not room_id:
        return
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        player_rooms.pop(player_id, None)
        return
    player = room["players"][player_id]
    old_ws = player.get("ws")
    name = str(player.get("name") or "玩家")
    await remove_player_from_room(room_id, player_id, f"{name} 离开了房间")
    if old_ws is not None:
        try:
            await send_json(old_ws, {"type": "room_removed", "message": "你已加入其他游戏的房间"})
            await old_ws.close(code=4004)
        except Exception:
            pass


def get_reconnect_session(player_id: str) -> Optional[Dict[str, str]]:
    """返回可重连的会话 URL。"""
    room_id = player_rooms.get(player_id)
    if not room_id or timed_out_rooms.get(player_id) == room_id:
        return None
    room = rooms.get(room_id)
    if not room or player_id not in room["players"]:
        return None
    return {
        "game_id": GAME_ID,
        "room_id": room_id,
        "url": "/inkmesh/" + quote(room_id, safe=""),
    }


register_game(
    GAME_ID,
    get_player_room=player_rooms.get,
    evict_player=evict_player_for_other_game,
    get_reconnect_session=get_reconnect_session,
)


async def remove_disconnected_player_after_timeout(
    room_id: str, player_id: str, expected_room: Dict, disconnect_token: str
) -> None:
    """宽限期后移除仍未重连的玩家。"""
    await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
    room = rooms.get(room_id)
    if room is not expected_room:
        return
    player = room["players"].get(player_id)
    if not player or player["connected"] or player.get("disconnect_token") != disconnect_token:
        return
    timed_out_rooms[player_id] = room_id
    await remove_player_from_room(
        room_id, player_id, f"{player['name']} 断线超过30秒，已退出房间"
    )


async def handle_player_disconnect(
    room_id: Optional[str], player_id: Optional[str], websocket: WebSocket
) -> None:
    """标记断线并启动宽限期。"""
    if not room_id or room_id not in rooms or not player_id:
        return
    room = rooms[room_id]
    current = room["players"].get(player_id)
    if current is None or current["ws"] is not websocket:
        return
    current["connected"] = False
    token = uuid.uuid4().hex
    current["disconnect_token"] = token
    if room.get("owner_id") == player_id:
        guests = [pid for pid, p in room["players"].items() if pid != player_id and p["connected"]]
        if guests:
            room["owner_id"] = random.choice(guests)
    await broadcast(
        room_id,
        {"type": "player_leave", "player_id": player_id, "name": current["name"], "temporary": True},
        exclude_id=player_id,
    )
    if room_id in rooms:
        await broadcast_room_state_light(room)
    asyncio.create_task(remove_disconnected_player_after_timeout(room_id, player_id, room, token))


def board_has_drawn_strokes(board: Dict) -> bool:
    """判断画板是否含用户绘制内容（不含默认白底）。"""
    for stroke in board.get("strokes") or []:
        if stroke.get("owner_id") == SYSTEM_STROKE_OWNER:
            continue
        if stroke.get("stroke_id") == DEFAULT_BG_STROKE_ID:
            continue
        for segment in stroke.get("segments") or []:
            if segment.get("tool", "brush") != "background":
                return True
    return False


def room_has_user_strokes(room: Dict) -> bool:
    """房间是否已有用户绘制内容。"""
    for board_id in room.get("board_order", []):
        board = get_board(room, board_id)
        if board and board_has_drawn_strokes(board):
            return True
    return False


def _board_from_pbcc_entry(entry: Dict, player_id: str) -> Dict:
    """从 .inkmesh / .pbcc 画板条目构建服务端 board 对象。"""
    board_id = str(entry.get("board_id") or ("b_" + uuid.uuid4().hex[:10]))
    title = str(entry.get("title") or "画板")[:40]
    canvas = normalize_canvas_mode(entry.get("canvas") or default_vector_canvas())
    layers_raw = entry.get("layers") or default_layers()
    layers: List[Dict] = []
    for layer in layers_raw:
        if not isinstance(layer, dict) or not layer.get("layer_id"):
            continue
        parent = layer.get("parent_id")
        layers.append(
            {
                "layer_id": str(layer["layer_id"]),
                "name": str(layer.get("name") or layer["layer_id"])[:40],
                "kind": normalize_layer_kind(layer.get("kind")),
                "parent_id": str(parent) if parent else None,
                "visible": bool(layer.get("visible", True)),
                "opacity": max(0, min(255, int(layer.get("opacity", 255)))),
                "locked": bool(layer.get("locked", False)),
                "order": int(layer.get("order", 0)),
            }
        )
    if not layers:
        layers = default_layers()
    strokes: List[Dict] = []
    for stroke in entry.get("strokes") or []:
        if not isinstance(stroke, dict):
            continue
        segments = []
        for seg in stroke.get("segments") or []:
            if not isinstance(seg, dict) or seg.get("tool") == "localRaster":
                continue
            try:
                segments.append(normalize_segment(seg))
            except (KeyError, TypeError, ValueError):
                continue
        if not segments:
            continue
        strokes.append(
            {
                "stroke_id": str(stroke.get("stroke_id") or uuid.uuid4())[:100],
                "owner_id": str(stroke.get("owner_id") or player_id),
                "layer_id": str(stroke.get("layer_id") or DEFAULT_LAYER_ID),
                "segments": segments,
                "active": bool(stroke.get("active", True)),
            }
        )
    if not any(s.get("owner_id") == SYSTEM_STROKE_OWNER for s in strokes):
        strokes = list(default_background_strokes()) + strokes
    board = {
        "board_id": board_id,
        "title": title,
        "layers": layers,
        "strokes": strokes,
        "redo": {},
        "canvas": canvas,
        "created_at": float(entry.get("created_at") or time.time()),
        "created_by": str(entry.get("created_by") or player_id),
    }
    migrate_board_layers(board)
    return board


def import_pbcc_document(room: Dict, document: Dict, player_id: str) -> None:
    """用 .inkmesh / .pbcc 文档替换房间全部画板。"""
    boards_in = document.get("boards") or []
    order_in = document.get("board_order") or []
    if not boards_in:
        raise ValueError("文档不含画板")
    if len(boards_in) > MAX_BOARDS_PER_ROOM:
        raise ValueError("画板数量超过上限")
    new_boards: Dict[str, Dict] = {}
    new_order: List[str] = []
    seen_ids: Set[str] = set()
    for board_id in order_in:
        entry = next(
            (b for b in boards_in if str(b.get("board_id")) == str(board_id)),
            None,
        )
        if not entry:
            continue
        board = _board_from_pbcc_entry(entry, player_id)
        new_boards[board["board_id"]] = board
        new_order.append(board["board_id"])
        seen_ids.add(board["board_id"])
    for entry in boards_in:
        bid = str(entry.get("board_id") or "")
        if bid and bid not in seen_ids:
            board = _board_from_pbcc_entry(entry, player_id)
            new_boards[board["board_id"]] = board
            new_order.append(board["board_id"])
            seen_ids.add(board["board_id"])
    if not new_order:
        raise ValueError("无法解析画板")
    room["boards"] = new_boards
    room["board_order"] = new_order
    active_board = new_order[0]
    active_layer = top_layer_id(new_boards[active_board])
    for pdata in room["players"].values():
        pdata["active_board_id"] = active_board
        pdata["active_layer_id"] = active_layer


async def broadcast_room_state(room_id: str) -> None:
    """向房间内所有在线玩家推送最新 room_state。"""
    room = rooms.get(room_id)
    if not room:
        return
    for pid, pdata in list(room["players"].items()):
        if not pdata.get("connected"):
            continue
        try:
            await send_json(
                pdata["ws"],
                build_room_state(room, pid, include_strokes=True),
            )
        except Exception:
            continue


