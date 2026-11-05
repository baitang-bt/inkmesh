(function (global) {
  'use strict';

  const INKMESH_FORMAT = 'inkmesh';
  const PBCC_FORMAT = 'pbcc';
  const ACCEPTED_FORMATS = { inkmesh: 1, pbcc: 1 };
  const PBCC_FORMAT_VERSION = 1;
  const PBCC_PROTOCOL_VERSION = 2;

  /** 过滤不可持久化的笔迹（localRaster 等）。 */
  function sanitizeStroke(stroke) {
    if (!stroke) return null;
    const segments = (stroke.segments || []).filter(seg => seg && seg.tool !== 'localRaster');
    if (!segments.length) return null;
    return {
      stroke_id: String(stroke.stroke_id || ''),
      owner_id: String(stroke.owner_id || ''),
      layer_id: String(stroke.layer_id || 'l_default'),
      active: stroke.active !== false,
      segments: segments.map(seg => Object.assign({}, seg))
    };
  }

  /** 规范化图层元数据为 wire 形态。 */
  function sanitizeLayer(layer) {
    if (!layer || !layer.layer_id) return null;
    return {
      layer_id: String(layer.layer_id),
      name: String(layer.name || layer.layer_id).slice(0, 40),
      kind: layer.kind === 'group' ? 'group' : 'paint',
      parent_id: layer.parent_id != null ? String(layer.parent_id) : '',
      visible: layer.visible !== false,
      opacity: Math.max(0, Math.min(255, Number(layer.opacity != null ? layer.opacity : 255))),
      locked: Boolean(layer.locked),
      order: Number(layer.order || 0)
    };
  }

  /** 从画板快照构建 .inkmesh 文档对象（format 字段为 inkmesh）。 */
  function buildDocument(options) {
    const opts = options || {};
    const boardsIn = opts.boards || [];
    const orderIn = opts.boardOrder || boardsIn.map(b => b.meta && b.meta.board_id).filter(Boolean);
    const boards = [];
    orderIn.forEach(boardId => {
      const entry = boardsIn.find(b => b.meta && b.meta.board_id === boardId);
      if (!entry) return;
      const meta = entry.meta || {};
      const layers = (meta.layers || []).map(sanitizeLayer).filter(Boolean);
      const strokes = (entry.strokes || []).map(sanitizeStroke).filter(Boolean);
      boards.push({
        board_id: String(meta.board_id || boardId),
        title: String(meta.title || '画板').slice(0, 40),
        canvas: Object.assign(
          { mode: 'vector', width: 1920, height: 1080 },
          meta.canvas || {}
        ),
        layers,
        strokes,
        created_at: Number(meta.created_at || 0),
        created_by: String(meta.created_by || '')
      });
    });
    return {
      format: INKMESH_FORMAT,
      formatVersion: PBCC_FORMAT_VERSION,
      protocolVersion: PBCC_PROTOCOL_VERSION,
      exportedAt: new Date().toISOString(),
      sourceRoomId: String(opts.roomId || ''),
      exportedBy: {
        uid: String(opts.exportedByUid || ''),
        displayName: String(opts.exportedByName || '')
      },
      board_order: boards.map(b => b.board_id),
      boards
    };
  }

  /** 解析 .inkmesh / 旧版 .pbcc JSON 文本/对象并做基础校验。 */
  function parseDocument(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      data = JSON.parse(raw);
    }
    const formatId = data && String(data.format || '');
    if (!data || !ACCEPTED_FORMATS[formatId]) {
      throw new Error('不是有效的 .inkmesh / .pbcc 文件');
    }
    if (Number(data.formatVersion) !== PBCC_FORMAT_VERSION) {
      throw new Error('不支持的文件版本');
    }
    const boards = Array.isArray(data.boards) ? data.boards : [];
    if (!boards.length) throw new Error('文件不含画板');
    const boardOrder = Array.isArray(data.board_order) && data.board_order.length
      ? data.board_order.map(String)
      : boards.map(b => String(b.board_id));
    return {
      format: formatId,
      formatVersion: PBCC_FORMAT_VERSION,
      protocolVersion: Number(data.protocolVersion) || PBCC_PROTOCOL_VERSION,
      exportedAt: data.exportedAt || '',
      sourceRoomId: String(data.sourceRoomId || ''),
      exportedBy: data.exportedBy || {},
      board_order: boardOrder,
      boards: boards.map(board => ({
        board_id: String(board.board_id || ''),
        title: String(board.title || '画板').slice(0, 40),
        canvas: board.canvas || { mode: 'vector', width: 1920, height: 1080 },
        layers: (board.layers || []).map(sanitizeLayer).filter(Boolean),
        strokes: (board.strokes || []).map(sanitizeStroke).filter(Boolean),
        created_at: Number(board.created_at || 0),
        created_by: String(board.created_by || '')
      }))
    };
  }

  /** 序列化为 Blob（UTF-8 JSON）。 */
  function encodeBlob(document) {
    const json = JSON.stringify(document, null, 2);
    return new Blob([json], { type: 'application/vnd.potatoblock.collab-canvas+json' });
  }

  /** 从 File 读取并解析 .inkmesh 或旧版 .pbcc。 */
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(parseDocument(String(reader.result || '')));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
      reader.readAsText(file);
    });
  }

  global.PbccFormat = {
    INKMESH_FORMAT,
    PBCC_FORMAT,
    PBCC_FORMAT_VERSION,
    ACCEPTED_FORMATS,
    buildDocument,
    parseDocument,
    encodeBlob,
    readFile
  };
})(window);
