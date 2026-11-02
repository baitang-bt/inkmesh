# ink-net

Inkmesh 联机会话与同步（浏览器静态 JS）。

- 路径：`js/`（session、adapter、commands、handlers、cursor、monitor、prefs）
- 协议 SoT：[protocol.md](protocol.md)
- 契约：见 [CONTRACT.md](CONTRACT.md)
- 挂载 URL：`/static/packages/ink-net/…`

服务端 WS（本轮仍在 App 树内，属 net 泳道）：

- `app/games/collab_canvas/ws_handlers/**`
- `app/games/collab_canvas/room_store.py`

本包**不**实现笔刷像素算法，**不**改 `packages/ink-engine/js/board/core|tool`。
