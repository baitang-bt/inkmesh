/**
 * 信令 / 大厅共用的房间号规范化与校验。
 */

const MAX_ROOM_ID_LENGTH = 8;
const RESERVED = new Set(['RANDOM-ROOM', 'WS', 'LOBBY']);

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

export { MAX_ROOM_ID_LENGTH, RESERVED };
