(function (global) {
  'use strict';

  const STORAGE_PEN = 'collabCanvas.penPressure';
  const STORAGE_SENS = 'collabCanvas.penPressureSensitivity';
  const STORAGE_CURVE = 'collabCanvas.penPressureCurve';
  const STORAGE_SPEED = 'collabCanvas.penSpeedCurve';
  const STORAGE_SPEED_FACTOR = 'collabCanvas.penSpeedFactor';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 压感曲线：把 0–1 压力映射为线宽系数。 */
  const PRESSURE_CURVES = {
    linear: t => t,
    easeOutSine: t => Math.sin(t * Math.PI / 2),
    easeInQuad: t => t * t,
    easeOutQuad: t => t * (2 - t),
    easeInOutQuad: t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
  };

  /** 数位板/触控笔压感、掌拒与笔侧橡皮；支持可配置压感/速度传感器曲线。 */
  class PenInput {
    constructor(options) {
      const settings = options || {};
      this.getBaseSize = settings.getBaseSize || (() => 5);
      this.onActivity = settings.onActivity || (() => {});
      this.activePenPointers = new Set();
      this.penGuardUntil = 0;
      this.lastPenSample = null;
      this.enabled = localStorage.getItem(STORAGE_PEN) !== '0';
      const sens = Number(localStorage.getItem(STORAGE_SENS));
      this.sensitivity = Number.isFinite(sens) ? clamp(sens / 100, 0.25, 2) : 1;
      const curve = localStorage.getItem(STORAGE_CURVE);
      this.pressureCurve = curve && PRESSURE_CURVES[curve] ? curve : 'easeOutSine';
      this.sizeRange = [0.15, 1.0];
      this.useSpeedCurve = localStorage.getItem(STORAGE_SPEED) === '1';
      const speedFactor = Number(localStorage.getItem(STORAGE_SPEED_FACTOR));
      this.speedFactor = Number.isFinite(speedFactor) ? clamp(speedFactor / 100, 0.25, 2) : 1;
    }

    isStylus(event) {
      return Boolean(event && event.pointerType === 'pen');
    }

    /**
     * 触控笔且 pressure 为有效正数时视为真实笔压（供 simulatePressure:false）。
     * 鼠标/触摸或压力无效时返回 false，继续走速度模拟或 perfect-freehand 估压。
     */
    hasRealPressure(event) {
      if (!this.enabled || !this.isStylus(event)) return false;
      const pressure = Number(event && event.pressure);
      return Number.isFinite(pressure) && pressure > 0;
    }

    /**
     * 把原始笔压映射为 0–1，写入 segment.points 供 perfect-freehand 使用。
     */
    mappedPressure(value) {
      return this._mapPressure(value);
    }

    /**
     * 展开 pointermove 的 coalesced 采样（含当前事件）；不支持时退回单点。
     * 避免触控笔被浏览器节流丢点。
     */
    coalescedSamples(event) {
      if (!event) return [];
      let samples = null;
      try {
        if (typeof event.getCoalescedEvents === 'function') {
          samples = event.getCoalescedEvents();
        }
      } catch (_err) {
        samples = null;
      }
      if (samples && samples.length) return samples;
      return [event];
    }

    isPenEraser(event) {
      if (!event) return false;
      return event.button === 5 || (event.buttons & 32) !== 0;
    }

    markPenActivity(event, extendGuard) {
      if (!this.isStylus(event)) return;
      this.activePenPointers.add(event.pointerId);
      if (extendGuard) this.penGuardUntil = performance.now() + 400;
      this.onActivity(true);
    }

    clearPenPointer(event) {
      if (!event) return;
      this.activePenPointers.delete(event.pointerId);
      if (this.activePenPointers.size === 0) {
        this.penGuardUntil = performance.now() + 300;
        this.onActivity(false);
      }
    }

    shouldIgnorePointer(event, activeDrawPointerId) {
      if (!event || event.isPrimary === false) return true;
      if (this.isStylus(event)) return false;
      const stylusBusy = this.activePenPointers.size > 0 || performance.now() < this.penGuardUntil;
      if (event.pointerType === 'touch' && stylusBusy) return true;
      if (event.pointerType === 'mouse' && stylusBusy) return true;
      if (activeDrawPointerId !== null && event.pointerId !== activeDrawPointerId) return true;
      return false;
    }

    /** 把原始压力经幂函数与曲线映射为 0–1 系数。 */
    _mapPressure(value) {
      let pressure = Number(value);
      if (!Number.isFinite(pressure) || pressure <= 0) pressure = 0.28;
      pressure = clamp(pressure, 0.08, 1);
      const powered = Math.pow(pressure, 1 / clamp(this.sensitivity, 0.25, 2));
      const curveFn = PRESSURE_CURVES[this.pressureCurve] || PRESSURE_CURVES.easeOutSine;
      return curveFn(powered);
    }

    /**
     * 由相邻两采样的位移估算 0–1 笔压（快移变细）；无上一采样时返回 null。
     */
    pressureFromSpeed(prevSample, sample) {
      if (!this.useSpeedCurve || !sample) return null;
      if (!prevSample) return 0.85;
      const t0 = Number(prevSample.timeStamp);
      const t1 = Number(sample.timeStamp);
      const dt = Number.isFinite(t0) && Number.isFinite(t1)
        ? Math.max(1, t1 - t0)
        : 16;
      const dist = Math.hypot(
        Number(sample.clientX) - Number(prevSample.clientX),
        Number(sample.clientY) - Number(prevSample.clientY)
      );
      const speed = dist / dt;
      return clamp(1 - speed * 0.015 * this.speedFactor, 0.25, 1);
    }

    /**
     * 为单次采样解析写入点列的 pressure。
     * simulatePressure=true：返回 null，交给 perfect-freehand 估压。
     * simulatePressure=false：真实笔压优先，否则速度曲线，再否则 0.5。
     */
    pressureForSample(sample, prevSample, simulatePressure) {
      if (this.hasRealPressure(sample)) {
        return this.mappedPressure(sample.pressure);
      }
      if (simulatePressure) return null;
      if (this.useSpeedCurve) {
        return this.pressureFromSpeed(prevSample, sample);
      }
      return 0.5;
    }

    /**
     * 笔宽固定为基础尺寸；粗细只由点上 pressure + perfect-freehand thinning 决定。
     */
    sizeForPressure(_pressure, _isStylus, _event, _useRealPressure) {
      return clamp(Math.round(this.getBaseSize()), 1, 128);
    }

    /** 当前基础笔宽（测试画板 / 预览）。 */
    strokeSize(_event) {
      return this.sizeForPressure();
    }

    setEnabled(on) {
      this.enabled = Boolean(on);
      localStorage.setItem(STORAGE_PEN, on ? '1' : '0');
    }

    setSensitivity(percent) {
      this.sensitivity = clamp(Number(percent) / 100, 0.25, 2);
      localStorage.setItem(STORAGE_SENS, String(Math.round(this.sensitivity * 100)));
    }

    /** 切换压感曲线名（localStorage 持久化）。 */
    setPressureCurve(name) {
      if (!PRESSURE_CURVES[name]) return;
      this.pressureCurve = name;
      localStorage.setItem(STORAGE_CURVE, name);
    }

    /** 开关速度曲线并持久化。 */
    setUseSpeedCurve(on) {
      this.useSpeedCurve = Boolean(on);
      localStorage.setItem(STORAGE_SPEED, on ? '1' : '0');
    }

    /** 设置速度曲线强度（25–200 映射到内部 0.25–2）。 */
    setSpeedFactor(percent) {
      this.speedFactor = clamp(Number(percent) / 100, 0.25, 2);
      localStorage.setItem(STORAGE_SPEED_FACTOR, String(Math.round(this.speedFactor * 100)));
    }
  }

  global.PenInput = PenInput;
  global.PenPressureCurves = Object.keys(PRESSURE_CURVES);
})(window);
