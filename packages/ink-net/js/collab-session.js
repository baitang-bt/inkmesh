(function (global) {
  'use strict';

  const CURSOR_HZ = 15;
  const ROOM_ID_MAX_LEN = 8;

  /** 规范化房间号。 */
  function normalizeRoomId(roomId) {
    return String(roomId || '').trim().toUpperCase().slice(0, ROOM_ID_MAX_LEN);
  }

  /**
   * 联机会话：信令 WebSocket + 房主 WebRTC 数据通道。
   * 笔迹与房间状态只经数据通道；信令只交换房间号与 ICE。
   */
  class CollabSession {
    constructor(options) {
      const settings = options || {};
      this.wsUrl = settings.wsUrl || '';
      this.selfId = settings.selfId || '';
      this.nickname = settings.nickname || '';
      this.getDisplayName = settings.getDisplayName || null;
      this.getRoomSnapshot = settings.getRoomSnapshot || null;
      this.runHostAuthority = settings.runHostAuthority || null;
      this.handlers = settings.handlers || {};
      this.ws = null;
      this.roomId = '';
      this.connected = false;
      this._pendingJoin = null;
      this._cursorTimer = 0;
      this._lastCursorSent = 0;
      this._pendingCursor = null;
      this._syncWaiters = new Map();
      this._pingWaiter = null;
      this.lastRtt = null;
      this.lastPingAt = null;
      this.lastError = '';
      this._intentionalLeave = false;
      this._hostGone = false;
      this._reconnectTimer = null;
      this._reconnecting = false;
      this._inRoom = false;
      this._signalPeerId = '';
      this._role = '';
      this._hostRoom = null;
      this._guestLinks = new Map();
      this._hostLink = null;
      this._hostPeerId = '';
      this._guestPeerIdByLink = new WeakMap();
    }

    /** 连接信令 WebSocket。 */
    connect() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
      const url = this._buildWsUrl();
      this.ws = new WebSocket(url);
      this.ws.addEventListener('open', () => {
        this.connected = true;
        this.lastError = '';
        this._emit('open');
        if (this._pendingJoin) {
          const pending = this._pendingJoin;
          this._pendingJoin = null;
          this._beginRoomEntry(pending.room);
        }
      });
      this.ws.addEventListener('error', () => {
        this.lastError = 'WebSocket 连接失败';
        this._emit('error', { message: this.lastError });
      });
      this.ws.addEventListener('close', event => {
        this.connected = false;
        const wasInRoom = this._inRoom && Boolean(this.roomId);
        const savedRoom = this.roomId;
        this.ws = null;
        if (event && event.code === 4000) return;
        if (event && event.code === 4001) {
          this.lastError = '请先登录后再进入房间';
          this._pendingJoin = null;
          this._emit('close', event);
          return;
        }
        if (wasInRoom && savedRoom && !this._intentionalLeave && this._role === 'guest') {
          this.lastError = '连接已断开，正在重新连接…';
          this._emit('close', event);
          this._scheduleReconnect(savedRoom);
          return;
        }
        if (!this.roomId && this.lastError === 'WebSocket 连接失败') {
          this._pendingJoin = null;
          this._emit('close', event);
          return;
        }
        if (!this.roomId && event && event.code !== 1000) {
          this.lastError = '无法连接服务器，请刷新后重试';
        }
        this._pendingJoin = null;
        this._emit('close', event);
      });
      this.ws.addEventListener('message', event => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch (_err) {
          return;
        }
        this._onSignalMessage(data);
      });
    }

    _buildWsUrl() {
      const base = this.wsUrl || (location.origin.replace(/^http/, 'ws') + '/inkmesh/ws');
      const params = new URLSearchParams(location.search);
      const devUser = params.get('dev_user');
      const devName = params.get('dev_name');
      if (!devUser && !devName) return base;
      const url = new URL(base);
      if (devUser) url.searchParams.set('dev_user', devUser);
      if (devName) url.searchParams.set('dev_name', devName);
      return url.toString();
    }

    /** 经信令套接字发送。 */
    _sendSignal(payload) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify(payload));
      return true;
    }

    /** 处理信令入站。 */
    _onSignalMessage(data) {
      const type = data && data.type;
      if (!type) return;
      if (type === 'signal_hello') {
        this._signalPeerId = String(data.peer_id || this.selfId);
        if (!this.selfId) this.selfId = this._signalPeerId;
        return;
      }
      if (type === 'error') {
        this.lastError = data.message || '信令错误';
        this._emit('error', { message: this.lastError });
        if (this.handlers.error) this.handlers.error(data);
        return;
      }
      if (type === 'signal_no_host') {
        this._claimHost(String(data.room || ''));
        return;
      }
      if (type === 'signal_hosted') {
        this._onHosted(String(data.room || ''));
        return;
      }
      if (type === 'signal_peer') {
        this._connectAsGuest(String(data.room || ''), String(data.host_id || ''));
        return;
      }
      if (type === 'signal_offer') {
        this._onRemoteOffer(data);
        return;
      }
      if (type === 'signal_answer') {
        this._onRemoteAnswer(data);
        return;
      }
      if (type === 'signal_ice') {
        this._onRemoteIce(data);
        return;
      }
      if (type === 'signal_host_gone') {
        this._markHostGone(data.message || '房主已离开房间');
        this._dispatch({ type: 'room_removed', message: this.lastError });
        return;
      }
      if (type === 'pong' && this._pingWaiter && this._role === '') {
        const rtt = Math.round(performance.now() - this._pingWaiter.sentAt);
        this._pingWaiter.resolve(rtt);
      }
    }

    /** 发送 ping；在房时走数据通道，否则走信令。 */
    ping(timeoutMs) {
      const timeout = Number(timeoutMs) || 3000;
      if (this._pingWaiter) {
        return Promise.reject(new Error('已有检测进行中'));
      }
      const sentAt = performance.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pingWaiter = null;
          this.lastError = '检测超时';
          reject(new Error(this.lastError));
        }, timeout);
        this._pingWaiter = {
          resolve: rtt => {
            clearTimeout(timer);
            this._pingWaiter = null;
            this.lastRtt = rtt;
            this.lastPingAt = Date.now();
            this.lastError = '';
            resolve(rtt);
          },
          reject: err => {
            clearTimeout(timer);
            this._pingWaiter = null;
            this.lastError = err.message || '检测失败';
            reject(err);
          },
          sentAt
        };
        if (!this.send({ type: 'ping' })) {
          clearTimeout(timer);
          this._pingWaiter = null;
          this.lastError = '发送 ping 失败';
          reject(new Error(this.lastError));
        }
      });
    }

    /** 返回连接状态摘要，供网络面板显示。 */
    getConnectionInfo() {
      let statusLabel = '断开';
      const mediaOpen = this._role === 'host'
        ? true
        : Boolean(this._hostLink && this._hostLink.dc && this._hostLink.dc.readyState === 'open');
      if (this.ws) {
        if (this.ws.readyState === WebSocket.CONNECTING) statusLabel = '连接中';
        else if (this.ws.readyState === WebSocket.OPEN) {
          statusLabel = this._inRoom && mediaOpen ? '已连接' : '信令已连接';
        } else if (this.ws.readyState === WebSocket.CLOSING) statusLabel = '关闭中';
      }
      return {
        connected: this.connected,
        readyState: this.ws ? this.ws.readyState : WebSocket.CLOSED,
        statusLabel,
        roomId: this.roomId || (this._pendingJoin && this._pendingJoin.room) || '',
        role: this._role,
        lastRtt: this.lastRtt,
        lastPingAt: this.lastPingAt,
        lastError: this.lastError
      };
    }

    /** 向房主房间导入 .pbcc（房主本机处理）。 */
    sendRoomImport(document) {
      return this.send({ type: 'room_import', document });
    }

    /**
     * 发送业务消息：房主广播给房客；房客发给房主。
     * ping 在房主本机直接回 pong。
     */
    send(payload) {
      if (!payload || !payload.type) return false;
      if (payload.type === 'ping' && this._role === 'host') {
        this._dispatch({ type: 'pong' });
        return true;
      }
      if (this._role === 'host') {
        if (payload.type === 'drawing_sync_request' || payload.type === 'join') {
          return true;
        }
        if (this.runHostAuthority) {
          const authored = this.runHostAuthority(this.selfId, payload);
          if (authored) {
            authored.forEach(msg => {
              this._dispatch(msg);
              this._broadcastToGuests(msg);
            });
            return true;
          }
        }
        const out = Object.assign({}, payload);
        if (
          (out.type === 'draw' || out.type === 'draw_batch' || out.type === 'stroke_visibility') &&
          !out.owner_id
        ) {
          out.owner_id = this.selfId;
        }
        this._broadcastToGuests(out);
        return true;
      }
      if (this._role === 'guest') {
        return global.P2pTransport.sendOnLink(this._hostLink, payload);
      }
      return this._sendSignal(payload);
    }

    /** 房主向所有房客数据通道广播。 */
    _broadcastToGuests(payload, excludePeerId) {
      this._guestLinks.forEach((link, peerId) => {
        if (excludePeerId && peerId === excludePeerId) return;
        global.P2pTransport.sendOnLink(link, payload);
      });
    }

    /** 向服务端请求指定画板 strokes 快照；P2P 下由房主回 drawing_sync。 */
    requestBoardSync(boardId, timeoutMs) {
      const id = String(boardId || '');
      const timeout = Number(timeoutMs) || 8000;
      if (!id) return Promise.reject(new Error('无效画板 ID'));
      if (this._syncWaiters.has(id)) {
        return this._syncWaiters.get(id).promise;
      }
      let resolveFn;
      let rejectFn;
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      const timer = setTimeout(() => {
        this._syncWaiters.delete(id);
        rejectFn(new Error('画板同步超时'));
      }, timeout);
      this._syncWaiters.set(id, { resolve: resolveFn, reject: rejectFn, timer, promise });
      if (!this.send({ type: 'drawing_sync_request', board_id: id })) {
        clearTimeout(timer);
        this._syncWaiters.delete(id);
        return Promise.reject(new Error('连接未就绪'));
      }
      return promise;
    }

    _resolveSyncWaiter(data) {
      const boardId = String(data && data.board_id || '');
      if (!boardId) return false;
      const waiter = this._syncWaiters.get(boardId);
      if (!waiter) return false;
      clearTimeout(waiter.timer);
      this._syncWaiters.delete(boardId);
      waiter.resolve(data);
      return true;
    }

    /** 进入房间：先查信令，无房主则主持，有则做房客。 */
    joinRoom(roomId) {
      this._clearReconnectTimer();
      this._intentionalLeave = false;
      this._hostGone = false;
      const target = normalizeRoomId(roomId);
      if (!target) return;
      this._pendingJoin = { room: target };
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connect();
        return;
      }
      this._beginRoomEntry(target);
    }

    /** 信令已通后发起进房。 */
    _beginRoomEntry(roomId) {
      const target = normalizeRoomId(roomId);
      if (!target) return;
      this._pendingJoin = { room: target };
      this._sendSignal({ type: 'signal_join', room: target });
    }

    /** 无房主时登记自己为房主。 */
    _claimHost(roomId) {
      const target = normalizeRoomId(roomId || (this._pendingJoin && this._pendingJoin.room));
      if (!target) return;
      this._sendSignal({ type: 'signal_host', room: target });
    }

    /** 成为房主并下发本机初始 room_state。 */
    _onHosted(roomId) {
      const target = normalizeRoomId(roomId);
      this._role = 'host';
      this.roomId = target;
      this._hostRoom = new global.P2pHostRoom({
        selfId: this.selfId || this._signalPeerId,
        getDisplayName: () => (this.getDisplayName ? this.getDisplayName() : this.nickname),
        getRoomSnapshot: forId => (this.getRoomSnapshot ? this.getRoomSnapshot(forId) : null)
      });
      if (!this.selfId) this.selfId = this._signalPeerId;
      const state = this._hostRoom.bootstrapHost(target);
      this._pendingJoin = null;
      this._dispatch(state);
    }

    /** 作为房客向房主发起 WebRTC。 */
    async _connectAsGuest(roomId, hostId) {
      const target = normalizeRoomId(roomId);
      this._role = 'guest';
      this.roomId = target;
      this._hostPeerId = hostId;
      this._teardownGuestLinkOnly();
      const link = global.P2pTransport.createPeerLink({
        createDataChannel: true,
        remotePeerId: hostId,
        onMessage: data => this._onDataMessage(data, { asHost: false }),
        onOpen: () => this._onGuestChannelOpen(),
        onClose: () => this._onGuestChannelClose(),
        onIce: candidate => {
          this._sendSignal({
            type: 'signal_ice',
            room: target,
            to_id: hostId,
            candidate
          });
        }
      });
      this._hostLink = link;
      try {
        const sdp = await global.P2pTransport.createOfferSdp(link);
        this._sendSignal({
          type: 'signal_offer',
          room: target,
          to_id: hostId,
          sdp
        });
      } catch (err) {
        this.lastError = (err && err.message) || '无法建立 P2P 连接';
        this._emit('error', { message: this.lastError });
      }
    }

    /** 房客数据通道打开后发送 join。 */
    _onGuestChannelOpen() {
      const displayName = this.getDisplayName ? this.getDisplayName() : this.nickname;
      global.P2pTransport.sendOnLink(this._hostLink, {
        type: 'join',
        room: this.roomId,
        name: displayName,
        player_id: this.selfId || this._signalPeerId
      });
    }

    /** 房客通道断开：房主已走则不重连，避免空房占主。 */
    _onGuestChannelClose() {
      if (this._intentionalLeave || this._hostGone || this._role !== 'guest') return;
      if (this._inRoom && this.roomId) {
        this.lastError = '连接已断开，正在重新连接…';
        this._scheduleReconnect(this.roomId);
      }
    }

    /**
     * 标记房主已离开：取消重连并拆掉媒体，防止随后 datachannel close 误占房。
     */
    _markHostGone(message) {
      this._hostGone = true;
      this._intentionalLeave = true;
      this._clearReconnectTimer();
      this.lastError = message || '房主已离开房间';
      this._teardownMedia();
      this._inRoom = false;
      this.roomId = '';
      this._role = '';
    }

    /** 房客是否仍可绘制（缺省 true）。 */
    _guestCanDraw(peerId) {
      if (!this._hostRoom) return true;
      const row = this._hostRoom.players.get(peerId);
      return !row || row.can_draw !== false;
    }

    /** 房主收到房客 offer。 */
    async _onRemoteOffer(data) {
      if (this._role !== 'host') return;
      const fromId = String(data.from_id || '');
      if (!fromId) return;
      this._closeGuestLink(fromId);
      const link = global.P2pTransport.createPeerLink({
        createDataChannel: false,
        remotePeerId: fromId,
        onMessage: msg => this._onDataMessage(msg, { asHost: true, peerId: fromId }),
        onOpen: () => {},
        onClose: () => this._onGuestPeerClosed(fromId),
        onIce: candidate => {
          this._sendSignal({
            type: 'signal_ice',
            room: this.roomId,
            to_id: fromId,
            candidate
          });
        }
      });
      this._guestLinks.set(fromId, link);
      this._guestPeerIdByLink.set(link, fromId);
      try {
        const sdp = await global.P2pTransport.acceptOfferCreateAnswer(link, data.sdp);
        this._sendSignal({
          type: 'signal_answer',
          room: this.roomId,
          to_id: fromId,
          sdp
        });
      } catch (err) {
        this.lastError = (err && err.message) || '无法应答 P2P';
        this._closeGuestLink(fromId);
      }
    }

    /** 房客收到 answer。 */
    async _onRemoteAnswer(data) {
      if (this._role !== 'guest' || !this._hostLink) return;
      try {
        await global.P2pTransport.applyAnswer(this._hostLink, data.sdp);
      } catch (_err) {
        this.lastError = 'P2P 应答失败';
      }
    }

    /** 收到 ICE 候选。 */
    async _onRemoteIce(data) {
      const fromId = String(data.from_id || '');
      let link = null;
      if (this._role === 'guest') link = this._hostLink;
      else if (this._role === 'host') link = this._guestLinks.get(fromId);
      if (!link) return;
      await global.P2pTransport.addIceCandidate(link, data.candidate);
    }

    /** 数据通道业务消息。 */
    _onDataMessage(data, meta) {
      const type = data && data.type;
      if (!type) return;
      if (type === 'pong' && this._pingWaiter) {
        const rtt = Math.round(performance.now() - this._pingWaiter.sentAt);
        this._pingWaiter.resolve(rtt);
        return;
      }
      if (meta && meta.asHost) {
        this._hostHandleGuestMessage(meta.peerId, data);
        return;
      }
      if (type === 'drawing_sync') this._resolveSyncWaiter(data);
      this._dispatch(data);
    }

    /** 房主处理房客上行消息并转发。 */
    _hostHandleGuestMessage(peerId, data) {
      const type = data.type;
      if (type === 'ping') {
        global.P2pTransport.sendOnLink(this._guestLinks.get(peerId), { type: 'pong' });
        return;
      }
      if (type === 'join') {
        const playerId = String(data.player_id || peerId);
        const result = this._hostRoom.acceptGuestJoin(playerId, data.name);
        global.P2pTransport.sendOnLink(this._guestLinks.get(peerId), result.roomState);
        this._dispatch(result.playerJoin);
        this._broadcastToGuests(result.playerJoin, peerId);
        return;
      }
      if (type === 'leave_room') {
        this._removeGuest(peerId);
        return;
      }
      if (type === 'player_style') {
        const styleMsg = this._hostRoom.applyPlayerStyle(peerId, data);
        if (styleMsg) {
          this._dispatch(styleMsg);
          this._broadcastToGuests(styleMsg);
        }
        return;
      }
      if (type === 'host_set_permissions' || type === 'kick_player') {
        return;
      }
      if (type === 'drawing_sync_request') {
        const snap = this.getRoomSnapshot ? this.getRoomSnapshot(peerId) : null;
        if (snap) {
          global.P2pTransport.sendOnLink(this._guestLinks.get(peerId), {
            type: 'drawing_sync',
            board_id: data.board_id || snap.active_board_id,
            layers: snap.layers,
            strokes: snap.strokes
          });
        }
        return;
      }
      const needsDraw = type === 'draw' || type === 'draw_batch'
        || type === 'undo' || type === 'redo' || type === 'clear';
      if (needsDraw && !this._guestCanDraw(peerId)) {
        return;
      }
      if (this.runHostAuthority) {
        const authored = this.runHostAuthority(peerId, data);
        if (authored) {
          authored.forEach(msg => {
            this._dispatch(msg);
            this._broadcastToGuests(msg);
          });
          return;
        }
      }
      const forward = Object.assign({}, data);
      if (type === 'draw' || type === 'draw_batch' || type === 'stroke_visibility') {
        forward.owner_id = peerId;
      }
      if (type === 'cursor_move') {
        forward.type = 'cursor_update';
        forward.player_id = peerId;
        const row = this._hostRoom.players.get(peerId);
        if (row) forward.nickname = row.name;
      }
      this._dispatch(forward);
      this._broadcastToGuests(forward, peerId);
    }

    /** 房客断开时清理成员。 */
    _onGuestPeerClosed(peerId) {
      this._closeGuestLink(peerId);
      if (!this._hostRoom) return;
      const leave = this._hostRoom.removePlayer(peerId);
      if (leave) {
        this._dispatch(leave);
        this._broadcastToGuests(leave);
      }
    }

    _removeGuest(peerId) {
      this._onGuestPeerClosed(peerId);
    }

    _closeGuestLink(peerId) {
      const link = this._guestLinks.get(peerId);
      if (link) {
        global.P2pTransport.closeLink(link);
        this._guestLinks.delete(peerId);
      }
    }

    _teardownGuestLinkOnly() {
      if (this._hostLink) {
        global.P2pTransport.closeLink(this._hostLink);
        this._hostLink = null;
      }
    }

    /** 关闭所有媒体连接。 */
    _teardownMedia() {
      this._teardownGuestLinkOnly();
      this._guestLinks.forEach(link => global.P2pTransport.closeLink(link));
      this._guestLinks.clear();
      this._hostRoom = null;
    }

    /** 主动离开房间。 */
    leaveRoom() {
      this._intentionalLeave = true;
      this._clearReconnectTimer();
      if (this._role === 'guest') {
        this.send({ type: 'leave_room' });
      }
      // 房主先经数据通道通知，避免房客只收到通道关闭后误重连占房。
      if (this._role === 'host') {
        this._broadcastToGuests({
          type: 'room_removed',
          message: '房主已离开房间'
        });
      }
      this._teardownMedia();
      this._inRoom = false;
      this.roomId = '';
      this._role = '';
      this._pendingJoin = null;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(4000);
        this.ws = null;
      }
      this.connected = false;
      this._dispatch({ type: 'room_removed', message: '已退出房间' });
    }

    _clearReconnectTimer() {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    }

    /** 断线后自动重连并重新进房。 */
    _scheduleReconnect(roomId) {
      if (this._reconnectTimer || this._intentionalLeave || this._hostGone) return;
      const targetRoom = normalizeRoomId(roomId);
      if (!targetRoom) return;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (this._intentionalLeave || this._hostGone) return;
        this._reconnecting = true;
        this.roomId = targetRoom;
        this._pendingJoin = { room: targetRoom };
        this._teardownMedia();
        this._role = '';
        this.connect();
      }, 1500);
    }

    sendCursor(boardId, x, y, drawing, extras) {
      const extra = extras || {};
      this._pendingCursor = {
        boardId,
        x,
        y,
        drawing: Boolean(drawing),
        size: extra.size,
        label_color: extra.label_color
      };
      const now = performance.now();
      if (now - this._lastCursorSent < 1000 / CURSOR_HZ) return;
      this._flushCursor();
    }

    /** 上送联机展示偏好（他人看到的用户名与标签色）。 */
    sendPlayerStyle(style) {
      const payload = { type: 'player_style' };
      if (style && typeof style === 'object') {
        if (style.label_color != null) payload.label_color = style.label_color || '';
        if (style.display_name != null) payload.display_name = String(style.display_name || '').trim();
      } else {
        payload.label_color = style || '';
      }
      if (this._role === 'host' && this._hostRoom) {
        const msg = this._hostRoom.applyPlayerStyle(this.selfId, payload);
        if (msg) {
          this._broadcastToGuests(msg);
        }
        return true;
      }
      return this.send(payload);
    }

    _flushCursor() {
      if (!this._pendingCursor) return;
      const c = this._pendingCursor;
      this._lastCursorSent = performance.now();
      const payload = {
        type: 'cursor_move',
        board_id: c.boardId,
        x: c.x,
        y: c.y,
        drawing: c.drawing
      };
      if (c.size != null) payload.size = c.size;
      if (c.label_color) payload.label_color = c.label_color;
      if (this._role === 'host') {
        const forward = Object.assign({}, payload, {
          type: 'cursor_update',
          player_id: this.selfId,
          nickname: this.getDisplayName ? this.getDisplayName() : this.nickname
        });
        this._broadcastToGuests(forward);
        return;
      }
      this.send(payload);
    }

    _dispatch(data) {
      const type = data && data.type;
      if (!type) return;
      if (type === 'pong' && this._pingWaiter) {
        const rtt = Math.round(performance.now() - this._pingWaiter.sentAt);
        this._pingWaiter.resolve(rtt);
        return;
      }
      if (type === 'drawing_sync') this._resolveSyncWaiter(data);
      if (type === 'room_removed' && this._role === 'guest' && !this._intentionalLeave) {
        this._markHostGone(data.message || '房间已解散');
      }
      const handler = this.handlers[type] || this.handlers['*'];
      if (handler) handler(data);
      if (type === 'room_state' && data.room_id) {
        this.roomId = data.room_id;
        this._inRoom = true;
        this._pendingJoin = null;
        this._reconnecting = false;
        this._hostGone = false;
        this._intentionalLeave = false;
        this.lastError = '';
        if (data.self_id) this.selfId = data.self_id;
      }
    }

    _emit(name, payload) {
      const handler = this.handlers[name];
      if (handler) handler(payload);
    }

    disconnect() {
      this._clearReconnectTimer();
      this._intentionalLeave = true;
      this._teardownMedia();
      if (this.ws) {
        this.ws.close(4000);
        this.ws = null;
      }
      this._inRoom = false;
      this.roomId = '';
      this._role = '';
      this._pendingJoin = null;
      this.connected = false;
    }

    /** 房主：设置房客权限；target_id 省略则作用于全部房客。 */
    sendHostPermissions(patch) {
      if (this._role !== 'host' || !this._hostRoom) return false;
      const msgs = this._hostRoom.applyHostPermissions(this.selfId, patch || {});
      msgs.forEach(msg => {
        this._dispatch(msg);
        this._broadcastToGuests(msg);
      });
      return true;
    }

    /** 房主：踢出指定玩家。 */
    kickPlayer(targetId) {
      if (this._role !== 'host' || !this._hostRoom) return false;
      const tid = String(targetId || '');
      if (!this._hostRoom.kickPlayer(this.selfId, tid)) return false;
      const link = this._guestLinks.get(tid);
      if (link) {
        global.P2pTransport.sendOnLink(link, {
          type: 'room_removed',
          message: '你已被房主移出房间'
        });
      }
      this._closeGuestLink(tid);
      const leave = {
        type: 'player_leave',
        player_id: tid,
        name: '',
        temporary: false,
        message: '已移出房间'
      };
      this._dispatch(leave);
      this._broadcastToGuests(leave);
      return true;
    }
  }

  global.CollabSession = CollabSession;
})(window);
