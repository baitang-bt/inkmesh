"""P2P 信令：登记房间号并转交 SDP / ICE。"""

from __future__ import annotations

from typing import Optional

from fastapi import WebSocket

from app.games.collab_canvas import signal_store as store
from app.games.collab_canvas.room_store import send_error, send_json


async def handle_signal(
    websocket: WebSocket,
    msg_type: str,
    data: dict,
    *,
    peer_id: str,
) -> bool:
    """处理信令消息；非信令类型返回 False。"""
    if msg_type == "signal_join":
        await _signal_join(websocket, data, peer_id=peer_id)
        return True
    if msg_type == "signal_host":
        await _signal_host(websocket, data, peer_id=peer_id)
        return True
    if msg_type in ("signal_offer", "signal_answer", "signal_ice"):
        await _signal_relay(websocket, data, peer_id=peer_id, msg_type=msg_type)
        return True
    return False


async def _signal_join(websocket: WebSocket, data: dict, *, peer_id: str) -> None:
    """房客查找房间；无房主则通知可自行主持。"""
    room_id = store.normalize_room_id(data.get("room"))
    if not store.room_id_ok(room_id):
        await send_error(websocket, "房间号无效")
        return
    host_id = store.attach_guest(room_id, peer_id, websocket)
    if not host_id:
        await send_json(websocket, {"type": "signal_no_host", "room": room_id})
        return
    await send_json(
        websocket,
        {"type": "signal_peer", "room": room_id, "host_id": host_id, "peer_id": peer_id},
    )


async def _signal_host(websocket: WebSocket, data: dict, *, peer_id: str) -> None:
    """登记当前连接为房间房主。"""
    room_id = store.normalize_room_id(data.get("room"))
    if not store.room_id_ok(room_id):
        await send_error(websocket, "房间号无效")
        return
    ok = store.register_host(room_id, peer_id, websocket)
    if not ok:
        await send_error(websocket, "房间已有房主")
        return
    await send_json(
        websocket,
        {"type": "signal_hosted", "room": room_id, "peer_id": peer_id},
    )


async def _signal_relay(
    websocket: WebSocket,
    data: dict,
    *,
    peer_id: str,
    msg_type: str,
) -> None:
    """在房主与房客之间转发 WebRTC 描述或 ICE。"""
    room_id = store.normalize_room_id(
        data.get("room") or store.peer_signal_room.get(peer_id)
    )
    to_id = str(data.get("to_id") or "")
    if not room_id or not to_id:
        await send_error(websocket, "信令目标无效")
        return
    target = store.find_peer_ws(room_id, to_id)
    if target is None:
        await send_error(websocket, "对方不在线")
        return
    payload = {
        "type": msg_type,
        "room": room_id,
        "from_id": peer_id,
        "to_id": to_id,
    }
    if msg_type in ("signal_offer", "signal_answer"):
        payload["sdp"] = data.get("sdp")
    if msg_type == "signal_ice":
        payload["candidate"] = data.get("candidate")
    try:
        await send_json(target, payload)
    except Exception:
        await send_error(websocket, "信令转发失败")


async def cleanup_signal_peer(peer_id: Optional[str]) -> None:
    """连接断开时清理信令登记，并通知房客房主已离开。"""
    if not peer_id:
        return
    info = store.detach_peer(peer_id)
    if not info or not info.get("was_host"):
        return
    room_id = info.get("room_id") or ""
    for guest_ws in info.get("guest_websockets") or []:
        try:
            await send_json(
                guest_ws,
                {
                    "type": "signal_host_gone",
                    "room": room_id,
                    "message": "房主已离开房间",
                },
            )
        except Exception:
            continue
