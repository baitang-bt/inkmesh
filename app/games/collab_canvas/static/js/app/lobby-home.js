(function (global) {
  'use strict';

  const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const ROOM_FIRST = ROOM_ALPHABET.replace('P', '');

  /** 从 .inkmesh / .pbcc 文档取第一块画板标题。 */
  function titleFromDocument(document) {
    if (!document || !Array.isArray(document.boards) || !document.boards.length) return '';
    const first = document.boards[0];
    return String((first && first.title) || '').trim().slice(0, 40);
  }

  /** 相对时间文案。 */
  function formatWhen(ts) {
    const t = Number(ts || 0);
    if (!t) return '';
    const delta = Date.now() - t;
    if (delta < 60 * 1000) return '刚刚';
    if (delta < 60 * 60 * 1000) return `${Math.floor(delta / 60000)} 分钟前`;
    if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3600000)} 小时前`;
    if (delta < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(delta / 86400000)} 天前`;
    try {
      return new Date(t).toLocaleDateString();
    } catch (_err) {
      return '';
    }
  }

  /**
   * 进站大厅：我的画板 / 最近 / 公开大厅 + 最近同房的人。
   * 点击与新建只通过回调进入现有 enterRoom。
   */
  class LobbyHome {
    constructor(options) {
      const settings = options || {};
      this.root = settings.root || document.getElementById('joinScreen');
      this.userId = String(settings.userId || '');
      this.onEnterRoom = settings.onEnterRoom || (() => {});
      this.onImportFile = settings.onImportFile || (() => {});
      this.getLobbyUrl = settings.getLobbyUrl || (() => '');
      this.onRandomJoin = settings.onRandomJoin || (() => {});
      this.view = 'boards';
      this._bound = false;
      this._hallRooms = [];
      this._hallQuery = '';
      this._hallSearchTimer = null;

      this.titleEl = document.getElementById('lobbyTitle');
      this.gridEl = document.getElementById('lobbyBoardGrid');
      this.emptyEl = document.getElementById('lobbyEmpty');
      this.peerListEl = document.getElementById('lobbyPeerList');
      this.peerEmptyEl = document.getElementById('lobbyPeerEmpty');
      this.starredListEl = document.getElementById('lobbyStarredPeerList');
      this.starredEmptyEl = document.getElementById('lobbyStarredEmpty');
      this.peersRoot = this.root && this.root.querySelector('.lobby-peers');
      this.newBtn = document.getElementById('lobbyNewBoardBtn');
      this.emptyNewBtn = document.getElementById('lobbyEmptyNewBtn');
      this.emptyImportBtn = document.getElementById('lobbyEmptyImportBtn');
      this.hallSearchEl = document.getElementById('lobbyHallSearch');
      this.hallRandomBtn = document.getElementById('lobbyHallRandomBtn');
    }

    /** 绑定导航与工具条事件（只绑一次）。 */
    bind() {
      if (this._bound || !this.root) return;
      this._bound = true;
      this.root.querySelectorAll('[data-lobby-view]').forEach(btn => {
        btn.addEventListener('click', () => {
          this.setView(btn.getAttribute('data-lobby-view') || 'boards');
        });
      });
      if (this.newBtn) this.newBtn.addEventListener('click', () => this.createBoard());
      if (this.emptyNewBtn) this.emptyNewBtn.addEventListener('click', () => this.createBoard());
      if (this.emptyImportBtn) {
        this.emptyImportBtn.addEventListener('click', () => this.onImportFile());
      }
      if (this.hallRandomBtn) {
        this.hallRandomBtn.addEventListener('click', () => this.randomJoinHall());
      }
      if (this.hallSearchEl) {
        this.hallSearchEl.addEventListener('input', () => {
          this._hallQuery = String(this.hallSearchEl.value || '').trim();
          if (this._hallSearchTimer) clearTimeout(this._hallSearchTimer);
          this._hallSearchTimer = setTimeout(() => {
            this._hallSearchTimer = null;
            if (this.view === 'hall') this.refresh();
          }, 280);
        });
      }
      if (this.gridEl) {
        this.gridEl.addEventListener('click', event => {
          if (event.target.closest('[data-lobby-create]')) {
            this.createBoard();
            return;
          }
          if (event.target.closest('.lobby-board-title-input')) return;
          const card = event.target.closest('[data-room-id]');
          if (!card) return;
          const roomId = card.getAttribute('data-room-id');
          if (roomId) this.onEnterRoom(roomId);
        });
      }
      this._bindPeerSections();
      this._syncChrome();
    }

    /** 绑定标星 / 最近分区折叠与星标按钮。 */
    _bindPeerSections() {
      if (!this.peersRoot) return;
      this.peersRoot.querySelectorAll('[data-peer-toggle]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-peer-toggle');
          if (!id) return;
          const open = !(global.LobbyHistory && LobbyHistory.getPeerSectionOpen(id));
          if (global.LobbyHistory) LobbyHistory.setPeerSectionOpen(id, open);
          this._applyPeerSectionOpen(id, open);
        });
      });
      this.peersRoot.addEventListener('click', event => {
        const starBtn = event.target.closest('[data-peer-star]');
        if (!starBtn) return;
        event.preventDefault();
        event.stopPropagation();
        const uid = starBtn.getAttribute('data-peer-star');
        if (!uid || !global.LobbyHistory) return;
        const next = starBtn.getAttribute('aria-pressed') !== 'true';
        const peer = {
          uid,
          name: starBtn.getAttribute('data-peer-name') || '',
          lastRoomId: starBtn.getAttribute('data-peer-room') || '',
          lastSeenAt: Number(starBtn.getAttribute('data-peer-seen') || 0)
        };
        LobbyHistory.setPeerStarred(peer, next);
        this._renderPeers();
      });
    }

    /** 应用同伴分区展开/折叠到 DOM。 */
    _applyPeerSectionOpen(sectionId, open) {
      if (!this.peersRoot) return;
      const section = this.peersRoot.querySelector('[data-peer-section="' + sectionId + '"]');
      if (!section) return;
      section.classList.toggle('is-collapsed', !open);
      const toggle = section.querySelector('[data-peer-toggle="' + sectionId + '"]');
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    /** 切换「我的画板 / 最近 / 大厅」并刷新列表。 */
    setView(view) {
      const raw = String(view || 'boards');
      this.view = raw === 'recent' || raw === 'hall' ? raw : 'boards';
      this.root.querySelectorAll('[data-lobby-view]').forEach(btn => {
        const active = btn.getAttribute('data-lobby-view') === this.view;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (this.titleEl) {
        this.titleEl.textContent = this.view === 'recent'
          ? '最近'
          : (this.view === 'hall' ? '大厅' : '我的画板');
      }
      this._syncChrome();
      this.refresh();
    }

    /** 按当前视图显示本地工具或大厅搜索/随机。 */
    _syncChrome() {
      if (!this.root) return;
      const hall = this.view === 'hall';
      this.root.querySelectorAll('[data-lobby-local-tools]').forEach(el => {
        el.classList.toggle('hidden', hall);
      });
      this.root.querySelectorAll('[data-lobby-hall-tools]').forEach(el => {
        el.classList.toggle('hidden', !hall);
      });
    }

    /** 拉取公开大厅房间列表。 */
    async _fetchHallRooms() {
      const base = String(this.getLobbyUrl() || '').replace(/\/$/, '');
      if (!base) {
        this._hallRooms = [];
        return [];
      }
      const q = encodeURIComponent(this._hallQuery || '');
      const url = base + '/inkmesh/lobby' + (q ? ('?q=' + q) : '');
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('lobby http ' + res.status);
        const data = await res.json();
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        this._hallRooms = rooms.map(row => ({
          roomId: String(row.room_id || '').toUpperCase(),
          title: String(row.title || row.room_id || '').slice(0, 40),
          playerCount: Math.max(1, Number(row.player_count) || 1),
          updatedAt: Number(row.updated_at) || 0,
          hasPreview: Boolean(row.has_preview)
        })).filter(r => r.roomId);
        return this._hallRooms;
      } catch (_err) {
        this._hallRooms = [];
        return [];
      }
    }

    /**
     * 构建公开大厅卡片（预览 / 标题 / 人数）。
     * @param {{roomId:string,title:string,playerCount:number,updatedAt:number,hasPreview:boolean}} room
     */
    _buildHallCard(room) {
      const root = document.createElement('div');
      root.className = 'lobby-board-card lobby-board-card--hall';
      root.setAttribute('data-room-id', room.roomId);
      root.setAttribute('role', 'button');
      root.tabIndex = 0;
      const base = String(this.getLobbyUrl() || '').replace(/\/$/, '');
      const previewUrl = room.hasPreview && base
        ? (base + '/inkmesh/lobby/' + encodeURIComponent(room.roomId)
          + '/preview?t=' + encodeURIComponent(String(room.updatedAt || 0)))
        : '';
      root.innerHTML =
        `<div class="lobby-board-thumb lobby-board-thumb--preview">` +
        (previewUrl
          ? `<img alt="" loading="lazy" src="${previewUrl}">`
          : `<span>公开</span>`) +
        `</div>` +
        `<div class="lobby-board-body">` +
        `<div class="lobby-board-title"></div>` +
        `<div class="lobby-board-meta"></div>` +
        `</div>`;
      root.querySelector('.lobby-board-title').textContent = room.title || room.roomId;
      root.querySelector('.lobby-board-meta').textContent =
        `${room.roomId} · ${room.playerCount} 人`;
      return root;
    }

    /**
     * 随机进公开房：拉全量列表（不受搜索框过滤），空则回退 onRandomJoin。
     */
    async randomJoinHall() {
      const prevQ = this._hallQuery;
      this._hallQuery = '';
      let list = [];
      try {
        list = await this._fetchHallRooms();
      } finally {
        this._hallQuery = prevQ;
      }
      if (list.length) {
        const pick = list[Math.floor(Math.random() * list.length)];
        if (pick && pick.roomId) {
          this.onEnterRoom(pick.roomId);
          return;
        }
      }
      this.onRandomJoin();
    }

    /** 生成非 P 开头的 8 位大写字母+数字房间号。 */
    generateRoomId() {
      let code = '';
      for (let i = 0; i < 8; i += 1) {
        code = ROOM_FIRST.charAt(Math.floor(Math.random() * ROOM_FIRST.length));
        for (let j = 0; j < 7; j += 1) {
          code += ROOM_ALPHABET.charAt(Math.floor(Math.random() * ROOM_ALPHABET.length));
        }
        if (!global.LobbyHistory || !LobbyHistory.listRooms().some(row => row.roomId === code)) {
          return code;
        }
      }
      return code;
    }

    /** 新建画板：生成本地房间号并进入。 */
    createBoard() {
      this.onEnterRoom(this.generateRoomId());
    }

    /**
     * 改大厅显示名；有本机快照时同步文档内第一块画板 title。
     * @param {string} roomId
     * @param {string} title
     * @param {boolean} hasLocal
     */
    async renameBoard(roomId, title, hasLocal) {
      const id = String(roomId || '').trim().toUpperCase();
      const next = String(title || '').trim().slice(0, 40);
      if (!id || !next) {
        this.refresh();
        return;
      }
      if (global.LobbyHistory) LobbyHistory.setRoomTitle(id, next);
      if (hasLocal && global.PbccLocalStore && PbccLocalStore.renameBoardTitle) {
        await PbccLocalStore.renameBoardTitle(this.userId, id, next);
      }
      this.refresh();
    }

    /** 构建「新建画板」入口卡片。 */
    _buildCreateCard() {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lobby-board-card lobby-board-card--create';
      btn.setAttribute('data-lobby-create', '1');
      btn.innerHTML =
        `<div class="lobby-board-thumb lobby-board-thumb--create" aria-hidden="true">+</div>` +
        `<div class="lobby-board-body">` +
        `<div class="lobby-board-title">新建画板</div>` +
        `<div class="lobby-board-meta">开始一块空白画布</div>` +
        `</div>`;
      return btn;
    }

    /**
     * 构建可进房、可改名的画板卡片。
     * @param {{roomId:string,title:string,visitedAt:number,hasLocal:boolean}} card
     */
    _buildBoardCard(card) {
      const root = document.createElement('div');
      root.className = 'lobby-board-card';
      root.setAttribute('data-room-id', card.roomId);
      root.setAttribute('role', 'button');
      root.tabIndex = 0;
      const when = formatWhen(card.visitedAt);
      const badge = card.hasLocal ? '本机' : '房间';
      root.innerHTML =
        `<div class="lobby-board-thumb">${badge}</div>` +
        `<div class="lobby-board-body">` +
        `<label class="lobby-board-title-wrap">` +
        `<span class="lobby-sr-only">画板名称</span>` +
        `<input class="lobby-board-title-input" type="text" maxlength="40" spellcheck="false">` +
        `</label>` +
        `<div class="lobby-board-meta"></div>` +
        `</div>`;
      const input = root.querySelector('.lobby-board-title-input');
      input.value = card.title || card.roomId;
      input.title = '点击修改显示名';
      root.querySelector('.lobby-board-meta').textContent =
        `${card.roomId}${when ? ' · ' + when : ''}`;
      const commit = () => {
        const next = input.value.trim().slice(0, 40);
        if (!next || next === (card.title || card.roomId)) {
          input.value = card.title || card.roomId;
          return;
        }
        this.renameBoard(card.roomId, next, card.hasLocal);
      };
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          input.value = card.title || card.roomId;
          input.blur();
        }
      });
      input.addEventListener('change', commit);
      root.addEventListener('keydown', event => {
        if (event.target !== root) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.onEnterRoom(card.roomId);
        }
      });
      return root;
    }

    /**
     * 合并本机快照与访问历史，得到卡片数据。
     * @returns {Promise<Array>}
     */
    async _collectCards() {
      const history = (global.LobbyHistory && LobbyHistory.listRooms()) || [];
      const historyMap = new Map(history.map(row => [row.roomId, row]));
      let snapshots = [];
      if (global.PbccLocalStore && PbccLocalStore.listForUser) {
        snapshots = await PbccLocalStore.listForUser(this.userId);
      }
      const cards = new Map();

      snapshots.forEach(snap => {
        const roomId = String(snap.roomId || '').toUpperCase();
        if (!roomId) return;
        const hist = historyMap.get(roomId);
        cards.set(roomId, {
          roomId,
          title: snap.title || (hist && hist.title) || roomId,
          visitedAt: Math.max(Number(snap.savedAt || 0), Number(hist && hist.visitedAt || 0)),
          hasLocal: true
        });
      });

      history.forEach(row => {
        if (cards.has(row.roomId)) {
          const existing = cards.get(row.roomId);
          existing.visitedAt = Math.max(existing.visitedAt, row.visitedAt);
          if (!existing.title || existing.title === existing.roomId) {
            existing.title = row.title || existing.title;
          }
          return;
        }
        cards.set(row.roomId, {
          roomId: row.roomId,
          title: row.title || row.roomId,
          visitedAt: row.visitedAt,
          hasLocal: false
        });
      });

      const list = Array.from(cards.values());
      list.sort((a, b) => b.visitedAt - a.visitedAt);
      return list;
    }

    /** 刷新中栏卡片与右栏同伴列表。 */
    async refresh() {
      if (!this.gridEl) return;
      this.gridEl.innerHTML = '';

      if (this.view === 'hall') {
        const rooms = await this._fetchHallRooms();
        if (!rooms.length) {
          if (this.emptyEl) {
            this.emptyEl.classList.remove('hidden');
            const title = this.emptyEl.querySelector('.lobby-empty-title');
            const hint = this.emptyEl.querySelector('.lobby-empty-hint');
            const actions = this.emptyEl.querySelector('.lobby-empty-actions');
            if (title) title.textContent = this.getLobbyUrl() ? '暂无公开房间' : '大厅未配置';
            if (hint) {
              hint.textContent = this.getLobbyUrl()
                ? '房主开启公开房间后会出现在这里；也可点「随机加入」。'
                : '公开站需配置 lobbyUrl / wsUrl（信令 Worker）后才能浏览大厅。';
            }
            if (actions) actions.classList.add('hidden');
          }
        } else {
          if (this.emptyEl) {
            this.emptyEl.classList.add('hidden');
            const actions = this.emptyEl.querySelector('.lobby-empty-actions');
            if (actions) actions.classList.remove('hidden');
          }
          rooms.forEach(room => this.gridEl.appendChild(this._buildHallCard(room)));
        }
        this._renderPeers();
        return;
      }

      const cards = await this._collectCards();
      const shown = this.view === 'recent' ? cards.slice(0, 20) : cards;
      if (!shown.length) {
        // 空列表只用居中空态按钮；有画板时才在网格里放「新建」卡片。
        if (this.emptyEl) {
          this.emptyEl.classList.remove('hidden');
          const title = this.emptyEl.querySelector('.lobby-empty-title');
          const hint = this.emptyEl.querySelector('.lobby-empty-hint');
          const actions = this.emptyEl.querySelector('.lobby-empty-actions');
          if (title) title.textContent = '还没有画板';
          if (hint) {
            hint.textContent = '新建一个房间开始画，或导入 .inkmesh / .pbcc。进出过的房间会出现在这里。';
          }
          if (actions) actions.classList.remove('hidden');
        }
      } else {
        if (this.emptyEl) this.emptyEl.classList.add('hidden');
        if (this.view === 'boards') {
          this.gridEl.appendChild(this._buildCreateCard());
        }
        shown.forEach(card => {
          this.gridEl.appendChild(this._buildBoardCard(card));
        });
      }
      this._renderPeers();
    }

    /**
     * 构建同伴列表项（含标星按钮）。
     * @param {object} peer
     * @param {boolean} starred
     */
    _buildPeerItem(peer, starred) {
      const li = document.createElement('li');
      li.className = 'lobby-peer-item' + (starred ? ' is-starred' : '');
      const initial = (peer.name || '?').slice(0, 1).toUpperCase();
      const when = formatWhen(peer.lastSeenAt);
      const room = peer.lastRoomId ? `房间 ${peer.lastRoomId}` : '';
      li.innerHTML =
        `<div class="lobby-peer-avatar"></div>` +
        `<div class="lobby-peer-text">` +
        `<div class="lobby-peer-name"></div>` +
        `<div class="lobby-peer-meta"></div>` +
        `</div>` +
        `<button type="button" class="lobby-peer-star" data-peer-star="" aria-label="标星" aria-pressed="false">☆</button>`;
      li.querySelector('.lobby-peer-avatar').textContent = initial;
      li.querySelector('.lobby-peer-name').textContent = peer.name;
      li.querySelector('.lobby-peer-meta').textContent =
        [room, when].filter(Boolean).join(' · ');
      const starBtn = li.querySelector('.lobby-peer-star');
      starBtn.setAttribute('data-peer-star', peer.uid);
      starBtn.setAttribute('data-peer-name', peer.name || '');
      starBtn.setAttribute('data-peer-room', peer.lastRoomId || '');
      starBtn.setAttribute('data-peer-seen', String(peer.lastSeenAt || 0));
      starBtn.setAttribute('aria-pressed', starred ? 'true' : 'false');
      starBtn.setAttribute('aria-label', starred ? '取消标星' : '标星');
      starBtn.textContent = starred ? '★' : '☆';
      return li;
    }

    /** 渲染右侧标星区与最近同房的人。 */
    _renderPeers() {
      const peers = (global.LobbyHistory && LobbyHistory.listPeers()) || [];
      const starred = (global.LobbyHistory && LobbyHistory.listStarredPeers()) || [];
      const starredIds = new Set(starred.map(p => p.uid));

      if (this.starredListEl) {
        this.starredListEl.innerHTML = '';
        starred.forEach(peer => {
          this.starredListEl.appendChild(this._buildPeerItem(peer, true));
        });
      }
      if (this.starredEmptyEl) {
        this.starredEmptyEl.classList.toggle('hidden', starred.length > 0);
      }

      if (this.peerListEl) {
        this.peerListEl.innerHTML = '';
        peers.slice(0, 20).forEach(peer => {
          this.peerListEl.appendChild(this._buildPeerItem(peer, starredIds.has(peer.uid)));
        });
      }
      if (this.peerEmptyEl) {
        this.peerEmptyEl.classList.toggle('hidden', peers.length > 0);
      }

      ['starred', 'recent'].forEach(id => {
        const open = !(global.LobbyHistory) || LobbyHistory.getPeerSectionOpen(id);
        this._applyPeerSectionOpen(id, open);
      });
    }
  }

  global.LobbyHome = LobbyHome;
  global.LobbyHomeTitleFromDocument = titleFromDocument;
})(window);
