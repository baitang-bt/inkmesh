# inkmesh-signal（Cloudflare Worker）

P2P 信令 + 公开大厅。协议见 [`../protocol.md`](../protocol.md)。

公开**静态站**默认发到 **GitHub Pages**（`baitang-bt.github.io/inkmesh`）；本 Worker 通过 `deploy/pages/config.json` 的 `wsUrl` / `lobbyUrl` 被引用。

## 架构

- **信令**：`/inkmesh/ws?room=` → 一房一 Durable Object `SignalRoom`。
- **大厅**：`/inkmesh/lobby*` → 单例 DO `PublicLobby`；`signal_hosted` 带 `lobby_token`。
- **Assets（可选镜像）**：`public/inkmesh/**`（`export-pages` + `sync-worker-public`）→ `*.workers.dev/inkmesh/`，非主入口。
- `run_worker_first`：先走 Worker 路由；房间深链回退到 `index.html`（仅镜像站需要）。

## 部署（信令 / 大厅）

```bash
# 在仓库根（可选：顺带刷新 workers.dev 静态镜像）
python3 scripts/export-pages.py
bash scripts/sync-worker-public.sh
cd packages/ink-net/signal-worker
npx wrangler deploy
npx wrangler secret put LOBBY_HMAC   # 建议
```

信令基址示例：`wss://inkmesh-signal.<account>.workers.dev/inkmesh/ws`。

CI：仓库 [`.github/workflows/deploy-cloudflare.yml`](../../../.github/workflows/deploy-cloudflare.yml)（**手动** `workflow_dispatch`；需 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）。

静态站发布：push `main` → [`.github/workflows/pages.yml`](../../../.github/workflows/pages.yml)。

## 自定义域名（信令）

Dashboard → Workers → `inkmesh-signal` → Custom Domains。  
绑好后改 [`deploy/pages/config.json`](../../../deploy/pages/config.json) 的 `wsUrl` / `lobbyUrl`，再 export 并 push（更新 Pages 上的 config）。

## 本地开发

本机 FastAPI：`python run_local.py` → `ws://127.0.0.1:8101/inkmesh/ws`，无需本 Worker。
