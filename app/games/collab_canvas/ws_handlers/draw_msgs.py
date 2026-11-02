"""draw / draw_batch / undo / redo / clear。"""
from __future__ import annotations

from typing import Dict

from fastapi import WebSocket

from app.games.collab_canvas.ws_handlers.common import *  # noqa: F403


async def handle(
    websocket: WebSocket,
    msg_type: str,
    *,
    room_id: str,
    player_id: str,
    room: Dict,
    pdata: Dict,
    data: Dict,
) -> bool:
    """处理本域消息；已处理返回 True，未认领返回 False。"""
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

    return False
