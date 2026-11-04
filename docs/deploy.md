# 合作画板部署说明

> 本文档记录将合作画板改动推送到生产（`game.potatoblock.com`）时的**必做步骤**。核心一条：**改过静态资源（JS/CSS）后，必须递增 `COLLAB_ASSET_VERSION`**，否则生产端走浏览器缓存，看不到新代码。

## 部署前检查清单（上传前过一遍）

### 1. 静态资源版本号必须 bump（最关键）

所有 `static/js/*.js`、`static/css/*.css` 都由模板经 `cc()` 宏拼上 `?v={{ asset_version }}`：

```jinja
{% macro cc(path) %}/static/games/inkmesh/{{ path }}?v={{ asset_version }}{% endmacro %}
```

版本号来自 `routes.py`：

```python
# app/games/collab_canvas/routes.py
# 静态资源 ?v= 版本号；改 JS/CSS 后递增以便生产绕过浏览器缓存。
COLLAB_ASSET_VERSION = "20260830n"
```

**规则：只要本次改动包含了 `static/js/` 或 `static/css/` 下的任何文件（新增 / 修改 / 删除），就必须把 `COLLAB_ASSET_VERSION` 从当前值改成一个新的、更大的值**（建议用当天日期 + 递增后缀，如 `20260830n` → `20260831a`）。

> 判断标准：`git diff --stat` 里 `static/` 路径有变化，就务必 bump；只改 Python（`routes.py` 逻辑、协议）或模板里的服务端逻辑、但完全没动 `static/` 文件时，可以不 bump。

### 2. 确认 deploy-worktree 同步了最新文件

上传脚本会把本地 `potatoblock-collab-canvas` 的文件展平到 `.deploy-worktree/games/collab_canvas/`。push 前可抽查：

```bash
ls .deploy-worktree/games/collab_canvas/static/js/stroke-smoother.js   # 新建的文件应存在
grep -n "COLLAB_ASSET_VERSION" .deploy-worktree/games/collab_canvas/routes.py
```

deploy-worktree 里的版本号应已被同步为本地源的最新值。

### 3. 本地先跑一遍冒烟

```bash
cd /Users/max/Documents/Cursor/projects/potatogame/potatoblock-collab-canvas
python run_local.py    # http://127.0.0.1:8101/inkmesh
```

改过 UI / 交互后，最好确认页面无 JS 报错、新功能可用。

## 上传命令

```bash
python3 /Users/max/.cursor/skills/potatoblock-deploy/scripts/push-github.py \
  --worktree /Users/max/Documents/Cursor/projects/potatogame/.deploy-worktree \
  --message "deploy: <简要说明本次改动>"
```

只推合作画板（不碰其它游戏）：

```bash
python3 /Users/max/.cursor/skills/potatoblock-deploy/scripts/push-github.py \
  --worktree /Users/max/Documents/Cursor/projects/potatogame/.deploy-worktree \
  --package /Users/max/Documents/Cursor/projects/potatogame/potatoblock-collab-canvas \
  --message "deploy: collab canvas <简述>"
```

## 部署后验证

1. 在 GitHub 仓库 Actions 页看 `CD — Deploy to MCSManager` 是否成功。
2. 打开本地或部署地址的 `/inkmesh`，强刷（Cmd/Ctrl+Shift+R），确认页面加载的是新版本号：
   - 查看 Network 里 `index.html` 引用的 `collab-export.js?v=...` 等资源，`v=` 应等于新版本号。
3. 冒烟新功能（例如笔刷防抖、画布尺寸、导出格式）。

## 版本号改动历史

| 版本号 | 日期 | 说明 |
|--------|------|------|
| `20260830a` | 2026-08-30 | 初始接入 `?v=` 缓存破坏 |
| `20260830n` | 2026-08-30 | 前一个版本（详见 git log） |
| `20260831a` | 2026-08-31 | 笔刷防抖 + 矢量画布 1920x1080 + 画笔上限 128 |
| `20260831b` | 2026-08-31 | 画笔管线升级：perfect-freehand + 传感器曲线 + 预设架构 + PSD 结构校准 |
| `20260831c` | 2026-08-31 | 移动端多指手势（平移/缩放/旋转）+ 移动端隐藏键位设置 + 房主退出转移/保存提醒 |
| `20260831d` | 2026-08-31 | 清理 canvas-viewport 重复方法 + 设置弹窗移动端 Tab 回退修复 |
| `20260901a` | 2026-09-01 | 修复画笔联机同步回归：normalize_segment 透传 perfect-freehand 字段（points/strokePart/预设参数） |
| `20260901b` | 2026-09-01 | 修复画笔断触：segment 渲染 last 恒为 true，轮廓到达真实端点，消除快速长线段间隙 |

> 新增条目：每次 bump 后把「版本号 / 日期 / 一句话」追加到本表，方便回溯。
