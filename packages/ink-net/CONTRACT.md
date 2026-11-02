# ink-net 契约

子对话改本包时只读本文件、`js/**`、`protocol.md`。服务端改动限 `ws_handlers` / `room_store`（同泳道）。

## 禁止

- canvas 像素绘制、笔刷轮廓 / freehand / compositor
- 修改 `packages/ink-engine/js/board/**` 源文件

## Board → Net（`CollabBoardAdapter`）

App 把 `send: payload => session.send(payload)` 注入 adapter。Board 只看见：

| 方法 | 线上消息（摘要） |
|------|------------------|
| `sendSegment` / `flushSegments` | `draw` / `draw_batch` |
| `sendHistoryAction` | `undo` / `redo` / `clear` |
| `requestRepairSync` / `requestBoardSync` | `drawing_sync_request` |
| `sendRoomImport` | `room_import` |

`board-commands.js` 经 install 挂到控制器后使用 `this.session.send`（图层 / 画板 CRUD）。

## Net → Board（入站）

经 App `handlers` 转到控制器：

- `room_state`、`drawing_sync`、`draw`、`draw_batch`、`stroke_visibility`、`clear`
- `layer_*`、`board_*`、`player_permissions`、`cursor_update` 等

允许使用的引擎模型助手：`DrawingBoard.cloneStrokes` / `findStroke` / `SegmentUtils`（只读模型，不调渲染细节）。

## 会话（`CollabSession`）

连接、重连、`join` / `leave`、`sendCursor`、`sendPlayerStyle`、踢人与房主权限。细节见 `protocol.md`。

## 改契约

协议字段变更：先改 `protocol.md`，再改本包 JS 与（若仍存在）服务端 `ws_handlers`。adapter / `handle*` 更名须同步 `ink-engine/CONTRACT.md`。
