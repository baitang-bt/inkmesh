# Inkmesh — 代码结构（Agent SoT）

> **先读本文件，再改代码。** 按域跳到对应章节；禁止全库盲扫。  
> 协议 SoT：[packages/ink-net/protocol.md](../packages/ink-net/protocol.md)（旧链接 [collab-canvas-protocol.md](collab-canvas-protocol.md) 仅占位）。  
> 部署 / 缓存版本见 [deploy.md](deploy.md)。  
> **改了目录、拆了文件、或调了模块边界 → 同一轮必须更新本文件。**

仓库根：`inkmesh/`。浏览器 JS 分三处：

| 包 / 树 | 物理路径 | URL 前缀 |
|---------|----------|----------|
| **ink-engine** | `packages/ink-engine/js/board/` | `/static/packages/ink-engine/` |
| **ink-net** | `packages/ink-net/js/` | `/static/packages/ink-net/` |
| **App** | `app/games/collab_canvas/static/js/app/` | `/static/games/inkmesh/` |

当前 `COLLAB_ASSET_VERSION`：见 `app/games/collab_canvas/routes.py`。

契约：`packages/ink-engine/CONTRACT.md`、`packages/ink-net/CONTRACT.md`。  
多对话泳道：`docs/agent/context.md`。

---

## 目录

