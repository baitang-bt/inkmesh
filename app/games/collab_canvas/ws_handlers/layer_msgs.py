"""图层 CRUD / 切换 / 更新。"""
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
    if msg_type == "layer_switch":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            return True
        layer_id = str(data.get("layer_id") or "")
        ensure_board(board)
        if not get_layer(board, layer_id):
            await send_error(websocket, "图层不存在")
            return True
        pdata["active_layer_id"] = layer_id
        return True

    if msg_type == "layer_create":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            await send_error(websocket, "画板不存在")
            return True
        ensure_board(board)
        if len(board["layers"]) >= MAX_LAYERS_PER_BOARD:
            await send_error(websocket, "图层数量已达上限")
            return True
        parent_raw = str(data.get("parent_id") or "").strip()
        parent_id = parent_raw or None
        try:
            layer = create_board_layer(
                board,
                name=str(data.get("name") or "").strip() or None,
                kind=str(data.get("kind") or "paint"),
                parent_id=parent_id,
            )
        except ValueError as exc:
            await send_error(websocket, str(exc))
            return True
        except Exception as exc:
            logger.exception("layer_create 失败")
            await send_error(websocket, f"新建图层失败：{exc}")
            return True
        pdata["active_layer_id"] = layer["layer_id"]
        payload = {
            "type": "layer_added",
            "board_id": board_id,
            "layer": serialize_layers([layer])[0],
            "created_by": player_id,
        }
        await send_json(websocket, payload)
        await broadcast_to_board(room_id, board_id, payload, exclude_id=player_id)
        return True

    if msg_type == "layer_duplicate":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            return True
        ensure_board(board)
        if len(board["layers"]) >= MAX_LAYERS_PER_BOARD:
            await send_error(websocket, "图层数量已达上限")
            return True
        source_layer_id = str(
            data.get("source_layer_id") or pdata.get("active_layer_id") or DEFAULT_LAYER_ID
        )
        if not get_layer(board, source_layer_id):
            await send_error(websocket, "图层不存在")
            return True
        if is_group_layer(get_layer(board, source_layer_id)):
            await send_error(websocket, "不能复制图层组")
            return True
        layer, cloned_strokes = duplicate_board_layer(board, source_layer_id)
        if not layer:
            await send_error(websocket, "无法复制图层")
            return True
        pdata["active_layer_id"] = layer["layer_id"]
        payload = {
            "type": "layer_duplicated",
            "board_id": board_id,
            "source_layer_id": source_layer_id,
            "layer": serialize_layers([layer])[0],
            "strokes": serialize_strokes(cloned_strokes),
            "created_by": player_id,
        }
        await broadcast_to_board(room_id, board_id, payload)
        return True

    if msg_type == "layer_delete":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        layer_id = str(data.get("layer_id") or "")
        board = get_board(room, board_id)
        if not board:
            return True
        ensure_board(board)
        if len(board["layers"]) <= 1:
            await send_error(websocket, "至少保留一个图层")
            return True
        if not get_layer(board, layer_id):
            await send_error(websocket, "图层不存在")
            return True
        target = get_layer(board, layer_id)
        assert target is not None
        if is_group_layer(target):
            blocked = False
            for child in board["layers"]:
                if layer_parent_id(child) != layer_id:
                    return True
                if layer_has_strokes(board, str(child["layer_id"])):
                    await send_error(websocket, "图层组内图层须先清空")
                    blocked = True
                    break
            if blocked:
                return True
            reparent_group_children(board, layer_id, layer_parent_id(target))
        else:
            if layer_has_strokes(board, layer_id):
                await send_error(websocket, "图层上还有内容，请先清空")
                return True
        board["layers"] = [layer for layer in board["layers"] if layer["layer_id"] != layer_id]
        added_layer = ensure_drawable_paint_layer(board)
        if pdata.get("active_layer_id") == layer_id:
            pdata["active_layer_id"] = top_paint_layer_id(board)
        await broadcast_to_board(
            room_id,
            board_id,
            {"type": "layer_removed", "board_id": board_id, "layer_id": layer_id},
        )
        if added_layer:
            add_payload = {
                "type": "layer_added",
                "board_id": board_id,
                "layer": serialize_layers([added_layer])[0],
                "created_by": player_id,
            }
            await send_json(websocket, add_payload)
            await broadcast_to_board(room_id, board_id, add_payload, exclude_id=player_id)
        return True

    if msg_type == "layer_rename":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        layer_id = str(data.get("layer_id") or "")
        board = get_board(room, board_id)
        if not board:
            return True
        layer = get_layer(board, layer_id)
        if not layer:
            await send_error(websocket, "图层不存在")
            return True
        layer["name"] = str(data.get("name") or layer["name"])[:40]
        await broadcast_to_board(
            room_id,
            board_id,
            {
                "type": "layer_renamed",
                "board_id": board_id,
                "layer_id": layer_id,
                "name": layer["name"],
            },
        )
        return True

    if msg_type == "layer_reorder":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        board = get_board(room, board_id)
        if not board:
            return True
        ensure_board(board)
        order_ids = data.get("layer_ids")
        if not isinstance(order_ids, list):
            return True
        id_set = {layer["layer_id"] for layer in board["layers"]}
        if set(order_ids) != id_set:
            await send_error(websocket, "图层顺序无效")
            return True
        order_map = {layer_id: index for index, layer_id in enumerate(order_ids)}
        for layer in board["layers"]:
            layer["order"] = order_map.get(layer["layer_id"], layer.get("order", 0))
        board["layers"].sort(key=lambda item: int(item.get("order", 0)))
        await broadcast_to_board(
            room_id,
            board_id,
            {
                "type": "layer_reordered",
                "board_id": board_id,
                "layers": serialize_layers(board["layers"]),
            },
        )
        return True

    if msg_type == "layer_update":
        board_id = str(data.get("board_id") or pdata.get("active_board_id", DEFAULT_BOARD_ID))
        layer_id = str(data.get("layer_id") or "")
        board = get_board(room, board_id)
        if not board:
            return True
        ensure_board(board)
        layer = get_layer(board, layer_id)
        if not layer:
            await send_error(websocket, "图层不存在")
            return True
        if "visible" in data:
            layer["visible"] = bool(data.get("visible"))
        if "opacity" in data:
            layer["opacity"] = max(0, min(255, int(data.get("opacity"))))
        if "locked" in data:
            layer["locked"] = bool(data.get("locked"))
        payload = {
            "type": "layer_updated",
            "board_id": board_id,
            "layer_id": layer_id,
            "visible": layer.get("visible", True),
            "opacity": layer.get("opacity", 255),
            "locked": layer.get("locked", False),
        }
        await send_json(websocket, payload)
        await broadcast_to_board(room_id, board_id, payload, exclude_id=player_id)
        return True

    return False
