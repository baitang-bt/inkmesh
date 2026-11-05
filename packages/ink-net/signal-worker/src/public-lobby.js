/**
 * 公开大厅目录 Durable Object：房间元数据 + JPEG 预览。
 */

import { DurableObject } from 'cloudflare:workers';
import { verifyLobbyToken, lobbyCorsHeaders } from './lobby-auth.js';
import { normalizeRoomId, roomIdOk } from './room-id.js';

const MAX_PREVIEW_BYTES = 350 * 1024;
const MAX_TITLE_LEN = 40;

/**
 * 单例公开大厅索引（idFromName('public')）。
 */
export class PublicLobby extends DurableObject {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    this._ready = this._initSchema();
  }

  /** 创建 rooms / previews 表。 */
  async _initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        player_count INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL,
        host_peer_id TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS previews (
        room_id TEXT PRIMARY KEY,
        mime TEXT NOT NULL DEFAULT 'image/jpeg',
        bytes BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** 确保 schema 已就绪。 */
  async _ensure() {
    await this._ready;
  }

  /** JSON 响应。 */
  _json(body, status, request) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...lobbyCorsHeaders(request),
      },
    });
  }

  /** 列出/搜索公开房间（有关键词时在 SQL 侧过滤，避免 LIMIT 后搜不到旧房）。 */
  async _listRooms(query) {
    await this._ensure();
    const q = String(query || '').trim().toUpperCase();
    const rows = q
      ? this.ctx.storage.sql
          .exec(
            `SELECT r.room_id, r.title, r.player_count, r.updated_at,
                    CASE WHEN p.room_id IS NULL THEN 0 ELSE 1 END AS has_preview
             FROM rooms r
             LEFT JOIN previews p ON p.room_id = r.room_id
             WHERE instr(upper(r.room_id || ' ' || r.title), ?) > 0
             ORDER BY r.updated_at DESC
             LIMIT 200`,
            q,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec(
            `SELECT r.room_id, r.title, r.player_count, r.updated_at,
                    CASE WHEN p.room_id IS NULL THEN 0 ELSE 1 END AS has_preview
             FROM rooms r
             LEFT JOIN previews p ON p.room_id = r.room_id
             ORDER BY r.updated_at DESC
             LIMIT 200`,
          )
          .toArray();
    const rooms = [];
    for (const row of rows) {
      const roomId = String(row.room_id || '');
      const title = String(row.title || '');
      rooms.push({
        room_id: roomId,
        title: title || roomId,
        player_count: Math.max(1, Number(row.player_count) || 1),
        updated_at: Number(row.updated_at) || 0,
        has_preview: Boolean(row.has_preview),
      });
    }
    return rooms;
  }

  /** 读取预览图。 */
  async _getPreview(roomId) {
    await this._ensure();
    const id = normalizeRoomId(roomId);
    if (!roomIdOk(id)) return null;
    const rows = this.ctx.storage.sql
      .exec('SELECT mime, bytes, updated_at FROM previews WHERE room_id = ?', id)
      .toArray();
    if (!rows.length) return null;
    return rows[0];
  }

  /** 上架或更新房间（可选预览）；先校验预览体积再写库。 */
  async _announce(roomId, title, playerCount, hostPeerId, previewBytes, mime) {
    await this._ensure();
    const id = normalizeRoomId(roomId);
    if (!roomIdOk(id)) return { ok: false, error: 'invalid room' };
    const now = Date.now();
    const safeTitle = String(title || '').trim().slice(0, MAX_TITLE_LEN) || id;
    const count = Math.max(1, Math.min(64, Math.floor(Number(playerCount) || 1)));
    const peer = String(hostPeerId || '');
    // 预览超限时仍上架元数据，只丢弃本帧预览（避免房间从大厅消失）。
    const hasPreview =
      Boolean(previewBytes && previewBytes.byteLength) &&
      previewBytes.byteLength <= MAX_PREVIEW_BYTES;
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (room_id, title, player_count, updated_at, host_peer_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         title = excluded.title,
         player_count = excluded.player_count,
         updated_at = excluded.updated_at,
         host_peer_id = excluded.host_peer_id`,
      id,
      safeTitle,
      count,
      now,
      peer,
    );
    if (hasPreview) {
      const safeMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
      this.ctx.storage.sql.exec(
        `INSERT INTO previews (room_id, mime, bytes, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           mime = excluded.mime,
           bytes = excluded.bytes,
           updated_at = excluded.updated_at`,
        id,
        safeMime,
        previewBytes,
        now,
      );
    }
    return { ok: true, room_id: id, updated_at: now };
  }

  /** 下架房间与预览。 */
  async _unpublish(roomId) {
    await this._ensure();
    const id = normalizeRoomId(roomId);
    if (!roomIdOk(id)) return false;
    this.ctx.storage.sql.exec('DELETE FROM previews WHERE room_id = ?', id);
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE room_id = ?', id);
    return true;
  }

  /** 解析 announce 请求体（JSON 或 multipart）。 */
  async _parseAnnounce(request) {
    const contentType = String(request.headers.get('content-type') || '');
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const roomId = String(form.get('room_id') || '');
      const title = String(form.get('title') || '');
      const playerCount = Number(form.get('player_count') || 1);
      const file = form.get('preview');
      let previewBytes = null;
      let mime = 'image/jpeg';
      if (file && typeof file.arrayBuffer === 'function') {
        previewBytes = new Uint8Array(await file.arrayBuffer());
        mime = file.type || 'image/jpeg';
      }
      return { roomId, title, playerCount, previewBytes, mime };
    }
    const data = await request.json();
    let previewBytes = null;
    let mime = 'image/jpeg';
    if (data && data.preview_base64) {
      const raw = String(data.preview_base64);
      const comma = raw.indexOf(',');
      const b64 = comma >= 0 ? raw.slice(comma + 1) : raw;
      const bin = atob(b64);
      previewBytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) previewBytes[i] = bin.charCodeAt(i);
      mime = String(data.preview_mime || 'image/jpeg');
    }
    return {
      roomId: String((data && data.room_id) || ''),
      title: String((data && data.title) || ''),
      playerCount: Number((data && data.player_count) || 1),
      previewBytes,
      mime,
    };
  }

  /** HTTP 入口。 */
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: lobbyCorsHeaders(request) });
    }

    if (method === 'POST' && path === '/internal/unpublish') {
      if (request.headers.get('X-Internal-Unpublish') !== '1') {
        return this._json({ ok: false, error: 'forbidden' }, 403, request);
      }
      const body = await request.json().catch(() => ({}));
      await this._unpublish(body.room_id);
      return this._json({ ok: true }, 200, request);
    }

    if (method === 'GET' && (path === '/lobby' || path === '/inkmesh/lobby')) {
      const rooms = await this._listRooms(url.searchParams.get('q') || '');
      return this._json({ rooms }, 200, request);
    }

    const previewMatch = path.match(/^(?:\/inkmesh)?\/lobby\/([^/]+)\/preview$/);
    if (method === 'GET' && previewMatch) {
      const row = await this._getPreview(decodeURIComponent(previewMatch[1]));
      if (!row) {
        return new Response('not found', {
          status: 404,
          headers: lobbyCorsHeaders(request),
        });
      }
      const bytes = row.bytes;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': String(row.mime || 'image/jpeg'),
          'cache-control': 'public, max-age=60',
          ...lobbyCorsHeaders(request),
        },
      });
    }

    if (method === 'POST' && (path === '/lobby/announce' || path === '/inkmesh/lobby/announce')) {
      const token = request.headers.get('X-Lobby-Token') || '';
      const parsed = await this._parseAnnounce(request);
      const auth = await verifyLobbyToken(this.env, token, parsed.roomId);
      if (!auth) return this._json({ ok: false, error: 'invalid token' }, 401, request);
      const result = await this._announce(
        auth.roomId,
        parsed.title,
        parsed.playerCount,
        auth.hostPeerId,
        parsed.previewBytes,
        parsed.mime,
      );
      if (!result.ok) return this._json(result, 400, request);
      return this._json(result, 200, request);
    }

    const deleteMatch = path.match(/^(?:\/inkmesh)?\/lobby\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      const roomId = decodeURIComponent(deleteMatch[1]);
      const token = request.headers.get('X-Lobby-Token') || '';
      const auth = await verifyLobbyToken(this.env, token, roomId);
      if (!auth) return this._json({ ok: false, error: 'invalid token' }, 401, request);
      await this._unpublish(auth.roomId);
      return this._json({ ok: true }, 200, request);
    }

    return this._json({ ok: false, error: 'not found' }, 404, request);
  }
}
