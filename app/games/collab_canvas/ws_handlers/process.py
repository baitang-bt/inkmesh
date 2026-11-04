"""WebSocket 主循环：仅 P2P 信令（不存笔迹）。"""

from __future__ import annotations

import json
import logging

from fastapi import WebSocket, WebSocketDisconnect

from app.error_codes import create_error_code
from app.routers.auth import get_current_identity_ws
from app.games.collab_canvas.room_store import send_error, send_json
from app.games.collab_canvas.ws_handlers import signal_msgs

logger = logging.getLogger(__name__)


async def handle_collab_websocket(websocket: WebSocket):
    """合作画板信令 WebSocket：登记房间并转交 SDP/ICE。"""
    identity = await get_current_identity_ws(websocket)
    if identity is None:
        await websocket.accept()
        await send_error(websocket, "请先登录后再进入房间")
        await websocket.close(code=4001)
        return
    passport_user_id, _passport_nickname = identity
    peer_id = str(passport_user_id)
    await websocket.accept()
    await send_json(websocket, {"type": "signal_hello", "peer_id": peer_id})

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

            if msg_type == "ping":
                await send_json(websocket, {"type": "pong"})
                continue

            handled = await signal_msgs.handle_signal(
                websocket,
                str(msg_type or ""),
                data,
                peer_id=peer_id,
            )
            if handled:
                continue
            await send_error(websocket, "未知信令消息")

    except WebSocketDisconnect:
        await signal_msgs.cleanup_signal_peer(peer_id)
    except Exception:
        code = create_error_code("CCWS")
        logger.exception("合作画板信令 WebSocket 未预期错误 [%s]", code)
        try:
            await send_error(websocket, "连接异常，请重新加入房间", code)
        except Exception:
            pass
        await signal_msgs.cleanup_signal_peer(peer_id)
