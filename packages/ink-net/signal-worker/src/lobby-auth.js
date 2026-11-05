/**
 * 公开大厅 announce 用 HMAC token（roomId|hostPeerId|exp）。
 */

const DEFAULT_HMAC = 'inkmesh-lobby-dev-hmac-change-me';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 读取 HMAC 密钥（优先 env.LOBBY_HMAC）。 */
export function lobbyHmacSecret(env) {
  const raw = env && env.LOBBY_HMAC != null ? String(env.LOBBY_HMAC).trim() : '';
  return raw || DEFAULT_HMAC;
}

/** 字节转 base64url。 */
function bytesToB64Url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** base64url 转字节。 */
function b64UrlToBytes(text) {
  const padded = String(text || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 计算 HMAC-SHA256。 */
async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToB64Url(sig);
}

/**
 * 签发大厅口令（signal_hosted 时发给房主）。
 * @returns {Promise<string>}
 */
export async function mintLobbyToken(env, roomId, hostPeerId) {
  const room = String(roomId || '').trim().toUpperCase();
  const peer = String(hostPeerId || '').trim();
  if (!room || !peer) return '';
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = `${room}|${peer}|${exp}`;
  const payloadB64 = bytesToB64Url(new TextEncoder().encode(payload));
  const sig = await hmacSign(lobbyHmacSecret(env), payload);
  return `${payloadB64}.${sig}`;
}

/**
 * 校验大厅口令；通过则返回 { roomId, hostPeerId }。
 * @returns {Promise<{roomId:string,hostPeerId:string}|null>}
 */
export async function verifyLobbyToken(env, token, expectedRoomId) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  let payload;
  try {
    payload = new TextDecoder().decode(b64UrlToBytes(parts[0]));
  } catch (_err) {
    return null;
  }
  const segs = payload.split('|');
  if (segs.length !== 3) return null;
  const roomId = String(segs[0] || '').trim().toUpperCase();
  const hostPeerId = String(segs[1] || '').trim();
  const exp = Number(segs[2]);
  if (!roomId || !hostPeerId || !Number.isFinite(exp) || exp < Date.now()) return null;
  if (expectedRoomId && roomId !== String(expectedRoomId).trim().toUpperCase()) return null;
  const expect = await hmacSign(lobbyHmacSecret(env), `${roomId}|${hostPeerId}|${exp}`);
  if (expect !== parts[1]) return null;
  return { roomId, hostPeerId };
}

/** 公开大厅 HTTP 的 CORS 头。 */
export function lobbyCorsHeaders(request) {
  const origin = request && request.headers ? request.headers.get('Origin') : '';
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, x-lobby-token',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
