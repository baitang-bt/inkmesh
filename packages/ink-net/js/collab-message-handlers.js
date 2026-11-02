(function (global) {
  'use strict';

  /**
   * 入站 WS 消息 → CollabBoardController 状态更新。
   * 通过 install 挂到控制器原型，保持 handle* 公开 API。
   */
  const CollabMessageHandlers = {
    /** 将入站处理函数安装到 CollabBoardController.prototype。 */
    install(ControllerClass) {
      const proto = ControllerClass.prototype;
      proto.handleRoomState = function(data) {
      this.selfId = data.self_id || this.selfId;
      this.ownerId = data.owner_id || '';
      this._applySelfPermissions(data.players, data.self_id);
      this.activeBoardId = data.active_board_id || 'b_default';
      this.activeLayerId = data.active_layer_id || 'l_default';
      this.layersMeta = this._coerceLayers(data.layers);
      this.boardsMeta = data.boards || [];
      this.boardOrder = data.board_order || this.boardsMeta.map(b => b.board_id);
      // 轻量 room_state（成员进出）不带 strokes；缺省时勿写成 []，否则会清空本地笔迹。
      if (Object.prototype.hasOwnProperty.call(data, 'strokes')) {
        this.strokes = DrawingBoard.cloneStrokes(data.strokes || []);
      }
      if (this.layerPanel) {
        this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      }
      this._refitCanvas();
      this._redraw();
      if (!this.isHost() && data.last_board_create_at) {
        const cooldownMs = global.BOARD_CREATE_COOLDOWN_MS || 60000;
        const until = Math.floor(Number(data.last_board_create_at) * 1000) + cooldownMs;
        if (until > Date.now()) {
          this._boardCreateCooldownUntil = until;
        }
      }
      this._syncBoardPanel();
      this.onRoomChange(data);
      this._updateMemberCount(data.players);
      this.setPlayersSnapshot(data.players);
    };

      proto._applySelfPermissions = function(players, selfId) {
      const id = selfId || this.selfId;
      const row = (players || []).find(p => p.uid === id);
      const isHost = id && this.ownerId && id === this.ownerId;
      this.canDraw = isHost || row == null || row.can_draw !== false;
      this.canSave = isHost || row == null || row.can_save !== false;
      this._syncPermissionUi();
    };

      proto.handlePlayerPermissions = function(data) {
      const list = this.getPlayersSnapshot().slice();
      const idx = list.findIndex(p => p.uid === data.player_id);
      if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], {
          can_draw: data.can_draw,
          can_save: data.can_save
        });
        this.setPlayersSnapshot(list);
      }
      if (data.player_id === this.selfId) {
        if (data.can_draw != null) this.canDraw = !!data.can_draw;
        if (data.can_save != null) this.canSave = !!data.can_save;
        this._syncPermissionUi();
      }
    };

      proto._syncPermissionUi = function() {
      if (this.canvasWatermark) this.canvasWatermark.setActive(this.canSave);
      if (this.stage) {
        this.stage.classList.toggle('is-readonly', !this.canDraw);
        this.stage.classList.toggle('is-save-blocked', !this.canSave);
      }
      const exportToggle = document.getElementById('exportToggleBtn');
      if (exportToggle) exportToggle.disabled = !this.canSave;
      if (!this.canDraw && this.brushPreview) this.brushPreview.hide();
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
    };

      proto.getPlayersSnapshot = function() {
      return this._playersSnapshot || [];
    };

      proto.setPlayersSnapshot = function(players) {
      this._playersSnapshot = Array.isArray(players) ? players.slice() : [];
    };

      proto.handleDrawingSync = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      if (data.layers) {
        this.layersMeta = this._coerceLayers(data.layers);
        const sorted = this.layersMeta.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        if (sorted.length) this.activeLayerId = sorted[sorted.length - 1].layer_id;
      }
      this.applyServerSnapshot(data.strokes || [], true);
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
    };

      proto.handleDrawMessage = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const segment = this._segmentFromMessage(data);
      if (!segment) return;
      this._appendRemoteSegment(data.owner_id, data.stroke_id, segment, data.layer_id);
    };

      proto.handleDrawBatch = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      (data.segments || []).forEach(segment => {
        this._appendRemoteSegment(data.owner_id, data.stroke_id, segment, data.layer_id);
      });
    };

      proto.handleStrokeVisibility = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const stroke = DrawingBoard.findStroke(this.strokes, data.owner_id, data.stroke_id);
      if (!stroke) return;
      stroke.active = Boolean(data.visible);
      if (!this.isDrawing) this._redraw();
    };

      proto.handleClear = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const layerId = data.layer_id || this.activeLayerId;
      this.strokes = this.strokes.filter(s =>
        String(s.layer_id || 'l_default') !== layerId
      );
      this._redraw();
    };

      proto.handleLayerAdded = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      this._clearPendingLayerCreate();
      if (data.layer) {
        const layer = this._normalizeLayerMeta(Object.assign({}, data.layer));
        if (!this.layersMeta.some(item => item.layer_id === layer.layer_id)) {
          this.layersMeta.push(layer);
        }
      }
      this.layersMeta.sort((a, b) => (a.order || 0) - (b.order || 0));
      if (data.created_by === this.selfId && data.layer) {
        this.activeLayerId = data.layer.layer_id;
        if (this._pendingSelectionCopy) {
          this._applyPendingSelectionCopy(data.layer.layer_id);
        }
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
      this._layerUiMessage('');
    };

      proto._applyPendingSelectionCopy = function(layerId) {
      const pending = this._pendingSelectionCopy;
      if (!pending || !layerId) return;
      const db = this.drawingBoard;
      const bbox = pending.bbox;
      const segment = {
        tool: 'localRaster',
        x: bbox.x / db.logicalWidth,
        y: bbox.y / db.logicalHeight,
        w: bbox.w / db.logicalWidth,
        h: bbox.h / db.logicalHeight,
        pixels: pending.pixels,
        punch: false
      };
      const strokeId = crypto.randomUUID();
      db.appendSegment(this.strokes, this.selfId, strokeId, segment, layerId);
      this._pendingSelectionCopy = null;
      this._redraw();
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
    };

      proto.handleLayerDuplicated = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      if (data.layer) {
        const exists = this.layersMeta.some(l => l.layer_id === data.layer.layer_id);
        if (!exists) this.layersMeta.push(data.layer);
        this.layersMeta.sort((a, b) => (a.order || 0) - (b.order || 0));
      }
      (data.strokes || []).forEach(stroke => {
        const copy = DrawingBoard.cloneStrokes([stroke])[0];
        if (copy) this.strokes.push(copy);
      });
      if (data.created_by === this.selfId && data.layer) {
        this.activeLayerId = data.layer.layer_id;
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    };

      proto.handleLayerRemoved = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const removed = this.layersMeta.find(l => l.layer_id === data.layer_id);
      if (removed && this._isGroupLayer(removed)) {
        this._reparentLayerChildren(data.layer_id, removed.parent_id || '');
      }
      this.layersMeta = this.layersMeta.filter(l => l.layer_id !== data.layer_id);
      this.strokes = this.strokes.filter(s => String(s.layer_id || 'l_default') !== data.layer_id);
      if (this.activeLayerId === data.layer_id || !this.layersMeta.some(l => l.layer_id === this.activeLayerId)) {
        this.activeLayerId = this._topPaintLayerId();
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    };

      proto.handleLayerRenamed = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const layer = this.layersMeta.find(l => l.layer_id === data.layer_id);
      if (layer) layer.name = data.name;
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
    };

      proto.handleLayerReordered = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      if (data.layers) {
        this.layersMeta = data.layers.map(layer => this._normalizeLayerMeta(Object.assign({}, layer)));
      }
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
    };

      proto.handleLayerUpdated = function(data) {
      if (data.board_id && data.board_id !== this.activeBoardId) return;
      const patch = {};
      if ('visible' in data) patch.visible = data.visible;
      if ('opacity' in data) patch.opacity = data.opacity;
      if ('locked' in data) patch.locked = data.locked;
      if (!this._applyLayerPatch(data.layer_id, patch)) return;
      this._syncLayerUi();
    };

      proto.handleBoardAdded = function(data) {
      this.boardsMeta.push({
        board_id: data.board_id,
        title: data.title,
        canvas: data.canvas
      });
      this.boardOrder.push(data.board_id);
      if (data.created_by === this.selfId && !this.isHost()) {
        this._boardCreateCooldownUntil = Date.now() + (global.BOARD_CREATE_COOLDOWN_MS || 60000);
        if (this.boardPanel) this.boardPanel.notifyBoardCreated(false);
      }
      this._syncBoardPanel();
    };

      proto.handleBoardRemoved = function(data) {
      this.boardsMeta = this.boardsMeta.filter(b => b.board_id !== data.board_id);
      this.boardOrder = this.boardOrder.filter(id => id !== data.board_id);
      if (this.activeBoardId === data.board_id) {
        this.activeBoardId = 'b_default';
        this.session.send({ type: 'board_switch', board_id: this.activeBoardId });
      }
      this._syncBoardPanel();
    };

      proto.handleBoardRenamed = function(data) {
      const board = this.boardsMeta.find(b => b.board_id === data.board_id);
      if (board) board.title = data.title;
      this._syncBoardPanel();
    };

    }
  };

  global.CollabMessageHandlers = CollabMessageHandlers;
})(typeof window !== 'undefined' ? window : globalThis);
