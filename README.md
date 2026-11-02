# Inkmesh

多人实时共画、多画板、远程光标与数位板压感。

## 本地运行

```bash
cd inkmesh
pip install -r requirements.txt
python run_local.py
```

访问 http://127.0.0.1:8101/collab-canvas

多用户测试：两个浏览器标签分别加 `?dev_user=a&dev_name=Alice` 与 `?dev_user=b&dev_name=Bob`。

## 部署

> **⚠️ 改过 `static/js` 或 `static/css` 后，务必先递增 `app/games/collab_canvas/routes.py` 里的 `COLLAB_ASSET_VERSION`，否则生产端走浏览器缓存看不到新代码。** 完整检查清单见 [docs/deploy.md](docs/deploy.md)。

```bash
python3 ~/.cursor/skills/potatoblock-deploy/scripts/push-github.py \
  --worktree /Users/max/Documents/Cursor/projects/potatogame/.deploy-worktree \
  --package /Users/max/Documents/Cursor/projects/potatogame/potatoblock-collab-canvas \
  --message "deploy: add collab canvas game"
```

**代码结构（Agent 导航 SoT）**见 [docs/CODE_STRUCTURE.md](docs/CODE_STRUCTURE.md)（画板 / 联网两大模块 + 改什么→去哪）。  
协议见 [docs/collab-canvas-protocol.md](docs/collab-canvas-protocol.md)，部署见 [docs/deploy.md](docs/deploy.md)。
