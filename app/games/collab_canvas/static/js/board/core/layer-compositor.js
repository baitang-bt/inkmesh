(function (global) {
  'use strict';

  /**
   * 图层合成与整板重绘：安装到 DrawingBoard.prototype。
   */
  const DrawingLayerCompositor = {
    /** 安装合成/重绘方法。 */
    install(DrawingBoardClass, helpers) {
      const proto = DrawingBoardClass.prototype;
      helpers = helpers || {};
      const cloneStrokes = helpers.cloneStrokes;
      const isHexColor = helpers.isHexColor;
      const clamp = helpers.clamp;
      const unitNumber = helpers.unitNumber;
      const hexToRgb = helpers.hexToRgb;
      const rgbToHex = helpers.rgbToHex;
      proto.ensureBufferSize = function() {
      if (this._buffer.width !== this.logicalWidth || this._buffer.height !== this.logicalHeight) {
        this._buffer.width = this.logicalWidth;
        this._buffer.height = this.logicalHeight;
      }
    };

      proto.redraw = function(strokes, layersMeta) {
      if (layersMeta) this.layersMeta = (layersMeta || []).slice();
      if (strokes) this.strokes = cloneStrokes(strokes);
      if (this.layersMeta && this.layersMeta.length) {
        this.redrawLayers(this.layersMeta, this.strokes);
        return;
      }
      this._redrawFlat(this.strokes);
    };

      proto._clearDrawBuffer = function(useLayerMode) {
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      if (useLayerMode) {
        this.context.fillStyle = this.defaultBackground;
        this.context.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
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
      this.context.fillStyle = fillColor;
      this.context.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
      this.backgroundColor = fillColor;
      this.canvas.style.backgroundColor = fillColor;
    };

      proto.redrawLayers = function(layersMeta, strokes) {
      if (layersMeta) this.layersMeta = (layersMeta || []).slice();
      if (strokes) this.strokes = cloneStrokes(strokes);
      this.ensureBufferSize();
      this.applySmoothing();
      const sorted = this.layersMeta.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
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
      const main = this.context;
      this.context = this._bufferCtx;
      this._clearDrawBuffer(true);
      sorted.forEach(layer => {
        if (layer.kind === 'group') return;
        if (!isVisible(layer)) return;
        const opacity = clamp(Number(layer.opacity != null ? layer.opacity : 255), 0, 255) / 255;
        if (opacity <= 0) return;
        const layerId = String(layer.layer_id || 'l_default');
        this.context.save();
        this.context.globalAlpha = opacity;
        this.strokes.filter(stroke => stroke.active !== false && String(stroke.layer_id || 'l_default') === layerId)
          .forEach(stroke => {
            (stroke.segments || []).forEach(segment => {
              if ((segment.tool || 'brush') === 'background') return;
              this.drawSegment(segment);
            });
          });
        this.context.restore();
      });
      this.context = main;
      main.setTransform(1, 0, 0, 1, 0, 0);
      main.save();
      main.globalCompositeOperation = 'copy';
      main.drawImage(this._buffer, 0, 0);
      main.restore();
    };

      proto._redrawFlat = function(strokes) {
      this.ensureBufferSize();
      this.applySmoothing();
      const main = this.context;
      this.context = this._bufferCtx;
      this._clearDrawBuffer(false);
      this.strokes.filter(stroke => stroke.active !== false).forEach(stroke => stroke.segments.forEach(segment => {
        if ((segment.tool || 'brush') === 'background') return;
        this.drawSegment(segment);
      }));
      this.context = main;
      main.setTransform(1, 0, 0, 1, 0, 0);
      // Present buffer in one copy op — avoid clearRect (causes visible white flash).
      main.save();
      main.globalCompositeOperation = 'copy';
      main.drawImage(this._buffer, 0, 0);
      main.restore();
    };

    }
  };

  global.DrawingLayerCompositor = DrawingLayerCompositor;
})(typeof window !== 'undefined' ? window : globalThis);
