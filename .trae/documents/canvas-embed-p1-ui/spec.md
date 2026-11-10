# 画布内嵌 P1 · UI 接入规格（spec）

> 状态：已实施（2D/Hex 整板段，2026-11-10）  
> 后续：按用户新口径，embed 抽象将下沉到「视图 id」，并追加姿态 3D 模型视图；本文件记录的是第一段（整板）落地口径。
> 前置提交：`0866d28`（逻辑层：schema v2 / panelActivity 并集 / 视图态契约 / 单实例互斥）  
> 语言：中文；代码注释中文，解释「为什么」。  
> 硬约束：浅色默认；SVG 图标；禁字符图标与 emoji；元素不重叠、对齐成体系；禁 `transform: scale`；禁操作本机 GUI（验证只跑单测 / 构建 / 无头渲染）。

## 1. 目标

把已经落库的逻辑层接上真正的 UI，让「2D 曲线」「Hex 数据流」两种面板可以：

1. 作为控制画布里的卡片真实渲染、真实收数据、真实可见性门控；
2. 从左侧控件库「面板」分组拖入画布，或从面板页签 chrome 一键内嵌；
3. 从内嵌卡片右键一键移回停靠，并保持视野不跳；
4. 失败原因（已停靠 / 已内嵌 / 无空位 / 页面太小 / 只读）说人话；
5. 卡片有标题条、边框、resize 手柄、最小尺寸提示，窄卡收工具栏与图例。

## 2. 边界（明确不做）

- 不扩大白名单：只有 `plot2d`、`hexview`。
- 不替换 dockview；停靠体系、布局存档、页签行为不动。
- 不做画布独立变焦；缩放仍走「格数重排 + 全局 CSS zoom」。
- 不做内嵌卡片的复制/多实例；同一 `panelId` 全局至多一处。
- 不新增 IntersectionObserver、不新增 store 订阅、不在 rAF 循环里做对象/数组分配。
- 不改 `package.json`、不动另一条会话的文件。

## 3. 关键设计决策

### 3.1 可见性 = 宿主页签可见 && 卡片在画布视口内

`panelActivity` 现有口径只到「宿主控制画布可见」。本轮补「卡片是否滚出视口」：

- 新增隐藏集合 `hiddenEmbedded`；
- `setEmbeddedCardVisible(id, visible)`：卡片滚出 `.ctl-grid` 视口 → 记入隐藏；滚回 → 移除；
- `clearEmbeddedCardVisibility(id)`：卡片卸载时清掉残留标记；
- `setEmbeddedPanels(ids)` 时把不在新集合里的 id 从 `hiddenEmbedded` 剪掉（换页/删卡不留脏标记）；
- `recompute()` 中 `visible = dockVisible(gate) && embedded && !hidden`；
- 初始不隐藏（新卡先画一帧），由 rAF 第一轮纠正。

rAF 判定放在 `EmbedCardView` 内：每 6 帧（约 100ms）比较一次卡片 `getBoundingClientRect()` 与最近的 `.ctl-grid` 视口矩形；布尔值变化才写 registry。**这是唯一的布局读取**，且不产生订阅。

### 3.2 视图态交接

沿用第一轮契约：`capturePanelView` → pending → 新实例 `registerPanelView` 一次性消费。本轮补两点：

- 卡片持久化的 `viewState` 在挂载时通过新增的 `primePanelView(panelId, state)` 预置 pending（**已有 pending 不覆盖**，保证「刚 capture 的实时视野」优先于「旧存档」）；
- `primePanelView` 在 `EmbedPanelHost` 的首个 render 惰性执行一次（子组件的 effect 晚于父 render，能在注册时吃到）。

### 3.3 双向切换顺序

- 停靠 → 内嵌（`movePanelToCanvas`）：先 `canAddEmbedCard` 干跑校验 → `capturePanelView` → `closeDockPanel` → `addEmbedCard(pageId, panelId, view)`；任何一步失败都 `discardPanelView` 并把 dock 恢复原样（未关闭前失败则无需恢复）。
- 内嵌 → 停靠（`movePanelToDock`）：先 `isDockReady()` → `capturePanelView` → `removeCard` → `openDockPanel`；极端失败则把卡片加回去并 `discardPanelView`。
- 两个动作都在同一个事件回调里完成，React 批处理下新旧实例同帧交接。

### 3.4 拖拽

- 新 kind：`vs-panel`，data 形如 `{"panelId":"plot2d"}`；
- 控件库「面板」分组只渲染 `EMBED_PANEL_IDS`；
- 画布 drop zone kind 串追加 `vs-panel`；
- 悬停预览用 `EMBED_PANEL_MIN` 的格数，并提前 `canPlacePanelInCanvas` 判可放置；
- 放下调用 `movePanelToCanvas`（已停靠的面板也走这条路，先 capture 再关闭），成功后按落点 `placeAt`（落点被占则保留自动选位）。

