# Inkmesh

多人实时共画、多画板、远程光标与数位板压感。

## 公开访问

- **静态站**：GitHub Pages → [https://baitang-bt.github.io/inkmesh/](https://baitang-bt.github.io/inkmesh/)
- **快捷方式**：大厅点「安装 / 快捷方式」（PWA 安装，或下载 `Inkmesh.url`；iOS 用 Safari「添加到主屏幕」）
- **联机信令**：独立 Cloudflare Worker（[`packages/ink-net/signal-worker`](packages/ink-net/signal-worker)）。部署后把 `wss://…/inkmesh/ws` 写入 [`deploy/pages/config.json`](deploy/pages/config.json) 的 `wsUrl`，再 push / 重跑 Pages。

本地导出静态站：

```bash
python3 scripts/export-pages.py
# 产物：dist/pages
```

仓库 **Settings → Pages → Source** 选 **GitHub Actions**（首次需点一次）。

## 本地运行

```bash
cd inkmesh
pip install -r requirements.txt
python run_local.py
```

访问 http://127.0.0.1:8101/inkmesh

多用户测试：两个浏览器标签分别加 `?dev_user=a&dev_name=Alice` 与 `?dev_user=b&dev_name=Bob`。

本机信令走同源 `/inkmesh/ws`（FastAPI），不依赖 Worker。

## 结构

- **ink-engine**（画笔）：[`packages/ink-engine`](packages/ink-engine)
- **ink-net**（联机）：[`packages/ink-net`](packages/ink-net)（含 `signal-worker`）
- **App 装配**：`app/games/collab_canvas/`

改静态 JS/CSS 后递增 `app/games/collab_canvas/routes.py` 的 `COLLAB_ASSET_VERSION`。

导航 SoT：[docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md)。协议：[packages/ink-net/protocol.md](packages/ink-net/protocol.md)。
