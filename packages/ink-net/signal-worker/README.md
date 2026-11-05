# inkmesh-signal（Cloudflare Worker）

静态站 + P2P 信令 + 公开大厅，同一 Worker。协议见 [`../protocol.md`](../protocol.md)。

## 架构

- **Assets**：`public/inkmesh/**`（由 `scripts/export-pages.py` + `scripts/sync-worker-public.sh` 生成）→ 页面 `/inkmesh/`。
- **信令**：`/inkmesh/ws?room=` → 一房一 Durable Object `SignalRoom`。
- **大厅**：`/inkmesh/lobby*` → 单例 DO `PublicLobby`；`signal_hosted` 带 `lobby_token`。
- `run_worker_first`：先走 Worker 路由，再回落静态；房间深链 `/inkmesh/ROOMID` 回退到 `index.html`。

## 部署

```bash
# 在仓库根
python3 scripts/export-pages.py
bash scripts/sync-worker-public.sh
cd packages/ink-net/signal-worker
npx wrangler deploy
npx wrangler secret put LOBBY_HMAC   # 建议
```

公开地址示例：`https://inkmesh-signal.<account>.workers.dev/inkmesh/`。

CI：仓库 `.github/workflows/deploy-cloudflare.yml`（需 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）。

## 自定义域名

Dashboard → Workers → `inkmesh-signal` → Custom Domains。  
大陆用户请绑自定义域，避免直连 `workers.dev`。绑好后改 [`deploy/pages/config.json`](../../../deploy/pages/config.json) 的 `wsUrl` / `lobbyUrl` 再部署。

## 本地开发

本机 FastAPI：`python run_local.py` → `ws://127.0.0.1:8101/inkmesh/ws`，无需本 Worker。
