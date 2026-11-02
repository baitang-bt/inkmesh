# 合作画板 WebSocket 协议

## 版本

| protocolVersion | 说明 |
|-----------------|------|
| 1 | 单平面 strokes，无图层 |
| **2** | 多图层、layer_id on strokes |

当前：**2**

坐标均为 **0–1 归一化**；压感在客户端映射为 `size` 后上送。

## 房间状态（服务端）

- `boards[board_id]`: `{ board_id, title, layers[], strokes[], redo{}, canvas, ... }`
- `layers[]`: `{ layer_id, name, kind, parent_id, visible, opacity, locked, order }`
  - `kind`: `paint`（默认，可绘制）| `group`（图层组，无笔迹）
  - `parent_id`: 空串或省略表示根级；须指向已存在的 `group`
- `strokes[]`: 含 `layer_id`（默认 `l_default`）
- 每玩家：`active_board_id`、`active_layer_id`、`last_board_create_at`（房客新建画板冷却用，Unix 秒）

## 画板（board）

| 操作 | 权限 / 规则 |
|------|-------------|
| `board_create` | 全员可创建；**房客**两次创建间隔 ≥ **60 秒**（服务端 `last_board_create_at`）；房主无冷却 |
| `board_rename` | 全员可重命名 |
| `board_delete` | **仅房主**；**至少保留一个画板**；默认画板 `b_default` 不可删；画板须无笔迹 |
| `board_switch` | 切换当前画板 |

`room_state` 向本客户端附带 `last_board_create_at`，用于重连后恢复新建冷却 UI。

## Client → Server

| type | 字段 |
|------|------|
| `join` / `create` | 同 v1 |
| `board_*` | 同 v1；见下方画板规则 |
| `layer_create` | `board_id`, `name?`, `kind?`（`paint`/`group`）, `parent_id?` |
| `layer_duplicate` | `board_id`, `source_layer_id?`（省略则用当前 active） |
| `layer_delete` | `board_id`, `layer_id` — **至少保留一个图层**；有笔迹须先清空 |
| `layer_rename` | `board_id`, `layer_id`, `name` |
| `layer_reorder` | `board_id`, `layer_ids[]` |
| `layer_switch` | `board_id`, `layer_id` |
| `layer_update` | `board_id`, `layer_id`, `visible?`, `opacity?`, `locked?` |
| `draw` / `draw_batch` | `board_id`, `layer_id?`, `stroke_id`, segment(s)；笔刷段可含 `points[]`、`strokePart`、`simulatePressure`（缺省 true；触控笔真实笔压为 false，远端须同字段回放） |
| `undo` / `redo` | `board_id`, `layer_id?` |
| `clear` | `board_id`, `layer_id?` — **仅清空当前图层** |
| `drawing_sync_request` | `board_id` |
| `cursor_move` | 同 v1 |
| `ping` | 无字段；服务端回复 `pong`，客户端用于 RTT 检测 |
| `player_style` | `label_color?`、`display_name?` — 更新标签色与显示名（仅本游戏） |
| `host_set_permissions` | 仅房主；`target_id?`（省略则全部房客）、`can_draw?`、`can_save?` |
| `kick_player` | 仅房主；`target_id` |
| `room_import` | 仅房主；`document` — 完整 `.pbcc` JSON 对象（见下文） |

## Server → Client

| type | 说明 |
|------|------|
| `room_state` | 含 `layers[]`、`active_layer_id`；`players[]` 含 `can_draw`、`can_save`、`connected`、`is_host`、`active_board_id` |
| `drawing_sync` | 含 `layers[]` + strokes |
| `layer_added` / `layer_removed` / `layer_renamed` / `layer_reordered` / `layer_updated` | 图层变更 |
| `layer_duplicated` | `board_id`, `source_layer_id`, `layer`, `strokes[]`, `created_by` — 图层副本含克隆 strokes |
| `player_board` | `player_id`, `board_id`, `name?` — 某玩家切换画板后广播（不含切换者本人） |
| `pong` | 响应 `ping`；客户端在设置「网络」Tab 中计算往返延迟 |
| `player_permissions` | `player_id`、`can_draw`、`can_save` — 权限变更广播 |
| `player_join` | 含 `can_draw`、`can_save`、`is_host`、`label_color` |
| `player_style` | `player_id`、`name`、`label_color` — 显示名或标签色变更 |
| `room_removed` | 被踢或房间解散；客户端应断开并返回加入页 |
| 其余 | 同 v1；draw/stroke_visibility/clear 带 `layer_id` |

## 房主权限

- 房主始终拥有 `can_draw` 与 `can_save`（服务端 `player_can_draw` / `player_can_save` 强制）。
- 房客默认两项均为 `true`；房主可通过 `host_set_permissions` 关闭。
- `can_draw=false`：服务端丢弃 `draw` / `draw_batch` / `undo` / `redo` / `clear`；客户端禁用绘制工具并显示只读光标。
- `can_save=false`：客户端禁用导出、画布叠加水印「预览 · 禁止保存」；导出文件亦带水印。

## 房间面板（客户端 UI）

