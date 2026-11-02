(function (global) {
  'use strict';

  const PATH_TOOLS = new Set(['brush', 'eraser', 'glow', 'spray']);
  const MAX_POINTS_PER_SEGMENT = 512;
  const POINT_EPS = 1e-9;

  /**
   * 笔画点列拼接与分段：纯函数，不碰 Canvas。
   * 同一 stroke_id 的多段 points 拼成一条路径，供整笔 perfect-freehand / 盖章使用。
   */
  const StrokePath = {
    PATH_TOOLS,
    MAX_POINTS_PER_SEGMENT,

    /** 是否为走拼路径渲染的画笔类工具。 */
    isPathTool(tool) {
      return PATH_TOOLS.has(String(tool || 'brush'));
    },

    /**
     * 笔画是否带显式 points 路径（新协议）。
     * 无 points 的旧房间笔画应逐段 drawSegment，不可拼成整笔轮廓。
     */
    hasPointPath(stroke) {
      const segments = stroke && Array.isArray(stroke.segments) ? stroke.segments : [];
      for (let i = 0; i < segments.length; i += 1) {
        const points = segments[i] && segments[i].points;
        if (Array.isArray(points) && points.length) return true;
      }
      return false;
    },

    /** 两点在归一化坐标下是否视为重合。 */
    pointsEqual(a, b) {
      if (!a || !b) return false;
      return Math.abs(Number(a.x) - Number(b.x)) <= POINT_EPS
        && Math.abs(Number(a.y) - Number(b.y)) <= POINT_EPS;
    },

    /**
     * 拼出 stroke 的完整点列；段首与上段末重合则丢弃段首，避免重复点。
     * 无 points 的旧 segment 退化为端点 [x1,y1]→[x2,y2]（单点段只取一点）。
     */
    concatStrokePoints(stroke) {
      const segments = stroke && Array.isArray(stroke.segments) ? stroke.segments : [];
      const out = [];
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const chunk = StrokePath.segmentPoints(segment);
        for (let j = 0; j < chunk.length; j += 1) {
          const point = chunk[j];
          if (out.length && StrokePath.pointsEqual(out[out.length - 1], point)) continue;
          out.push(point);
        }
      }
      return out;
    },

    /** 从单段取出归一化点列（优先 points，否则 x1/y1–x2/y2）。 */
    segmentPoints(segment) {
      if (!segment) return [];
      if (Array.isArray(segment.points) && segment.points.length) {
        return segment.points.map(point => {
          const item = { x: Number(point.x), y: Number(point.y) };
          if (point.pressure != null && Number.isFinite(Number(point.pressure))) {
            item.pressure = Number(point.pressure);
          }
          return item;
        });
      }
      if (segment.x1 == null || segment.y1 == null) return [];
      const a = { x: Number(segment.x1), y: Number(segment.y1) };
      if (segment.p1 != null && Number.isFinite(Number(segment.p1))) a.pressure = Number(segment.p1);
      if (segment.x2 == null || segment.y2 == null) return [a];
      const b = { x: Number(segment.x2), y: Number(segment.y2) };
      if (segment.p2 != null && Number.isFinite(Number(segment.p2))) b.pressure = Number(segment.p2);
      if (StrokePath.pointsEqual(a, b)) return [a];
      return [a, b];
    },

    /** 笔画是否已收尾（末段 strokePart 为 end 或 single）。 */
    isStrokeFinished(stroke) {
      const segments = stroke && Array.isArray(stroke.segments) ? stroke.segments : [];
      if (!segments.length) return false;
      const part = String(segments[segments.length - 1].strokePart || 'mid');
      return part === 'end' || part === 'single';
    },

    /**
     * 整笔锥形：未完成用 start/mid；完成用 single（首尾锥形）。
     * 单段且已是 single 则保持。
     */
    wholeStrokePart(stroke) {
      const segments = stroke && Array.isArray(stroke.segments) ? stroke.segments : [];
      if (!segments.length) return 'single';
      const last = segments[segments.length - 1];
      const part = String(last.strokePart || 'mid');
      if (part === 'single') return 'single';
      if (part === 'end') return 'single';
      if (segments.length === 1 && part === 'start') return 'start';
      if (part === 'start') return 'start';
      return 'mid';
    },

    /** 取笔画样式字段（颜色/尺寸/笔刷参数）——优先首段，缺省用末段补。 */
    styleSegment(stroke) {
      const segments = stroke && Array.isArray(stroke.segments) ? stroke.segments : [];
      return segments[0] || null;
    },

    /** 将点列切成不超过 max 的块，供联机 segment 发送。 */
    chunkPoints(points, max) {
      const limit = Math.max(1, Number(max) || MAX_POINTS_PER_SEGMENT);
      const list = Array.isArray(points) ? points : [];
      if (list.length <= limit) return list.length ? [list] : [];
      const chunks = [];
      for (let i = 0; i < list.length; i += limit) {
        chunks.push(list.slice(i, i + limit));
      }
      return chunks;
    },

    /** 段的包围端点（联机 x1/y1/x2/y2 兜底）。 */
    segmentBounds(points) {
      const list = Array.isArray(points) ? points : [];
      if (!list.length) return null;
      const first = list[0];
      const last = list[list.length - 1];
      return {
        x1: first.x,
        y1: first.y,
        x2: last.x,
        y2: last.y
      };
    }
  };

  global.StrokePath = StrokePath;
})(typeof window !== 'undefined' ? window : globalThis);
