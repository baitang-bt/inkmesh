(function (global) {
  'use strict';

  const BRUSH_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * 画布指针绑定与光标上送（挂到 CollabBoardController）。
   */
  const BoardPointer = {
    /** 安装指针/光标相关方法到控制器原型。 */
    install(ControllerClass) {
      const proto = ControllerClass.prototype;

      /** 构造 cursor_move 附加字段（笔刷大小与标签色）。 */
      proto._cursorExtras = function() {
        const extras = {};
        if (BRUSH_TOOLS.has(this.currentTool) || this.isDrawing) {
          extras.size = this.currentSize;
        }
        if (this.onlinePrefs) extras.label_color = this.onlinePrefs.getWireLabelColor();
        return extras;
      };

      proto._sendCursor = function(boardId, x, y, drawing) {
        this.session.sendCursor(boardId, x, y, drawing, this._cursorExtras());
      };

      proto.normalizedPoint = function(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        return {
          x: clamp(x, 0, 1),
          y: clamp(y, 0, 1)
        };
      };

      proto._bindPointer = function() {
        const down = event => this._onPointerDown(event);
        const move = event => this._onPointerMove(event);
        const up = event => this._onPointerUp(event);
        this.canvas.addEventListener('pointerdown', down);
        this.canvas.addEventListener('pointermove', move);
        this.canvas.addEventListener('pointerup', up);
        this.canvas.addEventListener('pointercancel', up);
        this.canvas.addEventListener('pointerleave', event => {
          if (this.isDrawing && event.pointerId === this.activeDrawPointerId) return;
          if (this.brushPreview) this.brushPreview.hide();
          this._sendCursor(this.activeBoardId, 0, 0, false);
        });
      };

      proto._onPointerDown = function(event) {
        if (this.popupPalette && this.popupPalette.isOpen()) this.popupPalette.close();
        if (event.button === 1 || event.button === 2) return;
        if (event.button !== 0 && !this.penInput.isPenEraser(event)) return;
        if (this.viewport && this.viewport.isPanning()) return;
        if (this.penInput.shouldIgnorePointer(event, this.activeDrawPointerId)) return;
        // 第二根手指落下时，取消进行中的单指笔划，交给多指手势处理画布。
        if (this.viewport && this.viewport.isTouchGestureActive()) {
          this._cancelActiveStroke();
        }
        if (this.toolController && this.toolController.onPointerDown(event)) return;
      };

      proto._onPointerMove = function(event) {
        if (this.viewport && this.viewport.isPanning()) return;
        // 多指手势期间不派发到画笔，避免误画；已有笔划在首指抬起前被取消。
        if (this.viewport && this.viewport.isTouchGestureActive()) {
          if (this.isDrawing) this._cancelActiveStroke();
          return;
        }
        this._lastPointerClientX = event.clientX;
        this._lastPointerClientY = event.clientY;
        const pt = this.normalizedPoint(event);
        if (this.brushPreview) this.brushPreview.update(event.clientX, event.clientY);
        if (BRUSH_TOOLS.has(this.currentTool) || this.isDrawing) {
          this._sendCursor(this.activeBoardId, pt.x, pt.y, this.isDrawing);
        } else if (this.currentTool !== 'zoom' && this.currentTool !== 'hand') {
          this._sendCursor(this.activeBoardId, pt.x, pt.y, false);
        }
        if (this.toolController && this.toolController.onPointerMove(event)) return;
      };

      proto._onPointerUp = function(event) {
        if (this.toolController && this.toolController.onPointerUp(event)) return;
        if (this.viewport && this.viewport.isTouchGestureActive()) return;
      };

      /** 取消进行中的本地笔划并清空相关状态。 */
      proto._cancelActiveStroke = function() {
        this.isDrawing = false;
        this.activeDrawPointerId = null;
        this.activeStrokeId = '';
        this.lastPoint = null;
        this._strokeSegmentIndex = 0;
        this._activeSimulatePressure = true;
        if (this.strokeSmoother) this.strokeSmoother.reset();
        if (this.stage) this.stage.classList.remove('stylus-ready');
        if (this.brushPreview) this.brushPreview.hide();
      };
    }
  };

  global.BoardPointer = BoardPointer;
})(typeof window !== 'undefined' ? window : globalThis);
