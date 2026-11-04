/**
 * Inkmesh P2P 信令 Worker：登记房间号并转发 SDP / ICE（不存笔迹）。
 * 协议与 packages/ink-net/protocol.md 的 signal_* 对齐。
 */

const MAX_ROOM_ID_LENGTH = 8;
const RESERVED = new Set(['RANDOM-ROOM', 'WS']);

/** @type {Map<string, { peerId: string, ws: WebSocket, guests: Map<string, WebSocket> }>} */
const signalRooms = new Map();
/** @type {Map<string, string>} */
const peerSignalRoom = new Map();
/** @type {Map<WebSocket, string>} */
const wsPeerId = new Map();

/** 规范化房间号。 */
function normalizeRoomId(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .slice(0, MAX_ROOM_ID_LENGTH);
}

/** 校验信令房间号（2–8 位，非保留段）。 */
function roomIdOk(roomId) {
  if (!roomId || roomId.length < 2 || roomId.length > MAX_ROOM_ID_LENGTH) return false;
  if (RESERVED.has(roomId)) return false;
  return /^[A-Z0-9][A-Z0-9_-]*$/.test(roomId);
}

/** 生成 peer id。 */
function newPeerId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return 'p' + Math.random().toString(36).slice(2, 12);
}

/** 向套接字发送 JSON。 */
function sendJson(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch (_err) {
    /* ignore closed */
  }
}

/** 发送错误帧（与 FastAPI send_error 字段兼容的精简形）。 */
function sendError(ws, message) {
  sendJson(ws, { type: 'error', message: String(message || 'error') });
}

/** 从信令表移除 peer；房主断开时返回客房 sockets。 */
function detachPeer(peerId) {
  const roomId = peerSignalRoom.get(peerId);
  peerSignalRoom.delete(peerId);
  if (!roomId) return null;
  const room = signalRooms.get(roomId);
  if (!room) return null;
  if (room.peerId === peerId) {
    const guests = [...room.guests.values()];
    for (const gid of room.guests.keys()) peerSignalRoom.delete(gid);
    signalRooms.delete(roomId);
    return { roomId, guestSockets: guests, wasHost: true };
  }
  room.guests.delete(peerId);
  return { roomId, guestSockets: [], wasHost: false };
}

/** 登记房主；死连接占用时可回收，并通知旧房客 host_gone。 */
function registerHost(roomId, peerId, ws) {
  const existing = signalRooms.get(roomId);
  if (existing && existing.peerId && existing.peerId !== peerId) {
    const hostAlive = existing.ws && existing.ws.readyState <= 1;
    if (hostAlive) return false;
    const stale = detachPeer(existing.peerId);
    if (stale && stale.wasHost) {
      for (const guestWs of stale.guestSockets) {
        sendJson(guestWs, {
          type: 'signal_host_gone',
          room: stale.roomId,
          message: '房主已离开房间',
        });
      }
    }
  }
  detachPeer(peerId);
  signalRooms.set(roomId, { peerId, ws, guests: new Map() });
  peerSignalRoom.set(peerId, roomId);
  return true;
}

/** 房客挂到房主；成功返回 hostId。房主套接字已死则清房并视为无主。 */
function attachGuest(roomId, peerId, ws) {
  const room = signalRooms.get(roomId);
  if (!room || !room.ws || !room.peerId) return null;
  if (room.ws.readyState > 1) {
    const stale = detachPeer(room.peerId);
    if (stale && stale.wasHost) {
      for (const guestWs of stale.guestSockets) {
        sendJson(guestWs, {
          type: 'signal_host_gone',
          room: stale.roomId,
          message: '房主已离开房间',
        });
      }
    }
    return null;
  }
  if (room.peerId === peerId) return room.peerId;
  detachPeer(peerId);
  room.guests.set(peerId, ws);
  peerSignalRoom.set(peerId, roomId);
  return room.peerId;
}

/** 在房间内找 peer 的 WebSocket。 */
function findPeerWs(roomId, peerId) {
  const room = signalRooms.get(roomId);
  if (!room) return null;
  if (room.peerId === peerId) return room.ws;
  return room.guests.get(peerId) || null;
}

/** 处理一条信令消息。 */
function handleMessage(ws, peerId, data) {
  const msgType = data && data.type;
  if (!msgType) return;

  if (msgType === 'signal_join') {
    const roomId = normalizeRoomId(data.room);
    if (!roomIdOk(roomId)) {
      sendError(ws, '房间号无效');
      return;
    }
    const hostId = attachGuest(roomId, peerId, ws);
    if (!hostId) {
      sendJson(ws, { type: 'signal_no_host', room: roomId });
      return;
    }
    sendJson(ws, {
      type: 'signal_peer',
      room: roomId,
      host_id: hostId,
      peer_id: peerId,
    });
    return;
  }

  if (msgType === 'signal_host') {
    const roomId = normalizeRoomId(data.room);
    if (!roomIdOk(roomId)) {
      sendError(ws, '房间号无效');
      return;
    }
    if (!registerHost(roomId, peerId, ws)) {
      sendError(ws, '房间已有房主');
      return;
    }
    sendJson(ws, { type: 'signal_hosted', room: roomId, peer_id: peerId });
    return;
  }

  if (msgType === 'signal_offer' || msgType === 'signal_answer' || msgType === 'signal_ice') {
    const roomId = normalizeRoomId(data.room || peerSignalRoom.get(peerId));
    const toId = String(data.to_id || '');
    if (!roomId || !toId) {
      sendError(ws, '信令目标无效');
      return;
    }
    const target = findPeerWs(roomId, toId);
    if (!target) {
      sendError(ws, '对方不在线');
      return;
    }
    const payload = {
      type: msgType,
      room: roomId,
      from_id: peerId,
      to_id: toId,
    };
    if (msgType === 'signal_offer' || msgType === 'signal_answer') {
      payload.sdp = data.sdp;
    }
    if (msgType === 'signal_ice') {
      payload.candidate = data.candidate;
    }
    try {
      sendJson(target, payload);
    } catch (_err) {
      sendError(ws, '信令转发失败');
    }
  }
}

/** 连接关闭时清理并通知房客。 */
function onClose(ws) {
  const peerId = wsPeerId.get(ws);
  wsPeerId.delete(ws);
  if (!peerId) return;
  const info = detachPeer(peerId);
  if (!info || !info.wasHost) return;
  for (const guestWs of info.guestSockets) {
    sendJson(guestWs, {
      type: 'signal_host_gone',
      room: info.roomId,
      message: '房主已离开房间',
    });
  }
}

/** HTTP / WebSocket 入口。 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'inkmesh-signal' }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const isWsPath = path === '/inkmesh/ws' || path === '/ws';
    if (isWsPath && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      const peerId = newPeerId();
      wsPeerId.set(server, peerId);
      sendJson(server, { type: 'signal_hello', peer_id: peerId });
      server.addEventListener('message', event => {
        let data;
        try {
          data = JSON.parse(String(event.data || ''));
        } catch (_err) {
          return;
        }
        handleMessage(server, peerId, data);
      });
      server.addEventListener('close', () => onClose(server));
      server.addEventListener('error', () => onClose(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Inkmesh signal worker. Connect WebSocket at /inkmesh/ws', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
