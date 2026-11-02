(function (global) {
  'use strict';

  /**
   * 快捷键 / 工具栏动作表：把 actionId 映射到 CollabBoardController 方法调用。
   * 新增动作只改本表 + shortcut-registry，不堆进 executeAction switch。
   */
  const BoardActions = {
    /** 解析并执行动作；未知 id 静默忽略。 */
    run(actionId, board) {
      const id = String(actionId || '');
      const handler = BoardActions._handlers[id];
      if (handler) handler(board);
    },

    _handlers: {
      undo(b) {
        if (!b.canDraw) return;
        b.adapter.sendHistoryAction('undo');
      },
      redo(b) {
        if (!b.canDraw) return;
        b.adapter.sendHistoryAction('redo');
      },
      clearLayer(b) {
        if (!b.canDraw) return;
        if (b._activeLayerLocked()) return;
        if (confirm('清空当前图层？')) b.adapter.sendHistoryAction('clear');
      },
      toolBrush(b) { b._setTool('brush'); },
      toolEraser(b) { b._setTool('eraser'); },
      toolZoom(b) { b._setTool('zoom'); },
      toolFill(b) { b._setTool('fillBucket'); },
      toolLine(b) { b._setTool('line'); },
      toolEyedropper(b) { b._setTool('eyedropper'); },
      toolHand(b) { b._setTool('hand'); },
      toolMove(b) { b._setTool('move'); },
      selectionDelete(b) {
        if (b.selectionManager) b.selectionManager.deleteSelection();
      },
      selectionFill(b) {
        if (b.selectionManager) b.selectionManager.fillSelection(b.currentColor);
      },
      brushSizeUp(b) { b._adjustBrushSize(1); },
      brushSizeDown(b) { b._adjustBrushSize(-1); },
      debounceBoost(b) {
        if (b.strokeSmoother) b.strokeSmoother.setBoost(!b.strokeSmoother.boost);
      },
      zoomIn(b) { b._zoomAtCenter(true); },
      zoomOut(b) { b._zoomAtCenter(false); },
      resetView(b) {
        if (b.viewport) b.viewport.resetView();
      },
      layerNew(b) { b.createLayer(); },
      layerDelete(b) {
        if (b.activeLayerId && b.canDeleteLayer(b.activeLayerId) && confirm('删除当前图层？')) {
          b.deleteLayer(b.activeLayerId);
        } else if (b.activeLayerId && !b.canDeleteLayer(b.activeLayerId)) {
          b._layerUiMessage('至少保留一个图层');
        }
      },
      layerUp(b) { b._moveActiveLayer(-1); },
      layerDown(b) { b._moveActiveLayer(1); },
      layerToggleVisible(b) {
        const layer = b.layersMeta.find(l => l.layer_id === b.activeLayerId);
        if (layer) b.updateLayer(layer.layer_id, { visible: layer.visible === false });
      },
      layerToggleLock(b) {
        const lockedLayer = b.layersMeta.find(l => l.layer_id === b.activeLayerId);
        if (lockedLayer) b.updateLayer(lockedLayer.layer_id, { locked: !lockedLayer.locked });
      },
      layerRename(b) {
        if (b.layerPanel && b.activeLayerId) b.layerPanel.startRename(b.activeLayerId);
      },
      boardNew(b) { b.createBoard(); },
      boardPrev(b) { b._stepBoard(-1); },
      boardNext(b) { b._stepBoard(1); },
      exportPng(b) { if (b.canSave) b.exportAllBoards('png'); },
      exportJpeg(b) { if (b.canSave) b.exportAllBoards('jpeg'); },
      exportKra(b) { if (b.canSave) b.exportAllBoards('kra'); },
      exportSkt(b) { if (b.canSave) b.exportAllBoards('skt'); },
      exportHsj(b) { if (b.canSave) b.exportAllBoards('hsj'); },
      exportProcreate(b) { if (b.canSave) b.exportAllBoards('procreate'); },
      exportPsd(b) { if (b.canSave) b.exportAllBoards('psd'); },
      exportPbcc(b) { if (b.canSave) b.exportAllBoards('pbcc'); },
      copyLink(b) {
        if (b._roomActions.copyLink) b._roomActions.copyLink();
      },
      leaveRoom(b) {
        if (b._roomActions.leaveRoom) b._roomActions.leaveRoom();
      },
      openSettings(b) {
        if (b._roomActions.openSettings) b._roomActions.openSettings();
      },
      swapColors(b) {
        if (b.colorPair) {
          b.colorPair.swap();
          b.currentColor = b.colorPair.foreground;
          if (b.colorPicker) b.colorPicker.setColor(b.currentColor);
          if (b.popupPalette) b.popupPalette.refresh();
        }
      }
    }
  };

  global.BoardActions = BoardActions;
})(typeof window !== 'undefined' ? window : globalThis);
