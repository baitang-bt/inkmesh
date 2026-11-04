"""P2P 信令表：房间号 → 房主连接；不保存笔迹。"""

from __future__ import annotations

from typing import Dict, Optional

from fastapi import WebSocket

from app.games.common.lobby import MAX_ROOM_ID_LENGTH, is_valid_deep_link_room_id
from app.games.collab_canvas.room_store import RESERVED_SEGMENTS

# room_id -> { peer_id, ws, guests: { peer_id: ws } }
signal_rooms: Dict[str, Dict] = {}
# peer_id -> room_id（房主或正在信令中的房客）
peer_signal_room: Dict[str, str] = {}


def normalize_room_id(raw: object) -> str:
    """规范化房间号为大写并截断到上限。"""
    return str(raw or "").strip().upper()[:MAX_ROOM_ID_LENGTH]


def room_id_ok(room_id: str) -> bool:
    """校验信令可用的房间号。"""
    return is_valid_deep_link_room_id(room_id, RESERVED_SEGMENTS)


def get_room(room_id: str) -> Optional[Dict]:
    """按房间号取信令房间。"""
    return signal_rooms.get(room_id)


def register_host(room_id: str, peer_id: str, websocket: WebSocket) -> bool:
    """登记房主；房间已有其它房主时返回 False。"""
    existing = signal_rooms.get(room_id)
    if existing and existing.get("peer_id") and existing["peer_id"] != peer_id:
        host_ws = existing.get("ws")
        if host_ws is not None:
            return False
    detach_peer(peer_id)
    signal_rooms[room_id] = {
        "peer_id": peer_id,
        "ws": websocket,
        "guests": {},
    }
    peer_signal_room[peer_id] = room_id
    return True


def attach_guest(room_id: str, peer_id: str, websocket: WebSocket) -> Optional[str]:
    """房客挂到已有房主；成功返回 host peer_id，失败返回 None。"""
    room = signal_rooms.get(room_id)
    if not room or not room.get("ws") or not room.get("peer_id"):
        return None
    if room["peer_id"] == peer_id:
        return room["peer_id"]
    detach_peer(peer_id)
    room.setdefault("guests", {})[peer_id] = websocket
    peer_signal_room[peer_id] = room_id
    return str(room["peer_id"])


def find_peer_ws(room_id: str, peer_id: str) -> Optional[WebSocket]:
    """在信令房间内查找 peer 的 WebSocket。"""
    room = signal_rooms.get(room_id)
    if not room:
        return None
    if room.get("peer_id") == peer_id:
        return room.get("ws")
    return (room.get("guests") or {}).get(peer_id)


def detach_peer(peer_id: str) -> Optional[Dict]:
    """从信令表移除 peer；若是房主则拆掉整房并返回 { room_id, guest_websockets }。"""
    room_id = peer_signal_room.pop(peer_id, None)
    if not room_id:
        return None
    room = signal_rooms.get(room_id)
    if not room:
        return None
    if room.get("peer_id") == peer_id:
        guests = list((room.get("guests") or {}).values())
        for gid in list((room.get("guests") or {}).keys()):
            peer_signal_room.pop(gid, None)
        del signal_rooms[room_id]
        return {"room_id": room_id, "guest_websockets": guests, "was_host": True}
    guests = room.get("guests") or {}
    guests.pop(peer_id, None)
    return {"room_id": room_id, "guest_websockets": [], "was_host": False}
