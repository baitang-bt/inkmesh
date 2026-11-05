(function (global) {
  'use strict';

  const ROOM_KEY = 'inkmesh-lobby-rooms-v1';
  const PEER_KEY = 'inkmesh-lobby-peers-v1';
  const STARRED_KEY = 'inkmesh-lobby-starred-peers-v1';
  const SECTION_KEY = 'inkmesh-lobby-peer-sections-v1';
  const MAX_ROOMS = 40;
  const MAX_PEERS = 30;
  const MAX_STARRED = 40;

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

  /** 规范化同伴行。 */
  function normalizePeer(row) {
    if (!row) return null;
    const uid = String(row.uid || '');
    const name = global.sanitizeDisplayName
      ? sanitizeDisplayName(row.name || '')
      : String(row.name || '').slice(0, 12);
    if (!uid || !name) return null;
    return {
      uid,
      name,
      lastRoomId: String(row.lastRoomId || '').toUpperCase(),
      lastSeenAt: Number(row.lastSeenAt || 0),
      starredAt: Number(row.starredAt || 0)
    };
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

    /**
     * 只改房间显示名，不刷新 visitedAt（大厅就地改名）。
     * @returns {boolean} 是否写入
     */
    setRoomTitle(roomId, title) {
      const id = String(roomId || '').trim().toUpperCase();
      const nextTitle = String(title || '').trim().slice(0, 40);
      if (!id || !nextTitle) return false;
      const list = this.listRooms();
      const row = list.find(item => item.roomId === id);
      if (row) {
        row.title = nextTitle;
        writeList(ROOM_KEY, list);
        return true;
      }
      list.unshift({ roomId: id, title: nextTitle, visitedAt: Date.now() });
      writeList(ROOM_KEY, list.slice(0, MAX_ROOMS));
      return true;
    },

    /** 返回最近同房的人，按时间倒序。 */
    listPeers() {
      return readList(PEER_KEY)
        .map(normalizePeer)
        .filter(Boolean)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    },

    /** 返回标星同伴，按标星时间倒序。 */
    listStarredPeers() {
      return readList(STARRED_KEY)
        .map(normalizePeer)
        .filter(Boolean)
        .sort((a, b) => (b.starredAt || b.lastSeenAt) - (a.starredAt || a.lastSeenAt));
    },

    /** 是否已标星。 */
    isStarred(uid) {
      const id = String(uid || '');
      if (!id) return false;
      return this.listStarredPeers().some(row => row.uid === id);
    },

    /**
     * 设置标星；取消时只改标星表。
     * @param {object} peer 至少含 uid/name
     * @param {boolean} starred
     */
    setPeerStarred(peer, starred) {
      const normalized = normalizePeer(peer);
      if (!normalized) return false;
      let list = this.listStarredPeers().filter(row => row.uid !== normalized.uid);
      if (starred) {
        const prev = readList(STARRED_KEY).map(normalizePeer).find(row => row && row.uid === normalized.uid);
        list.unshift({
          uid: normalized.uid,
          name: normalized.name,
          lastRoomId: normalized.lastRoomId,
          lastSeenAt: normalized.lastSeenAt || Date.now(),
          starredAt: (prev && prev.starredAt) || Date.now()
        });
        list = list.slice(0, MAX_STARRED);
      }
      writeList(STARRED_KEY, list);
      return true;
    },

    /**
     * 记住同房玩家（跳过自己）；若已标星则同步姓名与最近房间。
     * @param {object} player 含 uid/name
     * @param {string} [selfId] 本机用户 id
     * @param {string} [roomId] 当时房间号
     */
    rememberPeer(player, selfId, roomId) {
      if (!player) return;
      const uid = String(player.uid || player.player_id || '');
      if (!uid || (selfId && uid === selfId)) return;
      const name = global.sanitizeDisplayName
        ? sanitizeDisplayName(player.name || '')
        : String(player.name || '').trim().slice(0, 12);
      if (!name) return;
      const next = {
        uid,
        name,
        lastRoomId: String(roomId || '').trim().toUpperCase(),
        lastSeenAt: Date.now()
      };
      const list = this.listPeers().filter(row => row.uid !== uid);
      list.unshift(next);
      writeList(PEER_KEY, list.slice(0, MAX_PEERS));
      if (this.isStarred(uid)) {
        this.setPeerStarred(next, true);
      }
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
    },

    /** 读同伴分区展开状态（默认展开）。 */
    getPeerSectionOpen(sectionId) {
      try {
        const raw = localStorage.getItem(SECTION_KEY);
        if (!raw) return true;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return true;
        if (parsed[sectionId] === false) return false;
        return true;
      } catch (_err) {
        return true;
      }
    },

    /** 写同伴分区展开状态。 */
    setPeerSectionOpen(sectionId, open) {
      let state = {};
      try {
        const raw = localStorage.getItem(SECTION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') state = parsed;
        }
      } catch (_err) {}
      state[String(sectionId || '')] = Boolean(open);
      try {
        localStorage.setItem(SECTION_KEY, JSON.stringify(state));
      } catch (_err) {}
    }
  };

  global.LobbyHistory = LobbyHistory;
})(window);
