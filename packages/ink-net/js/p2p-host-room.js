(function (global) {
  'use strict';

  const PROTOCOL_VERSION = 2;
  const MAX_PLAYERS_MIN = 1;
  const MAX_PLAYERS_MAX = 16;
  const MAX_PLAYERS_DEFAULT = 8;

  /** 将人数上限夹到合法范围。 */
  function clampMaxPlayers(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return MAX_PLAYERS_DEFAULT;
    return Math.max(MAX_PLAYERS_MIN, Math.min(MAX_PLAYERS_MAX, n));
  }

  /** 生成邀请口令（约 32 位 hex）。 */
  function generateInviteToken() {
    const bytes = new Uint8Array(16);
    if (global.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  /** 默认画板元数据与空白笔迹（新房主进房用）。 */
  function defaultEmptySnapshot(roomId, selfId, displayName, maxPlayers, privateRoom) {
    const canvas = { mode: 'vector', width: 1920, height: 1080 };
    const layers = [
      {
        layer_id: 'l_background',
        name: '背景',
        kind: 'paint',
        parent_id: '',
        visible: true,
        opacity: 255,
        locked: false,
        order: 0
      },
      {
        layer_id: 'l_default',
        name: '图层 1',
        kind: 'paint',
        parent_id: '',
        visible: true,
        opacity: 255,
        locked: false,
        order: 1
      }
    ];
    const strokes = [
      {
        stroke_id: 'bg_fill',
        owner_id: '__system__',
        layer_id: 'l_background',
        active: true,
        segments: [
          {
            tool: 'rect',
            x1: 0,
            y1: 0,
            x2: 1,
            y2: 1,
            color: '#ffffff',
            size: 1,
            filled: true
          }
        ]
      }
    ];
    return {
      type: 'room_state',
      protocolVersion: PROTOCOL_VERSION,
      room_id: roomId,
      self_id: selfId,
      owner_id: selfId,
      max_players: clampMaxPlayers(maxPlayers),
      private_room: Boolean(privateRoom),
      players: [
        {
          uid: selfId,
          name: displayName,
          is_host: true,
          connected: true,
          active_board_id: 'b_default',
          label_color: '',
          can_draw: true,
          can_save: true
        }
      ],
      boards: [
        {
          board_id: 'b_default',
          title: '画板 1',
          canvas,
          created_at: Date.now() / 1000,
          created_by: selfId
        }
      ],
      board_order: ['b_default'],
      active_board_id: 'b_default',
      active_layer_id: 'l_default',
      layers,
      strokes,
      canvas,
      last_board_create_at: 0
    };
  }

  /**
   * 房主侧成员表与入站 join 处理；笔迹权威在 board 快照回调。
   */
  class P2pHostRoom {
    constructor(options) {
      const settings = options || {};
      this.selfId = settings.selfId || '';
      this.getDisplayName = settings.getDisplayName || (() => '玩家');
      this.getRoomSnapshot = settings.getRoomSnapshot || null;
      this.players = new Map();
      this.maxPlayers = clampMaxPlayers(settings.maxPlayers || MAX_PLAYERS_DEFAULT);
      this.privateRoom = false;
      this.inviteToken = '';
    }

    /** 房主开房时写入自己。 */
    bootstrapHost(roomId) {
      const name = this.getDisplayName();
      this.players.clear();
      this.maxPlayers = clampMaxPlayers(this.maxPlayers || MAX_PLAYERS_DEFAULT);
      this.privateRoom = false;
      this.inviteToken = '';
      this.players.set(this.selfId, {
        uid: this.selfId,
        name,
        is_host: true,
        connected: true,
        active_board_id: 'b_default',
        label_color: '',
        can_draw: true,
        can_save: true
      });
      return defaultEmptySnapshot(roomId, this.selfId, name, this.maxPlayers, false);
    }

    /** 当前成员列表（数组）。 */
    listPlayers() {
      return Array.from(this.players.values());
    }

    /**
     * 处理房客 join，返回发给该房客的 room_state 与广播用的 player_join。
     * 私密房须带正确 invite；已在成员表的重连免校验。
     */
    acceptGuestJoin(playerId, displayName, invite) {
      if (this.players.has(playerId)) {
        /* 重连同一人：不占新名额、不重复校验邀请口令 */
      } else if (this.privateRoom) {
        const token = String(this.inviteToken || '');
        const given = String(invite || '');
        if (!token || given !== token) {
          return {
            rejected: true,
            reason: 'invite_required',
            message: '这是私密房间，请使用房主分享的邀请链接进入'
          };
        }
      } else if (this.players.size >= this.maxPlayers) {
        return { rejected: true, reason: 'room_full', message: '房间已满' };
      }
      const name = (global.sanitizeDisplayName
        ? sanitizeDisplayName(displayName)
        : String(displayName || '').trim().slice(0, 12)) || '玩家';
      const row = {
        uid: playerId,
        name,
        is_host: false,
        connected: true,
        active_board_id: 'b_default',
        label_color: '',
        can_draw: true,
        can_save: true
      };
      this.players.set(playerId, row);
      let state = null;
      if (this.getRoomSnapshot) {
        state = this.getRoomSnapshot(playerId);
      }
      if (!state || state.type !== 'room_state') {
        state = defaultEmptySnapshot(
          (state && state.room_id) || '',
          playerId,
          name,
          this.maxPlayers,
          this.privateRoom
        );
        state.self_id = playerId;
        state.owner_id = this.selfId;
        state.players = this.listPlayers();
      } else {
        state = Object.assign({}, state, {
          type: 'room_state',
          self_id: playerId,
          owner_id: this.selfId,
          max_players: this.maxPlayers,
          private_room: this.privateRoom,
          players: this.listPlayers()
        });
      }
      const joinMsg = {
        type: 'player_join',
        player_id: playerId,
        name,
        label_color: '',
        can_draw: true,
        can_save: true,
        is_host: false
      };
      return { roomState: state, playerJoin: joinMsg };
    }

    /**
     * 房主设置人数上限；减少时不踢已在房内的人。
     * @returns {{ type: string, max_players: number }|null}
     */
    setMaxPlayers(fromId, rawMax) {
      if (fromId !== this.selfId) return null;
      this.maxPlayers = clampMaxPlayers(rawMax);
      return { type: 'room_max_players', max_players: this.maxPlayers };
    }

    /**
     * 房主开关私密房间；开启时生成邀请口令，关闭时清空。
     * @returns {{ type: string, private_room: boolean }|null}
     */
    setPrivateRoom(fromId, enabled) {
      if (fromId !== this.selfId) return null;
      const next = Boolean(enabled);
      this.privateRoom = next;
      if (next) {
        this.inviteToken = this.inviteToken || generateInviteToken();
      } else {
        this.inviteToken = '';
      }
      return { type: 'room_private', private_room: this.privateRoom };
    }

    /** 更新成员显示名或标签色。 */
    applyPlayerStyle(playerId, patch) {
      const row = this.players.get(playerId);
      if (!row) return null;
      const next = Object.assign({}, row);
      if (patch.display_name != null) {
        const name = global.sanitizeDisplayName
          ? sanitizeDisplayName(patch.display_name)
          : String(patch.display_name || '').trim().slice(0, 12);
        if (name) next.name = name;
      }
      if (patch.label_color != null) next.label_color = patch.label_color || '';
      this.players.set(playerId, next);
      return {
        type: 'player_style',
        player_id: playerId,
        name: next.name,
        label_color: next.label_color
      };
    }

    /** 房主改权限。 */
    applyHostPermissions(fromId, data) {
      if (fromId !== this.selfId) return [];
      const targetId = data.target_id ? String(data.target_id) : '';
      const out = [];
      this.players.forEach((row, uid) => {
        if (uid === this.selfId) return;
        if (targetId && uid !== targetId) return;
        const next = Object.assign({}, row);
        if (data.can_draw != null) next.can_draw = Boolean(data.can_draw);
        if (data.can_save != null) next.can_save = Boolean(data.can_save);
        this.players.set(uid, next);
        out.push({
          type: 'player_permissions',
          player_id: uid,
          can_draw: next.can_draw,
          can_save: next.can_save
        });
      });
      return out;
    }

    /** 踢人；返回是否踢掉。 */
    kickPlayer(fromId, targetId) {
      if (fromId !== this.selfId) return false;
      const tid = String(targetId || '');
      if (!tid || tid === this.selfId) return false;
      return this.players.delete(tid);
    }

    /** 房客离开。 */
    removePlayer(playerId) {
      const row = this.players.get(playerId);
      if (!row) return null;
      this.players.delete(playerId);
      return {
        type: 'player_leave',
        player_id: playerId,
        name: row.name,
        temporary: false,
        message: `${row.name} 离开了房间`
      };
    }
  }

  global.P2pHostRoom = P2pHostRoom;
  global.P2pHostRoomDefaults = {
    defaultEmptySnapshot,
    PROTOCOL_VERSION,
    MAX_PLAYERS_MIN,
    MAX_PLAYERS_MAX,
    MAX_PLAYERS_DEFAULT,
    clampMaxPlayers,
    generateInviteToken
  };
})(window);
