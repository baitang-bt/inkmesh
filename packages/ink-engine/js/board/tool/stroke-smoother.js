(function (global) {
  'use strict';

  const STORAGE_ENABLED = 'collabCanvas.debounceEnabled';
  const STORAGE_LEVEL = 'collabCanvas.debounceLevel';
  const MAX_LEVEL = 5;
  const DEFAULT_LEVEL = 2;
  /** 每级惰性半径（归一化坐标）；对齐 lazy-brush：笔尖与指针保持半径距离。 */
  const RADIUS_PER_LEVEL = 0.004;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * 笔画稳定：惰性半径跟随（参考 https://github.com/dulnan/lazy-brush）。
   * 只平滑 x/y，不平均、不丢弃 pressure；抬笔时 flushTo 收到真实终点。
   *
   * 动态防抖（预留）：setBoost(true) 时有效级数临时提到 MAX_LEVEL。
   */
  class StrokeSmoother {
    constructor(options) {
      const settings = options || {};
      this._enabled = localStorage.getItem(STORAGE_ENABLED) !== '0';
      const storedLevel = Number(localStorage.getItem(STORAGE_LEVEL));
      this._level = localStorage.getItem(STORAGE_LEVEL) != null && Number.isFinite(storedLevel)
        ? clamp(Math.round(storedLevel), 1, MAX_LEVEL)
        : DEFAULT_LEVEL;
      this._boost = false;
      this._hasTip = false;
      this._tipX = 0;
      this._tipY = 0;
      this.onChange = settings.onChange || (() => {});
      this.onBoostChange = settings.onBoostChange || (() => {});
    }

    get enabled() {
      return this._enabled;
    }

    /** 开关防抖（持久化）。 */
    setEnabled(on) {
      const next = Boolean(on);
      const changed = next !== this._enabled;
      this._enabled = next;
      if (changed) {
        try {
          localStorage.setItem(STORAGE_ENABLED, next ? '1' : '0');
        } catch (_err) {}
        this.onChange(this);
      }
    }

    get level() {
      return this._level;
    }

    /** 设置防抖级数 1..MAX_LEVEL（持久化）。 */
    setLevel(level) {
      const next = clamp(Math.round(Number(level) || 0), 1, MAX_LEVEL);
      const changed = next !== this._level;
      this._level = next;
      if (changed) {
        try {
          localStorage.setItem(STORAGE_LEVEL, String(next));
        } catch (_err) {}
        this.onChange(this);
      }
    }

    /** 动态防抖是否开启（最高级数）。 */
    get boost() {
      return this._boost;
    }

    /** 开启动态防抖（不持久化，配合按键按住 / 开关 UI 使用）。 */
    setBoost(on) {
      const next = Boolean(on);
      if (next === this._boost) return;
      this._boost = next;
      this.onBoostChange(this);
    }

    /** 当前有效级数：0 = 关闭；1..MAX_LEVEL；动态防抖时为 MAX_LEVEL。 */
    effectiveLevel() {
      if (this._boost) return MAX_LEVEL;
      return this._enabled ? this._level : 0;
    }

    /** 当前惰性半径（归一化）。 */
    radius() {
      return this.effectiveLevel() * RADIUS_PER_LEVEL;
    }

    /** 供测试画板 / 设置 UI 显示的状态文案。 */
    statusLabel() {
      const level = this.effectiveLevel();
      if (level <= 0) return '关闭';
      return this._boost ? '最高（动态）' : level + ' 级';
    }

    /** 清空笔尖，开始一笔时调用。 */
    reset() {
      this._hasTip = false;
      this._tipX = 0;
      this._tipY = 0;
    }

    /**
     * 输入原始点，返回平滑后的笔尖 {x, y, pressure}。
     * 指针在半径内时笔尖不动，返回 null（跳过重复位置）；pressure 原样透传。
     */
    push(x, y, pressure) {
      const level = this.effectiveLevel();
      const p = Number.isFinite(pressure) ? pressure : null;
      if (level <= 0) return { x, y, pressure: p };

      if (!this._hasTip) {
        this._hasTip = true;
        this._tipX = x;
        this._tipY = y;
        return { x, y, pressure: p };
      }

      const dx = x - this._tipX;
      const dy = y - this._tipY;
      const dist = Math.hypot(dx, dy);
      const radius = this.radius();
      if (dist <= radius || dist < 1e-12) return null;

      const move = dist - radius;
      this._tipX += (dx / dist) * move;
      this._tipY += (dy / dist) * move;
      return { x: this._tipX, y: this._tipY, pressure: p };
    }

    /**
     * 抬笔时把笔尖收到真实坐标（消除惰性滞后），并返回该点。
     */
    flushTo(x, y, pressure) {
      const p = Number.isFinite(pressure) ? pressure : null;
      this._hasTip = true;
      this._tipX = x;
      this._tipY = y;
      return { x, y, pressure: p };
    }
  }

  StrokeSmoother.MAX_LEVEL = MAX_LEVEL;
  global.StrokeSmoother = StrokeSmoother;
})(window);
