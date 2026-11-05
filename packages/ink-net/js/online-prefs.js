(function (global) {
  'use strict';

  const STORAGE_KEY = 'collab-online-label-color-v1';
  const DISPLAY_NAME_KEY = 'collab-online-display-name-v1';
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const MAX_DISPLAY_NAME_LEN = 12;
  /** 常用中英文标点（每个计 1 字）；字母/数字/汉字/空格另计。 */
  const DISPLAY_NAME_PUNCT =
    '。．.？?！!、，,：:；;·…—–-_/~～@#%&+=（）()【】[]「」『』《》<>"\'“”‘’';

  /** 单个字符是否允许出现在显示名中。 */
  function isAllowedDisplayNameChar(ch) {
    if (!ch) return false;
    if (ch === ' ') return true;
    if (DISPLAY_NAME_PUNCT.indexOf(ch) !== -1) return true;
    try {
      return /[\p{L}\p{N}]/u.test(ch);
    } catch (_err) {
      return /[A-Za-z0-9\u4e00-\u9fff]/.test(ch);
    }
  }

  /**
   * 规范化显示名：去掉非法字符，最长 12（含标点）。
   * @param {string} raw
   * @param {{trim?: boolean}} [options] trim 默认 true（提交时）；输入中可传 false
   */
  function sanitizeDisplayName(raw, options) {
    return inspectDisplayName(raw, options).value;
  }

  /**
   * 检查显示名问题并返回清洗结果（用于输入提示）。
   * @param {string} raw
   * @param {{trim?: boolean}} [options]
   * @returns {{ok:boolean,value:string,reasons:string[],illegalChars:string[],tooLong:boolean}}
   */
  function inspectDisplayName(raw, options) {
    const opts = options || {};
    const doTrim = opts.trim !== false;
    let text = String(raw || '');
    if (doTrim) text = text.trim();
    const chars = Array.from(text);
    const illegalChars = [];
    let out = '';
    let tooLong = false;
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i];
      if (!isAllowedDisplayNameChar(ch)) {
        if (illegalChars.indexOf(ch) === -1) illegalChars.push(ch);
        continue;
      }
      if (out.length >= MAX_DISPLAY_NAME_LEN) {
        tooLong = true;
        continue;
      }
      out += ch;
    }
    if (doTrim) out = out.trim();
    const reasons = [];
    if (illegalChars.length) {
      const shown = illegalChars.slice(0, 8).map(ch => {
        if (ch === '\n' || ch === '\r' || ch === '\t') return '空白控制符';
        return '「' + ch + '」';
      });
      const more = illegalChars.length > 8 ? '…' : '';
      reasons.push('含非法字符：' + shown.join('') + more);
    }
    if (tooLong) {
      reasons.push('长度超出 ' + MAX_DISPLAY_NAME_LEN + ' 个字符（每个标点也算 1）');
    }
    return {
      ok: reasons.length === 0,
      value: out,
      reasons,
      illegalChars,
      tooLong
    };
  }

  /** 把检查结果拼成一句提示文案。 */
  function formatDisplayNameIssues(report) {
    if (!report || report.ok || !report.reasons || !report.reasons.length) return '';
    return report.reasons.join('；');
  }

  /** 根据相对亮度返回黑或白文字色。 */
  function contrastText(color) {
    const raw = String(color || '');
    if (HEX_RE.test(raw)) {
      const r = parseInt(raw.slice(1, 3), 16);
      const g = parseInt(raw.slice(3, 5), 16);
      const b = parseInt(raw.slice(5, 7), 16);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return lum > 0.55 ? '#111827' : '#ffffff';
    }
    const hslMatch = raw.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/i);
    if (hslMatch) {
      const lightness = Number(hslMatch[3]) / 100;
      return lightness > 0.55 ? '#111827' : '#ffffff';
    }
    return '#ffffff';
  }

  /** 无自定义色时按玩家 id 生成稳定色相。 */
  function defaultLabelColor(playerId) {
    let hash = 0;
    const text = String(playerId || '');
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return 'hsl(' + (hash % 360) + ' 75% 55%)';
  }

  /** 联机展示偏好：用户名、标签底色（仅合作画板，localStorage 持久化）。 */
  class OnlinePrefs {
    constructor() {
      this._labelColor = '';
      this._customDisplayName = '';
      this._load();
    }

    getCustomDisplayName() {
      return this._customDisplayName;
    }

    setCustomDisplayName(name) {
      const next = sanitizeDisplayName(name);
      if (next === this._customDisplayName) return;
      this._customDisplayName = next;
      this._saveDisplayName();
      this._notify();
    }

    /**
     * 解析当前应上送/展示的用户名。
     * @param {string} [fallbackName] 未设自定义名时的回退（如启动引导昵称）
     */
    resolveDisplayName(fallbackName) {
      const fallback = sanitizeDisplayName(fallbackName);
      return this._customDisplayName || fallback || '玩家';
    }

    getLabelColor() {
      return this._labelColor;
    }

    /** 返回要上送的 hex 标签色；未设置则空字符串。 */
    getWireLabelColor() {
      return HEX_RE.test(this._labelColor) ? this._labelColor.toLowerCase() : '';
    }

    setLabelColor(color) {
      const next = HEX_RE.test(color || '') ? color.toLowerCase() : '';
      this._labelColor = next;
      this._saveLabelColor();
      this._notify();
    }

    resetLabelColor() {
      this.setLabelColor('');
    }

    _notify() {
      if (typeof this.onChange === 'function') this.onChange();
    }

    /** 解析远端或本地的标签底色。 */
    resolveLabelColor(playerId, wireColor) {
      if (HEX_RE.test(wireColor || '')) return wireColor.toLowerCase();
      return defaultLabelColor(playerId);
    }

    _load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw && HEX_RE.test(raw)) this._labelColor = raw.toLowerCase();
      } catch (_err) {}
      try {
        const nameRaw = localStorage.getItem(DISPLAY_NAME_KEY);
        if (nameRaw) {
          this._customDisplayName = sanitizeDisplayName(nameRaw);
          if (this._customDisplayName !== String(nameRaw).trim()) this._saveDisplayName();
        }
      } catch (_err) {}
    }

    _saveLabelColor() {
      try {
        if (this._labelColor) localStorage.setItem(STORAGE_KEY, this._labelColor);
        else localStorage.removeItem(STORAGE_KEY);
      } catch (_err) {}
    }

    _saveDisplayName() {
      try {
        if (this._customDisplayName) localStorage.setItem(DISPLAY_NAME_KEY, this._customDisplayName);
        else localStorage.removeItem(DISPLAY_NAME_KEY);
      } catch (_err) {}
    }
  }

  global.OnlinePrefs = OnlinePrefs;
  global.sanitizeDisplayName = sanitizeDisplayName;
  global.inspectDisplayName = inspectDisplayName;
  global.formatDisplayNameIssues = formatDisplayNameIssues;
  global.DisplayNameLimits = {
    MAX: MAX_DISPLAY_NAME_LEN,
    PUNCT: DISPLAY_NAME_PUNCT
  };
  global.contrastText = contrastText;
  global.defaultLabelColor = defaultLabelColor;
})(window);
