(function (global) {
  'use strict';

  const DB_NAME = 'collab-pbcc-v1';
  const DB_VERSION = 1;
  const STORE = 'snapshots';
  const PREF_KEY = 'collab-restore-last-v1';

  /** IndexedDB：按用户+房间保存上次 .inkmesh 文档。 */
  const PbccLocalStore = {
    _dbPromise: null,

    /** 打开 IndexedDB。 */
    _openDb() {
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('无法打开本地存储'));
      });
      return this._dbPromise;
    },

    /** 生成存储键：userId + roomId。 */
    _key(userId, roomId) {
      return `${String(userId || 'local')}:${String(roomId || '').toUpperCase()}`;
    },

    /** 保存房间快照文档。 */
    async save(userId, roomId, document) {
      const db = await this._openDb();
      const key = this._key(userId, roomId);
      const record = {
        key,
        userId: String(userId || ''),
        roomId: String(roomId || '').toUpperCase(),
        savedAt: Date.now(),
        document
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('保存失败'));
      });
    },

    /** 读取房间快照；不存在时返回 null。 */
    async load(userId, roomId) {
      const db = await this._openDb();
      const key = this._key(userId, roomId);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => {
          const row = req.result;
          resolve(row && row.document ? row.document : null);
        };
        req.onerror = () => reject(req.error || new Error('读取失败'));
      });
    },

    /** 是否已有该房间的本机快照。 */
    async has(userId, roomId) {
      const doc = await this.load(userId, roomId);
      return Boolean(doc && Array.isArray(doc.boards) && doc.boards.length);
    },

    /**
     * 列出某用户的本机快照摘要（大厅卡片用）。
     * @param {string} userId 本机用户 id
     * @returns {Promise<Array<{roomId:string,title:string,savedAt:number}>>}
     */
    async listForUser(userId) {
      const db = await this._openDb();
      const uid = String(userId || '');
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result : [];
          const out = [];
          rows.forEach(row => {
            if (!row) return;
            if (uid && String(row.userId || '') !== uid) return;
            const roomId = String(row.roomId || '').toUpperCase();
            if (!roomId) return;
            const doc = row.document;
            let title = roomId;
            if (doc && Array.isArray(doc.boards) && doc.boards[0] && doc.boards[0].title) {
              title = String(doc.boards[0].title).slice(0, 40);
            }
            out.push({
              roomId,
              title,
              savedAt: Number(row.savedAt || 0)
            });
          });
          out.sort((a, b) => b.savedAt - a.savedAt);
          resolve(out);
        };
        req.onerror = () => reject(req.error || new Error('列出本机画板失败'));
      });
    },

    /** 读取「恢复上次画板」勾选偏好。 */
    getRestorePref() {
      try {
        return localStorage.getItem(PREF_KEY) === '1';
      } catch (_err) {
        return false;
      }
    },

    /** 保存「恢复上次画板」勾选偏好。 */
    setRestorePref(enabled) {
      try {
        localStorage.setItem(PREF_KEY, enabled ? '1' : '0');
      } catch (_err) {}
    }
  };

  global.PbccLocalStore = PbccLocalStore;
})(window);
