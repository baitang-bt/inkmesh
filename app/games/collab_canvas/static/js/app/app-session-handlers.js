(function (global) {
  'use strict';

  /**
   * 构造 CollabSession.handlers：把 WS 事件接到 App 壳与 Board 控制器。
   * @param {object} ctx 可变上下文（boardController/roomPanel 等会在启动后赋值）
   */
  function createCollabAppSessionHandlers(ctx) {
    return {



      open: () => {
        if (ctx.session._pendingJoin) ctx.setStatus('正在进入房间…');
      },
      error: data => {
        const msg = (data && data.message) || ctx.session.lastError || '连接失败';
        ctx.resetJoinControls();
        if (ctx.boardController) {
          ctx.boardController._clearPendingLayerCreate();
          ctx.boardController.cancelPbccRestorePending(msg);
        }
        if (ctx.roomScreen && !ctx.roomScreen.classList.contains('hidden')) {
          ctx.setStatus(msg);
        } else {
          ctx.setJoinError(msg);
          ctx.setStatus('');
        }
      },
      close: () => {
        if (ctx.session._reconnecting || (ctx.session._inRoom && ctx.session.roomId && ctx.session.lastError === '连接已断开，正在重新连接…')) {
          ctx.setStatus(ctx.session.lastError);
          return;
        }
        ctx.resetJoinControls();
        ctx.cursorOverlay.clear();
        const alreadyOnLobby = ctx.roomScreen && ctx.roomScreen.classList.contains('hidden');
        const msg = ctx.session.lastError || (alreadyOnLobby ? '' : '连接已断开，请刷新页面');
        if (alreadyOnLobby) {
          if (msg) ctx.setJoinError(msg);
          ctx.setStatus('');
          if (ctx.lobbyHome) ctx.lobbyHome.refresh();
          return;
        }
        ctx.setJoinError(msg);
        ctx.setStatus('');
        ctx.showJoinScreen(msg);
      },
      room_removed: data => {
        ctx.session.disconnect();
        ctx.resetJoinControls();
        ctx.cursorOverlay.clear();
        const msg = (data && data.message) || '';
        const softLeave = !msg || msg === '已退出房间' || msg === '已离开房间';
        ctx.showJoinScreen(softLeave ? '' : msg);
      },
      room_state: data => {
        ctx.resetJoinControls();
        ctx.showRoomScreen(data.room_id);
        ctx.boardController.setSelfId(data.self_id);
        ctx.cursorOverlay.setSelfId(data.self_id);
        ctx.boardController.handleRoomState(data);
        ctx.session.sendPlayerStyle({
          label_color: ctx.onlinePrefs.getWireLabelColor(),
          display_name: ctx.onlinePrefs.resolveDisplayName(ctx.nickname)
        });
        if (ctx.roomPanel) {
          ctx.roomPanel.setPlayers(data.players || []);
          if (data.max_players != null) ctx.roomPanel.setMaxPlayers(data.max_players);
          if (data.private_room != null) ctx.roomPanel.setPrivateRoom(data.private_room);
        }
        if (Array.isArray(data.players)) {
          data.players.forEach(player => {
            if (player.uid === data.self_id) return;
            ctx.cursorOverlay.setPlayerStyle(player.uid, {
              label_color: player.label_color,
              nickname: player.name
            });
          });
        }
        if (global.LobbyHistory) {
          LobbyHistory.rememberRoom(data.room_id);
          LobbyHistory.rememberPeers(data.players || [], data.self_id, data.room_id);
        }
        if (ctx.boardController && ctx.boardController.finishPbccRestoreIfPending()) {
          /* 恢复成功提示已由 finishPbccRestoreIfPending 设置 */
        } else if (ctx.session && ctx.session._useRelay) {
          ctx.setStatus('当前为中继连接');
        } else if (!ctx.boardController || !ctx.boardController._pbccRestorePending) {
          ctx.setStatus('');
        }
        const copyBtn = document.getElementById('copyLinkBtn');
        if (copyBtn) copyBtn.onclick = () => ctx.copyRoomLink();
        ctx.maybeRestorePbccAfterJoin(data);
        if (ctx.startLobbyAnnounceIfHost) ctx.startLobbyAnnounceIfHost();
      },
      drawing_sync: data => ctx.boardController.handleDrawingSync(data),
      draw: data => ctx.boardController.handleDrawMessage(data),
      draw_batch: data => ctx.boardController.handleDrawBatch(data),
      stroke_visibility: data => ctx.boardController.handleStrokeVisibility(data),
      clear: data => ctx.boardController.handleClear(data),
      board_added: data => ctx.boardController.handleBoardAdded(data),
      board_removed: data => ctx.boardController.handleBoardRemoved(data),
      board_renamed: data => ctx.boardController.handleBoardRenamed(data),
      layer_added: data => ctx.boardController.handleLayerAdded(data),
      layer_duplicated: data => ctx.boardController.handleLayerDuplicated(data),
      layer_removed: data => ctx.boardController.handleLayerRemoved(data),
      layer_renamed: data => ctx.boardController.handleLayerRenamed(data),
      layer_reordered: data => ctx.boardController.handleLayerReordered(data),
      layer_updated: data => ctx.boardController.handleLayerUpdated(data),
      cursor_update: data => ctx.cursorOverlay.update(data.player_id, data),
      player_style: data => {
        ctx.cursorOverlay.setPlayerStyle(data.player_id, data);
        if (ctx.boardController && data.name) {
          const list = ctx.boardController.getPlayersSnapshot().slice();
          const idx = list.findIndex(p => p.uid === data.player_id);
          if (idx >= 0) {
            list[idx] = Object.assign({}, list[idx], { name: data.name });
            ctx.boardController.setPlayersSnapshot(list);
            if (ctx.roomPanel) ctx.roomPanel.setPlayers(list);
          }
        }
        if (ctx.boardPanel) ctx.boardPanel.refreshOccupantTree();
      },
      player_board: data => {
        if (!ctx.boardController) return;
        const list = ctx.boardController.getPlayersSnapshot().slice();
        const idx = list.findIndex(p => p.uid === data.player_id);
        if (idx >= 0) {
          list[idx] = Object.assign({}, list[idx], {
            active_board_id: data.board_id,
            name: data.name || list[idx].name
          });
        }
        ctx.boardController.setPlayersSnapshot(list);
        if (ctx.boardPanel) ctx.boardPanel.refreshOccupantTree();
      },
      player_permissions: data => {
        ctx.boardController.handlePlayerPermissions(data);
        if (ctx.roomPanel) {
          ctx.roomPanel.updatePlayerPermissions(data.player_id, {
            can_draw: data.can_draw,
            can_save: data.can_save
          });
        }
      },
      room_max_players: data => {
        if (ctx.boardController && ctx.boardController.handleRoomMaxPlayers) {
          ctx.boardController.handleRoomMaxPlayers(data);
        }
        if (ctx.roomPanel && data.max_players != null) {
          ctx.roomPanel.setMaxPlayers(data.max_players);
        }
      },
      room_private: data => {
        if (ctx.boardController && ctx.boardController.handleRoomPrivate) {
          ctx.boardController.handleRoomPrivate(data);
        }
        if (ctx.roomPanel && data.private_room != null) {
          ctx.roomPanel.setPrivateRoom(data.private_room);
        }
        if (data.private_room) {
          if (ctx.stopLobbyAnnounce) ctx.stopLobbyAnnounce(true);
        } else if (ctx.startLobbyAnnounceIfHost) {
          ctx.startLobbyAnnounceIfHost();
        }
      },
      player_join: data => {
        ctx.cursorOverlay.setPlayerStyle(data.player_id, data);
        if (ctx.boardController) {
          const list = ctx.boardController.getPlayersSnapshot().slice();
          const idx = list.findIndex(p => p.uid === data.player_id);
          const row = {
            uid: data.player_id,
            name: data.name,
            connected: true,
            is_host: !!data.is_host,
            label_color: data.label_color || '',
            can_draw: data.can_draw !== false,
            can_save: data.can_save !== false,
            active_board_id: 'b_default'
          };
          if (idx >= 0) list[idx] = Object.assign({}, list[idx], row);
          else list.push(row);
          ctx.boardController.setPlayersSnapshot(list);
          ctx.boardController._updateMemberCount(list);
          if (ctx.roomPanel) ctx.roomPanel.setPlayers(list);
        }
        if (ctx.boardPanel) ctx.boardPanel.refreshOccupantTree();
        if (global.LobbyHistory) {
          LobbyHistory.rememberPeer(
            { uid: data.player_id, name: data.name },
            ctx.boardController && ctx.boardController.selfId,
            ctx.session && ctx.session.roomId
          );
        }
        ctx.setStatus(`${data.name} 加入了房间`);
        if (ctx.scheduleLobbyAnnounce) ctx.scheduleLobbyAnnounce();
      },
      player_leave: data => {
        if (!data.temporary) ctx.cursorOverlay.remove(data.player_id);
        if (ctx.boardController) {
          const list = ctx.boardController.getPlayersSnapshot().slice();
          const next = data.temporary
            ? list.map(p => (
              p.uid === data.player_id ? Object.assign({}, p, { connected: false }) : p
            ))
            : list.filter(p => p.uid !== data.player_id);
          ctx.boardController.setPlayersSnapshot(next);
          ctx.boardController._updateMemberCount(next);
          if (ctx.roomPanel) ctx.roomPanel.setPlayers(next);
        }
        if (ctx.boardPanel) ctx.boardPanel.refreshOccupantTree();
        if (data.message) ctx.setStatus(data.message);
        if (ctx.scheduleLobbyAnnounce) ctx.scheduleLobbyAnnounce();
      }
    
    };
  }

  global.createCollabAppSessionHandlers = createCollabAppSessionHandlers;
})(typeof window !== 'undefined' ? window : globalThis);