### 3.5 内嵌卡片拖动

`CardFrame` 新增 `dragHandleOnly?: boolean`：为真时只有 `e.target.closest("[data-embed-head]")` 命中才触发整卡拖动。内容区（uPlot 画布 / Hex canvas）的鼠标事件直通组件。`embed` 卡根节点加 `embed` 类（`cursor: default`），标题条自己 `cursor: grab`。

### 3.6 视觉

不另起 token：标题条用 `--depth-bg-1`、次要文字 `--depth-fg-3`、分隔线 `--border-soft`、间距 `--sp-*`、圆角沿用 `.ctl-card` 的 `--radius-l`。新增类：

- `.ctl-card.embed`：去 padding、`justify-content: stretch`、`cursor: default`、`container-name: ctl-embed`；
- `.ctl-embed` / `.ctl-embed-head` / `.ctl-embed-title` / `.ctl-embed-meta` / `.ctl-embed-min` / `.ctl-embed-body`；
- `.ctl-embed-body > *` 绝对填满，避免 uPlot/Hex 撑破卡片；
- 窄卡容器查询（`@container ctl-embed (...)`）：≤420px 收 uPlot 图例；≤340px 收 Plot2D 的 Hz 徽标/游标提示/测量列与 Hex 搜索框；≤260px 再收 Hex 右侧统计。
- 不使用 `transform: scale`。

### 3.7 拒绝提示

`placementRejectText(reason)` 用 `tx(中, 英)` 全覆盖 7 种原因；调用点只负责 `toast(placementRejectText(...))`。不写 `default`，少一种原因是编译错误。

## 4. 改动清单（逐文件）

### 4.1 `src/panels/panelActivity.ts`

- 新增 `hiddenEmbedded`、`setEmbeddedCardVisible`、`clearEmbeddedCardVisibility`；
- `setEmbeddedPanels` 剪枝 `hiddenEmbedded`；
- `recompute` 排除隐藏项；
- 头注补「内嵌可见性含视口判定」。

### 4.2 `src/features/controls/controlsStore.ts`

- `addEmbedCard(pageId, panelId, viewState?: EmbedPanelViewState)`：用 `sanitizeEmbedViewState` 收敛后写入 `EmbedCard.viewState`（非法/缺省不写字段）；
- 新增 `canAddEmbedCard(pageId, panelId): EmbedAddResult`：与 `addEmbedCard` 同一套校验但不落库，供移动前干跑；
- 内部抽 `checkEmbedPlacement` 供两者复用，避免两份判断漂移。

### 4.3 `src/panels/viewState.ts`

- 新增 `primePanelView(panelId, state)`：`pending` 已有值时不覆盖。

### 4.4 `src/shell/dockBridge.ts`（新增）

```ts
registerDockApi(api, opener): void
unregisterDockApi(api): void
isDockReady(): boolean
openDockPanel(id): boolean   // 复用 App.addOrFocusPanel
closeDockPanel(id): boolean  // api.getPanel(id)?.api.close()
```

### 4.5 `src/App.tsx`

- `onReady` 末尾 `registerDockApi(api, (id) => { addOrFocusPanelRef.current(id); return true; })`；
- 用 ref 转发 `addOrFocusPanel`，规避 `const` 先用后声明；
- 卸载时 `unregisterDockApi(api)`。

### 4.6 `src/panels/panelPlacement.ts`

- `placePanelInCanvas(pageId, panelId, viewState?)` 透传视图态；
- 新增 `movePanelToCanvas(panelId): PlacePanelResult`（3.3 顺序）；
- 新增 `movePanelToDock(pageId, card: EmbedCard): { ok: true } | { ok: false; reason: "dock-unavailable" }`；
- 新增 `placementRejectText(reason): string`（tx 全覆盖）。

### 4.7 `src/panels/embedHost.tsx`（新增）

- `EmbedPanelHost({ panelId })`：`plot2d → MPlot2D`、`hexview → MHexView`，二者均已 memo；
- `EmbedCardView`：CardFrame（`dragHandleOnly`）+ 标题条（`data-embed-head`）+ 内容体 + rAF 可见性；
- 首个 render 惰性 `primePanelView`（读 `card.viewState`）；
- 标题条：卡名、面板名、`≥{minW}×{minH}` 提示；
- 卸载：`clearEmbeddedCardVisibility(card.id)`。

### 4.8 `src/features/controls/CardViews.tsx`

- `CardFrameProps` 加 `dragHandleOnly?: boolean`；
- 根 class 追加 `embed`（按 `card.type`）；
- 根 `onMouseDown` 按 3.5 门控。