- 按 **Tab** 开关「房间成员」面板：在线/暂离、本机 RTT、房主批量/单人权限与踢出。

## 客户端导出（纯浏览器）

| 格式 | 说明 |
|------|------|
| PNG / JPEG | 全图层合成图 |
| KRA | 多 paintlayer 分层 |
| **PBCC** | 全部画板 + 图层 + 矢量笔迹，单 JSON 文件（扩展名 `.pbcc`） |

## `.pbcc` 文件格式（formatVersion 1）

纯 JSON，UTF-8；`Content-Type` 建议 `application/json`。

| 字段 | 说明 |
|------|------|
| `format` | 固定 `"pbcc"` |
| `formatVersion` | 当前 **1** |
| `protocolVersion` | 对应 WS 协议版本（当前 **2**） |
| `exportedAt` | ISO 8601 时间 |
| `sourceRoomId` | 导出时房间号 |
| `exportedBy` | `{ uid, displayName }` |
| `board_order` | 画板 id 顺序 |
| `boards[]` | 每画板：`board_id`, `title`, `canvas`, `layers[]`, `strokes[]`, `created_at`, `created_by` |

笔迹与图层结构与 `room_state` / `drawing_sync` 一致；不含 `localRaster` 段。

### `room_import` 规则（服务端）

- **仅房主**可发送 `room_import`。
- `document.format` 必须为 `pbcc`。
- 若房间已有**用户笔迹**且**在线玩家 > 1**，拒绝覆盖（防误删协作内容）。
- 成功后服务端 `broadcast_room_state`，全员收到完整房间快照。

### 本机记忆（客户端，非 WS）

| 机制 | 说明 |
|------|------|
| IndexedDB | 键 `userId:roomId`；房主每 90s 与离开房间时自动保存 |
| localStorage | `collab-pbcc-restore-v1` — 加入页「恢复上次保存」开关 |
| 加入页 | 「从 .pbcc 文件打开…」→ 进房后房主自动 `room_import` |

房间数据仅存于**服务端进程内存**；进程重启后须依赖 `.pbcc` 导出/恢复。

## Segment 工具类型

| tool | 字段 |
|------|------|
| `brush` / `eraser` | `x1`, `y1`, `x2`, `y2`, `color`, `size` |
| `fill` | `x`, `y`, `color` |
| `background` | `color` |
| `line` | `x1`, `y1`, `x2`, `y2`, `color`, `size` |
| `rect` / `ellipse` | `x1`, `y1`, `x2`, `y2`, `color`, `size`, `filled` (bool) |
| `gradient` | `x1`, `y1`, `x2`, `y2`, `color`, `color2` |

`localRaster` 仅客户端选区操作缓存，**不上送** WS。

## 本地 UI 配置（localStorage）

| Key | 内容 |
|-----|------|
| `collab-workspace-layout-v2` | 右栏宽度、上下分割比例 |
| `collab-color-picker-mode` | `hsv` / `wheel` / `rgb` / `hsl` |
| `collab-canvas-shortcuts-v1` | 快捷键双绑（主键 / 副键 per action） |
| `collab-fg-bg-colors-v1` | 主色 / 背景色 |
| `collab-recent-colors-v1` | 最近使用颜色列表 |
| `collab-recent-colors-order-v1` | 轮盘外环排序：`recency` / `hsv` |
| `collab-recent-colors-limit-v1` | 最近色缓存上限（2–24，默认 12）；轮盘按实际数量等分 |
| `collab-tool-variants-v1` | 工具栏 flyout 组上次选用的变体 |
| `collab-online-label-color-v1` | 联机用户名标签自定义底色 |
| `collab-online-display-name-v1` | 合作画板专用自定义显示名 |
| `collab-online-use-passport-name-v1` | `1` 使用通行证名 / `0` 使用自定义名 |

## 联机显示名（客户端）

- 通行证用户名来自登录身份；可在设置「联机」中填写**自定义名**（仅合作画板生效，localStorage 记忆）。
- 「使用通行证用户名」开关开启时上送/展示通行证名；关闭时使用自定义名（为空则回退通行证名）。
- 加入房间与 `player_style.display_name` 均会更新服务端 `players[].name`，并广播 `player_style`。

## 联机光标（cursor_update）

| 字段 | 说明 |
|------|------|
| `nickname` | 玩家昵称 |
| `x`, `y` | 归一化坐标 |
| `drawing` | 是否正在绘制 |
| `size` | 笔刷大小（用于远端笔刷环预览） |
| `label_color` | 用户名标签底色 `#RRGGBB`；空则客户端按 id 哈希 |

Client → Server：`player_style` `{ label_color }` 更新标签色并广播。

## 布局（v2 UI）

- 左：工具栏（画笔 / 橡皮 / 填充 / 直线 / 吸管 / 形状 / 选区 / 抓手 / 缩放；组内 hover 或长按展开变体）
- 中：画布（滚轮缩放，Space 按住临时抓手，左上角倍率提示）
- 右上：多模式取色 + 笔刷设置
- 右下：图层 | 画板 tab 切换

`WorkspaceLayout` + `PanelRegistry` 预留后续 dock 拖拽自定义。
