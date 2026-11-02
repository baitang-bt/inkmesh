"""WebSocket 主循环与消息分发。"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from app.error_codes import create_error_code
from app.routers.auth import get_current_identity_ws
from app.games.collab_canvas.ws_handlers import board_msgs, draw_msgs, host_msgs, join_flow, layer_msgs
from app.games.collab_canvas.ws_handlers.common import (
    handle_player_disconnect,
    rooms,
    send_error,
    send_json,
)

logger = logging.getLogger(__name__)


async def handle_collab_websocket(websocket: WebSocket):
    """合作画板实时协议。"""
    identity = await get_current_identity_ws(websocket)
    if identity is None:
        await websocket.accept()
        await send_error(websocket, "请先登录后再进入房间")
        await websocket.close(code=4001)
        return
    passport_user_id, passport_nickname = identity
    await websocket.accept()
    room_id: Optional[str] = None
    player_id: Optional[str] = None

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await send_error(websocket, "消息格式无效")
                continue
            if not isinstance(data, dict):
                await send_error(websocket, "消息内容无效")
                continue
            msg_type = data.get("type")

            # ping 可不在房内
            if msg_type == "ping":
                await send_json(websocket, {"type": "pong"})
                continue

            if msg_type == "join":
                result = await join_flow.handle_join(
                    websocket,
                    data,
                    passport_user_id=passport_user_id,
                    passport_nickname=passport_nickname,
                    room_id=room_id,
                    player_id=player_id,
                )
                if result:
                    room_id, player_id = result
                continue

            if not room_id or not player_id or room_id not in rooms:
                await send_error(websocket, "请先加入房间")
                continue
            room = rooms[room_id]
            if player_id not in room["players"]:
                await send_error(websocket, "会话已失效，请刷新页面")
                continue
            pdata = room["players"][player_id]

            kwargs = dict(
                room_id=room_id,
                player_id=player_id,
                room=room,
                pdata=pdata,
                data=data,
            )
            if await board_msgs.handle(websocket, msg_type, **kwargs):
                continue
            if await layer_msgs.handle(websocket, msg_type, **kwargs):
                continue
            if await draw_msgs.handle(websocket, msg_type, **kwargs):
                continue
            if await host_msgs.handle(websocket, msg_type, **kwargs):
                continue

    except WebSocketDisconnect:
        await handle_player_disconnect(room_id, player_id, websocket)
    except Exception:
        code = create_error_code("CCWS")
        logger.exception("合作画板 WebSocket 未预期错误 [%s]", code)
        try:
            await send_error(websocket, "连接异常，请重新加入房间", code)
        except Exception:
            pass
        await handle_player_disconnect(room_id, player_id, websocket)
