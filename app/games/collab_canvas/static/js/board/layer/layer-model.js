(function (global) {
  'use strict';

  /**
   * 图层树纯逻辑：与服务端 drawing_board.py 的 coerce / orphan / lock 语义对齐。
   * Board 与 LayerPanel 共用，禁止在 UI 内再实现一套。
   */
  const LayerModel = {
    /** 是否为图层组。 */
    isGroupLayer(layer) {
      return Boolean(layer && layer.kind === 'group');
    },

    /** 规范化图层元数据（kind / parent_id）。 */
    normalize(layer) {
      if (!layer) return layer;
      if (!layer.kind) layer.kind = 'paint';
      if (layer.parent_id == null) layer.parent_id = '';
      return layer;
    },

    /** 将 parent_id 指向不存在图层的项提升到根。 */
    repairOrphans(layers) {
      const idSet = new Set((layers || []).map(layer => layer.layer_id));
      return (layers || []).map(layer => {
        const copy = LayerModel.normalize(Object.assign({}, layer));
        const parentId = copy.parent_id || '';
        if (parentId && !idSet.has(parentId)) copy.parent_id = '';
        return copy;
      });
    },

    /** 保证至少有一层可绘制「图层 1」（空列表时含背景 + 图层 1）。 */
    coerce(layers) {
      const fallback = [
        {
          layer_id: 'l_background',
          name: '背景',
          kind: 'paint',
          parent_id: '',
          visible: true,
          opacity: 255,
          locked: false,
          order: 0
        },
        {
          layer_id: 'l_default',
          name: '图层 1',
          kind: 'paint',
          parent_id: '',
          visible: true,
          opacity: 255,
          locked: false,
          order: 1
        }
      ];
      let source = !Array.isArray(layers) || layers.length === 0
        ? fallback.slice()
        : layers.map(layer => LayerModel.normalize(Object.assign({}, layer)));
      source = LayerModel.repairOrphans(source);
      const userPaints = source.filter(
        layer => !LayerModel.isGroupLayer(layer) && layer.layer_id !== 'l_background'
      );
      if (!userPaints.length) {
        const maxOrder = source.reduce((max, layer) => Math.max(max, layer.order || 0), 0);
        const ids = new Set(source.map(layer => layer.layer_id));
        source.push({
          layer_id: ids.has('l_default') ? ('l_' + Date.now().toString(36)) : 'l_default',
          name: '图层 1',
          kind: 'paint',
          parent_id: '',
          visible: true,
          opacity: 255,
          locked: false,
          order: maxOrder + 1
        });
      }
      return source;
    },

    /** 指定图层或其任意父组是否锁定。 */
    isLayerLocked(layersMeta, layerId) {
      let current = (layersMeta || []).find(l => l.layer_id === layerId);
      while (current) {
        if (current.locked) return true;
        const parentId = current.parent_id || '';
        if (!parentId) break;
        current = layersMeta.find(l => l.layer_id === parentId);
      }
      return false;
    },

    /** 返回 order 最高的绘画图层 id。 */
    topPaintLayerId(layersMeta) {
      const paints = (layersMeta || []).filter(l => !LayerModel.isGroupLayer(l));
      if (!paints.length) return 'l_default';
      paints.sort((a, b) => (a.order || 0) - (b.order || 0));
      return paints[paints.length - 1].layer_id;
    },

    /** 新建图层时默认 parent：选中组则入组，否则与当前层同级。 */
    resolveNewLayerParentId(layersMeta, activeLayerId) {
      const active = (layersMeta || []).find(l => l.layer_id === activeLayerId);
      if (!active) return '';
      if (LayerModel.isGroupLayer(active)) return active.layer_id;
      const parentId = active.parent_id || '';
      if (!parentId) return '';
      const parent = layersMeta.find(l => l.layer_id === parentId);
      if (parent && LayerModel.isGroupLayer(parent)) return parentId;
      return '';
    },

    /** 当前可绘制目标图层（选中组时落到组内顶层绘画层）。 */
    drawLayerId(layersMeta, activeLayerId) {
      const active = (layersMeta || []).find(l => l.layer_id === activeLayerId);
      if (active && LayerModel.isGroupLayer(active)) {
        const children = layersMeta
          .filter(l => !LayerModel.isGroupLayer(l) && (l.parent_id || '') === active.layer_id)
          .sort((a, b) => (a.order || 0) - (b.order || 0));
        if (children.length) return children[children.length - 1].layer_id;
        return LayerModel.topPaintLayerId(layersMeta);
      }
      return activeLayerId;
    },

    /** 将被删组/层的子图层挂到新 parent（空串为根）；就地修改 layersMeta。 */
    reparentChildren(layersMeta, removedLayerId, newParentId) {
      const parentId = newParentId || '';
      (layersMeta || []).forEach(layer => {
        if ((layer.parent_id || '') === removedLayerId) {
          layer.parent_id = parentId;
        }
      });
    }
  };

  global.LayerModel = LayerModel;
})(typeof window !== 'undefined' ? window : globalThis);
