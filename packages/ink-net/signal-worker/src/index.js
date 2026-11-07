/**
 * Inkmesh P2P 信令：Worker 按 ?room= 路由到一房一 Durable Object。
 * 另提供公开大厅 HTTP（PublicLobby DO）。
 */

import { DurableObject } from 'cloudflare:workers';
import { mintLobbyToken, lobbyCorsHeaders } from './lobby-auth.js';
import { PublicLobby } from './public-lobby.js';
import { normalizeRoomId, roomIdOk } from './room-id.js';

export { PublicLobby };

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

  /**
   * Hibernation 唤醒后从 WebSocket attachment 重建 hostPeerId / roomId。
   * 实例字段在休眠时会丢，attachment 与 getWebSockets() 仍在。
   */
  _ensureHostState() {
    let hostPeerId = '';
    let roomId = this.roomId || '';
    for (const ws of this.ctx.getWebSockets()) {
      if (!wsAlive(ws)) continue;
      const meta = this._attachment(ws);
      if (!meta || meta.role !== 'host' || !meta.peerId) continue;
      hostPeerId = String(meta.peerId);
      const attachedRoom = normalizeRoomId(meta.roomId);
      if (attachedRoom) roomId = attachedRoom;
      break;
    }
    this.hostPeerId = hostPeerId;
    if (roomId) this.roomId = roomId;
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

  /** 房主离开时从公开大厅下架。 */
  async _unpublishLobby(roomId) {
    const id = normalizeRoomId(roomId);
    if (!id || !this.env.PUBLIC_LOBBY) return;
    try {
      const stub = this.env.PUBLIC_LOBBY.get(this.env.PUBLIC_LOBBY.idFromName('public'));
      await stub.fetch(
        new Request('https://inkmesh-lobby/internal/unpublish', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Internal-Unpublish': '1',
          },
          body: JSON.stringify({ room_id: id }),
        }),
      );
    } catch (_err) {
      /* ignore lobby errors */
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
    this._ensureHostState();
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
    this._ensureHostState();
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
      const lobbyToken = await mintLobbyToken(this.env, roomId, peerId);
      sendJson(ws, {
        type: 'signal_hosted',
        room: roomId,
        peer_id: peerId,
        lobby_token: lobbyToken,
      });
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
      return;
    }

    // 应用层中继：P2P 失败时转发业务 JSON（不落库）。
    if (msgType === 'signal_relay_open' || msgType === 'signal_relay') {
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
      if (msgType === 'signal_relay') {
        let encoded = '';
        try {
          encoded = JSON.stringify(data.payload);
        } catch (_err) {
          sendError(ws, '中继载荷无效');
          return;
        }
        if (!encoded || encoded.length > 256 * 1024) {
          sendError(ws, '中继载荷过大');
          return;
        }
      }
      const out = {
        type: msgType,
        room: roomId,
        from_id: peerId,
        to_id: toId,
      };
      if (msgType === 'signal_relay') {
        out.payload = data.payload;
      }
      try {
        sendJson(target, out);
      } catch (_err) {
        sendError(ws, '中继转发失败');
      }
    }
  }

  /** Hibernation：连接关闭时清理房主。 */
  async webSocketClose(ws, code, reason, _wasClean) {
    this._ensureHostState();
    const meta = this._attachment(ws) || {};
    const peerId = String(meta.peerId || '');
    const result = this._detachPeer(peerId);
    if (result && result.wasHost) {
      await this._unpublishLobby(result.roomId);
    }
    try {
      ws.close(code || 1000, reason || '');
    } catch (_err) {
      /* ignore */
    }
  }

  /** Hibernation：错误时同样清理。 */
  async webSocketError(ws, _error) {
    this._ensureHostState();
    const meta = this._attachment(ws) || {};
    const result = this._detachPeer(String(meta.peerId || ''));
    if (result && result.wasHost) {
      await this._unpublishLobby(result.roomId);
    }
  }
}

