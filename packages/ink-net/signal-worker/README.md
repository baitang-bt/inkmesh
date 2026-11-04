# inkmesh-signal（Cloudflare Worker + Durable Objects）

独立信令宿主：只转发 `signal_*`（SDP / ICE），不存笔迹。协议见 [`../protocol.md`](../protocol.md)。

## 架构

- Worker 入口接受 `/inkmesh/ws` 与 `/ws`。
- **必须**带查询参数 `?room=<ROOMID>`（2–8 位规范化房间号）。
- 按 `idFromName(room)` 路由到 **一房间一** Durable Object `SignalRoom`，同房连接共享房主表（解决多 Isolate 内存不共享）。
- 客户端 [`collab-session.js`](../js/collab-session.js) 在进房时把 `room` 写进信令 URL；必要时会重连。

## 部署

```bash
cd packages/ink-net/signal-worker
npx wrangler login   # 首次
npx wrangler deploy
```

记下产出的主机名，例如 `inkmesh-signal.inkmesh-max.workers.dev`。

## 接到 GitHub Pages

编辑 [`deploy/pages/config.json`](../../../deploy/pages/config.json)：

```json
{
  "basePath": "/inkmesh",
  "wsUrl": "wss://inkmesh-signal.inkmesh-max.workers.dev/inkmesh/ws"
}
```

`wsUrl` 是基址；客户端会自动追加 `?room=`。改完后 `python3 scripts/export-pages.py` 或 push 触发 Pages。

## 限制

- 不提供 TURN；严格 NAT 下 WebRTC 仍可能失败（与本机 FastAPI 信令相同）。
- 信令 DO 只协调连接，不存笔迹。

## 本地开发

本机继续用 FastAPI：`python run_local.py` → 同源 `ws://127.0.0.1:8101/inkmesh/ws`（可带或不带 `?room=`），无需 Worker。
