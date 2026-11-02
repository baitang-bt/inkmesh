(function (global) {
  'use strict';

  /**
   * 图层 / 画板联机命令：经 session.send 上送，挂到 CollabBoardController。
   * 本地乐观占位与权限提示仍用控制器已有辅助方法。
   */
  const BoardCommands = {
    /** 安装图层与画板 CRUD 到控制器原型。 */
    install(ControllerClass) {
      const proto = ControllerClass.prototype;

      proto.switchLayer = function(layerId) {
        if (layerId === this.activeLayerId) return;
        this.activeLayerId = layerId;
        this.session.send({ type: 'layer_switch', board_id: this.activeBoardId, layer_id: layerId });
        if (this.layerPanel) this.layerPanel.setActive(layerId);
      };

      /** 新建图层/组：本地先占位，等服务端 layer_added 替换。 */
      proto.createLayer = function(options) {
        const opts = options || {};
        const kind = opts.kind || 'paint';
        let parentId = opts.parentId != null ? opts.parentId : this._resolveNewLayerParentId();
        if (parentId) {
          const parent = this.layersMeta.find(l => l.layer_id === parentId);
          if (!parent || !this._isGroupLayer(parent)) parentId = '';
        }
        const maxOrder = this.layersMeta.reduce((max, layer) => Math.max(max, layer.order || 0), 0);
        const paintCount = this.layersMeta.filter(l => !this._isGroupLayer(l)).length;
        const groupCount = this.layersMeta.filter(l => this._isGroupLayer(l)).length;
        const pendingId = 'l_pending_' + Date.now().toString(36);
        const pendingLayer = this._normalizeLayerMeta({
          layer_id: pendingId,
          name: opts.name || (kind === 'group' ? `组 ${groupCount + 1}` : `图层 ${paintCount + 1}`),
          kind,
          parent_id: parentId || '',
          visible: true,
          opacity: 255,
          locked: false,
          order: maxOrder + 1
        });
        this._clearPendingLayerCreate();
        this._pendingLayerCreateId = pendingId;
        this.layersMeta.push(pendingLayer);
        this.activeLayerId = pendingId;
        this._syncLayerUi();

        const payload = {
          type: 'layer_create',
          board_id: this.activeBoardId,
          kind
        };
        if (parentId) payload.parent_id = parentId;
        if (opts.name) payload.name = opts.name;
        if (!this.session.send(payload)) {
          this._clearPendingLayerCreate();
          this._syncLayerUi();
          this._layerUiMessage('连接未就绪，无法新建图层');
          return false;
        }
        return true;
      };

      /** 新建空图层组。 */
      proto.createLayerGroup = function() {
        return this.createLayer({ kind: 'group' });
      };

      /** 复制图层为副本（含该层 strokes，WS layer_duplicate）。 */
      proto.duplicateLayer = function(layerId) {
        const sourceId = layerId || this.activeLayerId;
        if (!sourceId) return;
        const source = this.layersMeta.find(l => l.layer_id === sourceId);
        if (source && this._isGroupLayer(source)) return;
        this.session.send({
          type: 'layer_duplicate',
          board_id: this.activeBoardId,
          source_layer_id: sourceId
        });
      };

      /** 是否允许删除该画板（房间至少保留一个）。 */
      proto.canDeleteBoard = function(boardId) {
        if (!boardId || this.boardsMeta.length <= 1) return false;
        if (boardId === 'b_default') return false;
        return true;
      };

      /** 是否允许删除该图层（画板至少保留一个）。 */
      proto.canDeleteLayer = function(layerId) {
        if (!layerId) return false;
        return this.layersMeta.length > 1;
      };

      proto.deleteLayer = function(layerId) {
        if (!layerId) return;
        if (!this.canDeleteLayer(layerId)) {
          this._layerUiMessage('至少保留一个图层');
          return;
        }
        this.session.send({ type: 'layer_delete', board_id: this.activeBoardId, layer_id: layerId });
      };

      proto.renameLayer = function(layerId, name) {
        this.session.send({ type: 'layer_rename', board_id: this.activeBoardId, layer_id: layerId, name });
      };

      proto.reorderLayers = function(layerIds) {
        this.session.send({ type: 'layer_reorder', board_id: this.activeBoardId, layer_ids: layerIds });
      };

      proto.updateLayer = function(layerId, patch) {
        if (!this._applyLayerPatch(layerId, patch)) return;
        this._syncLayerUi();
        this.session.send(Object.assign(
          { type: 'layer_update', board_id: this.activeBoardId, layer_id: layerId },
          patch
        ));
      };

      proto.switchBoard = function(boardId) {
        if (boardId === this.activeBoardId) return;
        this.adapter.flushSegments();
        this.activeBoardId = boardId;
        const players = this.getPlayersSnapshot().slice();
        const selfIdx = players.findIndex(p => p.uid === this.selfId);
        if (selfIdx >= 0) {
          players[selfIdx] = Object.assign({}, players[selfIdx], { active_board_id: boardId });
          this.setPlayersSnapshot(players);
        }
        this.strokes = [];
        this.layersMeta = [];
        if (this.layerPanel) this.layerPanel.setLayers([], this.activeLayerId);
        this._redraw();
        this.session.send({ type: 'board_switch', board_id: boardId });
        if (this.boardPanel) this.boardPanel.setActive(boardId);
      };

      proto.createBoard = function() {
        if (this.boardCreateCooldownRemaining() > 0) return;
        this.session.send({ type: 'board_create' });
      };

      proto.renameBoard = function(boardId, title) {
        this.session.send({ type: 'board_rename', board_id: boardId, title });
      };

      proto.deleteBoard = function(boardId) {
        if (!this.canDeleteBoard(boardId)) {
          if (this._roomActions.setStatus) {
            this._roomActions.setStatus(
              this.boardsMeta.length <= 1 ? '至少保留一个画板' : '默认画板不能删除'
            );
          }
          return;
        }
        this.session.send({ type: 'board_delete', board_id: boardId });
      };
    }
  };

  global.BoardCommands = BoardCommands;
})(typeof window !== 'undefined' ? window : globalThis);
