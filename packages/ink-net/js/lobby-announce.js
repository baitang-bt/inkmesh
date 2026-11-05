(function (global) {
  'use strict';

  const INTERVAL_MS = 5 * 60 * 1000;
  const DEBOUNCE_MS = 2500;
  const THUMB_MAX_W = 320;
  const JPEG_QUALITY = 0.7;

  /**
   * 房主向公开大厅定期上报标题、人数与画布缩略图。
   */
  class LobbyAnnouncer {
    /**
     * @param {{
     *   session: object,
     *   getLobbyUrl: () => string,
     *   getTitle: () => string,
     *   capturePreview: () => Promise<Blob|null>,
     * }} options
     */
    constructor(options) {
      const settings = options || {};
      this.session = settings.session || null;
      this.getLobbyUrl = settings.getLobbyUrl || (() => '');
      this.getTitle = settings.getTitle || (() => '');
      this.capturePreview = settings.capturePreview || (async () => null);
      this._timer = null;
      this._debounce = null;
      this._busy = false;
      this._lastKey = '';
    }

    /** 由 wsUrl 推导大厅 HTTP 基址。 */
    static lobbyUrlFromWs(wsUrl) {
      const raw = String(wsUrl || '').trim();
      if (!raw) return '';
      try {
        const u = new URL(raw);
        u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
        u.pathname = '';
        u.search = '';
        u.hash = '';
        return u.origin;
      } catch (_err) {
        return '';
      }
    }

    /** 启动定时上报（进房后由 app 调用）。 */
    start() {
      this.stopTimerOnly();
      this._timer = setInterval(() => {
        this.announce({ force: true }).catch(() => {});
      }, INTERVAL_MS);
      this.schedule();
    }

    /** 停止定时器（保留 debounce 清空）。 */
    stopTimerOnly() {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
    }

    /** 停止全部调度。 */
    stop() {
      this.stopTimerOnly();
      if (this._debounce) {
        clearTimeout(this._debounce);
        this._debounce = null;
      }
    }

    /** 防抖触发一次 announce。 */
    schedule() {
      if (this._debounce) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        this._debounce = null;
        this.announce({ force: false }).catch(() => {});
      }, DEBOUNCE_MS);
    }

    /** 私密或离开时下架并停表。 */
    async unpublishAndStop() {
      this.stop();
      await this.unpublish().catch(() => {});
      this._lastKey = '';
    }

    /** 从大厅下架当前房间。 */
    async unpublish() {
      const base = String(this.getLobbyUrl() || '').replace(/\/$/, '');
      const ctx = this.session && this.session.getLobbyAnnounceContext
        ? this.session.getLobbyAnnounceContext()
        : null;
      if (!base || !ctx || !ctx.token || !ctx.roomId) return false;
      const res = await fetch(base + '/inkmesh/lobby/' + encodeURIComponent(ctx.roomId), {
        method: 'DELETE',
        headers: { 'X-Lobby-Token': ctx.token }
      });
      return res.ok;
    }

    /**
     * 上报公开大厅；私密房跳过。
     * @param {{force?: boolean}} [options]
     */
    async announce(options) {
      const force = Boolean(options && options.force);
      if (this._busy) return false;
      const base = String(this.getLobbyUrl() || '').replace(/\/$/, '');
      const ctx = this.session && this.session.getLobbyAnnounceContext
        ? this.session.getLobbyAnnounceContext()
        : null;
      if (!base || !ctx || !ctx.isHost || !ctx.token || !ctx.roomId) return false;
      if (ctx.privateRoom) return false;

      const title = String(this.getTitle() || ctx.roomId).trim().slice(0, 40) || ctx.roomId;
      const key = [ctx.roomId, title, ctx.playerCount].join('|');
      if (!force && key === this._lastKey) return false;

      this._busy = true;
      try {
        let preview = null;
        try {
          preview = await this.capturePreview();
        } catch (_err) {
          preview = null;
        }
        const form = new FormData();
        form.append('room_id', ctx.roomId);
        form.append('title', title);
        form.append('player_count', String(ctx.playerCount));
        if (preview) form.append('preview', preview, 'preview.jpg');
        const res = await fetch(base + '/inkmesh/lobby/announce', {
          method: 'POST',
          headers: { 'X-Lobby-Token': ctx.token },
          body: form
        });
        if (!res.ok) return false;
        this._lastKey = key;
        return true;
      } finally {
        this._busy = false;
      }
    }
  }

  /**
   * 将当前合作画板合成约 320px 宽 JPEG 预览。
   * @param {object} boardController
   * @returns {Promise<Blob|null>}
   */
  async function captureBoardPreviewBlob(boardController) {
    if (!boardController || !global.CollabExportUtils || !CollabExportUtils.strokesToRgba) {
      return null;
    }
    const meta = (boardController.boardsMeta || []).find(
      b => b.board_id === boardController.activeBoardId
    ) || (boardController.boardsMeta || [])[0];
    const canvasSpec = (meta && meta.canvas) || {
      mode: 'vector',
      width: boardController.drawingBoard ? boardController.drawingBoard.logicalWidth : 1920,
      height: boardController.drawingBoard ? boardController.drawingBoard.logicalHeight : 1080
    };
    const { rgba, width, height } = await CollabExportUtils.strokesToRgba(
      boardController.strokes || [],
      canvasSpec,
      boardController.layersMeta || []
    );
    if (!rgba || !width || !height) return null;
    const scale = Math.min(1, THUMB_MAX_W / width);
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const src = document.createElement('canvas');
    src.width = width;
    src.height = height;
    const sctx = src.getContext('2d');
    const imageData = sctx.createImageData(width, height);
    imageData.data.set(rgba);
    sctx.putImageData(imageData, 0, 0);
    const out = document.createElement('canvas');
    out.width = tw;
    out.height = th;
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, tw, th);
    octx.drawImage(src, 0, 0, width, height, 0, 0, tw, th);
    return new Promise(resolve => {
      out.toBlob(blob => resolve(blob || null), 'image/jpeg', JPEG_QUALITY);
    });
  }

  global.LobbyAnnouncer = LobbyAnnouncer;
  global.captureBoardPreviewBlob = captureBoardPreviewBlob;
})(window);
