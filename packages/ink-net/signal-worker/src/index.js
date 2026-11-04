/**
 * Inkmesh P2P 信令：Worker 按 ?room= 路由到一房一 Durable Object。
 * 协议对齐 packages/ink-net/protocol.md 的 signal_*（不存笔迹）。
 */

import { DurableObject } from 'cloudflare:workers';

const MAX_ROOM_ID_LENGTH = 8;
const RESERVED = new Set(['RANDOM-ROOM', 'WS']);

/** 规范化房间号。 */
export function normalizeRoomId(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .slice(0, MAX_ROOM_ID_LENGTH);
}

/** 校验信令房间号（2–8 位，非保留段）。 */
export function roomIdOk(roomId) {
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

/** 发送错误帧。 */
function sendError(ws, message) {
  sendJson(ws, { type: 'error', message: String(message || 'error') });
}

/** 套接字是否仍可用。 */
function wsAlive(ws) {
  return Boolean(ws) && typeof ws.readyState === 'number' && ws.readyState <= 1;
}

/**
 * 单房间信令 Durable Object：同房所有 WebSocket 落在同一实例。
 */
export class SignalRoom extends DurableObject {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {string} */
    this.roomId = '';
    /** @type {string} */
    this.hostPeerId = '';
  }

  /** 从 attachment 读取 peer 元数据。 */
  _attachment(ws) {
    try {
      const raw = ws.deserializeAttachment();
      return raw && typeof raw === 'object' ? raw : null;
    } catch (_err) {
      return null;
    }
  }

  /** 写入 attachment（peerId / role）。 */
  _setAttachment(ws, data) {
    try {
      ws.serializeAttachment(data);
    } catch (_err) {
      /* ignore */
    }
  }

  /** 按 peerId 找仍存活的 WebSocket。 */
  _findWs(peerId) {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this._attachment(ws);
      if (meta && meta.peerId === peerId && wsAlive(ws)) return ws;
    }
    return null;
  }

  /** 列出仍连接的房客 sockets（不含房主）。 */
  _guestSockets() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this._attachment(ws);
      if (!meta || meta.peerId === this.hostPeerId) continue;
      if (wsAlive(ws)) out.push(ws);
    }
    return out;
  }

  /** 通知房客房主已离开。 */
  _notifyHostGone(roomId) {
    for (const guestWs of this._guestSockets()) {
      sendJson(guestWs, {
        type: 'signal_host_gone',
        room: roomId || this.roomId,
        message: '房主已离开房间',
      });
    }
  }

  /** 移除 peer；若是房主则清空房并通知房客。 */
  _detachPeer(peerId) {
    if (!peerId) return null;
    const wasHost = this.hostPeerId === peerId;
    const roomId = this.roomId;
    if (wasHost) {
      this.hostPeerId = '';
      this._notifyHostGone(roomId);
      return { roomId, wasHost: true };
    }
    return { roomId, wasHost: false };
  }

  /** 登记房主；死连接占用时可回收。 */
  _registerHost(roomId, peerId, ws) {
    if (this.hostPeerId && this.hostPeerId !== peerId) {
      const existing = this._findWs(this.hostPeerId);
      if (wsAlive(existing)) return false;
      this._detachPeer(this.hostPeerId);
    }
    this.roomId = roomId;
    this.hostPeerId = peerId;
    this._setAttachment(ws, { peerId, role: 'host', roomId });
    return true;
  }

  /** 房客挂到房主；死房主则清房并返回 null。 */
  _attachGuest(roomId, peerId, ws) {
    if (!this.hostPeerId) return null;
    const hostWs = this._findWs(this.hostPeerId);
    if (!wsAlive(hostWs)) {
      this._detachPeer(this.hostPeerId);
      return null;
    }
    if (this.hostPeerId === peerId) return this.hostPeerId;
    this.roomId = roomId;
    this._setAttachment(ws, { peerId, role: 'guest', roomId });
    return this.hostPeerId;
  }

  /** HTTP：接受 WebSocket 升级。 */
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('SignalRoom expects WebSocket', { status: 426 });
    }
    const roomId = normalizeRoomId(url.searchParams.get('room'));
    if (!roomIdOk(roomId)) {
      return new Response('invalid room', { status: 400 });
    }
    this.roomId = roomId;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const peerId = newPeerId();
    this.ctx.acceptWebSocket(server);
    this._setAttachment(server, { peerId, role: '', roomId });
    sendJson(server, { type: 'signal_hello', peer_id: peerId });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hibernation：处理信令消息。 */
  async webSocketMessage(ws, message) {
    const meta = this._attachment(ws) || {};
    const peerId = String(meta.peerId || '');
    if (!peerId) return;

    let data;
    try {
      data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch (_err) {
      return;
    }
    const msgType = data && data.type;
    if (!msgType) return;

    if (msgType === 'signal_join') {
      const roomId = normalizeRoomId(data.room || this.roomId);
      if (!roomIdOk(roomId)) {
        sendError(ws, '房间号无效');
        return;
      }
      const hostId = this._attachGuest(roomId, peerId, ws);
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
      const roomId = normalizeRoomId(data.room || this.roomId);
      if (!roomIdOk(roomId)) {
        sendError(ws, '房间号无效');
        return;
      }
      if (!this._registerHost(roomId, peerId, ws)) {
        sendError(ws, '房间已有房主');
        return;
      }
      sendJson(ws, { type: 'signal_hosted', room: roomId, peer_id: peerId });
      return;
    }

    if (msgType === 'signal_offer' || msgType === 'signal_answer' || msgType === 'signal_ice') {
      const roomId = normalizeRoomId(data.room || this.roomId || meta.roomId);
      const toId = String(data.to_id || '');
      if (!roomId || !toId) {
        sendError(ws, '信令目标无效');
        return;
      }
      const target = this._findWs(toId);
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

  /** Hibernation：连接关闭时清理房主。 */
  async webSocketClose(ws, code, reason, _wasClean) {
    const meta = this._attachment(ws) || {};
    const peerId = String(meta.peerId || '');
    this._detachPeer(peerId);
    try {
      ws.close(code || 1000, reason || '');
    } catch (_err) {
      /* ignore */
    }
  }

  /** Hibernation：错误时同样清理。 */
  async webSocketError(ws, _error) {
    const meta = this._attachment(ws) || {};
    this._detachPeer(String(meta.peerId || ''));
  }
}

/** HTTP / WebSocket 入口：健康检查 + 按 room 转发 DO。 */
export default {
  /**
   * @param {Request} request
   * @param {{ SIGNAL_ROOM: DurableObjectNamespace }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (path === '/' || path === '/health') {
      return new Response(
        JSON.stringify({ ok: true, service: 'inkmesh-signal', backend: 'durable-object' }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    const isWsPath = path === '/inkmesh/ws' || path === '/ws';
    if (isWsPath && request.headers.get('Upgrade') === 'websocket') {
      const roomId = normalizeRoomId(url.searchParams.get('room'));
      if (!roomIdOk(roomId)) {
        return new Response('room query required (2-8 chars)', { status: 400 });
      }
      const id = env.SIGNAL_ROOM.idFromName(roomId);
      const stub = env.SIGNAL_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('Inkmesh signal worker. Connect WebSocket at /inkmesh/ws?room=ROOMID', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
