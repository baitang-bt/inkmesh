# inkmesh-signal（Cloudflare Worker）

独立信令宿主：只转发 `signal_*`（SDP / ICE），不存笔迹。协议见 [`../protocol.md`](../protocol.md)。

## 部署

```bash
cd packages/ink-net/signal-worker
npx wrangler login   # 首次
npx wrangler deploy
```

记下产出的主机名，例如 `inkmesh-signal.<account>.workers.dev`。

## 接到 GitHub Pages

编辑 [`deploy/pages/config.json`](../../../deploy/pages/config.json)：

```json
{
  "basePath": "/inkmesh",
  "wsUrl": "wss://inkmesh-signal.<account>.workers.dev/inkmesh/ws"
}
```

然后重新跑 `python3 scripts/export-pages.py`（或 push 触发 Pages workflow）。

## 限制

- 首版用 **单 Isolate 内存**房间表，免费够用；多Isolate 下房间可能看不到彼此，日后可改 Durable Objects。
- 不提供 TURN；严格 NAT 下 WebRTC 仍可能失败（与本机 FastAPI 信令相同）。

## 本地开发

本机继续用 FastAPI：`python run_local.py` → 同源 `ws://127.0.0.1:8101/inkmesh/ws`，无需 Worker。
