(function (global) {
  'use strict';

  const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const ROOM_FIRST = ROOM_ALPHABET.replace('P', '');

  /** 从 .pbcc 文档取第一块画板标题。 */
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
   * 进站三栏大厅：本机画板 / 最近房间 + 最近同房的人。
   * 点击与新建只通过回调进入现有 enterRoom。
   */
  class LobbyHome {
    constructor(options) {
      const settings = options || {};
      this.root = settings.root || document.getElementById('joinScreen');
      this.userId = String(settings.userId || '');
      this.onEnterRoom = settings.onEnterRoom || (() => {});
      this.onImportFile = settings.onImportFile || (() => {});
      this.view = 'boards';
      this._bound = false;

      this.titleEl = document.getElementById('lobbyTitle');
      this.gridEl = document.getElementById('lobbyBoardGrid');
      this.emptyEl = document.getElementById('lobbyEmpty');
      this.peerListEl = document.getElementById('lobbyPeerList');
      this.peerEmptyEl = document.getElementById('lobbyPeerEmpty');
      this.newBtn = document.getElementById('lobbyNewBoardBtn');
      this.emptyNewBtn = document.getElementById('lobbyEmptyNewBtn');
      this.emptyImportBtn = document.getElementById('lobbyEmptyImportBtn');
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
      if (this.gridEl) {
        this.gridEl.addEventListener('click', event => {
          const card = event.target.closest('[data-room-id]');
          if (!card) return;
          const roomId = card.getAttribute('data-room-id');
          if (roomId) this.onEnterRoom(roomId);
        });
      }
    }

    /** 切换「我的画板 / 最近」并刷新列表。 */
    setView(view) {
      this.view = view === 'recent' ? 'recent' : 'boards';
      this.root.querySelectorAll('[data-lobby-view]').forEach(btn => {
        const active = btn.getAttribute('data-lobby-view') === this.view;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (this.titleEl) {
        this.titleEl.textContent = this.view === 'recent' ? '最近' : '我的画板';
      }
      this.refresh();
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
      const cards = await this._collectCards();
      const shown = this.view === 'recent' ? cards.slice(0, 20) : cards;
      this.gridEl.innerHTML = '';
      if (!shown.length) {
        if (this.emptyEl) this.emptyEl.classList.remove('hidden');
      } else {
        if (this.emptyEl) this.emptyEl.classList.add('hidden');
        shown.forEach(card => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'lobby-board-card';
          btn.setAttribute('data-room-id', card.roomId);
          const when = formatWhen(card.visitedAt);
          const badge = card.hasLocal ? '本机' : '房间';
          btn.innerHTML =
            `<div class="lobby-board-thumb">${badge}</div>` +
            `<div class="lobby-board-body">` +
            `<div class="lobby-board-title"></div>` +
            `<div class="lobby-board-meta"></div>` +
            `</div>`;
          btn.querySelector('.lobby-board-title').textContent = card.title || card.roomId;
          btn.querySelector('.lobby-board-meta').textContent =
            `${card.roomId}${when ? ' · ' + when : ''}`;
          this.gridEl.appendChild(btn);
        });
      }
      this._renderPeers();
    }

    /** 渲染右侧最近同房的人。 */
    _renderPeers() {
      if (!this.peerListEl) return;
      const peers = (global.LobbyHistory && LobbyHistory.listPeers()) || [];
      this.peerListEl.innerHTML = '';
      if (!peers.length) {
        if (this.peerEmptyEl) this.peerEmptyEl.classList.remove('hidden');
        return;
      }
      if (this.peerEmptyEl) this.peerEmptyEl.classList.add('hidden');
      peers.slice(0, 20).forEach(peer => {
        const li = document.createElement('li');
        li.className = 'lobby-peer-item';
        const initial = (peer.name || '?').slice(0, 1).toUpperCase();
        const when = formatWhen(peer.lastSeenAt);
        const room = peer.lastRoomId ? `房间 ${peer.lastRoomId}` : '';
        li.innerHTML =
          `<div class="lobby-peer-avatar"></div>` +
          `<div class="lobby-peer-text">` +
          `<div class="lobby-peer-name"></div>` +
          `<div class="lobby-peer-meta"></div>` +
          `</div>`;
        li.querySelector('.lobby-peer-avatar').textContent = initial;
        li.querySelector('.lobby-peer-name').textContent = peer.name;
        li.querySelector('.lobby-peer-meta').textContent =
          [room, when].filter(Boolean).join(' · ');
        this.peerListEl.appendChild(li);
      });
    }
  }

  global.LobbyHome = LobbyHome;
  global.LobbyHomeTitleFromDocument = titleFromDocument;
})(window);