### 4.9 `src/features/controls/ControlCanvas.tsx`

- 引入 `EmbedCardView`、`panelActivity`、`EMBED_PANEL_MIN`、`isEmbedPanelId`、`movePanelToCanvas`、`movePanelToDock`、`canPlacePanelInCanvas`、`placementRejectText`；
- effect：当前页内嵌卡 id 串变化 → `setEmbeddedPanels(ids, "controls")`；卸载 → `setEmbeddedPanels([])`；
  - **hook 顺序**：该 effect 必须写在 `if (!page)` 早返回之前（用 `page?.cards` 取值），否则切到无页状态会触发 React hook 数量变化；
  - id 串构造时逐张 `isEmbedPanelId(c.panelId)` 过滤，坏数据不进 registry；
- `renderCard` 在 managed 兜底后加 `if (c.type === "embed") return <EmbedCardView ... />`；
- pdrag zone kinds 追加 `vs-panel`；
- `gridOverRef` 处理 `vs-panel`（最小格数、可放置性、冲突判定）；
- `gridDropRef` 处理 `vs-panel`（`movePanelToCanvas` → 失败 toast → 成功 `placeAt`）；
- 卡片右键菜单：`menuCard.type === "embed"` 时加「移回停靠」，失败 toast `dock-unavailable`。

### 4.10 `src/features/controls/WidgetGallery.tsx`

- 新增「面板」分组标题与两个条目；
- 图标复用现有 SVG（`plot2d → IconLanes`，`hexview → IconTerminal`），不新增字符图标；
- 结构：沿用 `.widget-list`，在 `CONTROL_TYPES` 循环后插一个 `.widget-group-title`（「面板」/「Panels」）和 `EMBED_PANEL_IDS.map(...)`；每条 `className="widget-item pdrag-src"`，与控件条目同一套样式，不新增视觉；
- `beginPointerDrag` kind `vs-panel`、data `{panelId}`、label `embedPanelName`。

### 4.11 `src/features/plot/Plot2D.tsx`

- `chromeItems` 末尾追加「内嵌到控制画布」（`IconDock`，`movePanelToCanvas("plot2d")`，失败 toast）；
- `feedTick` 内加 `panelActivity.isVisible("plot2d")` 门控：不可见时置脏并返回，可见后补画。

### 4.12 `src/features/hexview/HexView.tsx`

- rAF 绘制循环加 `panelActivity.isVisible("hexview")`，不满足保持 `dirtyRef` 为真；
- 注册页签 chrome：仅「内嵌到控制画布」一项（`IconDock`），失败 toast。

### 4.13 `src/styles/theme.css`

- 在 `.ctl-card.linked` 后补下列类与容器查询；
- 只复用现有 token，不新增全局变量：

```css
.ctl-card.embed { padding: 0; gap: 0; justify-content: stretch; cursor: default; container-name: ctl-embed; }
.ctl-card.embed .ctl-embed { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.ctl-embed-head { display: flex; align-items: center; gap: var(--sp-1); flex: 0 0 26px; padding: 0 var(--sp-1); border-bottom: 1px solid var(--border-soft); background: var(--depth-bg-1); color: var(--depth-fg-2); cursor: grab; user-select: none; }
.ctl-embed-head:active { cursor: grabbing; }
.ctl-embed-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--depth-fg-1); }
.ctl-embed-meta { margin-left: auto; white-space: nowrap; color: var(--depth-fg-3); }
.ctl-embed-min { color: var(--depth-fg-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ctl-embed-body { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.ctl-embed-body > * { position: absolute; inset: 0; }
.ctl-card.embed .ctl-resize { z-index: 2; }
@container ctl-embed (max-width: 420px) { .ctl-embed-body .u-legend { display: none; } }
@container ctl-embed (max-width: 340px) { .ctl-embed-body .plot-chip-hz, .ctl-embed-body .plot-cursor-hint, .ctl-embed-body .plot-measure-col, .ctl-embed-body .hex-search { display: none; } }
@container ctl-embed (max-width: 260px) { .ctl-embed-meta, .ctl-embed-body .hex-status-right { display: none; } }
```

## 5. 测试清单

| 文件 | 新增用例 |
| --- | --- |
| `src/panels/panelActivity.test.ts` | 视口隐藏：仍 open、不 visible；恢复后 visible；换内嵌集合剪掉隐藏标记 |
| `src/panels/viewState.test.ts` | `primePanelView` 不覆盖已有 pending；无 pending 时生效 |
| `src/panels/panelPlacement.test.ts` | `movePanelToCanvas` 拒绝已内嵌/页面缺失/无空位；`movePanelToDock` 在无 dock 时返回 dock-unavailable；`placementRejectText` 7 种原因均非空 |
| `src/shell/dockBridge.test.ts` | 注册后 open 复用已有页签、close 命中返回 true、未注册/未知 id 返回 false、unregister 后失效 |
| `src/features/controls/controlsStore.test.ts` | `addEmbedCard` 带 viewState 落库并可被 `sanitize` 读回；`canAddEmbedCard` 不改变快照 |
| `src/panels/embedVisibility.test.ts` | 纯函数视口相交：完全在内/部分相交/完全在外/贴边 |