/** 将大厅请求转发给 PublicLobby 单例 DO。 */
function forwardLobby(request, env, pathSuffix) {
  const stub = env.PUBLIC_LOBBY.get(env.PUBLIC_LOBBY.idFromName('public'));
  const url = new URL(request.url);
  url.pathname = pathSuffix;
  return stub.fetch(new Request(url.toString(), request));
}

/** 是否房间深链路径（/inkmesh/ROOMID）。 */
function isRoomDeepLink(path) {
  const m = String(path || '').match(/^\/inkmesh\/([^/]+)$/i);
  if (!m) return false;
  const seg = String(m[1] || '').toUpperCase();
  if (seg === 'WS' || seg === 'LOBBY' || seg === 'CONFIG.JSON') return false;
  return roomIdOk(seg);
}

/**
 * 从 ASSETS 取 SPA 壳（index.html），吞掉 Assets 可能返回的 3xx，避免浏览器循环跳。
 * @param {Fetcher} assets
 * @param {string} origin
 */
async function fetchSpaShell(assets, origin) {
  const indexUrl = new URL('/inkmesh/index.html', origin).toString();
  let res = await assets.fetch(indexUrl);
  // html_handling=none 后通常直接 200；若仍有 3xx 则跟一次到 Location 再吐 200。
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('Location');
    if (loc) {
      const next = new URL(loc, origin);
      res = await assets.fetch(next.toString());
    }
  }
  if (!res.ok) {
    return new Response('inkmesh index missing', { status: 502 });
  }
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  return new Response(res.body, { status: 200, headers });
}

/** 从 ASSETS 取静态文件；大厅根与房间深链回退到 index.html（不经浏览器重定向）。 */
async function serveAssets(request, env, path) {
  if (!env.ASSETS) {
    return new Response('Static assets not bound', { status: 503 });
  }
  if (path === '/' || path === '') {
    // 根路径只跳一次进 /inkmesh/；后续由 Worker 直接吐 HTML，不再 302。
    return Response.redirect(new URL('/inkmesh/', request.url).toString(), 302);
  }
  if (path === '/inkmesh' || isRoomDeepLink(path)) {
    return fetchSpaShell(env.ASSETS, request.url);
  }
  const assetRes = await env.ASSETS.fetch(request);
  if (assetRes.status !== 404) return assetRes;
  if (path.startsWith('/inkmesh/')) {
    return fetchSpaShell(env.ASSETS, request.url);
  }
  return assetRes;
}

/** HTTP / WebSocket 入口：静态站 + 健康检查 + 大厅 + 按 room 转发 DO。 */
export default {
  /**
   * @param {Request} request
   * @param {{ SIGNAL_ROOM: DurableObjectNamespace, PUBLIC_LOBBY: DurableObjectNamespace, ASSETS?: Fetcher, LOBBY_HMAC?: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathRaw = url.pathname;
    const path = pathRaw.replace(/\/$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS' && path.startsWith('/inkmesh/lobby')) {
      return new Response(null, { status: 204, headers: lobbyCorsHeaders(request) });
    }

    if (path === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'inkmesh-signal',
          backend: 'durable-object',
          lobby: true,
          static: Boolean(env.ASSETS),
        }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    if (path === '/inkmesh/lobby' || path === '/lobby') {
      return forwardLobby(request, env, '/inkmesh/lobby');
    }
    if (path === '/inkmesh/lobby/announce' || path === '/lobby/announce') {
      return forwardLobby(request, env, '/inkmesh/lobby/announce');
    }
    const previewMatch = path.match(/^\/(?:inkmesh\/)?lobby\/([^/]+)\/preview$/);
    if (previewMatch) {
      return forwardLobby(
        request,
        env,
        `/inkmesh/lobby/${encodeURIComponent(previewMatch[1])}/preview`,
      );
    }
    const deleteMatch = path.match(/^\/(?:inkmesh\/)?lobby\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      return forwardLobby(
        request,
        env,
        `/inkmesh/lobby/${encodeURIComponent(deleteMatch[1])}`,
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

    return serveAssets(request, env, path);
  },
};
