"""房主权限、踢人、离开、样式、光标、ping。"""
from __future__ import annotations

from typing import Dict, List, Optional

from fastapi import WebSocket

from app.games.collab_canvas.ws_handlers.common import *  # noqa: F403


async def handle(
    websocket: WebSocket,
    msg_type: str,
    *,
    room_id: Optional[str] = None,
    player_id: Optional[str] = None,
    room: Optional[Dict] = None,
    pdata: Optional[Dict] = None,
    data: Optional[Dict] = None,
) -> bool:
    """处理本域消息；已处理返回 True，未认领返回 False。ping 由 process 主循环处理。"""
    if msg_type == "ping":
        await send_json(websocket, {"type": "pong"})
        return True

    if room is None or pdata is None or data is None or not room_id or not player_id:
        return False

    if msg_type == "host_set_permissions":
        if not is_room_host(room, player_id):
            await send_error(websocket, "仅房主可修改权限")
            return True
        target_id = str(data.get("target_id") or "").strip()
        can_draw = data.get("can_draw")
        can_save = data.get("can_save")
        targets: List[str] = []
        if target_id:
            if target_id not in room["players"]:
                await send_error(websocket, "目标玩家不在房间")
                return True
            if is_room_host(room, target_id):
                await send_error(websocket, "无法修改房主权限")
                return True
            targets = [target_id]
        else:
            targets = [
                pid for pid in room["players"]
                if not is_room_host(room, pid)
            ]
        for tid in targets:
            tp = room["players"][tid]
            if can_draw is not None:
                tp["can_draw"] = bool(can_draw)
            if can_save is not None:
                tp["can_save"] = bool(can_save)
            await broadcast(
                room_id,
                {
                    "type": "player_permissions",
                    "player_id": tid,
                    "can_draw": bool(tp.get("can_draw", True)),
                    "can_save": bool(tp.get("can_save", True)),
                },
            )
        return True

    if msg_type == "kick_player":
        if not is_room_host(room, player_id):
            await send_error(websocket, "仅房主可踢出玩家")
            return True
        target_id = str(data.get("target_id") or data.get("player_id") or "").strip()
        if not target_id or target_id not in room["players"]:
            await send_error(websocket, "目标玩家不在房间")
            return True
        if target_id == player_id:
            await send_error(websocket, "无法踢出自己")
            return True
        target = room["players"][target_id]
        target_ws = target.get("ws")
        target_name = str(target.get("name") or "玩家")
        if target_ws:
            try:
                await send_json(
                    target_ws,
                    {"type": "room_removed", "message": "你已被房主移出房间"},
                )
            except Exception:
                pass
        await remove_player_from_room(
            room_id, target_id, f"{target_name} 已被移出房间"
        )
        if target_ws:
            try:
                await target_ws.close(code=4003)
            except Exception:
                pass
        return True

    if msg_type in {"leave_room", "leave_game"}:
        leave_name = str(pdata.get("name") or "玩家")
        await send_json(
            websocket,
            {"type": "room_removed", "message": "已退出房间"},
        )
        await remove_player_from_room(
            room_id, player_id, f"{leave_name} 离开了房间"
        )
        await websocket.close(code=4004)
        return

    if msg_type in {"draw", "draw_batch"}:
        if not player_can_draw(room, player_id):
            return True
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            return True
        layer_id = resolve_draw_layer_id(board, pdata, data)
        layer = get_layer(board, layer_id)
        if layer and is_layer_locked(board, layer_id):
            return True
        stroke_id = str(data.get("stroke_id") or "")[:100]
        if msg_type == "draw_batch":
            raw_segments = data.get("segments")
            if not isinstance(raw_segments, list) or not raw_segments:
                return True
            try:
                stroke, applied = append_stroke_segments(
                    board["strokes"],
                    board["redo"],
                    player_id,
                    stroke_id,
                    [seg for seg in raw_segments if isinstance(seg, dict)],
                    layer_id,
                )
            except (KeyError, TypeError, ValueError, AssertionError):
                return True
            await broadcast_to_board(
                room_id,
                board_id,
                {
                    "type": "draw_batch",
                    "board_id": board_id,
                    "layer_id": layer_id,
                    "stroke_id": stroke["stroke_id"],
                    "owner_id": player_id,
                    "segments": applied,
                },
                exclude_id=player_id,
            )
            return True
        packet = dict(data)
        packet["layer_id"] = layer_id
        try:
            stroke = append_stroke_segment(board["strokes"], board["redo"], player_id, packet, layer_id)
        except (KeyError, TypeError, ValueError):
            return True
        segment = stroke["segments"][-1]
        await broadcast_to_board(
            room_id,
            board_id,
            {
                "type": "draw",
                "board_id": board_id,
                "layer_id": layer_id,
                "stroke_id": stroke["stroke_id"],
                "owner_id": player_id,
                **segment,
            },
            exclude_id=player_id,
        )
        return True

    if msg_type in {"undo", "redo"}:
        if not player_can_draw(room, player_id):
            return True
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            return True
        layer_id = resolve_draw_layer_id(board, pdata, data)
        # 仅操作 player_id 自己的 stroke；redo 栈亦按玩家隔离。
        stroke = (
            undo_player_stroke(board["strokes"], board["redo"], player_id, layer_id)
            if msg_type == "undo"
            else redo_player_stroke(board["redo"], player_id)
        )
        if stroke:
            await broadcast_to_board(
                room_id,
                board_id,
                {
                    "type": "stroke_visibility",
                    "board_id": board_id,
                    "layer_id": stroke.get("layer_id", layer_id),
                    "stroke_id": stroke["stroke_id"],
                    "owner_id": player_id,
                    "visible": msg_type == "redo",
                },
            )
        return True

    if msg_type == "clear":
        if not player_can_draw(room, player_id):
            return True
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            return True
        layer_id = resolve_draw_layer_id(board, pdata, data)
        if is_layer_locked(board, layer_id):
            return True
        clear_layer_strokes(board, layer_id)
        board["redo"] = {}
        clear_msg = {"type": "clear", "board_id": board_id, "layer_id": layer_id}
        await broadcast_to_board(room_id, board_id, clear_msg)
        return True

    if msg_type == "player_style":
        label_color = parse_label_color(data.get("label_color"))
        pdata["label_color"] = label_color
        display_name = parse_display_name(data.get("display_name"))
        if display_name:
            pdata["name"] = display_name
        await broadcast(
            room_id,
            {
                "type": "player_style",
                "player_id": player_id,
                "name": pdata["name"],
                "label_color": label_color,
            },
        )
        return True

    if msg_type == "cursor_move":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        try:
            x = max(0.0, min(1.0, float(data.get("x", 0))))
            y = max(0.0, min(1.0, float(data.get("y", 0))))
        except (TypeError, ValueError):
            return True
        drawing = bool(data.get("drawing"))
        try:
            size = max(1, min(128, int(data.get("size", 0))))
        except (TypeError, ValueError):
            size = 0
        wire_color = parse_label_color(data.get("label_color"))
        if wire_color:
            pdata["label_color"] = wire_color
        await broadcast_to_board(
            room_id,
            board_id,
            {
                "type": "cursor_update",
                "board_id": board_id,
                "player_id": player_id,
                "nickname": pdata["name"],
                "x": x,
                "y": y,
                "drawing": drawing,
                "size": size,
                "label_color": pdata.get("label_color") or "",
            },
            exclude_id=player_id,
        )
        return True

    return False
