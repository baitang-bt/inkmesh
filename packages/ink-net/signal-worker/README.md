# inkmesh-signal（Cloudflare Worker + Durable Objects）

独立信令宿主：只转发 `signal_*`（SDP / ICE），不存笔迹。协议见 [`../protocol.md`](../protocol.md)。

## 架构

- Worker 入口接受 `/inkmesh/ws` 与 `/ws`。
- **必须**带查询参数 `?room=<ROOMID>`（2–8 位规范化房间号）。
- 按 `idFromName(room)` 路由到 **一房间一** Durable Object `SignalRoom`，同房连接共享房主表（解决多 Isolate 内存不共享）。
- **Hibernation**：DO 休眠会丢掉实例上的 `hostPeerId`，但 WebSocket attachment（`role: host|guest`）保留。每次 `fetch` / `webSocketMessage` / close / error 入口会 `_ensureHostState()` 从 attachment 重建房主，避免静置后再 join 误报 `signal_no_host`。
- **公开大厅**：单例 DO `PublicLobby`（`idFromName('public')`）；HTTP `GET/POST/DELETE /inkmesh/lobby*`。`signal_hosted` 带 `lobby_token`；房主离开自动下架。
- 客户端 [`collab-session.js`](../js/collab-session.js) 在进房时把 `room` 写进信令 URL；必要时会重连。大厅上报见 [`lobby-announce.js`](../js/lobby-announce.js)。

## 部署

```bash
cd packages/ink-net/signal-worker
npx wrangler login   # 首次
npx wrangler deploy  # 含 migration v2 → PublicLobby
# 建议：
npx wrangler secret put LOBBY_HMAC
```

记下产出的主机名，例如 `inkmesh-signal.inkmesh-max.workers.dev`。

## 接到 GitHub Pages

编辑 [`deploy/pages/config.json`](../../../deploy/pages/config.json)：

```json
{
  "basePath": "/inkmesh",
  "wsUrl": "wss://inkmesh-signal.inkmesh-max.workers.dev/inkmesh/ws",
  "lobbyUrl": "https://inkmesh-signal.inkmesh-max.workers.dev"
}
```

`wsUrl` 是基址；客户端会自动追加 `?room=`。未写 `lobbyUrl` 时由 `wsUrl` 推导同源 HTTPS。改完后 `python3 scripts/export-pages.py` 或 push 触发 Pages。

## 限制

- 不提供 TURN；严格 NAT 下 WebRTC 仍可能失败（与本机 FastAPI 信令相同）。
- 信令 DO 只协调连接，不存笔迹；大厅只存元数据 + 缩略图，不存完整笔迹。

## 本地开发

本机继续用 FastAPI：`python run_local.py` → 同源 `ws://127.0.0.1:8101/inkmesh/ws`（可带或不带 `?room=`），无需 Worker。本机 `GET /inkmesh/lobby` 返回空列表；要测大厅请指向已部署的 Worker `lobbyUrl`。
