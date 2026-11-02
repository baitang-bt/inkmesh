(function (global) {
  'use strict';

  const BRUSH_MIN = 1;
  const BRUSH_MAX = 128;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 笔刷粗细：保留两位小数并限制在合法区间。 */
  const roundBrushSize = value => {
    const n = Math.round(Number(value) * 100) / 100;
    if (!Number.isFinite(n)) return 8;
    return clamp(n, BRUSH_MIN, BRUSH_MAX);
  };

  /** 数字框展示：整数不带小数，否则最多两位。 */
  const formatBrushSizeDisplay = value => {
    const n = roundBrushSize(value);
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  };
  const PALETTE = [
    '#111827', '#ef4444', '#f97316', '#eab308', '#22c55e',
    '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff'
  ];
  const BRUSH_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);

  /** 画板绘制生命周期：本地优先 + 联机同步。 */
  class CollabBoardController {
    constructor(options) {
      const settings = options || {};
      this.canvas = settings.canvas;
      this.stage = settings.stage;
      this.viewport = settings.viewport;
      this.session = settings.session;
      this.cursorOverlay = settings.cursorOverlay;
      this.boardPanel = settings.boardPanel;
      this.layerPanel = settings.layerPanel;
      this.toolRail = settings.toolRail;
      this.colorPicker = settings.colorPicker;
      this.colorPair = settings.colorPair || null;
      this.popupPalette = settings.popupPalette || null;
      this.recentColors = settings.recentColors || null;
      this.penInput = settings.penInput;
      this.strokeSmoother = settings.strokeSmoother || null;
      this.onlinePrefs = settings.onlinePrefs || null;
      this.onRoomChange = settings.onRoomChange || (() => {});

      this.drawingBoard = new DrawingBoard(this.canvas, { width: 1920, height: 1080 });
      this.adapter = new CollabBoardAdapter({
        send: payload => this.session.send(payload),
        getBoardId: () => this.activeBoardId,
        getLayerId: () => this.drawLayerId(),
        getRoomId: () => (this.session && this.session.roomId) || '',
        getDisplayName: () => (
          this.session && this.session.getDisplayName
            ? this.session.getDisplayName()
            : ''
        ),
        requestBoardSync: (boardId, timeoutMs) => this.session.requestBoardSync(boardId, timeoutMs),
        sendRoomImport: document => this.session.sendRoomImport(document)
      });

      this.selfId = settings.selfId || '';
      this.strokes = [];
      this.layersMeta = [];
      this.activeBoardId = 'b_default';
      this.activeLayerId = 'l_default';
      this.boardsMeta = [];
      this.boardOrder = [];
      this.ownerId = '';
      this.canDraw = true;
      this.canSave = true;
      this.isDrawing = false;
      this.activeStrokeId = '';
      this.activeStrokeTool = null;
      this.lastPoint = null;
      this.activeDrawPointerId = null;
      this.currentTool = 'brush';
      this.currentColor = this.colorPair ? this.colorPair.foreground : '#111827';
      this.currentSize = 8;
      this.brushPreset = typeof BrushPreset !== 'undefined' ? new BrushPreset() : null;
      if (this.brushPreset) this.brushPreset.setSize(this.currentSize);
      this.wandTolerance = 20;
      this.exportRegistry = new CollabExportRegistry();
      this._exportBusy = false;
      this._roomActions = settings.roomActions || {};
      this._spaceToolPrev = null;
      this._handPanning = false;
      this._handLast = null;
      this._boardCreateCooldownUntil = 0;
      this._pendingSelectionCopy = null;
      this._pendingLayerCreateId = '';
      this._pbccAutoSaveTimer = null;
      this._pbccSaveBusy = false;
      this._pbccRestorePending = false;
      this._pbccRestoreBoardCount = 0;

      this.toolController = new ToolController();
      this.toolController.attachBoard(this);
      this.canvasOverlay = new CanvasOverlay(null, this.drawingBoard);
      if (this.stage) {
        const surface = this.stage.querySelector('.canvas-stage-surface') || document.getElementById('canvasStageSurface');
        if (surface) this.canvasOverlay.attachToSurface(surface);
      }
      this.selectionManager = new SelectionManager(this, this.canvasOverlay);
      this.selectionActionsBar = new SelectionActionsBar(this, this.selectionManager);
      this._lastPointerClientX = null;
      this._lastPointerClientY = null;
      if (this.viewport) {
        this.viewport.onTransformChange = () => {
          if (this.selectionActionsBar) this.selectionActionsBar.sync();
          if (this.brushPreview && this._lastPointerClientX != null && this._lastPointerClientY != null) {
            this.brushPreview.update(this._lastPointerClientX, this._lastPointerClientY);
          }
        };
      }
      if (typeof registerCollabTools === 'function') {
        registerCollabTools(this.toolController, this);
      }

      const cursorLayer = document.getElementById('cursorLayer');
      this.brushPreview = new BrushPreview(this.stage || cursorLayer, {
        getStage: () => this.stage,
        getViewportScale: () => (this.viewport ? this.viewport.scale : 1),
        getCanvas: () => this.canvas,
        getLogicalWidth: () => this.drawingBoard.logicalWidth,
        getBrushSize: () => this.currentSize,
        getTool: () => this.currentTool,
        isVisible: () => !this.isDrawing || BRUSH_TOOLS.has(this.currentTool)
      });
      this.brushSizeDockPreview = new BrushSizeDockPreview(
        document.getElementById('brushSizePreview'),
        {
          getBrushSize: () => this.currentSize,
          getTool: () => this.currentTool
        }
      );

      const stageSurface = this.stage && (
        this.stage.querySelector('.canvas-stage-surface') || document.getElementById('canvasStageSurface')
      );
      this.canvasWatermark = stageSurface ? new CanvasWatermark(stageSurface, {
        getText: () => {
          const room = this.session && this.session.roomId ? this.session.roomId : '';
          return (room ? room + ' · ' : '') + '预览 · 禁止保存';
        }
      }) : null;

      this._bindPointer();
      this._bindToolbar();
      this._bindVisibility();
      this._bindStageResize();
      this._bindToolKeys();
    }

    /** 舞台尺寸变化时重新 fit，保证视口灰色 letterbox 正确。 */
    _bindStageResize() {
      this._refitCanvas = () => {
        if (this.stage) this.drawingBoard.fitToStage(this.stage);
        this._updateBrushSizeDockPreview();
        if (this.selectionActionsBar) this.selectionActionsBar.sync();
      };
      window.addEventListener('resize', this._refitCanvas);
      if (this.stage && typeof ResizeObserver !== 'undefined') {
        this._stageResizeObserver = new ResizeObserver(() => this._refitCanvas());
        this._stageResizeObserver.observe(this.stage);
      }
    }

    setSelfId(id) {
      this.selfId = String(id || '');
      if (this.cursorOverlay) this.cursorOverlay.setSelfId(this.selfId);
    }

    _redraw() {
      this.drawingBoard.redraw(this.strokes, this.layersMeta);
      if (this.layerPanel && this.layerPanel.refreshThumbnails) {
        this.layerPanel.refreshThumbnails();
      }
    }

    _activeLayerLocked() {
      return this._isLayerLocked(this.drawLayerId());
    }

    /** 指定图层或其任意父组是否锁定。 */
    _isLayerLocked(layerId) {
      return LayerModel.isLayerLocked(this.layersMeta, layerId);
    }

    /** 合并图层 visible/opacity/locked 补丁到 layersMeta。 */
    _applyLayerPatch(layerId, patch) {
      const layer = this.layersMeta.find(l => l.layer_id === layerId);
      if (!layer || !patch) return false;
      if ('visible' in patch) layer.visible = Boolean(patch.visible);
      if ('opacity' in patch) layer.opacity = Number(patch.opacity);
      if ('locked' in patch) layer.locked = Boolean(patch.locked);
      return true;
    }

    /** 图层元数据变更后刷新列表与画布。 */
    _syncLayerUi() {
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
      this._redraw();
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
    }

    /** 设置房间级动作回调（复制链接、离开、打开设置）。 */
    setRoomActions(handlers) {
      this._roomActions = handlers || {};
    }

    /** 快捷键 / 按钮统一动作入口（表驱动见 BoardActions）。 */
    executeAction(actionId) {
      BoardActions.run(actionId, this);
    }

    _setTool(toolId) {
      const resolved = ToolRegistry.resolveTool(toolId, this.toolRail ? this.toolRail.variantStore : null);
      const prev = this.currentTool;
      this.currentTool = resolved;
      if (this.brushPreset && typeof STROKE_TOOLS !== 'undefined' && STROKE_TOOLS.has(resolved)) {
        this.brushPreset.setTool(resolved);
      }
      if (this.toolRail) this.toolRail.setTool(resolved, { silent: true });
      if (this.stage) {
        this.stage.dataset.tool = resolved;
        this._applyToolCursor(resolved);
      }
      if (this.brushPreview && !BRUSH_TOOLS.has(resolved)) this.brushPreview.hide();
      this._updateBrushSizeDockPreview();
      if (this.selectionManager && (String(resolved).startsWith('select') || resolved === 'magicWand')) {
        this.selectionManager.setMode(resolved);
      } else if (this.selectionManager && prev !== resolved && resolved !== 'move') {
        this.selectionManager.clear();
      }
      if (this.selectionActionsBar) this.selectionActionsBar.sync();
    }

    /** 返回当前工具应对应的 CSS 光标。 */
    _toolCursor(toolId) {
      const id = String(toolId || '');
      const map = {
        hand: 'grab',
        move: 'move',
        eyedropper: 'crosshair',
        fillBucket: 'cell',
        fillGradient: 'crosshair',
        zoom: 'zoom-in',
        line: 'crosshair',
        brush: 'none',
        eraser: 'none',
        glow: 'none',
        spray: 'none'
      };
      if (map[id]) return map[id];
      if (id.startsWith('select') || id === 'magicWand') return 'crosshair';
      if (id.startsWith('rect') || id.startsWith('ellipse')) return 'crosshair';
      return 'default';
    }

    /** 按当前工具设置舞台与画布光标。 */
    _applyToolCursor(toolId) {
      const cursor = this._toolCursor(toolId);
      if (this.stage) this.stage.style.cursor = cursor === 'none' ? '' : cursor;
      if (this.canvas) this.canvas.style.cursor = cursor;
    }

    /** Space 按住临时抓手；Delete 清除选区。 */
    _bindToolKeys() {
      document.addEventListener('keydown', event => {
        if (event.target && event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
        if (event.code === 'Space' && !event.repeat && this._spaceToolPrev == null) {
          event.preventDefault();
          this._spaceToolPrev = this.currentTool;
          this._setTool('hand');
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          if (this.selectionManager && this.selectionManager.isActive()) {
            event.preventDefault();
            this.selectionManager.deleteSelection();
          }
        }
        if (event.key === 'Escape') {
          if (this.selectionManager) this.selectionManager.clear();
          if (this.canvasOverlay) this.canvasOverlay.clear();
        }
      });
      document.addEventListener('keyup', event => {
        if (event.code === 'Space' && this._spaceToolPrev != null) {
          event.preventDefault();
          const prev = this._spaceToolPrev;
          this._spaceToolPrev = null;
          this._setTool(prev);
        }
      });
    }

    /** 标记当前笔划末段以启用 perfect-freehand 收尾锥形。 */
    _finalizeActiveStroke() {
      if (!this.activeStrokeId || !this.ownerId) return;
      const stroke = DrawingBoard.findStroke(this.strokes, this.ownerId, this.activeStrokeId);
      if (!stroke || !stroke.segments.length) return;
      const last = stroke.segments[stroke.segments.length - 1];
      if (last.strokePart === 'start') last.strokePart = 'single';
      else last.strokePart = 'end';
    }

    _adjustBrushSize(delta) {
      this._setBrushSize(this.currentSize + delta);
    }

    /** 同步滑块、数字框与 currentSize。 */
    _setBrushSize(value) {
      this.currentSize = roundBrushSize(value);
      if (this.brushPreset) this.brushPreset.setSize(this.currentSize);
      const sizeSlider = document.getElementById('brushSize');
      const sizeNumber = document.getElementById('brushSizeNumber');
      if (sizeSlider) sizeSlider.value = String(this.currentSize);
      if (sizeNumber) sizeNumber.value = formatBrushSizeDisplay(this.currentSize);
      this._updateBrushSizeDockPreview();
    }

    /** 刷新右栏粗细滑块旁的空心圆预览。 */
    _updateBrushSizeDockPreview() {
      if (this.brushSizeDockPreview) this.brushSizeDockPreview.update();
    }

    _zoomAtCenter(zoomIn) {
      if (!this.viewport || !this.stage) return;
      const rect = this.stage.getBoundingClientRect();
      this.viewport.zoomStepAt(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        zoomIn
      );
    }

    _moveActiveLayer(delta) {
      const order = this.layersMeta
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(l => l.layer_id);
      const idx = order.indexOf(this.activeLayerId);
      if (idx < 0) return;
      const next = idx + delta;
      if (next < 0 || next >= order.length) return;
      order.splice(idx, 1);
      order.splice(next, 0, this.activeLayerId);
      this.reorderLayers(order);
    }

    _stepBoard(delta) {
      const order = this.boardOrder.length
        ? this.boardOrder.slice()
        : this.boardsMeta.map(b => b.board_id);
      const idx = order.indexOf(this.activeBoardId);
      if (idx < 0) return;
      const next = idx + delta;
      if (next < 0 || next >= order.length) return;
      this.switchBoard(order[next]);
    }

    isHost() {
      return Boolean(this.selfId && this.ownerId && this.selfId === this.ownerId);
    }

    /** 房客新建画板冷却剩余毫秒（房主无冷却）。 */
    boardCreateCooldownRemaining() {
      if (this.isHost()) return 0;
      return Math.max(0, this._boardCreateCooldownUntil - Date.now());
    }

    /** 同步画板面板列表与联机上下文。 */
    _syncBoardPanel() {
      if (!this.boardPanel) return;
      this.boardPanel.setRoomContext({
        isOwner: () => this.isHost(),
        getCreateCooldownMs: () => this.boardCreateCooldownRemaining()
      });
      this.boardPanel.setBoards(this.boardsMeta, this.boardOrder, this.activeBoardId);
    }







    /** 是否为图层组。 */
    _isGroupLayer(layer) {
      return LayerModel.isGroupLayer(layer);
    }

    /** 规范化图层元数据（kind / parent_id）。 */
    _normalizeLayerMeta(layer) {
      return LayerModel.normalize(layer);
    }

    /** 将 parent_id 指向不存在图层的项提升到根。 */
    _repairOrphanLayers(layers) {
      return LayerModel.repairOrphans(layers);
    }

    /** 保证至少有一层可绘制「图层 1」。 */
    _coerceLayers(layers) {
      return LayerModel.coerce(layers);
    }

    /** 将被删组/层的子图层挂到新 parent（空串为根）。 */
    _reparentLayerChildren(removedLayerId, newParentId) {
      LayerModel.reparentChildren(this.layersMeta, removedLayerId, newParentId);
    }

    /** 返回 order 最高的绘画图层 id。 */
    _topPaintLayerId() {
      return LayerModel.topPaintLayerId(this.layersMeta);
    }

    /** 新建图层时默认 parent。 */
    _resolveNewLayerParentId() {
      return LayerModel.resolveNewLayerParentId(this.layersMeta, this.activeLayerId);
    }

    /** 当前可绘制目标图层。 */
    drawLayerId() {
      return LayerModel.drawLayerId(this.layersMeta, this.activeLayerId);
    }

    /** 在状态栏提示图层相关错误。 */
    _layerUiMessage(message) {
      if (this._roomActions.setStatus) this._roomActions.setStatus(message);
    }

    /** 移除乐观占位图层。 */
    _clearPendingLayerCreate() {
      if (!this._pendingLayerCreateId) return;
      this.layersMeta = this.layersMeta.filter(l => l.layer_id !== this._pendingLayerCreateId);
      if (this.activeLayerId === this._pendingLayerCreateId) {
        this.activeLayerId = this._topPaintLayerId();
      }
      this._pendingLayerCreateId = '';
      if (this.layerPanel) this.layerPanel.setLayers(this.layersMeta, this.activeLayerId);
    }


    applyServerSnapshot(serverStrokes, preserveActiveStroke) {
      const shouldPreserve = Boolean(
        this.activeStrokeId && (preserveActiveStroke || this.isDrawing)
      );
      this.strokes = this.drawingBoard.mergeServerSnapshot(
        serverStrokes,
        this.strokes,
        {
          preserveOwnerId: this.selfId,
          preserveStrokeId: shouldPreserve ? this.activeStrokeId : ''
        }
      );
      if (!this.isDrawing) this._redraw();
    }










    _segmentFromMessage(data) {
      return SegmentUtils.fromMessage(data);
    }

    _appendRemoteSegment(ownerId, strokeId, segment, layerId) {
      this.drawingBoard.appendSegment(this.strokes, ownerId, strokeId, segment, layerId);
      if (!this.isDrawing) this._redraw();
      else this.drawingBoard.drawSegment(segment);
    }

    _appendLocalSegment(strokeId, segment) {
      if (!this.canDraw && segment.tool !== 'localRaster') return;
      if (segment.tool !== 'localRaster' && this._activeLayerLocked()) return;
      this.drawingBoard.appendSegment(this.strokes, this.selfId, strokeId, segment, this.drawLayerId());
      this.drawingBoard.drawSegment(segment);
      if (segment.tool !== 'localRaster') {
        this.adapter.sendSegment(strokeId, segment);
      }
    }


    _bindToolbar() {
      if (this.toolRail) {
        this.toolRail.onChange = toolId => this._setTool(toolId);
      }
      if (this.colorPicker) {
        this.colorPicker.onChange = color => { this.currentColor = color; };
        this.currentColor = this.colorPicker.getColor();
      }
      const sizeSlider = document.getElementById('brushSize');
      const sizeNumber = document.getElementById('brushSizeNumber');
      if (sizeSlider) {
        sizeSlider.addEventListener('input', () => this._setBrushSize(sizeSlider.value));
      }
      if (sizeNumber) {
        sizeNumber.addEventListener('input', () => this._setBrushSize(sizeNumber.value));
        sizeNumber.addEventListener('change', () => this._setBrushSize(sizeNumber.value));
      }
      if (sizeSlider || sizeNumber) {
        this._setBrushSize(sizeSlider ? sizeSlider.value : (sizeNumber ? sizeNumber.value : 8));
      }
      if (typeof bindExportMenu === 'function') bindExportMenu(this);
      const undoBtn = document.getElementById('undoBtn');
      const redoBtn = document.getElementById('redoBtn');
      if (undoBtn) undoBtn.addEventListener('click', () => this.executeAction('undo'));
      if (redoBtn) redoBtn.addEventListener('click', () => this.executeAction('redo'));
    }

    _bindVisibility() {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.adapter.requestRepairSync();
        }
      });
    }

    _updateMemberCount(players) {
      const el = document.getElementById('memberCount');
      if (!el || !Array.isArray(players)) return;
      const online = players.filter(p => p.connected).length;
      el.textContent = `${online}/${players.length}`;
    }
  }

  BoardCommands.install(CollabBoardController);
  BoardPointer.install(CollabBoardController);
  CollabMessageHandlers.install(CollabBoardController);
  PbccHostService.install(CollabBoardController);

  global.CollabBoardController = CollabBoardController;
  global.COLLAB_PALETTE = PALETTE;
})(window);
