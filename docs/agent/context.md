# Agent Context — inkmesh

> 多 Agent / 多对话共享的项目记忆。Hub `conversations/{标题}.md` 只存指针与本场状态；**可复用的决策与进展写在此文件**。
>
> 最后更新：2026-11-02 20:25 +0800

## 当前焦点

- **任务**：双包结构已落地；画笔分阶段修复已完成（临时流程 MD 已删）
- **下一步**：UI 按提示词改大厅；联机可推进 P2P；画笔可手测压感/半透明/抬笔性能
- **活跃对话**：inkmesh UI、画笔引擎优化、画板P2P独立工作区

## 活跃泳道

同工作区多对话分工时维护此表。动手改文件前先扫一遍；占用冲突先改表协调，禁止静默覆盖他人 active 范围。

| 对话 | lane | 负责范围 | 状态 | 更新 |
|------|------|----------|------|------|
| inkmesh UI | ui | `docs/ui/**`、`app/games/collab_canvas/static/css/**`、`templates/index.html` 界面结构、`static/js/app/{workspace-layout,ui-prefs,ui-tooltip,material-icons,room-panel,settings-panel,board-panel,export-menu}.js`、`packages/ink-engine/js/board/ui/**`、`board/layer/layer-panel*.js`、`board/color/*picker*` 与 `popup-palette.js` / `recent-colors.js` 的界面 | active | 2026-11-02 |
| 画笔引擎优化 | brush | `packages/ink-engine/js/board/tool/{pen-input,stroke-smoother,brush-preset,register-tools}.js`、`packages/ink-engine/js/board/core/{stroke-path,stroke-render,perfect-freehand,layer-compositor,drawing-board}.js`、`board/layer/layer-thumbnail.js`、`static/js/app/{collab-board,pen-test-pad}.js`（笔画路径） | done | 2026-11-02 |
| 画板P2P独立工作区 | app | `static/js/app/**`（含大厅）、`templates/index.html` 装配与 script 宏、`docs/CODE_STRUCTURE.md`、包挂载 | active | 2026-11-02 |
| inkmesh 更新后检查 | review | `packages/ink-engine/js/board/core/{stroke-path,stroke-render}.js`、`tool/register-tools.js`、`static/js/app/collab-board.js`（远端形状）、`scripts/validate-*.js`、`routes.py` 资源版本 | done | 2026-11-02 |
| （子对话模板） | engine | `packages/ink-engine/**`、`app/games/common/drawing_board.py` | — | 2026-11-02 |
| （子对话模板） | net | `packages/ink-net/**`、`app/games/collab_canvas/ws_handlers/**`、`room_store.py` | — | 2026-11-02 |

状态：`active`（进行中）/ `done`（本泳道收工）。子对话开场时把模板行改成真实对话名并设 `active`。

## 架构与决策

| ID | 日期 | 决策 | 相关文件 |
|----|------|------|----------|
| d1 | 2026-11-02 | 界面学 Krita 的工作方式：中央画布、窄工具条、直角 docker、高密度小字、1px 分隔。配色走中性灰，强调色只用于选中/激活。不搬运 Krita 图标或主题文件。协议、笔迹、联网不归本泳道。 | `static/css/collab-workspace.css` |
| d2 | 2026-11-02 | 画笔是「短 segment + perfect-freehand 轮廓」；发光/喷笔不走折线。主要缺点：段间不连续、抬笔整板重放、flow/opacity 未进画笔渲染、笔压与速度/平滑互相抢。先分析，未改代码。 | `board/core/stroke-render.js` |
| d3 | 2026-11-02 | 矢量 segment 仍为权威；渲染改为拼路径整笔一次轮廓 + 笔画缓冲（opacity/flow）+ 惰性跟随 + 图层位图缓存。不移植 libmypaint。已落地于 `packages/ink-engine`；临时流程 MD 已删。 | `packages/ink-engine/js/board/core/stroke-path.js` |
| d4 | 2026-11-02 | 同仓双包：`packages/ink-engine`（画笔）与 `packages/ink-net`（联机 JS + protocol.md）。App 只装配。服务端 WS 暂不拆包（待 P2P）。无 bundler，StaticFiles 挂 `/static/packages/*`。契约见各包 `CONTRACT.md`。 | `packages/*`、`docs/CODE_STRUCTURE.md` |
| d5 | 2026-11-02 | 大厅用特色 UI（cask 战术终端提示词）。画板工作区维持高效直角 dock。他人光标和名字继续高效 UI：小圆点 + 10px 色标，不上切角和扫光。提示词在 `docs/ui/`，尚未改样式。 | `docs/ui/distinctive-ui.md`、`docs/ui/efficient-ui.md` |

## 进展

- [x] 工作区 CSS 已有 Krita/Magma 式直角 dock 与中性灰 token（既有）
- [x] 两套 UI 提示词：大厅特色、画板与他人光标高效（`docs/ui/`，未改样式）
- [ ] 按提示词改大厅；画板 chrome 仍等指定再收紧
- [x] 画笔引擎现状与缺点已说明
- [x] 画笔分阶段修复：拼路径整笔轮廓、惰性跟随、opacity/flow、发光/喷笔沿折线、图层缓存
- [x] 更新后回归：旧笔画 `hasPointPath`、发光/喷笔 opacity 封顶、绘制中远端形状进缓存、brushMove 逐点 minDist；`COLLAB_ASSET_VERSION=20261102d`
- [x] 进站三栏大厅
- [x] 双包拆分 + 挂载 + CODE_STRUCTURE / 泳道路径更新

## 关键路径

| 用途 | 路径 |
|------|------|
| 结构导航 | `docs/CODE_STRUCTURE.md` |
| 引擎契约 | `packages/ink-engine/CONTRACT.md` |
| 联机契约 / 协议 | `packages/ink-net/CONTRACT.md`、`protocol.md` |
| 工作区样式 | `app/games/collab_canvas/static/css/collab-workspace.css` |
| 入口模板 | `app/games/collab_canvas/templates/index.html` |

## 阻塞 / 未决

- **阻塞**：无
- **未决问题**：公开房间发现（局域网 / DHT）；大厅何时按特色提示词改样式

## 专题文档

| 文档 | 用途 |
|------|------|
| `docs/CODE_STRUCTURE.md` | 双包 + App 与改哪里 |
| `docs/ui/distinctive-ui.md` | 大厅特色 UI 提示词 |
| `docs/ui/efficient-ui.md` | 画板与他人光标的高效 UI 提示词 |

## Handoff

- 浏览器 JS：引擎只改 `packages/ink-engine`，联机只改 `packages/ink-net`；装配改 `static/js/app`。
- 读本节「活跃泳道」与决策 d4；契约变更同步两边 `CONTRACT.md`。
- **勿动**对方泳道：UI 不改笔迹核心；画笔不改 net 包；net 不改 board/core|tool。
- 画笔泳道已 done：后续手测半透明叠笔、点按、抬笔卡顿、旧房间无 points 笔画。
- 改静态资源后递增 `routes.py` 的 `COLLAB_ASSET_VERSION`。
