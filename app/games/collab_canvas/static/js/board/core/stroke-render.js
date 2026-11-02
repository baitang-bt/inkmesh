(function (global) {
  'use strict';

  /**
   * 描边/形状/喷笔/形状绘制：安装到 DrawingBoard.prototype。
   */
  const DrawingStrokeRender = {
    /** 安装描边绘制方法。 */
    install(DrawingBoardClass, helpers) {
      const proto = DrawingBoardClass.prototype;
      helpers = helpers || {};
      const unitNumber = helpers.unitNumber;
      const clamp = helpers.clamp;
      const hexToRgb = helpers.hexToRgb;
      const VALID_TOOLS = helpers.VALID_TOOLS;
      const FREEHAND_TOOLS = helpers.FREEHAND_TOOLS;
      const STROKE_VARIANT_TOOLS = helpers.STROKE_VARIANT_TOOLS;
      const isHexColor = helpers.isHexColor;
      proto._strokeSizePx = function(segment) {
      return clamp(Number(segment.size) || 5, 1, 128) * (this.logicalWidth / 640);
    };

      proto._segmentStrokePoints = function(segment) {
      const w = this.logicalWidth;
      const h = this.logicalHeight;
      if (Array.isArray(segment.points) && segment.points.length >= 1) {
        return segment.points.map(point => ({
          x: unitNumber(point.x) * w,
          y: unitNumber(point.y) * h,
          pressure: point.pressure != null ? clamp(Number(point.pressure), 0, 1) : undefined
        }));
      }
      const pMid = 0.5;
      return [
        {
          x: unitNumber(segment.x1) * w,
          y: unitNumber(segment.y1) * h,
          pressure: segment.p1 != null ? clamp(Number(segment.p1), 0, 1) : pMid
        },
        {
          x: unitNumber(segment.x2) * w,
          y: unitNumber(segment.y2) * h,
          pressure: segment.p2 != null ? clamp(Number(segment.p2), 0, 1) : pMid
        }
      ];
    };

      proto._drawLegacyStroke = function(context, x1, y1, x2, y2, lineWidth, strokeStyle, composite) {
      context.save();
      context.globalCompositeOperation = composite;
      context.strokeStyle = strokeStyle;
      context.lineWidth = lineWidth;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
      context.restore();
    };

      proto._drawFreehandStroke = function(context, segment, strokeStyle, composite) {
      const pf = global.PerfectFreehand;
      if (!pf || typeof pf.getStroke !== 'function') {
        const x1 = unitNumber(segment.x1) * this.logicalWidth;
        const y1 = unitNumber(segment.y1) * this.logicalHeight;
        const x2 = unitNumber(segment.x2) * this.logicalWidth;
        const y2 = unitNumber(segment.y2) * this.logicalHeight;
        this._drawLegacyStroke(context, x1, y1, x2, y2, this._strokeSizePx(segment), strokeStyle, composite);
        return;
      }
      const sizePx = this._strokeSizePx(segment);
      const points = this._segmentStrokePoints(segment);
      const preset = segment.brushPreset || null;
      const strokePart = segment.strokePart || 'mid';
      // 缺省 true 兼容旧 segment；显式 false 时用点上真实笔压（联机回放同字段）。
      const simulatePressure = segment.simulatePressure == null
        ? true
        : Boolean(segment.simulatePressure);
      const freehandOpts = { simulatePressure };
      let options;
      if (preset && typeof preset.getStrokeOptions === 'function') {
        options = preset.getStrokeOptions(sizePx, strokePart, freehandOpts);
      } else {
        const taperStart = strokePart === 'start' || strokePart === 'single';
        const taperEnd = strokePart === 'end' || strokePart === 'single';
        const capStart = taperStart;
        const capEnd = taperEnd;
        options = {
          size: sizePx,
          thinning: segment.thinning != null ? Number(segment.thinning) : 0.5,
          smoothing: segment.smoothing != null ? Number(segment.smoothing) : 0.5,
          streamline: segment.streamline != null ? Number(segment.streamline) : 0.5,
          simulatePressure,
          start: { taper: taperStart, cap: capStart },
          end: { taper: taperEnd, cap: capEnd },
          // last 恒为 true：保证轮廓到达真实端点，避免快速长线段间出现断触。
          last: true
        };
      }
      const outline = pf.getStroke(points, options);
      if (!outline.length) return;
      context.save();
      context.globalCompositeOperation = composite;
      context.fillStyle = strokeStyle;
      pf.fillStrokePath(context, outline);
      context.restore();
    };

      proto._drawGlowStroke = function(context, segment, strokeStyle) {
      const x1 = unitNumber(segment.x1) * this.logicalWidth;
      const y1 = unitNumber(segment.y1) * this.logicalHeight;
      const x2 = unitNumber(segment.x2) * this.logicalWidth;
      const y2 = unitNumber(segment.y2) * this.logicalHeight;
      const radius = this._strokeSizePx(segment);
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rgb = hexToRgb(strokeStyle);
      const opacity = segment.opacity != null ? clamp(Number(segment.opacity), 0, 1) : 0.55;
      context.save();
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = opacity;
      const grad = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
      grad.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + opacity + ')');
      grad.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
      context.fillStyle = grad;
      context.beginPath();
      context.arc(cx, cy, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    };

      proto._drawSprayStroke = function(context, segment, strokeStyle) {
      const x1 = unitNumber(segment.x1) * this.logicalWidth;
      const y1 = unitNumber(segment.y1) * this.logicalHeight;
      const x2 = unitNumber(segment.x2) * this.logicalWidth;
      const y2 = unitNumber(segment.y2) * this.logicalHeight;
      const sizePx = this._strokeSizePx(segment);
      const dist = Math.hypot(x2 - x1, y2 - y1);
      const spacing = sizePx * (segment.spacing != null ? Number(segment.spacing) : 0.25);
      const steps = Math.max(1, Math.floor(dist / Math.max(spacing, 1)));
      let seed = Math.floor(
        (unitNumber(segment.x1) * 9973 + unitNumber(segment.y1) * 7919
          + unitNumber(segment.x2) * 6151 + unitNumber(segment.y2) * 5399) * 10000
      ) | 0;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed % 10000) / 10000;
      };
      const jitter = segment.randomJitter != null ? Number(segment.randomJitter) : 0.35;
      const dotR = Math.max(0.5, sizePx * 0.12);
      const opacity = segment.opacity != null ? clamp(Number(segment.opacity), 0, 1) : 0.75;
      context.save();
      context.globalCompositeOperation = 'source-over';
      context.fillStyle = strokeStyle;
      context.globalAlpha = opacity;
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const jx = (rand() - 0.5) * sizePx * jitter;
        const jy = (rand() - 0.5) * sizePx * jitter;
        const px = x1 + (x2 - x1) * t + jx;
        const py = y1 + (y2 - y1) * t + jy;
        context.beginPath();
        context.arc(px, py, dotR, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    };

      proto.drawSegment = function(segment) {
      if (segment && segment.tool === 'localRaster') return this.drawLocalRaster(segment);
      if (!segment || !VALID_TOOLS.has(segment.tool || 'brush')) return false;
      const tool = segment.tool || 'brush';
      if (tool === 'background') { this.setBackground(segment.color); return true; }
      if (tool === 'fill') return this.floodFill(segment).changed;
      if (tool === 'gradient') return this.drawGradient(segment);
      const strokeStyle = isHexColor(segment.color) ? segment.color : '#111827';
      if (this.pixelMode && STROKE_VARIANT_TOOLS.has(tool)) {
        this.stampPixelStroke(
          this.context,
          unitNumber(segment.x1),
          unitNumber(segment.y1),
          unitNumber(segment.x2),
          unitNumber(segment.y2),
          segment.size,
          strokeStyle,
          tool === 'eraser'
        );
        return true;
      }
      const x1 = unitNumber(segment.x1) * this.logicalWidth;
      const y1 = unitNumber(segment.y1) * this.logicalHeight;
      const x2 = unitNumber(segment.x2) * this.logicalWidth;
      const y2 = unitNumber(segment.y2) * this.logicalHeight;
      const lineWidth = this._strokeSizePx(segment);
      const composite = tool === 'eraser' ? 'destination-out' : 'source-over';
      if (FREEHAND_TOOLS.has(tool)) {
        if (segment.legacy === true) {
          this._drawLegacyStroke(this.context, x1, y1, x2, y2, lineWidth, strokeStyle, composite);
        } else {
          this._drawFreehandStroke(this.context, segment, strokeStyle, composite);
        }
        return true;
      }
      if (tool === 'glow') {
        this._drawGlowStroke(this.context, segment, strokeStyle);
        return true;
      }
      if (tool === 'spray') {
        this._drawSprayStroke(this.context, segment, strokeStyle);
        return true;
      }
      const paint = context => {
        context.save();
        context.globalCompositeOperation = composite;
        context.strokeStyle = strokeStyle;
        context.fillStyle = strokeStyle;
        context.lineWidth = lineWidth;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        if (tool === 'line') {
          context.beginPath();
          context.moveTo(x1, y1);
          context.lineTo(x2, y2);
          context.stroke();
        } else if (tool === 'rect') {
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const rw = Math.abs(x2 - x1);
          const rh = Math.abs(y2 - y1);
          if (segment.filled) context.fillRect(left, top, rw, rh);
          else context.strokeRect(left, top, rw, rh);
        } else if (tool === 'ellipse') {
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          const rx = Math.abs(x2 - x1) / 2;
          const ry = Math.abs(y2 - y1) / 2;
          context.beginPath();
          context.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
          if (segment.filled) context.fill();
          else context.stroke();
        }
        context.restore();
      };
      paint(this.context);
      return true;
    };

      proto.drawLocalRaster = function(segment) {
      const x = Math.floor(unitNumber(segment.x) * this.logicalWidth);
      const y = Math.floor(unitNumber(segment.y) * this.logicalHeight);
      const w = Math.max(1, Math.floor(unitNumber(segment.w) * this.logicalWidth));
      const h = Math.max(1, Math.floor(unitNumber(segment.h) * this.logicalHeight));
      const raw = segment.pixels;
      if (!raw || !raw.length) return false;
      const ctx = this.context;
      ctx.save();
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const i = (row * w + col) * 4;
          const alpha = raw[i + 3];
          if (segment.punch && alpha === 0) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = '#000';
            ctx.fillRect(x + col, y + row, 1, 1);
          } else if (alpha > 0) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = 'rgba(' + raw[i] + ',' + raw[i + 1] + ',' + raw[i + 2] + ',' + (alpha / 255) + ')';
            ctx.fillRect(x + col, y + row, 1, 1);
          }
        }
      }
      ctx.restore();
      return true;
    };

      proto.drawGradient = function(segment) {
      const x1 = unitNumber(segment.x1) * this.logicalWidth;
      const y1 = unitNumber(segment.y1) * this.logicalHeight;
      const x2 = unitNumber(segment.x2) * this.logicalWidth;
      const y2 = unitNumber(segment.y2) * this.logicalHeight;
      const left = clamp(Math.min(x1, x2), 0, this.logicalWidth);
      const top = clamp(Math.min(y1, y2), 0, this.logicalHeight);
      const right = clamp(Math.max(x1, x2), 0, this.logicalWidth);
      const bottom = clamp(Math.max(y1, y2), 0, this.logicalHeight);
      const rw = Math.max(1, right - left);
      const rh = Math.max(1, bottom - top);
      const c1 = isHexColor(segment.color) ? segment.color : '#111827';
      const c2 = isHexColor(segment.color2) ? segment.color2 : this.backgroundColor;
      const ctx = this.context;
      ctx.save();
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      ctx.fillRect(left, top, rw, rh);
      ctx.restore();
      return true;
    };

    }
  };

  global.DrawingStrokeRender = DrawingStrokeRender;
})(typeof window !== 'undefined' ? window : globalThis);
