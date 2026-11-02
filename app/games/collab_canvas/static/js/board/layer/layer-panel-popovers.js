(function (global) {
  'use strict';

  /**
   * 图层面板弹层：添加菜单、属性 popover、右键菜单、文档级关闭。
   */
  const LayerPanelPopovers = {
    /** 安装弹层相关方法到 LayerPanel.prototype。 */
    install(LayerPanelClass) {
      const proto = LayerPanelClass.prototype;
      proto._closePopup = function() {
      if (this._openPopup && this._openPopup.parentNode) {
        this._openPopup.parentNode.removeChild(this._openPopup);
      }
      if (this._openPopupAnchor) {
        this._openPopupAnchor.classList.remove('is-open');
        this._openPopupAnchor.setAttribute('aria-expanded', 'false');
      }
      this._openPopup = null;
      this._openPopupAnchor = null;
      this._propsOpacityInput = null;
      this._propsOpacityOut = null;
    };

      proto._positionPopup = function(anchorEl, popupEl, prefer) {
      if (!anchorEl || !popupEl) return;
      const rect = anchorEl.getBoundingClientRect();
      popupEl.style.position = 'fixed';
      popupEl.style.zIndex = '2100';
      const popupRect = popupEl.getBoundingClientRect();
      let top = rect.top - popupRect.height - 4;
      if (prefer !== 'above' || top < 4) {
        top = rect.bottom + 4;
      }
      if (top + popupRect.height > window.innerHeight - 4) {
        top = Math.max(4, rect.top - popupRect.height - 4);
      }
      let left = rect.left;
      if (left + popupRect.width > window.innerWidth - 4) {
        left = window.innerWidth - popupRect.width - 4;
      }
      popupEl.style.left = Math.round(left) + 'px';
      popupEl.style.top = Math.round(top) + 'px';
    };

      proto._openAnchoredPopup = function(anchorEl, popupEl, options) {
      const settings = options || {};
      if (this._openPopup === popupEl && this._openPopupAnchor === anchorEl) {
        this._closePopup();
        return;
      }
      this._closePopup();
      document.body.appendChild(popupEl);
      this._openPopup = popupEl;
      this._openPopupAnchor = anchorEl;
      anchorEl.classList.add('is-open');
      anchorEl.setAttribute('aria-expanded', 'true');
      this._positionPopup(anchorEl, popupEl, settings.prefer);
    };

      proto._toggleAddMenu = function(anchorEl) {
      const menu = document.createElement('div');
      menu.className = 'layer-footer-menu';
      menu.setAttribute('role', 'menu');
      const layerItem = document.createElement('button');
      layerItem.type = 'button';
      layerItem.className = 'layer-footer-menu-item';
      layerItem.textContent = '新建图层';
      layerItem.setAttribute('role', 'menuitem');
      layerItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        this.onCreate();
      });
      const groupItem = document.createElement('button');
      groupItem.type = 'button';
      groupItem.className = 'layer-footer-menu-item';
      groupItem.textContent = '新建图层组';
      groupItem.setAttribute('role', 'menuitem');
      groupItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        this.onCreateGroup();
      });
      const maskItem = document.createElement('button');
      maskItem.type = 'button';
      maskItem.className = 'layer-footer-menu-item';
      maskItem.textContent = '新建蒙版';
      maskItem.setAttribute('role', 'menuitem');
      maskItem.disabled = true;
      maskItem.title = '即将推出';
      menu.appendChild(layerItem);
      menu.appendChild(groupItem);
      menu.appendChild(maskItem);
      this._openAnchoredPopup(anchorEl, menu, { prefer: 'above' });
    };

      proto._buildPropsPopover = function() {
      const popover = document.createElement('div');
      popover.className = 'layer-props-popover';
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', '图层属性');
      const head = document.createElement('div');
      head.className = 'layer-props-head';
      head.textContent = '图层属性';
      const row = document.createElement('div');
      row.className = 'layer-props-row';
      const label = document.createElement('label');
      label.textContent = '不透明度';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '255';
      slider.value = '255';
      const out = document.createElement('output');
      out.textContent = '100%';
      slider.addEventListener('input', () => {
        const value = Number(slider.value);
        out.textContent = Math.round(value / 255 * 100) + '%';
        if (this.activeLayerId) this.onUpdate(this.activeLayerId, { opacity: value });
      });
      slider.addEventListener('pointerdown', event => event.stopPropagation());
      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(out);
      const maskBlock = document.createElement('div');
      maskBlock.className = 'layer-props-mask-placeholder';
      maskBlock.innerHTML = '<h4>蒙版</h4><p>即将推出</p>';
      popover.appendChild(head);
      popover.appendChild(row);
      popover.appendChild(maskBlock);
      this._propsOpacityInput = slider;
      this._propsOpacityOut = out;
      return popover;
    };

      proto._syncPropsPopover = function() {
      if (!this._propsOpacityInput || !this._propsOpacityOut) return;
      const layer = this._activeLayer();
      const opacity = layer && layer.opacity != null ? layer.opacity : 255;
      this._propsOpacityInput.value = String(opacity);
      this._propsOpacityOut.textContent = Math.round(opacity / 255 * 100) + '%';
    };

      proto._togglePropsPopover = function(anchorEl) {
      const existing = this._openPopup;
      if (existing && existing.classList.contains('layer-props-popover')) {
        this._closePopup();
        return;
      }
      const popover = this._buildPropsPopover();
      this._syncPropsPopover();
      this._openAnchoredPopup(anchorEl, popover, { prefer: 'above' });
    };

      proto._showContextMenu = function(layer, clientX, clientY) {
      this._closePopup();
      const menu = document.createElement('div');
      menu.className = 'layer-context-menu';
      menu.setAttribute('role', 'menu');
      const delItem = document.createElement('button');
      delItem.type = 'button';
      delItem.className = 'layer-context-menu-item is-danger';
      delItem.textContent = this._isGroupLayer(layer) ? '删除图层组' : '删除图层';
      delItem.setAttribute('role', 'menuitem');
      const canDelete = this.canDeleteLayer(layer.layer_id);
      if (!canDelete) {
        delItem.disabled = true;
        delItem.title = '至少保留一个图层';
      }
      delItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        if (!canDelete) return;
        if (confirm('删除「' + (layer.name || layer.layer_id) + '」？')) {
          this.onDelete(layer.layer_id);
        }
      });
      const renameItem = document.createElement('button');
      renameItem.type = 'button';
      renameItem.className = 'layer-context-menu-item';
      renameItem.textContent = '重命名图层';
      renameItem.setAttribute('role', 'menuitem');
      renameItem.addEventListener('click', event => {
        event.stopPropagation();
        this._closePopup();
        this.onSwitch(layer.layer_id);
        this.startRename(layer.layer_id);
      });
      menu.appendChild(renameItem);
      menu.appendChild(delItem);
      document.body.appendChild(menu);
      this._openPopup = menu;
      menu.style.position = 'fixed';
      menu.style.left = Math.round(clientX) + 'px';
      menu.style.top = Math.round(clientY) + 'px';
      menu.style.zIndex = '2100';
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth - 4) {
        menu.style.left = Math.round(window.innerWidth - rect.width - 4) + 'px';
      }
      if (rect.bottom > window.innerHeight - 4) {
        menu.style.top = Math.round(window.innerHeight - rect.height - 4) + 'px';
      }
    };

      proto._onDocPointer = function(event) {
      if (!this._openPopup) return;
      if (this._openPopup.contains(event.target)) return;
      const split = this.root && (
        this.root.querySelector('[data-layer-add-split]')?.contains(event.target)
        || this.root.querySelector('[data-layer-props-split]')?.contains(event.target)
      );
      if (split) return;
      this._closePopup();
    };

      proto._onDocKey = function(event) {
      if (event.key !== 'Escape') return;
      if (this._renamingLayerId) {
        this._cancelRename();
        return;
      }
      this._closePopup();
    };

    }
  };

  global.LayerPanelPopovers = LayerPanelPopovers;
})(typeof window !== 'undefined' ? window : globalThis);
