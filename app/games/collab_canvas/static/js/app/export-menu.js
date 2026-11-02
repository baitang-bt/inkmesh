(function (global) {
  'use strict';

  /**
   * 绑定导出菜单 DOM（切换面板、data-export 点击）。
   * 与笔刷尺寸/撤销按钮分离，避免挤在 CollabBoardController._bindToolbar。
   */
  function bindExportMenu(board) {
    const exportMenu = document.getElementById('exportMenu');
    const exportToggle = document.getElementById('exportToggleBtn');
    const exportPanel = document.getElementById('exportMenuPanel');
    if (exportToggle && exportPanel) {
      exportToggle.addEventListener('click', event => {
        event.stopPropagation();
        exportPanel.classList.toggle('hidden');
        const settingsModal = document.getElementById('settingsModal');
        if (settingsModal) settingsModal.classList.add('hidden');
      });
      document.addEventListener('click', event => {
        if (!exportMenu || exportMenu.contains(event.target)) return;
        exportPanel.classList.add('hidden');
      });
    }
    const exportSpecialToggle = document.getElementById('exportSpecialToggle');
    const exportSpecialPanel = document.getElementById('exportSpecialPanel');
    if (exportSpecialToggle && exportSpecialPanel) {
      exportSpecialToggle.addEventListener('click', event => {
        event.stopPropagation();
        const open = exportSpecialPanel.classList.toggle('hidden');
        exportSpecialToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
    }
    document.querySelectorAll('[data-export]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        const formatId = btn.dataset.export || 'png';
        if (exportPanel) exportPanel.classList.add('hidden');
        if (exportSpecialPanel) exportSpecialPanel.classList.add('hidden');
        if (exportSpecialToggle) exportSpecialToggle.setAttribute('aria-expanded', 'false');
        board.exportAllBoards(formatId);
      });
    });
  }

  global.bindExportMenu = bindExportMenu;
})(typeof window !== 'undefined' ? window : globalThis);
