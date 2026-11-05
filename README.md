# Inkmesh

浏览器里多人实时共画：多画板、多图层、远程光标、数位板压感。笔迹权威在**房主浏览器**（P2P 数据通道）；信令只交换房间号与 SDP/ICE。

- **公开站（Cloudflare）**：[https://inkmesh-signal.inkmesh-max.workers.dev/inkmesh/](https://inkmesh-signal.inkmesh-max.workers.dev/inkmesh/)
- **结构 SoT**：[docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md)
- **联机协议**：[packages/ink-net/protocol.md](packages/ink-net/protocol.md)

> 静态壳、信令 WebSocket、公开大厅 API 都在同一个 Worker（`packages/ink-net/signal-worker`）。大陆访问建议在 Cloudflare Dashboard 给该 Worker **绑定自定义域名**（避免直连 `workers.dev`）。

---

## 技术路线（按模块）

```text
┌────────────── App（装配）──────────────┐
│  大厅 UI · CollabBoard · 会话接线      │
└───────┬──────────────────┬─────────────┘
        │                  │
 ┌──────▼──────┐    ┌──────▼──────┐
 │ ink-engine  │    │  ink-net    │
 │ 画笔/图层/  │◄──►│ 信令+P2P/   │
 │ 导出        │    │ 同步/权限   │
 └─────────────┘    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │ Cloudflare Worker        │
              │ 静态 Assets + DO 信令    │
              │ + PublicLobby            │
              └─────────────────────────┘
```

| 模块 | 路径 | 技术路线 | 不负责 |
|------|------|----------|--------|
| **ink-engine** | [`packages/ink-engine`](packages/ink-engine) | Canvas 2D；矢量 segment + perfect-freehand；图层合成；工具/压感/颜色；`.inkmesh` 与多格式导出 | WebSocket、房间权威 |
| **ink-net** | [`packages/ink-net`](packages/ink-net) | 信令 WS + 房主 WebRTC 数据通道；`room_state` / `draw`；权限与私密邀请；公开大厅 announce | 像素渲染、笔刷算法 |
| **App** | [`app/games/collab_canvas`](app/games/collab_canvas) | 大厅（我的画板 / 最近 / 大厅）、装配 Board↔Session、静态资源版本 | 堆新业务逻辑（应进 engine 或 net） |
| **signal-worker** | [`packages/ink-net/signal-worker`](packages/ink-net/signal-worker) | Cloudflare Worker：静态站 Assets + 一房一 DO 信令 + `PublicLobby` 目录/预览 | 笔迹持久化服务端 |

契约边界：[`ink-engine/CONTRACT.md`](packages/ink-engine/CONTRACT.md)、[`ink-net/CONTRACT.md`](packages/ink-net/CONTRACT.md)。  
engine **禁止** `session.send`；net **禁止** 改 `board/core` 渲染。

### 联机要点

1. 进房：信令登记房主；房客经 SDP 连到房主数据通道后发 `join`。
2. 画板状态与笔迹只走数据通道；信令不存笔画。
3. **私密房间**：房主开关；仅带 `?invite=` 的链接可进（校验在房主 `join`）。
4. **公开大厅**：非私密房主约每 5 分钟向 Worker 上报标题、人数与缩略图；左栏「大厅」可搜索 / 随机加入。

---

## 使用说明

### 公开站（最终用户）

1. 打开 [Worker 上的 Inkmesh](https://inkmesh-signal.inkmesh-max.workers.dev/inkmesh/)。
2. 左栏：**我的画板** · **最近** · **大厅**。
3. 「新建画板」开房；「复制链接」分享。私密房请用带邀请参数的链接。
4. 「安装 / 快捷方式」可装 PWA。
5. 若界面像旧版：硬刷新（`Cmd+Shift+R`）或清站点 Service Worker。

### 本机开发

```bash
cd inkmesh   # 仓库根目录
pip install -r requirements.txt
python run_local.py
```

打开 http://127.0.0.1:8101/inkmesh  

- 信令走同源 `/inkmesh/ws`（FastAPI），不依赖 Cloudflare。
- 双人测试：两个标签分别加 `?dev_user=a&dev_name=Alice` 与 `?dev_user=b&dev_name=Bob`。

### 部署到 Cloudflare

公开站与信令一次部署：

```bash
python3 scripts/export-pages.py
bash scripts/sync-worker-public.sh
cd packages/ink-net/signal-worker && npx wrangler deploy
# 建议：npx wrangler secret put LOBBY_HMAC
```

CI：push `main` → [`.github/workflows/deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml)。  
仓库 Secrets 需配置：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | 含 Workers 编辑权限的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID（Dashboard 右侧可见） |

[`deploy/pages/config.json`](deploy/pages/config.json) 中 `wsUrl` / `lobbyUrl` 指向同一 Worker 主机。

#### 自定义域名（大陆推荐）

1. 域名 DNS 放到 Cloudflare。
2. Workers → `inkmesh-signal` → **Custom Domains** → 添加如 `inkmesh.example.com`。
3. 更新 `config.json` 的 `wsUrl` / `lobbyUrl` 为该域名后重新 `export` + `deploy`。

改了静态 JS/CSS：递增 [`routes.py`](app/games/collab_canvas/routes.py) 的 `COLLAB_ASSET_VERSION`。

旧的 GitHub Pages workflow 仅保留手动触发回退，默认不再随 push 发布。

---

## 仓库地图（改哪里）

| 要改的 | 去哪 |
|--------|------|
| 笔刷、图层合成、导出格式 | `packages/ink-engine/js/board/` |
| 进房、P2P、权限、私密、大厅上报 | `packages/ink-net/js/` |
| 信令 DO / 公开大厅 / 静态托管 | `packages/ink-net/signal-worker/` |
| 大厅 UI、房间成员面板、装配 | `app/games/collab_canvas/static/js/app/`、`templates/` |
| 协议字段 | 先改 `packages/ink-net/protocol.md`，再改 JS |

更细目录见 [docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md)。
