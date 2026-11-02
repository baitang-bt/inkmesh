(function (global) {
  'use strict';

  const CLEAR_DELAY_MS = 500;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 设置内外设 Tab 本地笔压测试画板；笔迹不上传，停笔 0.5 秒后清空。 */
  class PenTestPad {
    constructor(canvas, options) {
      const settings = options || {};
      this.canvas = canvas;
      this.ctx = canvas ? canvas.getContext('2d') : null;
      this.penInput = settings.penInput || null;
      this.strokeSmoother = settings.strokeSmoother || null;
      this.getBaseSize = settings.getBaseSize || (() => 8);
      this.getColor = settings.getColor || (() => '#111827');
      this.pressureEl = settings.pressureEl || null;
      this._active = false;
      this._drawing = false;
      this._pointerId = null;
      this._lastPoint = null;
      this._lastRaw = null;
      this._simulatePressure = true;
      this._clearTimer = null;
      if (this.canvas) this._bind();
    }

    /** Tab 激活时启用监听并重置画布。 */
    activate() {
      this._active = true;
      this._cancelClear();
      this.clear();
      this._updatePressureLabel(null, this.getBaseSize());
    }

    /** Tab 离开或弹窗关闭时停用并清定时器。 */
    deactivate() {
      this._active = false;
      this._drawing = false;
      this._pointerId = null;
      this._lastPoint = null;
      this._lastRaw = null;
      if (this.strokeSmoother) this.strokeSmoother.reset();
      this._cancelClear();
      this.clear();
    }

    /** 供外部（设置变更 / 动态防抖切换）刷新状态标签。 */
    refreshStatus() {
      this._updatePressureLabel(null, this.penInput ? this.penInput.strokeSize(null) : this.getBaseSize());
    }

    /** 立即清空测试画板。 */
    clear() {
      if (!this.ctx || !this.canvas) return;
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.fillStyle = '#ffffff';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.restore();
    }

    _bind() {
      const down = event => this._onPointerDown(event);
      const move = event => this._onPointerMove(event);
      const up = event => this._onPointerUp(event);
      this.canvas.addEventListener('pointerdown', down);
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerup', up);
      this.canvas.addEventListener('pointercancel', up);
      this.canvas.addEventListener('contextmenu', event => {
        event.preventDefault();
      });
      this.canvas.addEventListener('pointerleave', event => {
        if (this._drawing && event.pointerId === this._pointerId) this._onPointerUp(event);
      });
    }

    _onPointerDown(event) {
      if (!this._active || !this.penInput) return;
      if (event.button !== 0) return;
      event.preventDefault();
      this._cancelClear();
      this.canvas.setPointerCapture(event.pointerId);
      this._drawing = true;
      this._pointerId = event.pointerId;
      this._lastRaw = event;
      const hasReal = this.penInput.hasRealPressure(event);
      this._simulatePressure = !(hasReal || this.penInput.useSpeedCurve);
      const point = this._normalizedPoint(event);
      const pressure = this.penInput.pressureForSample(event, null, this._simulatePressure);
      this._lastPoint = point;
      if (this.strokeSmoother) {
        this.strokeSmoother.reset();
        const out = this.strokeSmoother.push(point.x, point.y, pressure);
        if (out) this._lastPoint = out;
      }
      if (this.penInput.isStylus(event)) this.penInput.markPenActivity(event, true);
      this._updatePressureLabel(event, this.penInput.strokeSize(event));
    }

    _onPointerMove(event) {
      if (!this._active || !this._drawing || event.pointerId !== this._pointerId) return;
      event.preventDefault();
      const samples = this.penInput.coalescedSamples(event);
      const size = this.penInput.strokeSize(event);
      let prevRaw = this._lastRaw;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i];
        const point = this._normalizedPoint(sample);
        const pressure = this.penInput.pressureForSample(sample, prevRaw, this._simulatePressure);
        prevRaw = sample;
        let drawPt = { x: point.x, y: point.y, pressure };
        if (this.strokeSmoother) {
          const out = this.strokeSmoother.push(point.x, point.y, pressure);
          if (!out) continue;
          drawPt = out;
        }
        const width = size * (0.35 + 0.65 * (drawPt.pressure != null ? drawPt.pressure : 0.5));
        if (this._lastPoint) this._drawSegment(this._lastPoint, drawPt, width, this.getColor());
        this._lastPoint = drawPt;
      }
      this._lastRaw = event;
      if (this.penInput.isStylus(event)) this.penInput.markPenActivity(event, true);
      this._updatePressureLabel(event, size);
    }

    _onPointerUp(event) {
      if (!this._drawing || event.pointerId !== this._pointerId) return;
      event.preventDefault();
      if (this.strokeSmoother && this._lastPoint) {
        const raw = this._normalizedPoint(event);
        const pressure = this.penInput.pressureForSample(
          event,
          this._lastRaw,
          this._simulatePressure
        );
        const flushed = this.strokeSmoother.flushTo(raw.x, raw.y, pressure);
        const size = this.penInput.strokeSize(event);
        const width = size * (0.35 + 0.65 * (flushed.pressure != null ? flushed.pressure : 0.5));
        this._drawSegment(this._lastPoint, flushed, width, this.getColor());
      }
      this._drawing = false;
      this._pointerId = null;
      this._lastPoint = null;
      this._lastRaw = null;
      if (this.strokeSmoother) this.strokeSmoother.reset();
      if (this.penInput.isStylus(event)) this.penInput.clearPenPointer(event);
      this._scheduleClear();
    }

    _normalizedPoint(event) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
        y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
      };
    }

    _drawSegment(from, to, size, color) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = Math.max(1, size);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(from.x * w, from.y * h);
      this.ctx.lineTo(to.x * w, to.y * h);
      this.ctx.stroke();
    }

    _updatePressureLabel(event, size) {
      if (!this.pressureEl) return;
      const debounceText = this.strokeSmoother
        ? ' · 防抖 ' + this.strokeSmoother.statusLabel()
        : '';
      if (!event || !this.penInput.isStylus(event)) {
        this.pressureEl.textContent = '无笔压输入 · 线宽 ' + size + ' px' + debounceText;
        return;
      }
      let pressure = Number(event.pressure);
      if (!Number.isFinite(pressure) || pressure <= 0) pressure = 0;
      this.pressureEl.textContent =
        '压感 ' + pressure.toFixed(2) + ' · 线宽 ' + size + ' px' + debounceText;
    }

    _scheduleClear() {
      this._cancelClear();
      this._clearTimer = setTimeout(() => {
        this._clearTimer = null;
        if (this._active) this.clear();
      }, CLEAR_DELAY_MS);
    }

    _cancelClear() {
      if (this._clearTimer != null) {
        clearTimeout(this._clearTimer);
        this._clearTimer = null;
      }
    }
  }

  global.PenTestPad = PenTestPad;
})(window);
