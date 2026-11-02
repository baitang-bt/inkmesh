# 合作画板 — 代码结构（Agent SoT）

> **先读本文件，再改代码。** 按目录跳到对应章节与路径表；禁止全库盲扫。  
> 协议字段见 [collab-canvas-protocol.md](collab-canvas-protocol.md)；部署 / 缓存版本见 [deploy.md](deploy.md)。  
> **改了目录、拆了文件、或调了模块边界 → 同一轮必须更新本文件。**

路径均相对包根 `potatoblock-collab-canvas/`，JS 根为 `app/games/collab_canvas/static/js/`。  
当前 `COLLAB_ASSET_VERSION`：见 `app/games/collab_canvas/routes.py`。

---

## 目录

1. [如何使用](#1-如何使用agent)
2. [总览：两大模块](#2-总览两大模块)
3. [画板 Board](#3-画板-board)
4. [联网 Net](#4-联网-net)
5. [装配 App](#5-装配-app)
6. [改什么 → 去哪](#6-改什么--去哪)
7. [目录树](#7-目录树)
8. [维护约定](#8-维护约定)

---

## 1. 如何使用（Agent）

1. 用 §6「改什么 → 去哪」锁 **1 个域**（Board / Net / App）。
2. 只打开该节列出的文件；不要通读上帝文件 unless 任务点名。
3. Board **禁止** `session.send`（经 App/Net 出口）；Net **禁止** 写 canvas 像素算法。
4. 结构变更后：更新 §3–§7，并 bump `COLLAB_ASSET_VERSION`（见 deploy.md）。

---

## 2. 总览：两大模块

```text
┌──────────── App（装配，薄）────────────┐
│  进房 UI · 接线 · CollabBoardController │
└─────────┬──────────────────┬───────────┘
          │                  │
   ┌──────▼──────┐    ┌──────▼──────┐
   │ Board 画板  │    │  Net 联网   │
   │ 渲染/工具/  │◄──►│  WS/房间/   │
   │ 图层/导出   │    │  同步/权限  │
   └─────────────┘    └─────────────┘
```

| 模块 | 黑盒职责 | 不负责 |
|------|----------|--------|
| **Board** | 本地绘制、图层纯逻辑、工具、选区、颜色、视口、导出格式 | WebSocket、房间权威 |
| **Net** | 会话、批量/重试、入站消息、房间/权限、服务端权威 | 像素渲染、笔刷算法 |
| **App** | 进房屏、组件装配、Board↔Net 编排 | 堆新业务（新功能进 Board 或 Net） |

---

## 3. 画板 Board

**根目录：** `app/games/collab_canvas/static/js/board/`

| 子域 | 路径 | 一句话 |
|------|------|--------|
| core | `board/core/drawing-board.js` | Canvas 引擎 facade（生命周期 / 模型 / 填充） |
| core | `board/core/stroke-render.js` | 描边/形状/喷笔绘制（`DrawingStrokeRender.install`） |
| core | `board/core/layer-compositor.js` | 图层合成与重绘（`DrawingLayerCompositor.install`） |
| core | `board/core/segment-utils.js` | Segment 归一化纯函数 |
| core | `board/core/perfect-freehand.js` | 笔刷轮廓第三方 |
| tool | `board/tool/` | 笔刷/压感/防抖/工具注册与控制器；`pen-input` 真实笔压与 coalesced 采样，`register-tools` 出 segment（含 `simulatePressure`） |
| layer | `board/layer/layer-model.js` | 图层树纯逻辑（coerce/lock/group） |
| layer | `board/layer/layer-panel.js` | 图层面板列表 / 缩略图 / 重命名 |
| layer | `board/layer/layer-panel-popovers.js` | 添加菜单 / 属性 / 右键弹层 |
| layer | `board/layer/layer-thumbnail.js` / `layer-move.js` | 缩略图绘制、层内移动 |
| color | `board/color/` | 取色、色对、最近色、弹层调色板 |
| select | `board/select/` | 选区 FSM、动作条、overlay |
| export | `board/export/` | PBCC / 格式导出；`pbcc-host-service.js` 本机保存（发网只经 `adapter` / `_roomActions`） |
| ui | `board/ui/` | 视口、水印、工具轨、笔刷预览 |

**服务端镜像（校验，非渲染）：** `app/games/common/drawing_board.py`

---

## 4. 联网 Net

**客户端根：** `app/games/collab_canvas/static/js/net/`

| 文件 | 一句话 |
|------|--------|
| `net/collab-session.js` | WebSocket 连接、发送、重连钩子 |
| `net/collab-board-adapter.js` | draw 批量、undo/redo/clear、repair、PBCC sync/import 出口 |
| `net/board-commands.js` | 图层/画板 CRUD `session.send`（install 到控制器） |
| `net/collab-message-handlers.js` | 入站 `handle*` → Board 状态（install 到控制器） |
| `net/cursor-overlay.js` | 远程光标 |
| `net/network-monitor.js` | RTT / 连接状态 UI |
| `net/online-prefs.js` | 联机显示名等偏好 |

**服务端：**

| 路径 | 一句话 |
|------|--------|
| `app/games/collab_canvas/routes.py` | HTTP + 薄 WS 入口（~100 行） |
| `app/games/collab_canvas/room_store.py` | 内存房间 / serialize / broadcast / 占用登记 |
| `ws_handlers/process.py` | 鉴权 + 主循环分发（薄） |
| `ws_handlers/common.py` | 子模块共用 store / drawing_board 符号 |
| `ws_handlers/join_flow.py` | join 进房 |
| `ws_handlers/board_msgs.py` | board_* / room_import / drawing_sync_request |
| `ws_handlers/layer_msgs.py` | layer_* |
| `ws_handlers/draw_msgs.py` | draw / undo / redo / clear |
| `ws_handlers/host_msgs.py` | 权限 / 踢人 / 离开 / 样式 / 光标 |
| `app/games/collab_canvas/protocol.py` | 协议常量 |
| `app/games/common/drawing_board.py` | segment/layer/stroke 权威校验 |

---

## 5. 装配 App

**根目录：** `app/games/collab_canvas/static/js/app/`

| 文件 | 一句话 |
|------|--------|
| `app/collab-app.js` | 进房/退房、组件图、启动 |
| `app/collab-board.js` | `CollabBoardController` 编排（commands/pointer/handlers/PBCC 经 install） |
| `app/board-pointer.js` | 指针绑定 / 光标上送（install） |
| `app/app-session-handlers.js` | `createCollabAppSessionHandlers(ctx)` |
| `app/board-actions.js` | `BoardActions.run` 表驱动快捷键 |
| `app/export-menu.js` | 导出菜单 DOM 绑定 |
| `app/board-panel.js` / `room-panel.js` / `settings-panel.js` | 画板列表 / 成员 / 设置壳 |
| `app/shortcut-*.js` | 快捷键注册与管理 |
| `app/workspace-layout.js` / `ui-prefs.js` / `ui-tooltip.js` | 布局与通用 UI |
| `app/collab-fullscreen.js` / `material-icons.js` / `pen-test-pad.js` | 全屏、图标、压感测试 |

入口模板：`app/games/collab_canvas/templates/index.html`（script 顺序 = 依赖顺序）。

---

## 6. 改什么 → 去哪

| 任务关键词 | 模块 | 优先打开 |
|------------|------|----------|
| 笔刷 / 压感 / 防抖 / coalesced / 新工具 | Board | `board/tool/pen-input.js`、`register-tools.js`、`brush-preset.js`、`board/core/stroke-render.js` |
| 图层合成 / 重绘 | Board | `board/core/layer-compositor.js` |
| 图层锁 / 组 / 面板 UI | Board | `board/layer/` |
| 选区 / 魔棒 | Board | `board/select/` |
| 颜色 / 调色板 | Board | `board/color/` |
| 导出格式 / PBCC | Board | `board/export/` |
| 视口缩放 / 平移 | Board | `board/ui/canvas-viewport.js` |
| WS 发送 / 重连 / batch | Net | `net/collab-session.js`、`net/collab-board-adapter.js` |
| 图层/画板上送命令 | Net | `net/board-commands.js` |
| 入站消息处理 | Net | `net/collab-message-handlers.js` |
| 房间 / 权限 / 踢人 | Net | `ws_handlers/host_msgs.py`、`room_store.py`、`app/room-panel.js` |
| 服务端 draw/layer/board | Net | `ws_handlers/draw_msgs.py` / `layer_msgs.py` / `board_msgs.py` |
| 指针 / 光标 | App | `app/board-pointer.js` |
| 协议字段 | Net | `docs/collab-canvas-protocol.md` + `drawing_board.py` |
| 进房屏 / 深链 | App | `app/collab-app.js` |
| 快捷键动作 | App | `app/board-actions.js`、`app/shortcut-registry.js` |
| 部署缓存 | — | `routes.py` → `COLLAB_ASSET_VERSION` |

---

## 7. 目录树

```text
static/js/
  board/
    core/     drawing-board.js  stroke-render.js  layer-compositor.js
              segment-utils.js  perfect-freehand.js
    tool/     pen-input.js  stroke-smoother.js  brush-preset.js
              tool-registry.js  tool-variant-store.js  tool-controller.js
              register-tools.js
    layer/    layer-model.js  layer-panel.js  layer-panel-popovers.js
              layer-thumbnail.js  layer-move.js
    color/    color-*.js  recent-colors.js  popup-palette.js
    select/   selection-manager.js  selection-actions-bar.js  canvas-overlay.js
    export/   collab-export.js  pbcc-*  *-export.js  zip-store.js  pbcc-host-service.js
    ui/       canvas-viewport.js  canvas-watermark.js  tool-rail.js  brush-preview.js
  net/
    collab-session.js  collab-board-adapter.js  board-commands.js
    collab-message-handlers.js
    cursor-overlay.js  network-monitor.js  online-prefs.js
  app/
    collab-app.js  collab-board.js  board-pointer.js  app-session-handlers.js
    board-actions.js  export-menu.js
    board-panel.js  room-panel.js  settings-panel.js
    shortcut-registry.js  shortcut-manager.js
    workspace-layout.js  ui-prefs.js  ui-tooltip.js
    collab-fullscreen.js  material-icons.js  pen-test-pad.js

app/games/collab_canvas/
  routes.py          # 薄 HTTP + WS 入口
  room_store.py      # 房间态
  ws_handlers/       # process + join/board/layer/draw/host + common
  protocol.py
```


---

## 8. 维护约定

- [ ] 新增 `.js` → 放入 Board / Net / App 之一，并补 §3–§6 一行
- [ ] 移动 / 重命名 → 改 `templates/index.html` script `src` + 本文件路径
- [ ] 纯逻辑优先：`layer-model.js`、`segment-utils.js`、`board-actions.js`
- [ ] 服务端新消息类型 → `ws_handlers/process.py` + protocol.md + §4/§6
- [ ] 改 static 资源 → bump `COLLAB_ASSET_VERSION`
- [ ] **禁止** 再建平铺上帝文件或 `utils.js` 垃圾桶
