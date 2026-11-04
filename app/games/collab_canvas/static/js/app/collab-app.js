(function (global) {
  'use strict';

  const boot = window.COLLAB_BOOT || {};
  const selfId = boot.userId || '';
  const nickname = boot.nickname || '';
  let basePath = String(boot.basePath || '/inkmesh').replace(/\/$/, '') || '/inkmesh';
  let runtimeWsUrl = '';

  const joinScreen = document.getElementById('joinScreen');
  const roomScreen = document.getElementById('roomScreen');
  const roomCodeEl = document.getElementById('roomCode');
  const statusEl = document.getElementById('statusText');
  const joinErrorEl = document.getElementById('joinError');
  const joinStatusEl = document.getElementById('joinStatus');
  const roomInput = document.getElementById('roomInput');
  const restoreCheckbox = document.getElementById('restoreLastBoard');
  const openPbccBtn = document.getElementById('openPbccBtn');
  const openPbccInput = document.getElementById('openPbccInput');
  const openPbccHint = document.getElementById('openPbccHint');

  let pendingPbccDocument = null;
  let pendingRestoreLocal = false;
  let restoreAttempted = false;
  let lobbyHome = null;
  let lobbyProfile = null;

  const RESERVED = { 'random-room': 1, ws: 1 };
  const ROOM_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,7}$/;
  const ROOM_ID_MAX_LEN = 8;
  const ROOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const ROOM_FIRST = ROOM_ALPHABET.replace('P', '');

  /** 拉取 Pages/本地可选 config.json（wsUrl、basePath）。 */
  async function loadRuntimeConfig() {
    try {
      const res = await fetch(basePath + '/config.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.basePath === 'string' && data.basePath.trim()) {
        basePath = String(data.basePath).replace(/\/$/, '') || basePath;
      }
      if (data && typeof data.wsUrl === 'string' && data.wsUrl.trim()) {
        runtimeWsUrl = data.wsUrl.trim();
      }
    } catch (_err) {
      // 本地 FastAPI 无 config.json 时保持同源信令。
    }
  }

  /** 生成本地 8 位房间号（静态站无 /random-room API 时使用）。 */
  function generateLocalRoomId() {
    let code = ROOM_FIRST.charAt(Math.floor(Math.random() * ROOM_FIRST.length));
    for (let i = 0; i < ROOM_ID_MAX_LEN - 1; i += 1) {
      code += ROOM_ALPHABET.charAt(Math.floor(Math.random() * ROOM_ALPHABET.length));
    }
    return code;
  }

  function setJoinError(text) {
    if (joinErrorEl) joinErrorEl.textContent = text || '';
    if (text && joinStatusEl) joinStatusEl.textContent = '';
  }

  function setJoinStatus(text) {
    if (joinStatusEl) joinStatusEl.textContent = text || '';
    if (text && joinErrorEl) joinErrorEl.textContent = '';
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
    if (joinScreen && !joinScreen.classList.contains('hidden')) {
      setJoinStatus(text);
    }
  }

  function roomIdFromPath() {
    const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(location.pathname || '').match(
      new RegExp('^' + escaped + '/([^/]+)/?$', 'i')
    );
    if (!match) return '';
    let id = '';
    try {
      id = decodeURIComponent(match[1]).trim().toUpperCase();
    } catch (_err) {
      return '';
    }
    if (!id || RESERVED[id.toLowerCase()]) return '';
    if (!ROOM_ID_PATTERN.test(id)) return '';
    return id;
  }

  function roomShareUrl(roomId) {
    const id = String(roomId || '').trim();
    if (!id) return '';
    return location.origin + basePath + '/' + encodeURIComponent(id);
  }

  function syncRoomDeepLink(roomId) {
    const id = String(roomId || '').trim().toUpperCase();
    if (!id) return;
    const target = basePath + '/' + encodeURIComponent(id);
    if (location.pathname === target) return;
    try {
      history.replaceState(null, '', target);
    } catch (_err) {}
  }

  function showJoinScreen(message) {
    if (joinScreen) joinScreen.classList.remove('hidden');
    if (roomScreen) roomScreen.classList.add('hidden');
    setCollabRoomScrollLock(false);
    setJoinError(message || '');
    setJoinStatus('');
    setStatus('');
    try {
      history.replaceState(null, '', basePath);
    } catch (_err) {}
    if (lobbyHome) lobbyHome.refresh();
  }

  function showRoomScreen(roomId) {
    if (joinScreen) joinScreen.classList.add('hidden');
    if (roomScreen) roomScreen.classList.remove('hidden');
    setCollabRoomScrollLock(true);
    if (roomCodeEl) roomCodeEl.textContent = roomId;
    syncRoomDeepLink(roomId);
    setJoinError('');
    setJoinStatus('');
  }

  const onlinePrefs = new OnlinePrefs();
  let session = null;
  onlinePrefs.onChange = () => {
    const displayName = onlinePrefs.resolveDisplayName(nickname);
    if (session && session.connected) {
      session.sendPlayerStyle({
        label_color: onlinePrefs.getWireLabelColor(),
        display_name: displayName
      });
    }
    if (boardController && roomPanel) {
      const list = boardController.getPlayersSnapshot().slice();
      const idx = list.findIndex(p => p.uid === boardController.selfId);
      if (idx >= 0) {
        list[idx] = Object.assign({}, list[idx], { name: displayName });
        boardController.setPlayersSnapshot(list);
        roomPanel.setPlayers(list);
      }
    }
    if (lobbyProfile) lobbyProfile.refresh();
    if (settingsPanel && settingsPanel.syncOnlineFromPrefs) settingsPanel.syncOnlineFromPrefs();
  };

  const canvas = document.getElementById('drawCanvas');
  const stage = document.getElementById('canvasStage');
  const stageSurface = document.getElementById('canvasStageSurface');
  const cursorLayer = document.getElementById('cursorLayer');
  const zoomBadge = document.getElementById('canvasZoomBadge');

  disableCollabBrowserZoom(roomScreen);
  lockCollabPageScroll(roomScreen);
  if (roomScreen && !roomScreen.classList.contains('hidden')) {
    setCollabRoomScrollLock(true);
  }
  initUiTooltips(roomScreen);

  const uiPrefs = new UiPrefs();
  const collabWorkspaceEl = document.getElementById('collabWorkspace');
  uiPrefs.applyToWorkspace(collabWorkspaceEl);

  const canvasViewport = new CanvasViewport({
    stage,
    surface: stageSurface,
    badge: zoomBadge,
    gesturesEnabled: uiPrefs.getGesturesEnabled()
  });

  uiPrefs.onChange(() => {
    // 同步多指手势开关与工作区布局。
    canvasViewport.setGesturesEnabled(uiPrefs.getGesturesEnabled());
    uiPrefs.applyToWorkspace(document.getElementById('collabWorkspace'));
  });

  const workspaceLayout = new WorkspaceLayout({
    root: document.getElementById('collabWorkspace'),
    rightDock: document.getElementById('dockRight'),
    splitter: document.getElementById('dockSplitter'),
    gutterLeft: document.getElementById('dockGutterLeft'),
    gutterRight: document.getElementById('dockGutterRight'),
    rightTop: document.getElementById('dockRightTop'),
    rightBottom: document.getElementById('dockRightBottom')
  });

  let boardController = null;
  let settingsPanel = null;
  let popupPalette = null;
  let roomPanel = null;

  const colorPair = new ColorPairState({
    onChange: snap => {
      if (boardController) boardController.currentColor = snap.foreground;
      if (popupPalette && popupPalette.isOpen()) popupPalette.refresh();
    }
  });

  const recentColors = new RecentColors({
    onChange: () => {
      if (popupPalette && popupPalette.isOpen()) popupPalette.refresh();
    }
  });

  const penInput = new PenInput({
    getBaseSize: () => (boardController ? boardController.currentSize : 8),
    onActivity: active => stage && stage.classList.toggle('stylus-ready', active)
  });

  const strokeSmoother = new StrokeSmoother();

  const cursorOverlay = new CursorOverlay(cursorLayer, {
    selfId,
    resolveLabelColor: (playerId, wireColor) => onlinePrefs.resolveLabelColor(playerId, wireColor),
    getLogicalWidth: () => (boardController ? boardController.drawingBoard.logicalWidth : 1920),
    getCanvas: () => canvas
  });

  const toolRail = new ToolRail(document.getElementById('dockLeft'), {
    initialTool: 'brush',
    onChange: toolId => {
      if (boardController) boardController.currentTool = toolId;
      if (stage) stage.dataset.tool = toolId;
    }
  });

  uiPrefs.onChange(() => {
    uiPrefs.applyToWorkspace(collabWorkspaceEl);
    toolRail.repositionOpenFlyout();
  });

  const colorPicker = new ColorPicker(document.getElementById('colorPickerMount'), {
    initialColor: colorPair.foreground,
    onChange: color => {
      colorPair.setColor('fg', color);
      if (boardController) boardController.currentColor = color;
    },
    onCommit: color => {
      recentColors.push(color);
    },
    onModeChange: () => {
      if (popupPalette && popupPalette.isOpen()) popupPalette.refresh();
    }
  });

  SettingsPanel.fillModeOptions(document.getElementById('settingsColorMode'));

  const boardPanel = new BoardPanel(document.getElementById('boardPanelPane'), {
    onSwitch: boardId => boardController && boardController.switchBoard(boardId),
    onCreate: () => boardController && boardController.createBoard(),
    onRename: (id, title) => boardController && boardController.renameBoard(id, title),
    onDelete: id => boardController && boardController.deleteBoard(id),
    canDeleteBoard: id => boardController && boardController.canDeleteBoard(id),
    getPlayersForBoard: boardId => {
      if (!boardController) return [];
      const target = String(boardId || 'b_default');
      return boardController.getPlayersSnapshot()
        .filter(p => p.connected && String(p.active_board_id || 'b_default') === target)
        .sort((a, b) => {
          if (a.is_host && !b.is_host) return -1;
          if (!a.is_host && b.is_host) return 1;
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
        });
    },
    getSelfId: () => (boardController ? boardController.selfId : '')
  });

  const layerPanel = new LayerPanel(document.getElementById('layerPanelPane'), {
    onSwitch: layerId => boardController && boardController.switchLayer(layerId),
    onCreate: () => boardController && boardController.createLayer(),
    onCreateGroup: () => boardController && boardController.createLayerGroup(),
    onDuplicate: layerId => boardController && boardController.duplicateLayer(layerId),
    onDelete: layerId => boardController && boardController.deleteLayer(layerId),
    canDeleteLayer: layerId => boardController && boardController.canDeleteLayer(layerId),
    onRename: (id, name) => boardController && boardController.renameLayer(id, name),
    onReorder: order => boardController && boardController.reorderLayers(order),
    onUpdate: (id, patch) => boardController && boardController.updateLayer(id, patch),
    getBoardState: () => (boardController ? {
      drawingBoard: boardController.drawingBoard,
      strokes: boardController.strokes
    } : null)
  });

  workspaceLayout.registry.register({ id: 'colorPicker', title: '调色', slot: 'rightTop', mountNode: document.getElementById('colorPickerMount') });
  workspaceLayout.registry.register({ id: 'layerPanel', title: '图层', slot: 'rightBottom', mountNode: document.getElementById('layerPanelPane') });
  workspaceLayout.registry.register({ id: 'boardPanel', title: '画板', slot: 'rightBottom', mountNode: document.getElementById('boardPanelPane') });

  function copyRoomLink() {
    const roomId = session.roomId || (roomCodeEl && roomCodeEl.textContent);
    const link = roomShareUrl(roomId);
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => setStatus('链接已复制'));
  }

  /** 房主退出：有房客则自动转移房主；无房客则提醒保存 .pbcc。 */
  async function leaveRoom() {
    if (boardController) {
      boardController.stopPbccAutoSave();
    }
    const isHost = boardController && boardController.isHost();
    const guests = boardController.getPlayersSnapshot().filter(p => p.uid !== boardController.ownerId).length;
    if (isHost && guests === 0) {
      // 无房客：提醒保存，离开后画板将从服务端删除。
      const wantSave = confirm('房间内没有其他成员，离开后画板会被删除。\n是否先导出 .pbcc 保存画板？');
      if (wantSave && boardController) {
        await boardController.exportAllBoards('pbcc');
      }
    } else if (isHost && guests > 0) {
      // 有房客：服务端会自动转移房主，先通知一下。
      setStatus('正在离开房间，房主将转移给其他房客…');
    }
    if (session.roomId) {
      session.leaveRoom();
      return;
    }
    session.disconnect();
    cursorOverlay.clear();
    showJoinScreen('');
  }

  /** 房主进房后尝试从 .pbcc 文件或本机记忆恢复。 */
  async function maybeRestorePbccAfterJoin(data) {
    if (restoreAttempted || !boardController) return;
    restoreAttempted = true;
    const isHost = data.self_id && data.self_id === data.owner_id;
    if (!isHost) return;
    let restoreResult = 'none';
    if (pendingPbccDocument) {
      restoreResult = await boardController.tryRestoreLocalPbcc({ document: pendingPbccDocument });
      pendingPbccDocument = null;
      if (openPbccHint) openPbccHint.textContent = '';
    } else if (pendingRestoreLocal) {
      restoreResult = await boardController.tryRestoreLocalPbcc({ fromLocal: true });
      if (restoreResult === 'none') {
        setStatus('未找到本机保存的画板');
        window.setTimeout(() => setStatus(''), 3000);
      }
    }
    boardController.schedulePbccAutoSave();
  }

  const sessionCtx = {
    get session() { return session; },
    get boardController() { return boardController; },
    get roomPanel() { return roomPanel; },
    get boardPanel() { return boardPanel; },
    get lobbyHome() { return lobbyHome; },
    cursorOverlay,
    onlinePrefs,
    nickname,
    roomScreen,
    setStatus,
    setJoinError,
    resetJoinControls,
    showJoinScreen,
    showRoomScreen,
    get maybeRestorePbccAfterJoin() { return maybeRestorePbccAfterJoin; },
    copyRoomLink
  };

  session = new CollabSession({
    selfId,
    nickname,
    wsUrl: runtimeWsUrl,
    getDisplayName: () => onlinePrefs.resolveDisplayName(nickname),
    getRoomSnapshot: forPlayerId => {
      if (!boardController || !boardController.buildP2pSnapshot) return null;
      return boardController.buildP2pSnapshot(forPlayerId);
    },
    runHostAuthority: (playerId, data) => {
      if (!boardController || !boardController.runP2pHostAuthority) return null;
      return boardController.runP2pHostAuthority(playerId, data);
    },
    handlers: createCollabAppSessionHandlers(sessionCtx)
  });


  const shortcutManager = new ShortcutManager({
    execute: actionId => {
      if (boardController) boardController.executeAction(actionId);
    },
    isModalOpen: () => (settingsPanel && settingsPanel.isOpen()) || (roomPanel && roomPanel.isOpen()),
    isPopupOpen: () => popupPalette && popupPalette.isOpen(),
    isRoomActive: () => roomScreen && !roomScreen.classList.contains('hidden')
  });

  const networkMonitor = new NetworkMonitor({
    session,
    root: document.querySelector('[data-settings-pane="network"]')
  });

  settingsPanel = new SettingsPanel({
    colorPicker,
    penInput,
    strokeSmoother,
    viewport: canvasViewport,
    shortcutManager,
    networkMonitor,
    recentColors,
    getBrushSize: () => (boardController ? boardController.currentSize : 8),
    getBrushColor: () => (colorPair ? colorPair.foreground : '#111827'),
    getDrawingBoard: () => (boardController ? boardController.drawingBoard : null),
    getBoardController: () => boardController,
    onlinePrefs,
    uiPrefs,
    session,
    getNickname: () => nickname,
    onOpen: () => {
      const exportPanel = document.getElementById('exportMenuPanel');
      if (exportPanel) exportPanel.classList.add('hidden');
      if (popupPalette) popupPalette.close();
    }
  });

  boardController = new CollabBoardController({
    canvas,
    stage,
    viewport: canvasViewport,
    session,
    cursorOverlay,
    boardPanel,
    layerPanel,
    toolRail,
    colorPicker,
    colorPair,
    penInput,
    strokeSmoother,
    recentColors,
    onlinePrefs,
    selfId,
    onRoomChange: () => {}
  });

  popupPalette = new PopupPalette({
    colorPicker,
    toolRail,
    colorPair,
    recentColors,
    isDrawing: () => boardController && boardController.isDrawing,
    isPanning: () => canvasViewport.isPanning(),
    isModalOpen: () => (settingsPanel && settingsPanel.isOpen()) || (roomPanel && roomPanel.isOpen()),
    onColorApplied: snap => {
      boardController.currentColor = snap.foreground;
    }
  });
  boardController.popupPalette = popupPalette;

  roomPanel = new RoomPanel({
    session,
    getSelfId: () => boardController.selfId,
    getOwnerId: () => boardController.ownerId,
    onKick: targetId => session.kickPlayer(targetId),
    onSetPermissions: patch => session.sendHostPermissions(patch)
  });

  const roomPanelToggleBtn = document.getElementById('roomPanelToggleBtn');

  /** 开关房间成员面板（与 Tab 键相同；设置弹窗打开时不触发）。 */
  function tryToggleRoomPanel() {
    if (!roomScreen || roomScreen.classList.contains('hidden')) return;
    if (settingsPanel && settingsPanel.isOpen()) return;
    roomPanel.toggle();
  }

  if (roomPanelToggleBtn) {
    roomPanelToggleBtn.addEventListener('click', () => tryToggleRoomPanel());
  }

  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!roomScreen || roomScreen.classList.contains('hidden')) return;
    const target = event.target;
    if (target && target.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (settingsPanel && settingsPanel.isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    tryToggleRoomPanel();
  }, true);

  if (stage) {
    stage.dataset.tool = toolRail.getTool();
    if (boardController) boardController._applyToolCursor(toolRail.getTool());
  }

  boardController.setRoomActions({
    copyLink: copyRoomLink,
    leaveRoom,
    openSettings: () => settingsPanel.open(),
    setStatus,
    getRoomId: () => (session && session.roomId) || '',
    getDisplayName: () => onlinePrefs.resolveDisplayName(nickname)
  });

  function enterRoom(roomId) {
    const id = String(roomId || '').trim().toUpperCase().slice(0, ROOM_ID_MAX_LEN);
    if (!id) {
      setJoinError('请输入房间号');
      return;
    }
    if (!ROOM_ID_PATTERN.test(id)) {
      setJoinError('房间号须为 2–8 位字母或数字');
      return;
    }
    setJoinError('');
    setStatus('正在进入房间…');
    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) joinBtn.disabled = true;
    pendingRestoreLocal = Boolean(restoreCheckbox && restoreCheckbox.checked);
    if (global.PbccLocalStore) {
      PbccLocalStore.setRestorePref(pendingRestoreLocal);
    }
    restoreAttempted = false;
    session.joinRoom(id);
  }

  function resetJoinControls() {
    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) joinBtn.disabled = false;
  }

  if (restoreCheckbox && global.PbccLocalStore) {
    restoreCheckbox.checked = PbccLocalStore.getRestorePref();
    restoreCheckbox.addEventListener('change', () => {
      PbccLocalStore.setRestorePref(restoreCheckbox.checked);
    });
  }

  /** 触发本机选择 .pbcc 文件。 */
  function triggerPbccImport() {
    if (openPbccInput) openPbccInput.click();
  }

  if (openPbccBtn && openPbccInput) {
    openPbccBtn.addEventListener('click', () => triggerPbccImport());
    openPbccInput.addEventListener('change', async () => {
      const file = openPbccInput.files && openPbccInput.files[0];
      openPbccInput.value = '';
      if (!file || !global.PbccFormat) return;
      try {
        pendingPbccDocument = await PbccFormat.readFile(file);
        if (openPbccHint) openPbccHint.textContent = file.name;
        setJoinError('');
        const importTitle = global.LobbyHomeTitleFromDocument
          ? LobbyHomeTitleFromDocument(pendingPbccDocument)
          : '';
        const roomId = lobbyHome ? lobbyHome.generateRoomId() : '';
        if (!roomId) {
          setJoinError('无法生成房间号');
          return;
        }
        if (global.LobbyHistory && importTitle) {
          LobbyHistory.rememberRoom(roomId, importTitle);
        }
        enterRoom(roomId);
      } catch (err) {
        pendingPbccDocument = null;
        if (openPbccHint) openPbccHint.textContent = '';
        setJoinError(err.message || '无法读取 .pbcc 文件');
      }
    });
  }

  const joinBtn = document.getElementById('joinBtn');
  if (joinBtn) {
    joinBtn.addEventListener('click', () => {
      enterRoom(roomInput.value);
    });
  }

  const randomRoomBtn = document.getElementById('randomRoomBtn');
  if (randomRoomBtn) {
    randomRoomBtn.addEventListener('click', async () => {
      try {
        const response = await fetch(basePath + '/random-room', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('api');
        const data = await response.json();
        if (data.room_id) {
          roomInput.value = data.room_id;
          return;
        }
        throw new Error('api');
      } catch (_err) {
        roomInput.value = generateLocalRoomId();
        setJoinStatus('已生成本地房间号');
      }
    });
  }

  const leaveRoomBtn = document.getElementById('leaveRoomBtn');
  if (leaveRoomBtn) leaveRoomBtn.addEventListener('click', () => leaveRoom());

  if (roomInput) {
    roomInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') enterRoom(roomInput.value);
    });
  }

  if (global.LobbyHome) {
    lobbyHome = new LobbyHome({
      root: joinScreen,
      userId: selfId,
      onEnterRoom: roomId => enterRoom(roomId),
      onImportFile: () => triggerPbccImport()
    });
    lobbyHome.bind();
    lobbyHome.refresh();
  }

  if (global.LobbyProfile) {
    lobbyProfile = new LobbyProfile({
      onlinePrefs,
      passportNickname: nickname,
      playerId: selfId
    });
    lobbyProfile.bind();
  }

  if (typeof createCollabFullscreen === 'function') {
    createCollabFullscreen();
  }

  /** 读完可选 config 后再注册 PWA / 连信令，保证 basePath 与 wsUrl 已生效。 */
  loadRuntimeConfig().then(() => {
    if (runtimeWsUrl) session.wsUrl = runtimeWsUrl;
    if (typeof createPwaInstall === 'function') {
      createPwaInstall({
        basePath,
        setStatus: setJoinStatus
      }).bind();
    }
    // 静态站无 Worker 地址时不要连同源 /inkmesh/ws（Pages 上必失败）。
    if (boot.staticMode && !runtimeWsUrl) {
      setJoinStatus('公开站尚未配置信令 wsUrl（deploy/pages/config.json）；大厅可用，联机需部署 Worker');
      return;
    }
    const pathRoom = roomIdFromPath() || (boot.initialRoom || '').trim().toUpperCase();
    if (pathRoom && roomInput) roomInput.value = pathRoom;
    // 公开站 Worker 强制 ?room=；无房间时不预连，进房由 joinRoom 再 connect。
    if (pathRoom) {
      pendingRestoreLocal = Boolean(restoreCheckbox && restoreCheckbox.checked);
      restoreAttempted = false;
      setStatus('正在进入房间…');
      if (joinBtn) joinBtn.disabled = true;
      session.joinRoom(pathRoom);
    }
  });
})(window);
