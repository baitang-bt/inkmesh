# ink-net

Inkmesh 联机会话与同步（浏览器静态 JS）。

- 路径：`js/`（session、p2p-transport、p2p-host-room、adapter、commands、handlers、cursor、monitor、prefs）
- 协议 SoT：[protocol.md](protocol.md)
- 契约：见 [CONTRACT.md](CONTRACT.md)
- 挂载 URL：`/static/packages/ink-net/…`

服务端（App 树内，属 net 泳道）只做信令：

- `app/games/collab_canvas/ws_handlers/**`（`signal_msgs` / `process`）
- `app/games/collab_canvas/signal_store.py`

公开站信令（pages-share）：[`signal-worker/`](signal-worker/) Cloudflare Worker，部署说明见其 README。

笔迹权威在房主浏览器。本包**不**实现笔刷像素算法，**不**改 `packages/ink-engine/js/board/core|tool`。
