"""进房 join 流程。"""
from __future__ import annotations

from typing import Optional, Tuple

from fastapi import WebSocket

from app.games.collab_canvas.ws_handlers.common import *  # noqa: F403


async def handle_join(
    websocket: WebSocket,
    data: dict,
    *,
    passport_user_id: str,
    passport_nickname: str,
    room_id: Optional[str],
    player_id: Optional[str],
) -> Optional[Tuple[str, str]]:
    """处理 join；成功返回 (room_id, player_id)，失败已回错误时返回 None。"""
    requested_room_id = str(data.get("room", "")).strip()[:MAX_ROOM_ID_LENGTH].upper()
    client_name = parse_display_name(data.get("name"))
    display_name = client_name or passport_nickname
    if not requested_room_id:
        await send_error(websocket, "房间号不能为空")
        return None
    if not is_valid_room_path_id(requested_room_id):
        await send_error(websocket, f"房间号须为 2–{MAX_ROOM_ID_LENGTH} 位字母或数字")
        return None
    if requested_room_id.casefold() in RESERVED_SEGMENTS:
        await send_error(websocket, "该房间号不可用")
        return None
    if not display_name:
        await send_error(websocket, "请输入昵称")
        return None
    player_id = str(passport_user_id)
    if timed_out_rooms.get(player_id) == requested_room_id:
        del timed_out_rooms[player_id]
        await send_json(
            websocket,
            {"type": "room_removed", "message": "已退出房间"},
        )
        await websocket.close(code=4004)
        return None
    await evict_from_other_games(GAME_ID, player_id)
    occupied = player_rooms.get(player_id)
    if occupied and occupied != requested_room_id:
        occ_room = rooms.get(occupied)
        if occ_room and player_id in occ_room["players"]:
            old_ws = occ_room["players"][player_id].get("ws")
            await remove_player_from_room(
                occupied, player_id, f"{display_name} 离开了房间"
            )
            if old_ws and old_ws is not websocket:
                try:
                    await send_json(
                        old_ws,
                        {"type": "room_removed", "message": "你已切换到其他房间"},
                    )
                    await old_ws.close(code=4004)
                except Exception:
                    pass
        elif player_id in player_rooms:
            del player_rooms[player_id]

    room_id = requested_room_id
    room = rooms.setdefault(room_id, create_room(room_id))
    existing = room["players"].get(player_id)
    if existing is not None:
        old_ws = existing["ws"]
        if old_ws is websocket:
            await send_error(websocket, "你已加入该房间")
            return None
        was_offline = not existing["connected"]
        existing["name"] = display_name
        existing["ws"] = websocket
        existing["connected"] = True
        existing["disconnect_token"] = ""
        if "label_color" not in existing:
            existing["label_color"] = ""
        if "can_draw" not in existing:
            existing["can_draw"] = True
        if "can_save" not in existing:
            existing["can_save"] = True
        if not existing.get("active_layer_id"):
            existing["active_layer_id"] = DEFAULT_LAYER_ID
        player_rooms[player_id] = room_id
        await send_json(websocket, build_room_state(room, player_id, include_strokes=True))
        if was_offline:
            await broadcast(
                room_id,
                {
                    "type": "player_join",
                    "player_id": player_id,
                    "name": display_name,
                    "label_color": existing.get("label_color") or "",
                    "can_draw": bool(existing.get("can_draw", True)),
                    "can_save": bool(existing.get("can_save", True)),
                    "is_host": is_room_host(room, player_id),
                },
                exclude_id=player_id,
            )
        try:
            await old_ws.close(code=4002)
        except Exception:
            pass
        return room_id, player_id

    if len(room["players"]) >= MAX_PLAYERS_PER_ROOM:
        await send_error(websocket, "房间已满")
        return None

    room["players"][player_id] = {
        "ws": websocket,
        "name": display_name,
        "connected": True,
        "disconnect_token": "",
        "active_board_id": DEFAULT_BOARD_ID,
        "active_layer_id": DEFAULT_LAYER_ID,
        "label_color": "",
        "can_draw": True,
        "can_save": True,
        "last_board_create_at": 0,
    }
    player_rooms[player_id] = room_id
    if room.get("owner_id") is None:
        room["owner_id"] = player_id
    await send_json(websocket, build_room_state(room, player_id, include_strokes=True))
    await broadcast(
        room_id,
        {
            "type": "player_join",
            "player_id": player_id,
            "name": display_name,
            "label_color": "",
            "can_draw": True,
            "can_save": True,
            "is_host": is_room_host(room, player_id),
        },
        exclude_id=player_id,
    )
    return room_id, player_id
