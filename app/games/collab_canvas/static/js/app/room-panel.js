(function (global) {
  'use strict';

  const MAX_PLAYERS_MIN = 2;
  const MAX_PLAYERS_MAX = 30;
  const MAX_PLAYERS_DEFAULT = 8;

  /** Tab 键打开的房间成员面板：在线状态、延迟、房主按人权限控制。 */
  class RoomPanel {
    constructor(options) {
      const settings = options || {};
      this.modal = settings.modal || document.getElementById('roomPanelModal');
      this.listMount = this.modal && this.modal.querySelector('[data-room-player-list]');
      this.backdrop = this.modal && this.modal.querySelector('[data-room-panel-backdrop]');
      this.closeBtn = this.modal && this.modal.querySelector('[data-room-panel-close]');
      this.selfRttEl = this.modal && this.modal.querySelector('[data-room-self-rtt]');
      this.batchBar = this.modal && this.modal.querySelector('[data-room-batch-bar]');
      this.optionsBar = this.modal && this.modal.querySelector('[data-room-options]');
      this.maxPlayersSelect = this.modal && this.modal.querySelector('[data-room-max-players]');
      this.session = settings.session || null;
      this.getSelfId = settings.getSelfId || (() => '');
      this.getOwnerId = settings.getOwnerId || (() => '');
      this.players = [];
      this.maxPlayers = MAX_PLAYERS_DEFAULT;
      this._onKick = settings.onKick || (() => {});
      this._onSetPermissions = settings.onSetPermissions || (() => {});
      this._onSetMaxPlayers = settings.onSetMaxPlayers || (() => {});

      if (this.backdrop) {
        this.backdrop.addEventListener('click', event => {
          if (event.target === this.backdrop) this.close();
        });
      }
      if (this.closeBtn) this.closeBtn.addEventListener('click', () => this.close());
      document.addEventListener('keydown', event => {
        if (!this.isOpen()) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.close();
        }
      }, true);

      this._fillMaxPlayersSelect();
      this._bindBatchActions();
      this._bindMaxPlayers();
    }

    /** 填充人数上限下拉（2–30）。 */
    _fillMaxPlayersSelect() {
      if (!this.maxPlayersSelect) return;
      this.maxPlayersSelect.innerHTML = '';
      for (let n = MAX_PLAYERS_MIN; n <= MAX_PLAYERS_MAX; n += 1) {
        const opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = String(n) + ' 人';
        this.maxPlayersSelect.appendChild(opt);
      }
      this.maxPlayersSelect.value = String(this.maxPlayers);
    }

    /** 房主改人数上限；减员不踢人。 */
    _bindMaxPlayers() {
      if (!this.maxPlayersSelect) return;
      this.maxPlayersSelect.addEventListener('change', () => {
        const next = Number(this.maxPlayersSelect.value);
        if (!Number.isFinite(next)) return;
        this.maxPlayers = Math.max(MAX_PLAYERS_MIN, Math.min(MAX_PLAYERS_MAX, Math.floor(next)));
        this._onSetMaxPlayers(this.maxPlayers);
      });
    }

    /** 房主批量开关：作用于全部房客。 */
    _bindBatchActions() {
      if (!this.modal) return;
      this.modal.querySelectorAll('[data-room-batch]').forEach(btn => {
        btn.addEventListener('click', () => {
          const draw = btn.getAttribute('data-batch-draw');
          const save = btn.getAttribute('data-batch-save');
          const patch = {};
          if (draw != null) patch.can_draw = draw === '1';
          if (save != null) patch.can_save = save === '1';
          this._onSetPermissions(patch);
        });
      });
    }

    isOpen() {
      return this.modal && !this.modal.classList.contains('hidden');
    }

    toggle() {
      if (this.isOpen()) this.close();
      else this.open();
    }

    open() {
      if (!this.modal) return;
      this.modal.classList.remove('hidden');
      this.refresh();
      if (this.session) {
        this.session.ping().finally(() => this.refresh());
      }
    }

    close() {
      if (this.modal) this.modal.classList.add('hidden');
    }

    setPlayers(players) {
      this.players = Array.isArray(players) ? players.slice() : [];
      if (this.isOpen()) this.refresh();
    }

    /** 同步房间人数上限到面板控件。 */
    setMaxPlayers(maxPlayers) {
      const n = Number(maxPlayers);
      if (!Number.isFinite(n)) return;
      this.maxPlayers = Math.max(MAX_PLAYERS_MIN, Math.min(MAX_PLAYERS_MAX, Math.floor(n)));
      if (this.maxPlayersSelect && String(this.maxPlayersSelect.value) !== String(this.maxPlayers)) {
        this.maxPlayersSelect.value = String(this.maxPlayers);
      }
      if (this.isOpen()) this.refresh();
    }

    updatePlayerPermissions(playerId, patch) {
      this.players = this.players.map(p => {
        if (p.uid !== playerId) return p;
        return Object.assign({}, p, patch);
      });
      if (this.isOpen()) this.refresh();
    }

    /** 重绘成员列表、顶部选项与房主批量栏。 */
    refresh() {
      const selfId = this.getSelfId();
      const ownerId = this.getOwnerId();
      const isHost = selfId && ownerId && selfId === ownerId;
      const guestCount = this.players.filter(p => p.uid !== ownerId).length;
      if (this.optionsBar) {
        this.optionsBar.classList.toggle('hidden', !isHost);
      }
      if (this.maxPlayersSelect) {
        this.maxPlayersSelect.disabled = !isHost;
        if (String(this.maxPlayersSelect.value) !== String(this.maxPlayers)) {
          this.maxPlayersSelect.value = String(this.maxPlayers);
        }
      }
      if (this.batchBar) {
        this.batchBar.classList.toggle('hidden', !isHost || guestCount === 0);
      }
      if (this.selfRttEl && this.session) {
        const info = this.session.getConnectionInfo();
        this.selfRttEl.textContent = info.lastRtt != null ? info.lastRtt + ' ms' : '—';
      }
      if (!this.listMount) return;
      this.listMount.innerHTML = '';
      const sorted = this.players.slice().sort((a, b) => {
        if (a.is_host !== b.is_host) return a.is_host ? -1 : 1;
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
      });
      sorted.forEach(player => {
        this.listMount.appendChild(this._renderRow(player, selfId, ownerId, isHost));
      });
    }

    /** 创建可切换的权限按钮（房主对房客）。 */
    _makePermToggle(label, active, onChange) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'room-perm-btn' + (active ? ' is-on' : ' is-off');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        const next = !btn.classList.contains('is-on');
        onChange(next);
      });
      return btn;
    }

    /** 只读权限标签（非房主视角）。 */
    _appendPermBadges(parent, player) {
      const wrap = document.createElement('div');
      wrap.className = 'room-player-perms-readonly';
      const draw = document.createElement('span');
      draw.className = 'room-perm-badge' + (player.can_draw !== false ? ' is-on' : ' is-off');
      draw.textContent = player.can_draw !== false ? '可绘画' : '禁绘画';
      const save = document.createElement('span');
      save.className = 'room-perm-badge' + (player.can_save !== false ? ' is-on' : ' is-off');
      save.textContent = player.can_save !== false ? '可保存' : '禁保存';
      wrap.appendChild(draw);
      wrap.appendChild(save);
      parent.appendChild(wrap);
    }

    _renderRow(player, selfId, ownerId, isHost) {
      const row = document.createElement('article');
      row.className = 'room-player-row';
      const isSelf = player.uid === selfId;
      const isPlayerHost = player.uid === ownerId || player.is_host;

      const top = document.createElement('div');
      top.className = 'room-player-top';

      const identity = document.createElement('div');
      identity.className = 'room-player-identity';
      const name = document.createElement('span');
      name.className = 'room-player-name';
      name.textContent = player.name + (isSelf ? '（你）' : '');
      identity.appendChild(name);
      if (isPlayerHost) {
        const badge = document.createElement('span');
        badge.className = 'room-player-badge';
        badge.textContent = '房主';
        identity.appendChild(badge);
      }
      const status = document.createElement('span');
      status.className = 'room-player-status' + (player.connected ? ' is-online' : ' is-offline');
      status.textContent = player.connected ? '在线' : '暂离';
      identity.appendChild(status);
      top.appendChild(identity);

      const metrics = document.createElement('span');
      metrics.className = 'room-player-metrics';
      if (isSelf && this.session) {
        const info = this.session.getConnectionInfo();
        metrics.textContent = info.lastRtt != null ? info.lastRtt + ' ms' : '—';
      } else {
        metrics.textContent = '—';
      }
      top.appendChild(metrics);
      row.appendChild(top);

      const bottom = document.createElement('div');
      bottom.className = 'room-player-bottom';

      if (isPlayerHost) {
        const note = document.createElement('span');
        note.className = 'room-player-host-note';
        note.textContent = '拥有全部权限';
        bottom.appendChild(note);
      } else if (isHost) {
        const actions = document.createElement('div');
        actions.className = 'room-player-actions';
        actions.appendChild(this._makePermToggle(
          '绘画',
          player.can_draw !== false,
          next => this._onSetPermissions({ target_id: player.uid, can_draw: next })
        ));
        actions.appendChild(this._makePermToggle(
          '保存',
          player.can_save !== false,
          next => this._onSetPermissions({ target_id: player.uid, can_save: next })
        ));
        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'room-player-kick';
        kickBtn.textContent = '踢出';
        kickBtn.addEventListener('click', () => {
          if (confirm('确定踢出「' + player.name + '」？')) {
            this._onKick(player.uid);
          }
        });
        actions.appendChild(kickBtn);
        bottom.appendChild(actions);
      } else {
        this._appendPermBadges(bottom, player);
      }

      row.appendChild(bottom);
      return row;
    }
  }

  global.RoomPanel = RoomPanel;
  global.RoomPanelLimits = {
    MIN: MAX_PLAYERS_MIN,
    MAX: MAX_PLAYERS_MAX,
    DEFAULT: MAX_PLAYERS_DEFAULT
  };
})(window);
