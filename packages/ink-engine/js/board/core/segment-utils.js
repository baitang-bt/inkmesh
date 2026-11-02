(function (global) {
  'use strict';

  /**
   * Segment 线格式纯函数：WS/P2P 消息 → DrawingBoard 可绘制 segment。
   * 与服务端 normalize_segment 字段应对齐。
   */
  const SegmentUtils = {
    /** 从联机消息构造本地 segment（透传笔刷扩展字段）。 */
    fromMessage(data) {
      const tool = data.tool || 'brush';
      if (tool === 'background') return { tool, color: data.color };
      if (tool === 'fill') return { tool, color: data.color, x: data.x, y: data.y };
      if (tool === 'gradient') {
        return {
          tool,
          x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2,
          color: data.color, color2: data.color2
        };
      }
      if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
        const segment = {
          x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2,
          color: data.color, size: data.size, tool
        };
        if (tool === 'rect' || tool === 'ellipse') segment.filled = !!data.filled;
        return segment;
      }
      const segment = {
        x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2,
        color: data.color, size: data.size, tool
      };
      if (Array.isArray(data.points) && data.points.length) segment.points = data.points;
      if (data.strokePart) segment.strokePart = data.strokePart;
      if (data.simulatePressure != null) segment.simulatePressure = Boolean(data.simulatePressure);
      ['thinning', 'smoothing', 'streamline', 'opacity', 'flow', 'spacing', 'randomJitter'].forEach(key => {
        if (data[key] != null) segment[key] = data[key];
      });
      return segment;
    },

    /** 浅比较两个 segment 是否同内容（用于去重/测试）。 */
    equals(a, b) {
      if (a === b) return true;
      if (!a || !b) return false;
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        const va = a[key];
        const vb = b[key];
        if (Array.isArray(va) || Array.isArray(vb)) {
          if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
        } else if (va !== vb) {
          return false;
        }
      }
      return true;
    }
  };

  global.SegmentUtils = SegmentUtils;
})(typeof window !== 'undefined' ? window : globalThis);
