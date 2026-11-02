(function (global) {
  'use strict';

  const SELECT_TOOLS = new Set(['selectRect', 'selectEllipse', 'selectLasso', 'selectPolygon', 'magicWand']);
  const STROKE_DRAW_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);
  const SHAPE_TOOLS = {
    rectOutline: { tool: 'rect', filled: false },
    rectFill: { tool: 'rect', filled: true },
    ellipseOutline: { tool: 'ellipse', filled: false },
    ellipseFill: { tool: 'ellipse', filled: true }
  };

  /** 注册全部工具 handler 到 ToolController。 */
  function registerCollabTools(controller, board) {
    const overlay = board.canvasOverlay;
    const selection = board.selectionManager;

    controller.register('brush', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });
    controller.register('eraser', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });
    controller.register('glow', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });
    controller.register('spray', {
      onPointerDown(ctx) { return brushDown(board, ctx); },
      onPointerMove(ctx) { return brushMove(board, ctx); },
      onPointerUp(ctx) { return brushUp(board, ctx); }
    });

    controller.register('zoom', {
      onPointerDown(ctx) {
        const { event } = ctx;
        event.preventDefault();
        const zoomIn = !(event.altKey || event.shiftKey);
        if (board.viewport) board.viewport.zoomStepAt(event.clientX, event.clientY, zoomIn);
        return true;
      }
    });

    controller.register('hand', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (event.button !== 0) return false;
        board._handPanning = true;
        board._handLast = { x: event.clientX, y: event.clientY };
        if (board.stage) board.stage.classList.add('is-panning');
        if (board.canvas) board.canvas.setPointerCapture(event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (!board._handPanning || !board._handLast) return false;
        const { event } = ctx;
        const dx = event.clientX - board._handLast.x;
        const dy = event.clientY - board._handLast.y;
        board._handLast = { x: event.clientX, y: event.clientY };
        if (board.viewport) board.viewport.panBy(dx, dy);
        return true;
      },
      onPointerUp(ctx) {
        board._handPanning = false;
        board._handLast = null;
        if (board.stage) board.stage.classList.remove('is-panning');
        return true;
      }
    });

    controller.register('eyedropper', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (board._activeLayerLocked()) return false;
        event.preventDefault();
        const pt = board.normalizedPoint(event);
        const color = board.drawingBoard.sampleColor(pt.x, pt.y);
        board.currentColor = color;
        if (board.colorPair) board.colorPair.setColor('fg', color);
        if (board.colorPicker) board.colorPicker.setColor(color);
        if (board.popupPalette && board.popupPalette.isOpen()) board.popupPalette.refresh();
        return true;
      }
    });

    controller.register('fillBucket', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        event.preventDefault();
        const pt = board.normalizedPoint(event);
        const segment = { tool: 'fill', x: pt.x, y: pt.y, color: board.currentColor };
        const strokeId = crypto.randomUUID();
        board._appendLocalSegment(strokeId, segment);
        board.adapter.flushSegments();
        board._redraw();
        return true;
      }
    });

    controller.register('fillGradient', {
      onPointerDown(ctx) {
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        board._gradientStart = board.normalizedPoint(ctx.event);
        board._gradientDragging = true;
        ctx.event.preventDefault();
        if (board.canvas) board.canvas.setPointerCapture(ctx.event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (!board._gradientDragging || !board._gradientStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        if (overlay) {
          overlay.setPreview({
            kind: 'gradient',
            x1: board._gradientStart.x,
            y1: board._gradientStart.y,
            x2: pt.x,
            y2: pt.y,
            color: board.currentColor,
            color2: board.colorPair ? board.colorPair.background : '#ffffff'
          });
        }
        return true;
      },
      onPointerUp(ctx) {
        if (!board._gradientDragging || !board._gradientStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const segment = {
          tool: 'gradient',
          x1: board._gradientStart.x,
          y1: board._gradientStart.y,
          x2: pt.x,
          y2: pt.y,
          color: board.currentColor,
          color2: board.colorPair ? board.colorPair.background : '#ffffff'
        };
        const strokeId = crypto.randomUUID();
        board._appendLocalSegment(strokeId, segment);
        board.adapter.flushSegments();
        board._redraw();
        board._gradientDragging = false;
        board._gradientStart = null;
        if (overlay) overlay.clear();
        return true;
      }
    });

    controller.register('line', makeGeometryHandler(board, overlay, 'line'));

    Object.keys(SHAPE_TOOLS).forEach(variantId => {
      controller.register(variantId, makeGeometryHandler(board, overlay, SHAPE_TOOLS[variantId]));
    });

    SELECT_TOOLS.forEach(toolId => {
      controller.register(toolId, {
        onPointerDown(ctx) {
          if (selection) {
            selection.setMode(toolId);
            return selection.onPointerDown(ctx);
          }
          return false;
        },
        onPointerMove(ctx) {
          return selection ? selection.onPointerMove(ctx) : false;
        },
        onPointerUp(ctx) {
          return selection ? selection.onPointerUp(ctx) : false;
        }
      });
    });

    controller.register('move', {
      onPointerDown(ctx) {
        const { event } = ctx;
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        event.preventDefault();
        const pt = board.normalizedPoint(event);
        if (selection && selection.isActive()) {
          if (selection.onPointerDown(ctx)) {
            if (board.canvas) board.canvas.setPointerCapture(event.pointerId);
            return true;
          }
          return false;
        }
        board._moveDragging = true;
        board._moveStart = pt;
        board._moveLayerBbox = LayerMove.measureLayerBounds(board);
        if (!board._moveLayerBbox) {
          board._moveDragging = false;
          board._moveStart = null;
          return false;
        }
        if (board.canvas) board.canvas.setPointerCapture(event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (selection && selection.state === 'moving') {
          return selection.onPointerMove(ctx);
        }
        if (!board._moveDragging || !board._moveStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const dx = pt.x - board._moveStart.x;
        const dy = pt.y - board._moveStart.y;
        if (overlay) LayerMove.showPreview(overlay, board, board._moveLayerBbox, dx, dy);
        return true;
      },
      onPointerUp(ctx) {
        if (selection && selection.state === 'moving') {
          const handled = selection.onPointerUp(ctx);
          if (overlay) overlay.setPreview(null);
          return handled;
        }
        if (!board._moveDragging || !board._moveStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const dx = pt.x - board._moveStart.x;
        const dy = pt.y - board._moveStart.y;
        LayerMove.commitLayerMove(board, dx, dy);
        board._moveDragging = false;
        board._moveStart = null;
        board._moveLayerBbox = null;
        if (overlay) overlay.clear();
        return true;
      }
    });
  }

  function makeGeometryHandler(board, overlay, spec) {
    const isLine = spec === 'line';
    return {
      onPointerDown(ctx) {
        if (!board.canDraw) return false;
        if (board._activeLayerLocked()) return false;
        if (board.penInput.isStylus(ctx.event)) board.penInput.markPenActivity(ctx.event, true);
        board._geoStart = board.normalizedPoint(ctx.event);
        board._geoStrokeSize = board.penInput.strokeSize(ctx.event);
        board._geoDragging = true;
        ctx.event.preventDefault();
        if (board.canvas) board.canvas.setPointerCapture(ctx.event.pointerId);
        return true;
      },
      onPointerMove(ctx) {
        if (!board._geoDragging || !board._geoStart) return false;
        const pt = board.normalizedPoint(ctx.event);
        const size = board._geoStrokeSize != null ? board._geoStrokeSize : board.currentSize;
        if (!overlay) return true;
        if (isLine) {
          overlay.setPreview({
            kind: 'line',
            x1: board._geoStart.x,
            y1: board._geoStart.y,
            x2: pt.x,
            y2: pt.y,
            color: board.currentColor,
            size
          });
        } else {
          overlay.setPreview({
            kind: spec.tool,
            x1: board._geoStart.x,
            y1: board._geoStart.y,
            x2: pt.x,
            y2: pt.y,
            color: board.currentColor,
            size,
            filled: spec.filled
          });
        }
        return true;
      },
      onPointerUp(ctx) {
        if (!board._geoDragging || !board._geoStart) return false;
        const size = board._geoStrokeSize != null ? board._geoStrokeSize : board.currentSize;
        const pt = board.normalizedPoint(ctx.event);
        let x2 = pt.x;
        let y2 = pt.y;
        if (ctx.event.shiftKey) {
          if (isLine) {
            const snapped = snapLine45(board._geoStart.x, board._geoStart.y, x2, y2);
            x2 = snapped.x;
            y2 = snapped.y;
          } else if (spec.tool === 'rect') {
            const side = Math.max(Math.abs(x2 - board._geoStart.x), Math.abs(y2 - board._geoStart.y));
            x2 = board._geoStart.x + (x2 >= board._geoStart.x ? side : -side);
            y2 = board._geoStart.y + (y2 >= board._geoStart.y ? side : -side);
          } else if (spec.tool === 'ellipse') {
            const side = Math.max(Math.abs(x2 - board._geoStart.x), Math.abs(y2 - board._geoStart.y));
            x2 = board._geoStart.x + (x2 >= board._geoStart.x ? side : -side);
            y2 = board._geoStart.y + (y2 >= board._geoStart.y ? side : -side);
          }
        }
        const segment = isLine ? {
          tool: 'line',
          x1: board._geoStart.x,
          y1: board._geoStart.y,
          x2,
          y2,
          color: board.currentColor,
          size
        } : {
          tool: spec.tool,
          x1: board._geoStart.x,
          y1: board._geoStart.y,
          x2,
          y2,
          color: board.currentColor,
          size,
          filled: spec.filled
        };
        const strokeId = crypto.randomUUID();
        board._appendLocalSegment(strokeId, segment);
        board.adapter.flushSegments();
        board._redraw();
        board._geoDragging = false;
        board._geoStart = null;
        board._geoStrokeSize = null;
        if (board.penInput.isStylus(ctx.event)) board.penInput.clearPenPointer(ctx.event);
        if (overlay) overlay.clear();
        return true;
      }
    };
  }

  function snapLine45(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = Math.atan2(dy, dx);
    const step = Math.PI / 4;
    const snapped = Math.round(angle / step) * step;
    const len = Math.sqrt(dx * dx + dy * dy);
    return { x: x1 + Math.cos(snapped) * len, y: y1 + Math.sin(snapped) * len };
  }

/** 笔刷参数写入 segment；稳定开启时 streamline=0，避免与惰性跟随双重平滑。 */
function presetSegmentFields(board) {
  const preset = board.brushPreset;
  if (!preset) return {};
  const smootherOn = board.strokeSmoother && board.strokeSmoother.effectiveLevel() > 0;
  return {
    thinning: preset.thinning,
    smoothing: preset.smoothing,
    streamline: smootherOn ? 0 : preset.streamline,
    opacity: preset.opacity,
    flow: preset.flow,
    spacing: preset.spacing,
    randomJitter: preset.randomJitter
  };
}

function resolveStrokeTool(board, event) {
  if (board.penInput.isPenEraser(event)) return 'eraser';
  const tool = board.currentTool;
  return STROKE_DRAW_TOOLS.has(tool) ? tool : 'brush';
}

/**
 * 从指针采样取归一化点；pressure 语义见 PenInput.pressureForSample。
 * prevSample 供速度曲线用相邻 coalesced 点。
 */
function sampleDrawPoint(board, sample, prevSample) {
  const pt = board.normalizedPoint(sample);
  const simulate = board._activeSimulatePressure !== false;
  const pressure = board.penInput.pressureForSample(sample, prevSample, simulate);
  if (board.strokeSmoother) {
    return board.strokeSmoother.push(pt.x, pt.y, pressure);
  }
  return { x: pt.x, y: pt.y, pressure };
}

/** 将压力夹到 perfect-freehand 可用的 0–1。 */
function clampPressure(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** 把平滑输出点列写成可上送的 points（含可选 pressure）。 */
function wirePointsFromOuts(outs, simulatePressure) {
  const points = [];
  for (let i = 0; i < outs.length; i += 1) {
    const p = outs[i];
    const item = { x: p.x, y: p.y };
    if (!simulatePressure && p.pressure != null) {
      item.pressure = clampPressure(p.pressure);
    }
    points.push(item);
  }
  return points;
}

/**
 * 发送一段或多段（points>512 时拆分）；只含本批新点。
 */
function emitBrushSegments(board, outs) {
  if (!outs.length) return;
  const StrokePath = global.StrokePath;
  const maxPts = StrokePath ? StrokePath.MAX_POINTS_PER_SEGMENT : 512;
  const simulate = board._activeSimulatePressure !== false;
  const size = board.penInput.sizeForPressure();
  const chunks = StrokePath
    ? StrokePath.chunkPoints(wirePointsFromOuts(outs, simulate), maxPts)
    : [wirePointsFromOuts(outs, simulate)];
  for (let c = 0; c < chunks.length; c += 1) {
    const points = chunks[c];
    const bounds = StrokePath
      ? StrokePath.segmentBounds(points)
      : { x1: points[0].x, y1: points[0].y, x2: points[points.length - 1].x, y2: points[points.length - 1].y };
    const strokePart = board._strokeSegmentIndex === 0 ? 'start' : 'mid';
    board._strokeSegmentIndex += 1;
    const segment = Object.assign({
      x1: bounds.x1,
      y1: bounds.y1,
      x2: bounds.x2,
      y2: bounds.y2,
      color: board.currentColor,
      size,
      tool: board.activeStrokeTool,
      strokePart,
      simulatePressure: simulate,
      points
    }, presetSegmentFields(board));
    board._appendLocalSegment(board.activeStrokeId, segment);
  }
  board.lastPoint = outs[outs.length - 1];
  board._brushHasSegment = true;
}

function brushDown(board, ctx) {
  const { event } = ctx;
  if (!board.canDraw) return false;
  if (board._activeLayerLocked()) return false;
  if (board.penInput.isStylus(event)) board.penInput.markPenActivity(event, true);
  event.preventDefault();
  board.canvas.setPointerCapture(event.pointerId);
  board.activeDrawPointerId = event.pointerId;
  board.isDrawing = true;
  board.activeStrokeId = crypto.randomUUID();
  board.activeStrokeTool = resolveStrokeTool(board, event);
  board._strokeSegmentIndex = 0;
  board._brushHasSegment = false;
  board._lastRawSample = event;
  // 有真实笔压，或开启速度曲线写入点压时，关闭 simulatePressure。
  const hasReal = board.penInput.hasRealPressure(event);
  board._activeSimulatePressure = !(hasReal || board.penInput.useSpeedCurve);
  if (board.strokeSmoother) board.strokeSmoother.reset();
  const out = sampleDrawPoint(board, event, null);
  board.lastPoint = out || board.normalizedPoint(event);
  board._downPoint = { x: board.lastPoint.x, y: board.lastPoint.y, pressure: board.lastPoint.pressure };
  if (board.recentColors) board.recentColors.push(board.currentColor);
  board.stage.classList.add('stylus-ready');
  if (typeof board._presentLiveStroke === 'function') board._presentLiveStroke();
  return true;
}

function brushMove(board, ctx) {
  const { event } = ctx;
  const cursorPt = board.normalizedPoint(event);
  board._sendCursor(board.activeBoardId, cursorPt.x, cursorPt.y, board.isDrawing);
  if (!board.isDrawing || event.pointerId !== board.activeDrawPointerId) return false;
  if (board.penInput.shouldIgnorePointer(event, board.activeDrawPointerId)) return false;
  if (board.penInput.isStylus(event)) board.penInput.markPenActivity(event, true);
  event.preventDefault();
  if (!board.lastPoint) {
    board.lastPoint = cursorPt;
    return true;
  }
  const samples = board.penInput.coalescedSamples(event);
  const outs = [];
  let prevSample = board._lastRawSample || null;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const out = sampleDrawPoint(board, sample, prevSample);
    prevSample = sample;
    if (out) outs.push(out);
  }
  board._lastRawSample = event;
  if (!outs.length) return true;

  // 逐点过滤：只丢掉相对上一已接受点移动不够的采样，避免整批因末点贴近而被丢。
  const minDist = 0.5 / Math.max(board.drawingBoard.logicalWidth, 1);
  const minDist2 = minDist * minDist;
  const accepted = [];
  let prev = board.lastPoint;
  for (let i = 0; i < outs.length; i += 1) {
    const pt = outs[i];
    const dx = pt.x - prev.x;
    const dy = pt.y - prev.y;
    if (dx * dx + dy * dy < minDist2) continue;
    accepted.push(pt);
    prev = pt;
  }
  if (!accepted.length) return true;

  emitBrushSegments(board, accepted);
  return true;
}

function brushUp(board, ctx) {
  const { event } = ctx;
  if (event.pointerId !== board.activeDrawPointerId) return false;
  if (board.penInput.isStylus(event)) board.penInput.clearPenPointer(event);

  const raw = board.normalizedPoint(event);
  const tipPressure = board.penInput.pressureForSample(
    event,
    board._lastRawSample,
    board._activeSimulatePressure !== false
  );
  if (board.strokeSmoother && typeof board.strokeSmoother.flushTo === 'function') {
    const flushed = board.strokeSmoother.flushTo(raw.x, raw.y, tipPressure);
    if (flushed && board.lastPoint) {
      const dx = flushed.x - board.lastPoint.x;
      const dy = flushed.y - board.lastPoint.y;
      if (dx * dx + dy * dy > 1e-12) {
        emitBrushSegments(board, [flushed]);
      }
    } else if (flushed && !board._brushHasSegment) {
      board._downPoint = flushed;
    }
  }

  if (!board._brushHasSegment) {
    const p = board._downPoint || board.lastPoint || raw;
    const simulate = board._activeSimulatePressure !== false;
    const points = [{ x: p.x, y: p.y }];
    if (!simulate && p.pressure != null) points[0].pressure = clampPressure(p.pressure);
    const segment = Object.assign({
      x1: p.x,
      y1: p.y,
      x2: p.x,
      y2: p.y,
      color: board.currentColor,
      size: board.penInput.sizeForPressure(),
      tool: board.activeStrokeTool,
      strokePart: 'single',
      simulatePressure: simulate,
      points
    }, presetSegmentFields(board));
    board._appendLocalSegment(board.activeStrokeId, segment);
    board._brushHasSegment = true;
  }

  board._finalizeActiveStroke();
  const finishedId = board.activeStrokeId;
  board.isDrawing = false;
  board.activeDrawPointerId = null;
  board.lastPoint = null;
  board._downPoint = null;
  board._lastRawSample = null;
  board._strokeSegmentIndex = 0;
  board._activeSimulatePressure = true;
  board._brushHasSegment = false;
  if (board.strokeSmoother) board.strokeSmoother.reset();
  board.stage.classList.remove('stylus-ready');
  board.adapter.flushSegments();
  if (typeof board._commitLiveStroke === 'function') {
    board._commitLiveStroke(finishedId);
  } else {
    board._redraw();
  }
  board.activeStrokeId = '';
  const pt = board.normalizedPoint(event);
  board._sendCursor(board.activeBoardId, pt.x, pt.y, false);
  return true;
}

  global.registerCollabTools = registerCollabTools;
})(window);
