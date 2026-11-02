"""画板创建/切换/重命名/删除、room_import、drawing_sync_request。"""
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
    if msg_type == "board_create":
        if len(room.get("board_order", [])) >= MAX_BOARDS_PER_ROOM:
            await send_error(websocket, "画板数量已达上限")
            return True
        is_owner = room.get("owner_id") == player_id
        if not is_owner:
            last_at = float(pdata.get("last_board_create_at") or 0)
            elapsed = time.time() - last_at
            if last_at > 0 and elapsed < BOARD_CREATE_COOLDOWN_SEC:
                remain = int(BOARD_CREATE_COOLDOWN_SEC - elapsed + 0.999)
                await send_error(
                    websocket,
                    f"创建画板冷却中，请 {remain} 秒后再试",
                )
                return True
        title = str(data.get("title") or f"画板 {len(room['board_order']) + 1}")[:40]
        board = create_board(title, created_by=player_id)
        room["boards"][board["board_id"]] = board
        room["board_order"].append(board["board_id"])
        if not is_owner:
            pdata["last_board_create_at"] = time.time()
        payload = {
            "type": "board_added",
            "board_id": board["board_id"],
            "title": board["title"],
            "canvas": serialize_canvas(board["canvas"]),
            "created_by": player_id,
        }
        await broadcast(room_id, payload)
        return True

    if msg_type == "board_switch":
        board_id = str(data.get("board_id") or "")
        if not get_board(room, board_id):
            await send_error(websocket, "画板不存在")
            return True
        pdata["active_board_id"] = board_id
        board = get_board(room, board_id)
        assert board is not None
        pdata["active_layer_id"] = top_layer_id(board)
        await send_json(websocket, build_drawing_sync(board, board_id))
        await broadcast(
            room_id,
            {
                "type": "player_board",
                "player_id": player_id,
                "board_id": board_id,
                "name": str(pdata.get("name") or ""),
            },
            exclude_id=player_id,
        )
        return True

    if msg_type == "room_import":
        if not is_room_host(room, player_id):
            await send_error(websocket, "仅房主可导入画板")
            return True
        document = data.get("document")
        if not isinstance(document, dict):
            await send_error(websocket, "导入数据无效")
            return True
        if str(document.get("format") or "") != "pbcc":
            await send_error(websocket, "不是有效的 .pbcc 文档")
            return True
        connected = sum(
            1 for pl in room["players"].values() if pl.get("connected")
        )
        if room_has_user_strokes(room) and connected > 1:
            await send_error(
                websocket,
                "房间已有内容且其他玩家在线，无法覆盖导入",
            )
            return True
        try:
            import_pbcc_document(room, document, player_id)
        except ValueError as exc:
            await send_error(websocket, str(exc))
            return True
        except Exception as exc:
            logger.exception("room_import 失败")
            await send_error(websocket, f"导入失败：{exc}")
            return True
        await broadcast_room_state(room_id)
        return True

    if msg_type == "board_rename":
        board_id = str(data.get("board_id") or "")
        board = get_board(room, board_id)
        if not board:
            await send_error(websocket, "画板不存在")
            return True
        board["title"] = str(data.get("title") or board["title"])[:40]
        await broadcast(
            room_id,
            {"type": "board_renamed", "board_id": board_id, "title": board["title"]},
        )
        return True

    if msg_type == "board_delete":
        board_id = str(data.get("board_id") or "")
        if len(room.get("boards") or {}) <= 1:
            await send_error(websocket, "至少保留一个画板")
            return True
        if board_id == DEFAULT_BOARD_ID:
            await send_error(websocket, "默认画板不能删除")
            return True
        board = get_board(room, board_id)
        if not board:
            await send_error(websocket, "画板不存在")
            return True
        if room.get("owner_id") != player_id:
            await send_error(websocket, "只有房主可以删除画板")
            return True
        if board_has_drawn_strokes(board):
            await send_error(websocket, "画板上还有内容，请先清空")
            return True
        room["boards"].pop(board_id, None)
        if board_id in room["board_order"]:
            room["board_order"].remove(board_id)
        for pid, pl in room["players"].items():
            if pl.get("active_board_id") == board_id:
                pl["active_board_id"] = DEFAULT_BOARD_ID
        await broadcast(room_id, {"type": "board_removed", "board_id": board_id})
        return True

    if msg_type == "drawing_sync_request":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            return True
        await send_json(websocket, build_drawing_sync(board, board_id))
        return True

    return False
