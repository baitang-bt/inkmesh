(function (global) {
  'use strict';

  /** 右下图层列表面板（Krita 式底栏 + 属性 popover + 右键菜单）。 */
  class LayerPanel {
    constructor(root, options) {
      const settings = options || {};
      this.root = root;
      this.listEl = root && root.querySelector('[data-layer-list]');
      this.onSwitch = settings.onSwitch || (() => {});
      this.onCreate = settings.onCreate || (() => {});
      this.onCreateGroup = settings.onCreateGroup || (() => {});
      this.onDuplicate = settings.onDuplicate || (() => {});
      this.onDelete = settings.onDelete || (() => {});
      this.canDeleteLayer = settings.canDeleteLayer || (() => true);
      this.onRename = settings.onRename || (() => {});
      this.onReorder = settings.onReorder || (() => {});
      this.onUpdate = settings.onUpdate || (() => {});
      this.getBoardState = settings.getBoardState || (() => null);
      this.activeLayerId = '';
      this.layers = [];
      this._openPopup = null;
      this._openPopupAnchor = null;
      this._propsOpacityInput = null;
      this._propsOpacityOut = null;
      this._renamingLayerId = null;
      this._renameBlurTimer = null;
      this._collapsedGroups = LayerPanel._loadCollapsedGroups();
      this._onDocPointer = this._onDocPointer.bind(this);
      this._onDocKey = this._onDocKey.bind(this);
      document.addEventListener('pointerdown', this._onDocPointer, true);
      document.addEventListener('keydown', this._onDocKey, true);
      this._bindFooter();
    }

    /** 绑定 Krita 式底栏按钮。 */
    _bindFooter() {
      if (!this.root) return;
      const addMain = this.root.querySelector('[data-layer-add-main]');
      const addMenu = this.root.querySelector('[data-layer-add-menu]');
      const dupBtn = this.root.querySelector('[data-layer-duplicate]');
      const upBtn = this.root.querySelector('[data-layer-up]');
      const downBtn = this.root.querySelector('[data-layer-down]');
      const propsMain = this.root.querySelector('[data-layer-props-main]');
      const propsMenu = this.root.querySelector('[data-layer-props-menu]');
      const groupBtn = this.root.querySelector('[data-layer-group]');
      if (addMain) addMain.addEventListener('click', () => this.onCreate());
      if (groupBtn) groupBtn.addEventListener('click', () => this.onCreateGroup());
      if (dupBtn) {
        dupBtn.addEventListener('click', () => {
          const active = this.layers.find(l => l.layer_id === this.activeLayerId);
          if (active && this._isGroupLayer(active)) return;
          this.onDuplicate(this.activeLayerId);
        });
      }
      if (addMenu) {
        addMenu.addEventListener('click', event => {
          event.stopPropagation();
          this._toggleAddMenu(addMenu);
        });
      }
      if (upBtn) upBtn.addEventListener('click', () => this._moveActive(-1));
      if (downBtn) downBtn.addEventListener('click', () => this._moveActive(1));
      if (propsMain) {
        propsMain.addEventListener('click', event => {
          event.stopPropagation();
          this._togglePropsPopover(propsMain);
        });
      }
      if (propsMenu) {
        propsMenu.addEventListener('click', event => {
          event.stopPropagation();
          this._togglePropsPopover(propsMenu);
        });
      }
    }

    setLayers(layers, activeLayerId) {
      this.layers = (layers || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      this.activeLayerId = activeLayerId || '';
      this._render();
      if (this._openPopup && this._openPopup.classList.contains('layer-props-popover')) {
        this._syncPropsPopover();
      }
    }

    setActive(layerId) {
      this.activeLayerId = layerId;
      if (!this.listEl) return;
      this.listEl.querySelectorAll('.layer-row').forEach(row => {
        const active = row.dataset.layerId === layerId;
        row.classList.toggle('is-active', active);
        const check = row.querySelector('.layer-row-check');
        if (check) {
          check.classList.toggle('is-checked', active);
          check.textContent = '';
          if (active) {
            check.appendChild(MaterialIcons.createIcon('check', 'layer-row-check-icon'));
          }
        }
      });
      if (this._openPopup && this._openPopup.classList.contains('layer-props-popover')) {
        this._syncPropsPopover();
      }
    }

    /** 读取本地折叠的图层组 id 集合。 */
    static _loadCollapsedGroups() {
      try {
        const raw = localStorage.getItem('collab-layer-collapsed-v1');
        const list = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(list) ? list : []);
      } catch (_err) {
        return new Set();
      }
    }

    /** 持久化折叠的图层组 id。 */
    _saveCollapsedGroups() {
      try {
        localStorage.setItem(
          'collab-layer-collapsed-v1',
          JSON.stringify(Array.from(this._collapsedGroups))
        );
      } catch (_err) {}
    }

    _isGroupLayer(layer) {
      return LayerModel.isGroupLayer(layer);
    }

    /** 构建树形扁平列表（UI 顶→底，含缩进深度）。 */
    _buildDisplayList() {
      const idSet = new Set(this.layers.map(layer => layer.layer_id));
      const normalized = this.layers.map(layer => {
        const pid = layer.parent_id || '';
        if (pid && !idSet.has(pid)) {
          return Object.assign({}, layer, { parent_id: '' });
        }
        return layer;
      });
      const byParent = new Map();
      normalized.forEach(layer => {
        const pid = layer.parent_id || '';
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(layer);
      });
      const sortByOrder = items => items.sort((a, b) => (a.order || 0) - (b.order || 0));
      const out = [];
      const walk = (parentId, depth) => {
        sortByOrder(byParent.get(parentId) || []).forEach(layer => {
          out.push({ layer, depth });
          if (this._isGroupLayer(layer) && !this._collapsedGroups.has(layer.layer_id)) {
            walk(layer.layer_id, depth + 1);
          }
        });
      };
      walk('', 0);
      if (out.length === 0 && this.layers.length > 0) {
        return normalized
          .slice()
          .sort((a, b) => (a.order || 0) - (b.order || 0))
          .map(layer => ({ layer, depth: 0 }))
          .reverse();
      }
      return out.reverse();
    }

    _flatLayerIdsTopFirst() {
      return this._buildDisplayList().map(entry => entry.layer.layer_id);
    }

    _toggleGroupCollapsed(layerId) {
      if (this._collapsedGroups.has(layerId)) this._collapsedGroups.delete(layerId);
      else this._collapsedGroups.add(layerId);
      this._saveCollapsedGroups();
      this._render();
    }

    _moveActive(delta) {
      const flat = this._flatLayerIdsTopFirst();
      const idx = flat.indexOf(this.activeLayerId);
      if (idx < 0) return;
      const next = idx + delta;
      if (next < 0 || next >= flat.length) return;
      flat.splice(idx, 1);
      flat.splice(next, 0, this.activeLayerId);
      this.onReorder(flat.slice().reverse());
    }

    _activeLayer() {
      return this.layers.find(l => l.layer_id === this.activeLayerId) || null;
    }



    /** 刷新各行缩略图（绘制变更后由 board 调用）。 */
    refreshThumbnails() {
      const state = this.getBoardState();
      if (!state || !this.listEl || !global.LayerThumbnail) return;
      this.listEl.querySelectorAll('.layer-row').forEach(row => {
        const layerId = row.dataset.layerId;
        const layer = this.layers.find(item => item.layer_id === layerId);
        if (!layer || this._isGroupLayer(layer)) return;
        const canvas = row.querySelector('.layer-row-thumb-canvas');
        if (canvas && layer) {
          LayerThumbnail.paint(canvas, state.drawingBoard, state.strokes, layer);
        }
      });
    }

    /** 绑定图层名称双击进入行内重命名。 */
    _bindNameLabel(nameEl, layer) {
      nameEl.addEventListener('dblclick', event => {
        event.stopPropagation();
        this.startRename(layer.layer_id);
      });
    }

    /** 取消进行中的行内重命名（不提交）。 */
    _cancelRename() {
      if (this._renameBlurTimer) {
        window.clearTimeout(this._renameBlurTimer);
        this._renameBlurTimer = null;
      }
      if (!this._renamingLayerId || !this.listEl) {
        this._renamingLayerId = null;
        return;
      }
      const row = this.listEl.querySelector('.layer-row[data-layer-id="' + this._renamingLayerId + '"]');
      const input = row && row.querySelector('.layer-row-name-input');
      if (!input) {
        this._renamingLayerId = null;
        return;
      }
      const layer = this.layers.find(item => item.layer_id === this._renamingLayerId);
      const span = document.createElement('span');
      span.className = 'layer-row-name';
      span.textContent = (layer && layer.name) || this._renamingLayerId;
      if (layer) this._bindNameLabel(span, layer);
      input.replaceWith(span);
      if (row) row.classList.remove('is-renaming');
      this._renamingLayerId = null;
    }

    /** 行内重命名（Krita 式：名称区变为输入框并全选）。 */
    startRename(layerId) {
      if (!this.listEl || !layerId) return;
      if (this._renamingLayerId === layerId) return;
      this._cancelRename();
      const layer = this.layers.find(item => item.layer_id === layerId);
      if (!layer) return;
      const row = this.listEl.querySelector('.layer-row[data-layer-id="' + layerId + '"]');
      if (!row) return;
      const nameEl = row.querySelector('.layer-row-name');
      if (!nameEl) return;

      const originalName = layer.name || layerId;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'layer-row-name-input';
      input.value = originalName;
      input.maxLength = 40;
      input.setAttribute('aria-label', '图层名称');

      const finish = commit => {
        if (this._renameBlurTimer) {
          window.clearTimeout(this._renameBlurTimer);
          this._renameBlurTimer = null;
        }
        if (this._renamingLayerId !== layerId) return;
        const next = input.value.trim();
        if (commit && next && next !== originalName) {
          this.onRename(layerId, next);
        }
        const span = document.createElement('span');
        span.className = 'layer-row-name';
        span.textContent = commit && next ? next : originalName;
        this._bindNameLabel(span, layer);
        if (input.parentNode) input.replaceWith(span);
        row.classList.remove('is-renaming');
        this._renamingLayerId = null;
      };

      input.addEventListener('pointerdown', event => event.stopPropagation());
      input.addEventListener('click', event => event.stopPropagation());
      input.addEventListener('dblclick', event => event.stopPropagation());
      input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        this._renameBlurTimer = window.setTimeout(() => finish(true), 0);
      });

      nameEl.replaceWith(input);
      row.classList.add('is-renaming');
      this._renamingLayerId = layerId;
      input.focus();
      input.select();
    }

    /** 创建 Krita 式行内图标按钮。 */
    _createRowIconBtn(icon, label, options) {
      const settings = options || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layer-row-icon-btn' + (settings.extraClass ? ' ' + settings.extraClass : '');
      btn.setAttribute('data-tooltip', label);
      btn.setAttribute('aria-label', label);
      if (settings.disabled) btn.disabled = true;
      btn.appendChild(MaterialIcons.createIcon(icon, 'layer-row-icon'));
      return btn;
    }

    _render() {
      if (!this.listEl) return;
      this._cancelRename();
      this.listEl.innerHTML = '';
      this._buildDisplayList().forEach(({ layer, depth }) => {
        const isGroup = this._isGroupLayer(layer);
        const isActive = layer.layer_id === this.activeLayerId;
        const row = document.createElement('div');
        row.className = 'layer-row'
          + (isActive ? ' is-active' : '')
          + (isGroup ? ' is-group' : '')
          + (layer.visible === false ? ' is-hidden' : '')
          + (layer.locked ? ' is-locked' : '');
        row.dataset.layerId = layer.layer_id;
        row.style.paddingLeft = (2 + depth * 12) + 'px';

        if (isGroup) {
          const collapsed = this._collapsedGroups.has(layer.layer_id);
          const foldBtn = this._createRowIconBtn(
            collapsed ? 'chevron_right' : 'expand_more',
            collapsed ? '展开图层组' : '折叠图层组'
          );
          foldBtn.classList.add('layer-row-fold-btn');
          foldBtn.addEventListener('click', event => {
            event.stopPropagation();
            this._toggleGroupCollapsed(layer.layer_id);
          });
          row.appendChild(foldBtn);
        }

        const grip = document.createElement('span');
        grip.className = 'layer-row-grip';
        grip.setAttribute('aria-hidden', 'true');
        grip.appendChild(MaterialIcons.createIcon('drag_indicator', 'layer-row-grip-icon'));

        const visBtn = this._createRowIconBtn(
          layer.visible !== false ? 'visibility' : 'visibility_off',
          layer.visible !== false ? '隐藏图层' : '显示图层'
        );
        visBtn.setAttribute('aria-pressed', layer.visible === false ? 'false' : 'true');
        visBtn.addEventListener('click', event => {
          event.stopPropagation();
          this.onUpdate(layer.layer_id, { visible: layer.visible === false });
        });

        const check = document.createElement('span');
        check.className = 'layer-row-check' + (isActive ? ' is-checked' : '');
        check.setAttribute('aria-hidden', 'true');
        if (isActive) {
          check.appendChild(MaterialIcons.createIcon('check', 'layer-row-check-icon'));
        }

        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'layer-row-thumb' + (isGroup ? ' layer-row-thumb--group' : '');
        if (isGroup) {
          thumbWrap.appendChild(MaterialIcons.createIcon('folder', 'layer-row-folder-icon'));
        } else {
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.className = 'layer-row-thumb-canvas';
          thumbCanvas.width = global.LayerThumbnail ? LayerThumbnail.THUMB_SIZE : 36;
          thumbCanvas.height = global.LayerThumbnail ? LayerThumbnail.THUMB_SIZE : 36;
          thumbCanvas.setAttribute('aria-hidden', 'true');
          thumbWrap.appendChild(thumbCanvas);
        }

        const typeIcon = document.createElement('span');
        typeIcon.className = 'layer-row-type';
        typeIcon.setAttribute('data-tooltip', isGroup ? '图层组' : '绘画图层');
        typeIcon.appendChild(MaterialIcons.createIcon(isGroup ? 'folder' : 'brush', 'layer-row-type-icon'));

        const name = document.createElement('span');
        name.className = 'layer-row-name';
        name.textContent = layer.name || layer.layer_id;
        this._bindNameLabel(name, layer);

        const actions = document.createElement('div');
        actions.className = 'layer-row-actions';

        const lockBtn = this._createRowIconBtn(layer.locked ? 'lock' : 'lock_open', layer.locked ? '解锁图层' : '锁定图层');
        lockBtn.setAttribute('aria-pressed', layer.locked ? 'true' : 'false');
        lockBtn.addEventListener('click', event => {
          event.stopPropagation();
          this.onUpdate(layer.layer_id, { locked: !layer.locked });
        });

        const alphaBtn = document.createElement('button');
        alphaBtn.type = 'button';
        alphaBtn.className = 'layer-row-icon-btn layer-row-icon-btn--stub layer-row-alpha-btn';
        alphaBtn.setAttribute('data-tooltip', '继承 Alpha · 即将推出');
        alphaBtn.setAttribute('aria-label', '继承 Alpha');
        alphaBtn.disabled = true;
        alphaBtn.textContent = 'α';
        const transBtn = this._createRowIconBtn('grid_on', '锁定透明像素 · 即将推出', {
          disabled: true,
          extraClass: 'layer-row-icon-btn--stub'
        });

        actions.appendChild(lockBtn);
        actions.appendChild(alphaBtn);
        actions.appendChild(transBtn);

        row.appendChild(grip);
        row.appendChild(visBtn);
        row.appendChild(check);
        row.appendChild(thumbWrap);
        row.appendChild(typeIcon);
        row.appendChild(name);
        row.appendChild(actions);

        row.addEventListener('click', () => this.onSwitch(layer.layer_id));
        row.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          this._showContextMenu(layer, event.clientX, event.clientY);
        });
        this.listEl.appendChild(row);
      });
      this.refreshThumbnails();
    }
  }

  LayerPanelPopovers.install(LayerPanel);

  global.LayerPanel = LayerPanel;
})(window);
