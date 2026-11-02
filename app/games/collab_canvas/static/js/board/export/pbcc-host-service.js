(function (global) {
  'use strict';

  /**
   * PBCC 本机保存/恢复与多画板导出协调（挂到 CollabBoardController）。
   * 发网只走 this.adapter / this._roomActions，禁止直接碰 session。
   */
  const PbccHostService = {
    /** 安装导出与 PBCC 相关方法到控制器原型。 */
    install(ControllerClass) {
      const proto = ControllerClass.prototype;

      /** 当前房间号：优先 roomActions，其次 adapter。 */
      proto._pbccRoomId = function() {
        const fromActions = this._roomActions && this._roomActions.getRoomId
          ? this._roomActions.getRoomId()
          : '';
        if (fromActions) return String(fromActions);
        return this.adapter && this.adapter.getRoomId
          ? String(this.adapter.getRoomId() || '')
          : '';
      };

      /** 导出/存档用显示名。 */
      proto._pbccDisplayName = function() {
        if (this._roomActions && typeof this._roomActions.getDisplayName === 'function') {
          return this._roomActions.getDisplayName() || '';
        }
        return this.adapter && typeof this.adapter.getDisplayName === 'function'
          ? (this.adapter.getDisplayName() || '')
          : '';
      };

      proto.collectBoardsForExport = async function() {
        this.adapter.flushSegments();
        const order = this.boardOrder.length
          ? this.boardOrder.slice()
          : this.boardsMeta.map(b => b.board_id);
        const boards = [];
        const roomId = this._pbccRoomId() || 'room';
        for (let i = 0; i < order.length; i += 1) {
          const boardId = order[i];
          const meta = this.boardsMeta.find(b => b.board_id === boardId);
          if (!meta) continue;
          let strokes;
          let layers;
          let canvas = meta.canvas;
          if (boardId === this.activeBoardId) {
            strokes = DrawingBoard.cloneStrokes(this.strokes);
            layers = this.layersMeta.slice();
          } else {
            const sync = await this.adapter.requestBoardSync(boardId);
            strokes = sync.strokes || [];
            layers = sync.layers || [];
            canvas = sync.canvas || canvas;
          }
          boards.push({
            meta: {
              board_id: boardId,
              title: meta.title,
              canvas,
              layers,
              created_at: meta.created_at,
              created_by: meta.created_by,
              exportOptions: this.canSave ? {} : {
                watermarkText: `${roomId} · 预览`
              }
            },
            strokes
          });
        }
        return boards;
      };

      proto.saveLocalPbccSnapshot = async function() {
        if (!this.isHost() || this._pbccSaveBusy || !global.PbccLocalStore) return false;
        const roomId = this._pbccRoomId();
        if (!roomId) return false;
        this._pbccSaveBusy = true;
        try {
          const boards = await this.collectBoardsForExport();
          if (!boards.length) return false;
          const document = this.exportRegistry.buildPbccDocument(boards, {
            roomId,
            boardOrder: this.boardOrder,
            exportedByUid: this.selfId,
            exportedByName: this._pbccDisplayName()
          });
          await PbccLocalStore.save(this.selfId, roomId, document);
          return true;
        } catch (_err) {
          return false;
        } finally {
          this._pbccSaveBusy = false;
        }
      };

      proto.tryRestoreLocalPbcc = async function(options) {
        const opts = options || {};
        if (!this.isHost() || !global.PbccFormat || !this.adapter) return 'none';
        const roomId = this._pbccRoomId();
        let document = opts.document || null;
        if (!document && opts.fromLocal && global.PbccLocalStore && roomId) {
          document = await PbccLocalStore.load(this.selfId, roomId);
        }
        if (!document) return 'none';
        const setStatus = this._roomActions.setStatus || (() => {});
        setStatus('正在恢复上次画板…');
        if (!this.adapter.sendRoomImport(document)) {
          setStatus('连接未就绪，无法恢复画板');
          return 'failed';
        }
        this._pbccRestorePending = true;
        this._pbccRestoreBoardCount = Array.isArray(document.boards) ? document.boards.length : 0;
        return 'sent';
      };

      proto.finishPbccRestoreIfPending = function() {
        if (!this._pbccRestorePending) return false;
        this._pbccRestorePending = false;
        const setStatus = this._roomActions.setStatus || (() => {});
        const n = this._pbccRestoreBoardCount || this.boardOrder.length || 1;
        setStatus(`已恢复 ${n} 个画板`);
        window.setTimeout(() => setStatus(''), 4000);
        return true;
      };

      proto.cancelPbccRestorePending = function(message) {
        if (!this._pbccRestorePending) return;
        this._pbccRestorePending = false;
        const setStatus = this._roomActions.setStatus || (() => {});
        setStatus(message || '恢复画板失败');
      };

      proto.schedulePbccAutoSave = function() {
        this.stopPbccAutoSave();
        if (!this.isHost()) return;
        this._pbccAutoSaveTimer = window.setInterval(() => {
          this.saveLocalPbccSnapshot();
        }, 90000);
      };

      proto.stopPbccAutoSave = function() {
        if (this._pbccAutoSaveTimer) {
          clearInterval(this._pbccAutoSaveTimer);
          this._pbccAutoSaveTimer = null;
        }
      };

      ControllerClass.roomStateHasUserContent = function(data) {
        const strokes = (data && data.strokes) || [];
        return strokes.some(stroke => {
          if (stroke.owner_id === '__system__') return false;
          return (stroke.segments || []).some(seg => seg && seg.tool !== 'background');
        });
      };

      proto.exportAllBoards = async function(formatId) {
        if (this._exportBusy) return;
        if (!this.canSave) {
          const statusEl = document.getElementById('statusText');
          if (statusEl) statusEl.textContent = '房主已关闭你的保存权限';
          return;
        }
        this._exportBusy = true;
        const statusEl = document.getElementById('statusText');
        const setStatus = text => { if (statusEl) statusEl.textContent = text || ''; };
        const format = this.exportRegistry.get(formatId);
        const isPbcc = format && format.multiBoardSingleFile;
        try {
          setStatus('正在准备导出…');
          const boards = await this.collectBoardsForExport();
          if (!boards.length) throw new Error('没有可导出的画板');
          setStatus(isPbcc ? '正在导出 .pbcc…' : `正在导出 ${boards.length} 个文件…`);
          await this.exportRegistry.exportBoards(formatId, boards, {
            roomId: this._pbccRoomId() || 'room',
            delayMs: 150,
            exportedByUid: this.selfId,
            exportedByName: this._pbccDisplayName()
          });
          if (isPbcc && this.isHost()) {
            await this.saveLocalPbccSnapshot();
          }
          setStatus(isPbcc ? '已导出 .pbcc 文件' : `已导出 ${boards.length} 个文件`);
        } catch (err) {
          setStatus(err.message || '导出失败');
        } finally {
          this._exportBusy = false;
        }
      };
    }
  };

  global.PbccHostService = PbccHostService;
})(typeof window !== 'undefined' ? window : globalThis);
