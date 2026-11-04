(function (global) {
  'use strict';

  /**
   * 描边/形状/喷笔绘制：安装到 DrawingBoard.prototype。
   * 画笔四件套优先走 drawStroke（整笔拼路径）；旧 segment 仍用 drawSegment。
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

      /** 逻辑线宽：size 相对 640 宽画布标定。 */
      proto._strokeSizePx = function(segment) {
        return clamp(Number(segment.size) || 5, 1, 128) * (this.logicalWidth / 640);
      };

      /** 确保笔画 alpha 缓冲与逻辑分辨率一致。 */
      proto._ensureStrokeBuffer = function() {
        if (!this._strokeBuffer) {
          this._strokeBuffer = document.createElement('canvas');
          this._strokeBufferCtx = this._strokeBuffer.getContext('2d');
        }
        if (
          this._strokeBuffer.width !== this.logicalWidth
          || this._strokeBuffer.height !== this.logicalHeight
        ) {
          this._strokeBuffer.width = this.logicalWidth;
          this._strokeBuffer.height = this.logicalHeight;
        }
        return this._strokeBufferCtx;
      };

      /** 清空笔画缓冲。 */
      proto._clearStrokeBuffer = function() {
        const ctx = this._ensureStrokeBuffer();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
        return ctx;
      };

      /**
       * 把笔画缓冲贴到目标：画笔 source-over×opacity；橡皮 destination-out×opacity。
       */
      proto._blitStrokeBuffer = function(targetCtx, opacity, eraser) {
        const alpha = clamp(opacity != null ? Number(opacity) : 1, 0, 1);
        targetCtx.save();
        targetCtx.globalAlpha = alpha;
        targetCtx.globalCompositeOperation = eraser ? 'destination-out' : 'source-over';
        targetCtx.drawImage(this._strokeBuffer, 0, 0);
        targetCtx.restore();
      };

      /** 单段 → 像素点列（含笔压），供旧版单段 freehand。 */
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

      /** 归一化点列 → 像素点列。 */
      proto._unitPointsToPx = function(points) {
        const w = this.logicalWidth;
        const h = this.logicalHeight;
        return (points || []).map(point => ({
          x: unitNumber(point.x) * w,
          y: unitNumber(point.y) * h,
          pressure: point.pressure != null ? clamp(Number(point.pressure), 0, 1) : undefined
        }));
      };

      /**
       * 解析 perfect-freehand 选项（整笔或单段）。
       * 几何 taper 读 segment / 预设，缺省 false；strokePart 只控制圆帽。
       */
      proto._freehandOptionsFor = function(segment, sizePx, strokePart) {
        const part = strokePart || segment.strokePart || 'mid';
        const simulatePressure = segment.simulatePressure == null
          ? true
          : Boolean(segment.simulatePressure);
        const freehandOpts = { simulatePressure };
        if (segment.streamline != null) freehandOpts.streamline = Number(segment.streamline);
        const preset = segment.brushPreset || null;
        if (preset && typeof preset.getStrokeOptions === 'function') {
          return preset.getStrokeOptions(sizePx, part, freehandOpts);
        }
        const taperStart = Boolean(Number(segment.taperStart));
        const taperEnd = Boolean(Number(segment.taperEnd));
        const capStart = part === 'start' || part === 'single';
        const capEnd = part === 'end' || part === 'single';
        return {
          size: sizePx,
          thinning: segment.thinning != null ? Number(segment.thinning) : 0.5,
          smoothing: segment.smoothing != null ? Number(segment.smoothing) : 0.5,
          streamline: segment.streamline != null ? Number(segment.streamline) : 0.5,
          simulatePressure,
          start: { taper: taperStart, cap: capStart },
          end: { taper: taperEnd, cap: capEnd },
          last: true
        };
      };

      /** 旧版圆角线段。 */
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

      /** 单段 perfect-freehand（旧数据 / 兼容路径）。 */
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
        const options = this._freehandOptionsFor(segment, sizePx, segment.strokePart || 'mid');
        const outline = pf.getStroke(points, options);
        if (!outline.length) return;
        context.save();
        context.globalCompositeOperation = composite;
        context.fillStyle = strokeStyle;
        pf.fillStrokePath(context, outline);
        context.restore();
      };

      /**
       * 稳定伪随机：由 stroke_id 与盖章序号决定，保证联机回放一致。
       */
      proto._strokeSeededRand = function(strokeId, dabIndex) {
        let seed = 2166136261;
        const key = String(strokeId || '') + '#' + String(dabIndex | 0);
        for (let i = 0; i < key.length; i += 1) {
          seed ^= key.charCodeAt(i);
          seed = Math.imul(seed, 16777619);
        }
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed % 10000) / 10000;
      };

      /**
       * 沿折线按 spacing×半径采样盖章点（像素坐标）。
       * onDab(x, y, index) 被调用；返回盖章次数。
       */
      proto._forEachPathDab = function(pxPoints, sizePx, spacingFactor, onDab) {
        const points = pxPoints || [];
        if (!points.length) return 0;
        const spacing = Math.max(0.5, sizePx * (spacingFactor != null ? Number(spacingFactor) : 0.25));
        let dabIndex = 0;
        onDab(points[0].x, points[0].y, dabIndex);
        dabIndex += 1;
        if (points.length === 1) return dabIndex;
        let carry = 0;
        for (let i = 1; i < points.length; i += 1) {
          const x1 = points[i - 1].x;
          const y1 = points[i - 1].y;
          const x2 = points[i].x;
          const y2 = points[i].y;
          const dist = Math.hypot(x2 - x1, y2 - y1);
          if (dist < 1e-6) continue;
          let traveled = spacing - carry;
          while (traveled <= dist) {
            const t = traveled / dist;
            onDab(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, dabIndex);
            dabIndex += 1;
            traveled += spacing;
          }
          carry = dist - (traveled - spacing);
          if (carry < 0) carry = 0;
        }
        return dabIndex;
      };

      /**
       * 整笔发光：沿路径盖径向渐变。
       * 盖章只用 flow 叠色；整笔 opacity 由调用方 blit 时封顶。
       */
      proto._drawGlowStrokePath = function(context, pxPoints, segment, strokeStyle, strokeId) {
        const sizePx = this._strokeSizePx(segment);
        const rgb = hexToRgb(strokeStyle);
        const flow = segment.flow != null ? clamp(Number(segment.flow), 0, 1) : 0.5;
        const spacing = segment.spacing != null ? Number(segment.spacing) : 0.5;
        context.save();
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = flow;
        this._forEachPathDab(pxPoints, sizePx, spacing, (px, py) => {
          const grad = context.createRadialGradient(px, py, 0, px, py, sizePx);
          grad.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',1)');
          grad.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
          context.fillStyle = grad;
          context.beginPath();
          context.arc(px, py, sizePx, 0, Math.PI * 2);
          context.fill();
        });
        context.restore();
      };

      /**
       * 整笔喷笔：沿路径抖动小圆，随机由 stroke_id+序号决定。
       * 盖章只用 flow；整笔 opacity 由调用方 blit 时封顶。
       */
      proto._drawSprayStrokePath = function(context, pxPoints, segment, strokeStyle, strokeId) {
        const sizePx = this._strokeSizePx(segment);
        const spacing = segment.spacing != null ? Number(segment.spacing) : 0.25;
        const jitter = segment.randomJitter != null ? Number(segment.randomJitter) : 0.35;
        const flow = segment.flow != null ? clamp(Number(segment.flow), 0, 1) : 0.7;
        const dotR = Math.max(0.5, sizePx * 0.12);
        context.save();
        context.globalCompositeOperation = 'source-over';
        context.fillStyle = strokeStyle;
        context.globalAlpha = flow;
        this._forEachPathDab(pxPoints, sizePx, spacing, (px, py, dabIndex) => {
          const jx = (this._strokeSeededRand(strokeId, dabIndex * 2) - 0.5) * sizePx * jitter;
          const jy = (this._strokeSeededRand(strokeId, dabIndex * 2 + 1) - 0.5) * sizePx * jitter;
          context.beginPath();
          context.arc(px + jx, py + jy, dotR, 0, Math.PI * 2);
          context.fill();
        });
        context.restore();
      };

      /** 旧版单段发光（弦中点）。 */
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

      /** 旧版单段喷笔（沿弦）。 */
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

      /**
       * 整笔绘制：拼路径一次轮廓或沿路径盖章，经笔画缓冲应用 flow/opacity。
       * targetCtx 缺省为 this.context；返回是否绘制。
       */
      proto.drawStroke = function(stroke, targetCtx) {
        if (!stroke || stroke.active === false) return false;
        const StrokePath = global.StrokePath;
        const segments = stroke.segments || [];
        if (!segments.length) return false;
        const style = StrokePath && StrokePath.styleSegment
          ? StrokePath.styleSegment(stroke)
          : segments[0];
        const tool = style.tool || 'brush';
        if (!STROKE_VARIANT_TOOLS.has(tool)) {
          segments.forEach(segment => this.drawSegment(segment));
          return true;
        }

        const hasPointPath = StrokePath && typeof StrokePath.hasPointPath === 'function'
          ? StrokePath.hasPointPath(stroke)
          : segments.some(segment => Array.isArray(segment.points) && segment.points.length);
        const unitPoints = hasPointPath && StrokePath
          ? StrokePath.concatStrokePoints(stroke)
          : [];
        const legacyOnly = !hasPointPath
          || !unitPoints.length
          || segments.every(segment => segment.legacy === true);
        if (legacyOnly) {
          const prev = this.context;
          if (targetCtx) this.context = targetCtx;
          segments.forEach(segment => this.drawSegment(segment));
          this.context = prev;
          return true;
        }

        const dest = targetCtx || this.context;
        const strokeStyle = isHexColor(style.color) ? style.color : '#111827';
        const pxPoints = this._unitPointsToPx(unitPoints);
        // 整笔每次都画完整点列：预览与抬笔统一用 single（首尾圆帽），
        // 避免 mid 段关 cap、抬笔才补圆头导致外观跳变。
        const strokePart = 'single';
        const opacity = style.opacity != null ? clamp(Number(style.opacity), 0, 1) : 1;
        const flow = style.flow != null ? clamp(Number(style.flow), 0, 1) : 1;
        const strokeId = stroke.stroke_id || '';

        if (this.pixelMode) {
          this.stampPixelStrokePath(
            dest,
            unitPoints,
            style.size,
            strokeStyle,
            tool === 'eraser'
          );
          return true;
        }

        if (tool === 'glow') {
          const buf = this._clearStrokeBuffer();
          this._drawGlowStrokePath(buf, pxPoints, style, strokeStyle, strokeId);
          this._blitStrokeBuffer(dest, opacity, false);
          return true;
        }
        if (tool === 'spray') {
          const buf = this._clearStrokeBuffer();
          this._drawSprayStrokePath(buf, pxPoints, style, strokeStyle, strokeId);
          this._blitStrokeBuffer(dest, opacity, false);
          return true;
        }

        const pf = global.PerfectFreehand;
        const sizePx = this._strokeSizePx(style);
        const buf = this._clearStrokeBuffer();
        if (!pf || typeof pf.getStroke !== 'function') {
          for (let i = 1; i < pxPoints.length; i += 1) {
            this._drawLegacyStroke(
              buf,
              pxPoints[i - 1].x,
              pxPoints[i - 1].y,
              pxPoints[i].x,
              pxPoints[i].y,
              sizePx,
              tool === 'eraser' ? '#000000' : strokeStyle,
              'source-over'
            );
          }
          if (pxPoints.length === 1) {
            buf.save();
            buf.fillStyle = tool === 'eraser' ? '#000000' : strokeStyle;
            buf.beginPath();
            buf.arc(pxPoints[0].x, pxPoints[0].y, sizePx / 2, 0, Math.PI * 2);
            buf.fill();
            buf.restore();
          }
        } else {
          const options = this._freehandOptionsFor(style, sizePx, strokePart);
          const outline = pf.getStroke(pxPoints, options);
          if (outline.length) {
            buf.save();
            buf.globalAlpha = tool === 'eraser' ? 1 : flow;
            buf.globalCompositeOperation = 'source-over';
            buf.fillStyle = tool === 'eraser' ? '#000000' : strokeStyle;
            pf.fillStrokePath(buf, outline);
            buf.restore();
          }
        }
        this._blitStrokeBuffer(dest, tool === 'eraser' ? opacity : opacity, tool === 'eraser');
        return true;
      };

      /** 单段绘制（形状 / 旧笔画 / 非路径工具）。 */
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