`embedVisibility.ts` 抽纯函数 `rectsOverlap(card, view)`，供 `EmbedCardView` 与单测共用，避免为可见性去渲染 uPlot/Canvas。

## 6. 验证门禁（全绿才算完成）

按顺序执行，任一失败先修根因：

1. 插件四文件门禁（`check:all` 串联项，含插件清单/契约检查）；
2. `npx vitest run`（全量）；
3. `npx tsc --noEmit`；
4. `npx eslint src scripts`；
5. `npm run check:all`；
6. `npx vite build`；
7. `cargo check`（`src-tauri`）。

不启动 GUI、不截图、不点击；无头渲染仅限单测环境。

## 7. 文档与提交

- 本目录 `tasks.md` 状态逐项打勾；
- `HANDOFF.md` 第十六节追加本批记录（问题、裁决、验证数字）；
- 单次提交，消息说明「为什么」：内嵌卡片此前只有逻辑层，接不上宿主就是死图；本次接通宿主、双向切换与拒绝提示；
- 提交后输出阶段报告：改动文件、内嵌 2D/Hex 的实际用法、关键数字（测试数/构建结果）、遗留风险。

## 8. 风险与应对

| 风险 | 应对 |
| --- | --- |
| dock 关闭与卡片挂载同帧，视图态被旧实例吃掉 | capture 先于 close；`registerPanelView` 注销只删自己那份；`primePanelView` 不覆盖 pending |
| 卡内 uPlot 抢鼠标导致拖不动 | `dragHandleOnly` 只认标题条；内容区完全直通 |
| rAF 读布局造成滚动卡顿 | 100ms 节流、布尔变化才写 registry、循环内不分配对象 |
| 窄卡图表溢出 | `.ctl-embed-body` 裁切 + `inset:0` 绝对定位 + 容器查询收工具栏 |
| 隐藏卡片仍跑数据泵 | `isVisible` 门控渲染；`isOpen` 仍按并集决定数据采集，可见后补画 |

## 9. 验收矩阵（对应用户五项）

| 用户要求 | 落点 | 可观察结果 |
| --- | --- | --- |
| 1 卡片宿主 | `embedHost.tsx` + `renderCard` + `setEmbeddedPanels` effect | 卡片里出现真实曲线/Hex，收数时刷新；删卡后 `panelActivity.isOpen` 变 false |
| 2 拖拽入口 | `WidgetGallery` + `vs-panel` + `".ctl-grid"` zone | 从「面板」拖入落点出现最小格数预览，松手成卡；标题条可拖、内容区可平移/滚动 |
| 3 两处切换 | `Plot2D/HexView` chrome + 卡片右键 | 内嵌/停靠往返后 X/Y 区间或滚动位置不跳；全局只有一个实例 |
| 4 拒绝提示 | `placementRejectText` + `toast` | 停靠中/已内嵌/无空位分别出现不同可读文案 |
| 5 卡片视觉 | `theme.css` + CardFrame | 浅色下标题条/边框/手柄清晰；窄卡收图例与工具栏；无 `transform: scale` |

## 10. 手测脚本（用户自行执行，agent 不操作用户电脑）

1. 打开「2D 曲线」停靠面板 → 页签 chrome 点「内嵌到控制画布」→ 卡片出现，曲线继续、视野不跳；
2. 拖卡片标题条换位置；在曲线区拖动/滚轮 → 只平移/缩放曲线，不移动卡片；
3. 右键卡片「移回停靠」→ 回到页签，视野仍是内嵌前那段；
4. 左侧「控件」导轨 →「面板」分组拖「Hex 数据流」到画布 → 出现 Hex 卡，滚轮/滚动条可用；
5. 同一面板再拖一次 → 出现「已在画布内嵌」toast；停靠中再点 chrome → 出现「已在停靠区」toast；
6. 把页面缩小到放不下最小格数 → 出现「页面太小 / 没有空位」toast；
7. 切到别的控制页再切回 → 卡片与视野保留（视图态随卡片存档）；
8. 浅色主题下检查标题条、边框、手柄不重叠、不越界。

## 11. 回滚

本批不迁移持久数据（`EmbedCard.viewState` 是可缺省字段）。若需回滚：`git revert` 单提交即可；已导出的 v2 存档在旧版本会被版本检查拒绝，不会静默丢卡。

