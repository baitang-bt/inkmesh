(function (global) {
  'use strict';

  const ROOM_KEY = 'inkmesh-lobby-rooms-v1';
  const PEER_KEY = 'inkmesh-lobby-peers-v1';
  const MAX_ROOMS = 40;
  const MAX_PEERS = 30;

  /** 安全读取 JSON 数组；失败时返回空数组。 */
  function readList(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  /** 写入 JSON 列表。 */
  function writeList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch (_err) {}
  }

  /** 本机大厅：进出过的房间与最近同房的人（仅 localStorage）。 */
  const LobbyHistory = {
    /** 返回房间访问记录，按时间倒序。 */
    listRooms() {
      return readList(ROOM_KEY)
        .map(row => ({
          roomId: String(row.roomId || '').toUpperCase(),
          title: String(row.title || row.roomId || '').slice(0, 40),
          visitedAt: Number(row.visitedAt || 0)
        }))
        .filter(row => row.roomId)
        .sort((a, b) => b.visitedAt - a.visitedAt);
    },

    /**
     * 记录一次进房成功。
     * @param {string} roomId 房间号
     * @param {string} [title] 显示标题；缺省保留旧标题或用房间号
     */
    rememberRoom(roomId, title) {
      const id = String(roomId || '').trim().toUpperCase();
      if (!id) return;
      const nextTitle = String(title || '').trim().slice(0, 40);
      const existing = this.listRooms();
      const prev = existing.find(row => row.roomId === id);
      const list = existing.filter(row => row.roomId !== id);
      list.unshift({
        roomId: id,
        title: nextTitle || (prev && prev.title) || id,
        visitedAt: Date.now()
      });
      writeList(ROOM_KEY, list.slice(0, MAX_ROOMS));
    },

    /** 返回最近同房的人，按时间倒序。 */
    listPeers() {
      return readList(PEER_KEY)
        .map(row => ({
          uid: String(row.uid || ''),
          name: String(row.name || '').slice(0, 24),
          lastRoomId: String(row.lastRoomId || '').toUpperCase(),
          lastSeenAt: Number(row.lastSeenAt || 0)
        }))
        .filter(row => row.uid && row.name)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    },

    /**
     * 记住同房玩家（跳过自己）。
     * @param {object} player 含 uid/name
     * @param {string} [selfId] 本机用户 id
     * @param {string} [roomId] 当时房间号
     */
    rememberPeer(player, selfId, roomId) {
      if (!player) return;
      const uid = String(player.uid || player.player_id || '');
      if (!uid || (selfId && uid === selfId)) return;
      const name = String(player.name || '').trim().slice(0, 24);
      if (!name) return;
      const list = this.listPeers().filter(row => row.uid !== uid);
      list.unshift({
        uid,
        name,
        lastRoomId: String(roomId || '').trim().toUpperCase(),
        lastSeenAt: Date.now()
      });
      writeList(PEER_KEY, list.slice(0, MAX_PEERS));
    },

    /**
     * 批量记住房间成员。
     * @param {Array} players 玩家列表
     * @param {string} selfId 本机用户 id
     * @param {string} roomId 房间号
     */
    rememberPeers(players, selfId, roomId) {
      if (!Array.isArray(players)) return;
      players.forEach(player => this.rememberPeer(player, selfId, roomId));
    }
  };

  global.LobbyHistory = LobbyHistory;
})(window);
