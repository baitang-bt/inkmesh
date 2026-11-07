# Inkmesh

浏览器里多人实时共画：多画板、多图层、远程光标、数位板压感。笔迹权威在**房主浏览器**（P2P 数据通道）；信令只交换房间号与 SDP/ICE。

- **公开站（GitHub Pages）**：[https://baitang-bt.github.io/inkmesh/](https://baitang-bt.github.io/inkmesh/)
- **结构 SoT**：[docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md)
- **联机协议**：[packages/ink-net/protocol.md](packages/ink-net/protocol.md)

> 静态壳发在 **GitHub Pages**；信令 WebSocket 与公开大厅 API 在 Cloudflare Worker（`packages/ink-net/signal-worker`）。`deploy/pages/config.json` 的 `wsUrl` / `lobbyUrl` 指向该 Worker。

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
              │ GitHub Pages（静态壳）   │
              │ + CF Worker（信令/大厅） │
              └─────────────────────────┘
```

| 模块 | 路径 | 技术路线 | 不负责 |
|------|------|----------|--------|
| **ink-engine** | [`packages/ink-engine`](packages/ink-engine) | Canvas 2D；矢量 segment + perfect-freehand；图层合成；工具/压感/颜色；`.inkmesh` 与多格式导出 | WebSocket、房间权威 |
| **ink-net** | [`packages/ink-net`](packages/ink-net) | 信令 WS + 房主 WebRTC 数据通道；`room_state` / `draw`；权限与私密邀请；公开大厅 announce | 像素渲染、笔刷算法 |
| **App** | [`app/games/collab_canvas`](app/games/collab_canvas) | 大厅（我的画板 / 最近 / 大厅）、装配 Board↔Session、静态资源版本 | 堆新业务逻辑（应进 engine 或 net） |
| **signal-worker** | [`packages/ink-net/signal-worker`](packages/ink-net/signal-worker) | Cloudflare Worker：一房一 DO 信令 + `PublicLobby`；可选 Assets 镜像 | 笔迹持久化、主站静态托管 |

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

1. 打开 [GitHub Pages 上的 Inkmesh](https://baitang-bt.github.io/inkmesh/)。
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

### 部署公开站（GitHub Pages）

```bash
python3 scripts/export-pages.py   # 本地预览产物在 dist/pages
```

CI：push `main` → [`.github/workflows/pages.yml`](.github/workflows/pages.yml) → [baitang-bt.github.io/inkmesh](https://baitang-bt.github.io/inkmesh/)。

[`deploy/pages/config.json`](deploy/pages/config.json) 的 `wsUrl` / `lobbyUrl` 指向信令 Worker；可选 `iceServers`（STUN/TURN）。跨运营商联机需自备 TURN 写入该数组。改了静态 JS/CSS：递增 [`routes.py`](app/games/collab_canvas/routes.py) 的 `COLLAB_ASSET_VERSION`。

### 部署信令 Worker（Cloudflare）

信令与公开大厅（不随 push 自动发；手动或改信令逻辑时部署）：

```bash
python3 scripts/export-pages.py          # 可选：刷新 workers.dev 静态镜像
bash scripts/sync-worker-public.sh
cd packages/ink-net/signal-worker && npx wrangler deploy
# 建议：npx wrangler secret put LOBBY_HMAC
```

CI 手动：[`.github/workflows/deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml)。Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

信令自定义域名：Workers → `inkmesh-signal` → Custom Domains，再改 `config.json` 后 push 更新 Pages。

---

## 仓库地图（改哪里）

| 要改的 | 去哪 |
|--------|------|
| 笔刷、图层合成、导出格式 | `packages/ink-engine/js/board/` |
| 进房、P2P、权限、私密、大厅上报 | `packages/ink-net/js/` |
| 信令 DO / 公开大厅 | `packages/ink-net/signal-worker/` |
| 公开静态导出 / Pages config | `scripts/export-pages.py`、`deploy/pages/` |
| 大厅 UI、房间成员面板、装配 | `app/games/collab_canvas/static/js/app/`、`templates/` |
| 协议字段 | 先改 `packages/ink-net/protocol.md`，再改 JS |

更细目录见 [docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md)。
