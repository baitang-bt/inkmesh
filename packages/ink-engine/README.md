# ink-engine

Inkmesh 画笔 / 画板引擎（浏览器静态 JS）。

- 路径：`js/board/`（core / tool / layer / color / select / export / ui）
- 契约：见 [CONTRACT.md](CONTRACT.md)
- 挂载 URL：`/static/packages/ink-engine/…`
- 服务端笔画校验镜像（本轮未搬家）：`app/games/common/drawing_board.py`（engine 泳道文档所有）

本包**不**打开 WebSocket，**不**调用 `session.send`。出站只经 App 注入的 `board.adapter`。
