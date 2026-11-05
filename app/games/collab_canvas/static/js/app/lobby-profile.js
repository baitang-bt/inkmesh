(function (global) {
  'use strict';

  const CHANNELS = {
    rgb: [
      { key: 'r', label: 'R', max: 255 },
      { key: 'g', label: 'G', max: 255 },
      { key: 'b', label: 'B', max: 255 }
    ],
    hsv: [
      { key: 'h', label: 'H', max: 360 },
      { key: 's', label: 'S', max: 100 },
      { key: 'v', label: 'V', max: 100 }
    ]
  };

  /** 把 hsl()/hex 收成 #rrggbb。 */
  function cssColorToHex(color) {
    const raw = String(color || '');
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext('2d');
    if (!ctx) return '#3b82f6';
    ctx.fillStyle = '#000000';
    ctx.fillStyle = raw;
    const next = ctx.fillStyle;
    return /^#[0-9a-f]{6}$/i.test(next) ? next.toLowerCase() : '#3b82f6';
  }

  /** 把通道值夹到该模式的合法范围。 */
  function clampChannel(value, max) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return 0;
    return Math.min(max, Math.max(0, n));
  }

  /**
   * 大厅右栏个人资料：昵称与色块头像。
   * 读写与画板设置同一个 OnlinePrefs，改一边另一边跟着变。
   */
  class LobbyProfile {
    constructor(options) {
      const settings = options || {};
      this.onlinePrefs = settings.onlinePrefs || null;
      this.defaultNickname = settings.defaultNickname || settings.passportNickname || '';
      this.playerId = String(settings.playerId || 'self');
      this.avatarBtn = document.getElementById('lobbyProfileAvatar');
      this.initialEl = document.getElementById('lobbyProfileInitial');
      this.nameInput = document.getElementById('lobbyProfileName');
      this.nameHint = document.getElementById('lobbyProfileNameHint');
      this.colorMode = 'rgb';
      this.popover = null;
      this._rows = [];
      this._applying = false;
      this._nameHintTimer = null;
    }

    /** 绑定改名，以及点色块打开 RGB/HSV 取色。 */
    bind() {
      if (this.avatarBtn) {
        this.avatarBtn.addEventListener('click', event => {
          event.stopPropagation();
          this._togglePicker();
        });
      }
      if (this.nameInput) {
        this.nameInput.addEventListener('input', () => {
          this._applyNameInput(false);
          this._paintAvatar(this.nameInput.value);
        });
        this.nameInput.addEventListener('change', () => this._commitName());
        this.nameInput.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.nameInput.blur();
          }
        });
      }
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') this._closePicker();
      });
      document.addEventListener('pointerdown', event => {
        if (!this.popover || this.popover.classList.contains('hidden')) return;
        if (this.popover.contains(event.target) || event.target === this.avatarBtn) return;
        this._closePicker();
      });
      this.refresh();
    }

    /** 按当前偏好重画昵称和色块；正在输入时不改输入框内容。 */
    refresh() {
      if (!this.onlinePrefs) return;
      const name = this.onlinePrefs.resolveDisplayName(this.defaultNickname);
      if (this.nameInput && document.activeElement !== this.nameInput) {
        this.nameInput.value = name;
      }
      this._paintAvatar(this.nameInput ? this.nameInput.value : name);
    }

    /**
     * 校验并清洗昵称输入；有问题时写入提示。
     * @param {boolean} trimEnds 是否按提交规则去掉首尾空白
     */
    _applyNameInput(trimEnds) {
      if (!this.nameInput) return '';
      const report = global.inspectDisplayName
        ? inspectDisplayName(this.nameInput.value, { trim: !!trimEnds })
        : {
          ok: true,
          value: this.nameInput.value.slice(0, 12),
          reasons: []
        };
      if (report.value !== this.nameInput.value) {
        this.nameInput.value = report.value;
      }
      this._setNameHint(report);
      return report.value;
    }

    /** 显示或清除昵称校验提示。 */
    _setNameHint(report) {
      if (!this.nameHint) return;
      if (this._nameHintTimer) {
        clearTimeout(this._nameHintTimer);
        this._nameHintTimer = null;
      }
      const message = global.formatDisplayNameIssues
        ? formatDisplayNameIssues(report)
        : ((report && report.reasons) || []).join('；');
      if (!message) {
        this.nameHint.textContent = '';
        this.nameHint.classList.remove('is-error');
        return;
      }
      this.nameHint.textContent = message;
      this.nameHint.classList.add('is-error');
      this._nameHintTimer = setTimeout(() => {
        this._nameHintTimer = null;
        if (this.nameHint) {
          this.nameHint.textContent = '';
          this.nameHint.classList.remove('is-error');
        }
      }, 5000);
    }

    /** 把输入写回偏好；空则回退启动昵称。 */
    _commitName() {
      if (!this.onlinePrefs || !this.nameInput) return;
      const next = this._applyNameInput(true);
      const current = this.onlinePrefs.resolveDisplayName(this.defaultNickname);
      if (next === current) {
        this.refresh();
        return;
      }
      this.onlinePrefs.setCustomDisplayName(next);
      this.refresh();
    }

    /** 色块用画板昵称色；字用对比色，显示昵称首字。 */
    _paintAvatar(name) {
      const color = this._labelColor();
      const ink = typeof global.contrastText === 'function' ? global.contrastText(color) : '#ffffff';
      if (this.avatarBtn) {
        this.avatarBtn.style.background = color;
        this.avatarBtn.style.color = ink;
      }
      if (this.initialEl) {
        const text = String(name || '').trim();
        this.initialEl.textContent = text ? text.slice(0, 1) : '玩';
      }
    }

    /** 已设昵称色优先，否则与光标同一套默认色。 */
    _labelColor() {
      if (!this.onlinePrefs) return '#3b82f6';
      return this.onlinePrefs.resolveLabelColor(this.playerId, this.onlinePrefs.getLabelColor());
    }

    /** 打开或关上取色面板。 */
    _togglePicker() {
      if (this.popover && !this.popover.classList.contains('hidden')) {
        this._closePicker();
        return;
      }
      this._openPicker();
    }

    /** 在色块旁弹出 RGB/HSV 三通道取色。 */
    _openPicker() {
      this._ensurePopover();
      this._fillFromHex(cssColorToHex(this._labelColor()));
      this.popover.classList.remove('hidden');
      const rect = this.avatarBtn.getBoundingClientRect();
      const width = 236;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 8;
      const top = below + 420 > window.innerHeight ? Math.max(8, rect.top - 420) : below;
      this.popover.style.left = left + 'px';
      this.popover.style.top = top + 'px';
    }

    /** 关掉取色面板。 */
    _closePicker() {
      if (this.popover) this.popover.classList.add('hidden');
    }

    /** 建一次取色面板：方形饱和度区、模式切换和三行滑条。 */
    _ensurePopover() {
      if (this.popover) return;
      const pop = document.createElement('div');
      pop.className = 'lobby-color-pop hidden';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', '昵称颜色');
      const square = document.createElement('div');
      square.className = 'lobby-color-square';
      pop.appendChild(square);
      const modes = document.createElement('div');
      modes.className = 'lobby-color-modes';
      ['rgb', 'hsv'].forEach(mode => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lobby-color-mode' + (mode === this.colorMode ? ' is-active' : '');
        btn.textContent = mode.toUpperCase();
        btn.addEventListener('click', () => this._setMode(mode));
        modes.appendChild(btn);
      });
      const rows = document.createElement('div');
      pop.appendChild(modes);
      pop.appendChild(rows);
      document.body.appendChild(pop);
      this.popover = pop;
      this._rowsHost = rows;
      this._renderRows();
      const hex = cssColorToHex(this._labelColor());
      this._square = new global.ColorPickerSurface(square, {
        mode: 'hsv',
        color: hex,
        onChange: next => this._onSquareChange(next)
      });
    }

    /** 方形取色区变动时，同步三通道并写入昵称色。 */
    _onSquareChange(hex) {
      if (this._applying) return;
      this._fillFromHex(hex);
      if (this.onlinePrefs) this.onlinePrefs.setLabelColor(hex);
    }

    /** 切换 RGB / HSV，并按当前颜色重填三通道。 */
    _setMode(mode) {
      if (!CHANNELS[mode] || mode === this.colorMode) return;
      const hex = this._hexFromRows();
      this.colorMode = mode;
      this.popover.querySelectorAll('.lobby-color-mode').forEach(btn => {
        btn.classList.toggle('is-active', btn.textContent === mode.toUpperCase());
      });
      this._renderRows();
      this._fillFromHex(hex);
    }

    /** 按当前模式画出三行：名称、滑条、数字。 */
    _renderRows() {
      this._rowsHost.innerHTML = '';
      this._rows = CHANNELS[this.colorMode].map(channel => {
        const row = document.createElement('label');
        row.className = 'lobby-color-row';
        const name = document.createElement('span');
        name.textContent = channel.label;
        const range = document.createElement('input');
        range.type = 'range';
        range.min = '0';
        range.max = String(channel.max);
        range.value = '0';
        const number = document.createElement('input');
        number.type = 'number';
        number.min = '0';
        number.max = String(channel.max);
        number.value = '0';
        const write = source => {
          const value = clampChannel(source.value, channel.max);
          range.value = String(value);
          number.value = String(value);
          this._commitChannels();
        };
        range.addEventListener('input', () => write(range));
        number.addEventListener('input', () => {
          if (number.value === '' || number.value === '-') return;
          write(number);
        });
        row.appendChild(name);
        row.appendChild(range);
        row.appendChild(number);
        this._rowsHost.appendChild(row);
        return { range, number, max: channel.max };
      });
    }

    /** 用当前颜色填三通道，不回写偏好。 */
    _fillFromHex(hex) {
      const { r, g, b } = global.ColorMath.hexToRgb(hex);
      let values;
      if (this.colorMode === 'hsv') {
        const hsv = global.ColorMath.rgbToHsv(r, g, b);
        values = [Math.round(hsv.h), Math.round(hsv.s), Math.round(hsv.v)];
      } else {
        values = [r, g, b];
      }
      this._applying = true;
      this._rows.forEach((row, i) => {
        const value = clampChannel(values[i], row.max);
        row.range.value = String(value);
        row.number.value = String(value);
      });
      this._applying = false;
      const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : '';
      if (this._square && normalized && this._square.getColor() !== normalized) {
        this._applying = true;
        this._square.setColor(normalized);
        this._applying = false;
      }
    }

    /** 读三通道并写成 hex。 */
    _hexFromRows() {
      const values = this._rows.map(row => clampChannel(row.range.value, row.max));
      if (this.colorMode === 'hsv') {
        return global.ColorMath.hsvToRgb(values[0], values[1], values[2]);
      }
      return global.ColorMath.rgbToHex(values[0], values[1], values[2]);
    }

    /** 把滑条上的颜色写入方形区和与画板共用的昵称色。 */
    _commitChannels() {
      if (this._applying || !this.onlinePrefs) return;
      const hex = this._hexFromRows();
      this._applying = true;
      if (this._square) this._square.setColor(hex);
      this._applying = false;
      this.onlinePrefs.setLabelColor(hex);
    }
  }

  global.LobbyProfile = LobbyProfile;
})(window);
