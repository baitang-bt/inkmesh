(function (global) {
  'use strict';

  const STROKE_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);

  const PRESET_DEFAULTS = {
    brush: {
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      // 默认关几何锥形：粗细只跟点压 + thinning，避免强制针尖淡入淡出。
      taperStart: false,
      taperEnd: false,
      opacity: 1,
      flow: 1,
      spacing: 0.25,
      randomJitter: 0
    },
    eraser: {
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      taperStart: false,
      taperEnd: false,
      opacity: 1,
      flow: 1,
      spacing: 0.25,
      randomJitter: 0
    },
    glow: {
      thinning: 0.2,
      smoothing: 0.8,
      streamline: 0.6,
      taperStart: false,
      taperEnd: false,
      opacity: 0.55,
      flow: 0.5,
      spacing: 0.5,
      randomJitter: 0
    },
    spray: {
      thinning: 0.3,
      smoothing: 0.3,
      streamline: 0.3,
      taperStart: false,
      taperEnd: false,
      opacity: 0.75,
      flow: 0.7,
      spacing: 0.25,
      randomJitter: 0.35
    }
  };

  /** 多笔刷预设：集中管理 tool 变体与 perfect-freehand 参数，供联机 segment 渲染复用。 */
  class BrushPreset {
    constructor() {
      this.tool = 'brush';
      this.size = 8;
      this.applyDefaults('brush');
    }

    /** 加载指定 tool 变体的默认参数集。 */
    applyDefaults(tool) {
      const defaults = PRESET_DEFAULTS[tool] || PRESET_DEFAULTS.brush;
      Object.assign(this, defaults);
    }

    /** 切换当前笔刷变体（brush / eraser / glow / spray）。 */
    setTool(tool) {
      if (!STROKE_TOOLS.has(tool)) return;
      this.tool = tool;
      this.applyDefaults(tool);
    }

    /** 同步 UI 滑块线宽到预设。 */
    setSize(size) {
      this.size = Math.max(1, Math.min(128, Number(size) || 8));
    }

    /**
     * 生成 perfect-freehand 选项。
     * 整笔绘制应传 single（首尾圆帽）；几何 taper 仅看预设开关。
     * last 恒为 true，轮廓到达真实端点。
     * opts.simulatePressure / opts.streamline 可覆盖（稳定开启时 streamline 置 0）。
     */
    getStrokeOptions(strokeSizePx, strokePart, opts) {
      const part = strokePart || 'mid';
      const taperStart = Boolean(this.taperStart);
      const taperEnd = Boolean(this.taperEnd);
      const capStart = part === 'start' || part === 'single';
      const capEnd = part === 'end' || part === 'single';
      const simulatePressure = opts && opts.simulatePressure != null
        ? Boolean(opts.simulatePressure)
        : true;
      const streamline = opts && opts.streamline != null
        ? Number(opts.streamline)
        : this.streamline;
      return {
        size: strokeSizePx,
        thinning: this.thinning,
        smoothing: this.smoothing,
        streamline,
        simulatePressure,
        start: { taper: taperStart, cap: capStart },
        end: { taper: taperEnd, cap: capEnd },
        last: true
      };
    }
  }

  global.BrushPreset = BrushPreset;
  global.STROKE_TOOLS = STROKE_TOOLS;
})(window);