1. [如何使用](#1-如何使用agent)
2. [总览：双包 + App](#2-总览双包--app)
3. [ink-engine（画笔引擎）](#3-ink-engine画笔引擎)
4. [ink-net（联机）](#4-ink-net联机)
5. [装配 App](#5-装配-app)
6. [改什么 → 去哪](#6-改什么--去哪)
7. [目录树](#7-目录树)
8. [维护约定](#8-维护约定)

---

## 1. 如何使用（Agent）

1. 用 §6 锁 **1 个域**（engine / net / app）；先核对 `docs/agent/context.md` 泳道。
2. 只打开该节列出的文件。
3. engine **禁止** `session.send` / WebSocket；net **禁止** 写 canvas 像素 / 笔刷算法。
4. 跨包改契约 → 同步两边 `CONTRACT.md`，并由 App 接线。
5. 结构变更后：更新 §3–§7，并 bump `COLLAB_ASSET_VERSION`。

---

## 2. 总览：双包 + App

```text
┌──────────── App（装配，薄）────────────┐
│  大厅 · 接线 · CollabBoardController   │
└─────────┬──────────────────┬───────────┘
          │                  │
   ┌──────▼──────┐    ┌──────▼──────┐
   │ ink-engine  │    │  ink-net    │
   │ 渲染/工具/  │◄──►│  WS/adapter │
   │ 图层/导出   │    │  同步/权限  │
   └─────────────┘    └─────────────┘
```

| 模块 | 黑盒职责 | 不负责 |
|------|----------|--------|
| **ink-engine** | 本地绘制、图层纯逻辑、工具、选区、颜色、视口、导出 | WebSocket、房间权威 |
| **ink-net** | 会话、批量/重试、入站 `handle*`、adapter 出口 | 像素渲染、笔刷算法 |
| **App** | 大厅、组件装配、Board↔Net 编排 | 堆新业务（新功能进 engine 或 net） |

服务端 WS（暂未拆包，属 **net** 泳道）：`app/games/collab_canvas/ws_handlers/`、`room_store.py`。  
笔画校验镜像（属 **engine** 泳道，路径暂未搬）：`app/games/common/drawing_board.py`。

---

## 3. ink-engine（画笔引擎）

**根目录：** `packages/ink-engine/js/board/`  
**契约：** `packages/ink-engine/CONTRACT.md`

| 子域 | 路径 | 一句话 |
|------|------|--------|
| core | `board/core/drawing-board.js` | Canvas 引擎 facade |
| core | `board/core/stroke-render.js` | 描边/形状/喷笔 |
| core | `board/core/layer-compositor.js` | 图层合成与重绘 |
| core | `board/core/segment-utils.js` | Segment 归一化 |
| core | `board/core/perfect-freehand.js` | 笔刷轮廓第三方 |
| tool | `board/tool/` | 笔刷/压感/防抖/工具注册 |
| layer | `board/layer/` | 图层模型与面板 |
| color | `board/color/` | 取色与调色板 |
| select | `board/select/` | 选区 |
| export | `board/export/` | PBCC / 格式导出（上网只经 adapter） |
| ui | `board/ui/` | 视口、水印、工具轨、预览 |

出站只经 App 注入的 `board.adapter`（见 engine CONTRACT）。

---

## 4. ink-net（联机）

**客户端根：** `packages/ink-net/js/`  
**协议：** `packages/ink-net/protocol.md`  
**契约：** `packages/ink-net/CONTRACT.md`

| 文件 | 一句话 |
|------|--------|
| `collab-session.js` | 信令 WS + 房主 WebRTC；进房/发送/重连 |
| `p2p-transport.js` | RTCPeerConnection 与数据通道 |
| `p2p-host-room.js` | 房主成员表与初始 room_state |
| `collab-board-adapter.js` | draw 批量、历史、repair、PBCC sync/import |
| `board-commands.js` | 图层/画板 CRUD `session.send` |
| `collab-message-handlers.js` | 入站 `handle*` → Board |
| `cursor-overlay.js` | 远程光标 |
| `network-monitor.js` | RTT UI |
| `online-prefs.js` | 联机显示名等偏好 |

**服务端（同泳道，未进 packages）：**

| 路径 | 一句话 |
|------|--------|
| `app/games/collab_canvas/routes.py` | HTTP + 薄 WS 入口 |
| `signal_store.py` | 信令：房间号 → 房主连接 |
| `room_store.py` | 旧内存房间辅助（序列化等） |
| `ws_handlers/*` | 信令主循环；历史 join/draw 文件暂留 |
| `protocol.py` | 协议常量 |
| `app/games/common/drawing_board.py` | 权威校验（engine 泳道文档所有） |

**公开站信令（pages-share，仍属 ink-net 包）：**

| 路径 | 一句话 |
|------|--------|
| `packages/ink-net/signal-worker/` | Cloudflare Worker，同 `signal_*` 协议 |
| `scripts/export-pages.py` | 导出 `dist/pages` 给 GitHub Pages |
| `deploy/pages/config.json` | `basePath` + `wsUrl`（指向 Worker） |

---

## 5. 装配 App

**根目录：** `app/games/collab_canvas/static/js/app/`

| 文件 | 一句话 |
|------|--------|
| `collab-app.js` | 进房/退房、组件图、启动 |
| `lobby-home.js` / `lobby-history.js` | 进站三栏大厅 |
| `collab-board.js` | `CollabBoardController` 编排 |
| `board-pointer.js` | 指针 / 光标上送 |
| `app-session-handlers.js` | session handlers 表 |
| `board-actions.js` | 快捷键动作表 |
| `board-panel.js` / `room-panel.js` / `settings-panel.js` | 面板壳 |
| 其余 `shortcut-*` / `workspace-layout` / `ui-*` / `export-menu` 等 | 装配 UI |

入口：`templates/index.html`（`eng` / `net` / `cc` 宏 = 依赖顺序）。

---

## 6. 改什么 → 去哪

| 任务关键词 | 域 | 优先打开 |
|------------|------|----------|
| 笔刷 / 压感 / 防抖 / 新工具 | engine | `packages/ink-engine/js/board/tool/`、`core/stroke-render.js` |
| 图层合成 / 重绘 | engine | `board/core/layer-compositor.js` |
| 图层锁 / 组 / 面板 | engine | `board/layer/` |
| 选区 | engine | `board/select/` |
| 颜色 | engine | `board/color/` |
| 导出 / PBCC | engine | `board/export/` |
| 视口 | engine | `board/ui/canvas-viewport.js` |
| WS / 重连 / batch | net | `packages/ink-net/js/collab-session.js`、`collab-board-adapter.js` |
| 图层/画板上送 | net | `board-commands.js` |
| 入站消息 | net | `collab-message-handlers.js` |
| 房间 / 踢人 / 权限 | net | `ws_handlers/host_msgs.py`、`room_store.py`、`app/room-panel.js` |
| 协议字段 | net | `packages/ink-net/protocol.md` + `drawing_board.py` |
| 大厅 / 深链 | app | `lobby-home.js`、`collab-app.js` |
| 快捷键 | app | `board-actions.js`、`shortcut-registry.js` |
| 缓存版本 | — | `routes.py` → `COLLAB_ASSET_VERSION` |

---

## 7. 目录树

```text
packages/
  ink-engine/
    README.md  CONTRACT.md
    js/board/
      core/ tool/ layer/ color/ select/ export/ ui/
  ink-net/
    README.md  CONTRACT.md  protocol.md
    js/
      collab-session.js  collab-board-adapter.js  board-commands.js
      collab-message-handlers.js
      cursor-overlay.js  network-monitor.js  online-prefs.js

app/games/collab_canvas/
  static/js/app/     # 装配
  static/css/        # lobby / workspace / …
  templates/index.html
  routes.py  room_store.py  protocol.py
  ws_handlers/
```

---

## 8. 维护约定

- [ ] 新增浏览器逻辑 → 放入 engine / net / app 之一，并补 §3–§6
- [ ] 移动 / 重命名 → 改 `templates/index.html` + 本文件；包脚本走 `eng`/`net` 宏
- [ ] 契约变更 → 同步两边 `CONTRACT.md`
- [ ] 服务端新消息 → `ws_handlers/process.py` + `packages/ink-net/protocol.md` + §4/§6
- [ ] 改静态资源 → bump `COLLAB_ASSET_VERSION`
- [ ] 子对话写前扫 `docs/agent/context.md` 泳道，禁止跨泳道静默改文件
- [ ] **禁止** 再建平铺上帝文件或 `utils.js` 垃圾桶
