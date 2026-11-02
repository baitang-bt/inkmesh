(function (global) {
  'use strict';

  /**
   * 图层合成与整板重绘：安装到 DrawingBoard.prototype。
   * 已完成笔画烘焙进每层位图缓存；未完成笔画每帧 drawStroke 叠在缓存之上。
   */
  const DrawingLayerCompositor = {
    /** 安装合成/重绘方法。 */
    install(DrawingBoardClass, helpers) {
      const proto = DrawingBoardClass.prototype;
      helpers = helpers || {};
      const cloneStrokes = helpers.cloneStrokes;
      const isHexColor = helpers.isHexColor;
      const clamp = helpers.clamp;

      /** 初始化图层缓存表。 */
      proto._ensureLayerCacheState = function() {
        if (!this._layerCaches) this._layerCaches = new Map();
      };

      /** 取或创建指定图层的离屏缓存（不含图层 opacity）。 */
      proto._getLayerCache = function(layerId) {
        this._ensureLayerCacheState();
        this.ensureBufferSize();
        const id = String(layerId || 'l_default');
        let entry = this._layerCaches.get(id);
        if (
          !entry
          || entry.canvas.width !== this.logicalWidth
          || entry.canvas.height !== this.logicalHeight
        ) {
          const canvas = document.createElement('canvas');
          canvas.width = this.logicalWidth;
          canvas.height = this.logicalHeight;
          entry = { canvas, ctx: canvas.getContext('2d') };
          this._layerCaches.set(id, entry);
        }
        return entry;
      };

      /** 清空单层缓存像素。 */
      proto._clearLayerCache = function(layerId) {
        const entry = this._getLayerCache(layerId);
        entry.ctx.setTransform(1, 0, 0, 1, 0, 0);
        entry.ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
        return entry;
      };

      /** 丢掉全部图层缓存（分辨率变更 / 强制重建）。 */
      proto.invalidateLayerCaches = function() {
        this._ensureLayerCacheState();
        this._layerCaches.clear();
      };

      /** 笔画是否应留在活动层（未收尾）。 */
      proto._isLiveStroke = function(stroke) {
        if (!stroke || stroke.active === false) return false;
        const StrokePath = global.StrokePath;
        if (!StrokePath) return false;
        const style = StrokePath.styleSegment(stroke);
        if (!style || !StrokePath.isPathTool(style.tool)) return false;
        return !StrokePath.isStrokeFinished(stroke);
      };

      /** 把已完成笔画画进对应图层缓存。 */
      proto.bakeStroke = function(stroke) {
        if (!stroke || stroke.active === false) return false;
        const StrokePath = global.StrokePath;
        const style = StrokePath ? StrokePath.styleSegment(stroke) : (stroke.segments || [])[0];
        if (!style) return false;
        if ((style.tool || 'brush') === 'background') return false;
        const layerId = String(stroke.layer_id || 'l_default');
        const entry = this._getLayerCache(layerId);
        if (StrokePath && StrokePath.isPathTool(style.tool) && typeof this.drawStroke === 'function') {
          this.drawStroke(stroke, entry.ctx);
        } else {
          const prev = this.context;
          this.context = entry.ctx;
          (stroke.segments || []).forEach(segment => {
            if ((segment.tool || 'brush') === 'background') return;
            this.drawSegment(segment);
          });
          this.context = prev;
        }
        return true;
      };

      /**
       * 从矢量重筑全部图层缓存（撤销/清空/进房/改层结构）。
       * 跳过未完成笔画，由 present 叠绘。
       */
      proto.rebuildLayerCaches = function(strokes, layersMeta) {
        if (layersMeta) this.layersMeta = (layersMeta || []).slice();
        if (strokes) this.strokes = cloneStrokes(strokes);
        this.invalidateLayerCaches();
        this.ensureBufferSize();
        const list = this.strokes || [];
        list.forEach(stroke => {
          if (stroke.active === false) return;
          if (this._isLiveStroke(stroke)) return;
          this.bakeStroke(stroke);
        });
      };

      /**
       * 合成到主画布：背景 + 各层缓存×opacity + 未完成笔画 + 可选额外活动笔。
       * options.skipLiveStrokeIds: 已由 extraActive 覆盖的 id，避免画两次。
       */
      proto.present = function(options) {
        const settings = options || {};
        const extraActive = settings.extraActiveStroke || null;
        const skipIds = settings.skipLiveStrokeIds || null;
        this.ensureBufferSize();
        this.applySmoothing();
        this._ensureLayerCacheState();

        const main = this.context;
        const buf = this._bufferCtx;
        buf.setTransform(1, 0, 0, 1, 0, 0);
        const useLayers = this.layersMeta && this.layersMeta.length;
        if (useLayers) {
          buf.fillStyle = this.defaultBackground;
          buf.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
          this.backgroundColor = this.defaultBackground;
          this.canvas.style.backgroundColor = this.defaultBackground;
        } else {
          this._clearDrawBufferInto(buf, false);
        }

        const sorted = useLayers
          ? this.layersMeta.slice().sort((a, b) => (a.order || 0) - (b.order || 0))
          : [{ layer_id: 'l_default', kind: 'paint', visible: true, opacity: 255, order: 0 }];
        const layerById = new Map(sorted.map(layer => [String(layer.layer_id || 'l_default'), layer]));
        const isVisible = layer => {
          if (!layer || layer.visible === false) return false;
          let parentId = layer.parent_id || '';
          while (parentId) {
            const parent = layerById.get(String(parentId));
            if (!parent || parent.visible === false) return false;
            parentId = parent.parent_id || '';
          }
          return true;
        };

        sorted.forEach(layer => {
          if (layer.kind === 'group') return;
          if (!isVisible(layer)) return;
          const opacity = clamp(Number(layer.opacity != null ? layer.opacity : 255), 0, 255) / 255;
          if (opacity <= 0) return;
          const layerId = String(layer.layer_id || 'l_default');
          const entry = this._getLayerCache(layerId);
          buf.save();
          buf.globalAlpha = opacity;
          buf.globalCompositeOperation = 'source-over';
          buf.drawImage(entry.canvas, 0, 0);
          buf.restore();
        });

        const live = (this.strokes || []).filter(stroke => {
          if (!this._isLiveStroke(stroke)) return false;
          if (skipIds && skipIds.has(String(stroke.stroke_id))) return false;
          if (extraActive && stroke.stroke_id === extraActive.stroke_id
            && stroke.owner_id === extraActive.owner_id) return false;
          return true;
        });
        live.forEach(stroke => {
          if (typeof this.drawStroke === 'function') this.drawStroke(stroke, buf);
          else {
            const prev = this.context;
            this.context = buf;
            (stroke.segments || []).forEach(segment => this.drawSegment(segment));
            this.context = prev;
          }
        });

        if (extraActive && extraActive.active !== false) {
          if (typeof this.drawStroke === 'function') this.drawStroke(extraActive, buf);
        }

        main.setTransform(1, 0, 0, 1, 0, 0);
        main.save();
        main.globalCompositeOperation = 'copy';
        main.drawImage(this._buffer, 0, 0);
        main.restore();
      };

      /** 把清屏逻辑画进指定 ctx（扁平模式仍扫描 background 段）。 */
      proto._clearDrawBufferInto = function(ctx, useLayerMode) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (useLayerMode) {
          ctx.fillStyle = this.defaultBackground;
          ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
          this.backgroundColor = this.defaultBackground;
          this.canvas.style.backgroundColor = this.defaultBackground;
          return;
        }
        let fillColor = this.defaultBackground;
        this.strokes.forEach(stroke => {
          if (stroke.active === false) return;
          (stroke.segments || []).forEach(segment => {
            if ((segment.tool || 'brush') === 'background' && isHexColor(segment.color)) {
              fillColor = segment.color.toLowerCase();
            }
          });
        });
        ctx.fillStyle = fillColor;
        ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
        this.backgroundColor = fillColor;
        this.canvas.style.backgroundColor = fillColor;
      };

      proto.ensureBufferSize = function() {
        if (this._buffer.width !== this.logicalWidth || this._buffer.height !== this.logicalHeight) {
          this._buffer.width = this.logicalWidth;
          this._buffer.height = this.logicalHeight;
          this.invalidateLayerCaches();
        }
      };

      /**
       * 全量重绘：重建图层缓存并 present。
       * 笔画很多时仍 O(全部已完成笔画)，但抬笔增量走 bakeStroke + present。
       */
      proto.redraw = function(strokes, layersMeta) {
        if (layersMeta) this.layersMeta = (layersMeta || []).slice();
        if (strokes) this.strokes = cloneStrokes(strokes);
        this.rebuildLayerCaches(this.strokes, this.layersMeta);
        this.present();
      };

      proto._clearDrawBuffer = function(useLayerMode) {
        this._clearDrawBufferInto(this.context, useLayerMode);
      };

      /** 兼容旧调用：按层矢量重放（无缓存时的退化路径）。 */
      proto.redrawLayers = function(layersMeta, strokes) {
        this.redraw(strokes, layersMeta);
      };

      proto._redrawFlat = function(strokes) {
        if (strokes) this.strokes = cloneStrokes(strokes);
        this.rebuildLayerCaches(this.strokes, this.layersMeta);
        this.present();
      };

      /** 返回图层缓存 canvas，供缩略图复用。 */
      proto.getLayerCacheCanvas = function(layerId) {
        this._ensureLayerCacheState();
        const entry = this._layerCaches.get(String(layerId || 'l_default'));
        return entry ? entry.canvas : null;
      };
    }
  };

  global.DrawingLayerCompositor = DrawingLayerCompositor;
})(typeof window !== 'undefined' ? window : globalThis);
