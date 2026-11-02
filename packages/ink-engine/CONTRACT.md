# ink-engine 契约

子对话改本包时只读本文件 + `js/board/**`。禁止改 `packages/ink-net` 或直接碰 WebSocket。

## 禁止

- `WebSocket`、`session.send`、引用 `ink-net` 源文件
- 房间权限、踢人、RTT、进房 UI

## 出站（App 注入 `board.adapter`）

引擎可调用、且只应调用：

| 方法 | 用途 |
|------|------|
| `sendSegment(strokeId, segment, opts?)` | 上送单段 |
| `flushSegments()` | 冲刷批量队列 |
| `sendHistoryAction('undo'\|'redo'\|'clear')` | 历史操作 |
| `requestRepairSync()` | 请求修复同步 |
| `requestBoardSync(boardId)` | 请求整板同步 |
| `sendRoomImport(document)` | 房主导入 .pbcc |

没有 adapter 时，本地绘制仍可工作，但不上网。

## 入站（供 Net / App 调用）

控制器上的 `handle*` 由 App 安装/转发；引擎侧提供模型与重绘能力：

- `handleDrawMessage` / `handleDrawBatch` / `handleDrawingSync` / `handleStrokeVisibility` / `handleClear`
- `handleLayer*` / `handleBoard*`
- 纯模型：`DrawingBoard.cloneStrokes` / `findStroke` / `appendSegment`，`SegmentUtils.fromMessage`

## 改契约

增减 adapter 方法或 `handle*` 名称时，必须同步改 `packages/ink-net/CONTRACT.md`，并由 App 泳道接线。
