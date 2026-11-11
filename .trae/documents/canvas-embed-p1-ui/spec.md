# 画布内嵌 P1 · UI 接入规格（spec）

> 状态：已实施（2D/Hex 整板段，2026-11-10；姿态 3D 视图段，2026-11-11）  
> 后续：按用户新口径，embed 抽象已下沉到「视图 id」并落地第一个视图（`attitude3d`）；3D 轨迹视图仍待评估。
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

## 10. 视图段（attitude3d，2026-11-11 追加）

### 10.1 口径变更

内嵌目标从「整块面板」下沉到「视图」：`plot2d` / `hexview` 仍是整板（有停靠对应物，可双向搬），
`attitude3d` 是视图（只渲染模型本身，不挂面板工具栏/绑定区/状态栏，也不参与「移回停靠」）。

- `embedPanels.ts` 是白名单唯一出处：`EMBED_PANEL_IDS` / `EMBED_VIEW_IDS` / `EMBED_IDS`、
  `EMBED_ID_MIN`、`EMBED_ID_ASPECT`、`isEmbedId` / `isEmbedPanelId` / `isEmbedViewId`、
  `embedKindOf`、`embedName`、`sanitizeEmbedViewState`。
- `EmbedCard.panelId` 类型放宽为 `EmbedId`；视图的 `viewState` 恒为 `null`（相机由用户现调，不跨实例迁移）。
- schema 同时表达两种形态；导入导出、Operator 包白名单、控件库、drop 判定全部走同一张 `EMBED_IDS`。
  未知 id 在导入时丢弃并告警（`importPage({ droppedPanels })` → activate 回执里列出）。

### 10.2 宿主与形态

共用 `EmbedCardView` 卡片宿主（标题条 + 内容体 + rAF 可见性 + 拖动只认 `[data-embed-head]`）。
视图形态额外在标题条右侧给一颗「锁定交互」图标钮（`aria-pressed`，Lock/Unlock SVG），
锁上后 `OrbitControls.enabled = false`：拖卡片、滚页面都不会误转视角。2D/Hex 不显示该按钮。

`AttitudeModelView` 数据只订阅 `attitudeStore`（`config` / `values`；settings 只用于取全局 zoom 折算像素比），
模型几何复用 `View3D.tsx` 导出的 `buildModel` / `addStickerArrow`，避免两处机头朝向不一致。

### 10.3 实例上限与渲染预算（纯函数 `attitudeViewQuality.ts`）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `ATTITUDE_VIEW_MAX_INSTANCES` | 1 | 视图同屏上限；第二张被 `view-limit` 拒（不是靠文档） |
| `ATTITUDE_WEBGL_BUDGET` | 2 | 姿态自身：停靠 1 + 内嵌 1 |
| `TRAJECTORY_WEBGL_BUDGET` | 1 | 3D 轨迹单独计，不与姿态共享 |

降级阶梯（只降不升；重挂载回到 L0）：

| 级别 | dprCap | 目标 fps | 降级条件 |
| --- | --- | --- | --- |
| L0 | 2 | 30 | fps < 24 持续 2000ms → L1 |
| L1 | 1.5 | 30 | fps < 20 持续 2000ms → L2 |
| L2 | 1 | 20 | 终点，不再降 |

像素比：`pixelRatioFor(dpr, zf, level) = clamp(dpr × zf, 1, dprCap, 2)`；`zf = zoom / 100`。
不可见（`panelActivity.isVisible("attitude3d")` 为假）时整帧跳过并重置采样窗口，避免 fps 被算成 0 误降级。

### 10.4 尺寸与交互

- 最小格数 `EMBED_ID_MIN.attitude3d = { w: 4, h: 3 }`；宽高比 `EMBED_ID_ASPECT.attitude3d = 4/3`，
  `normalizeGeometry` 在最小格数钳制之后按 4:3 回正，resize 时同样被钳制。
- 指针：左键旋转、右键平移、滚轮缩放全部是 `OrbitControls` 默认映射，不另写手势。
- 可见性沿用 rAF 每 6 帧比较 `getBoundingClientRect` 与 `.ctl-grid`，不用 `IntersectionObserver`。

### 10.5 视图段测试

| 文件 | 用例 |
| --- | --- |
| `attitudeViewQuality.test.ts` | 预算分开计、dwell、只降不升、cap/target 表、`pixelRatioFor` 三条 |
| `embedPanels.test.ts` | 两种 id 的判定、`embedKindOf`、最小格数/宽高比、视图 `viewState` 恒 null |
| `controlsStore.test.ts` | 视图按 4:3 最小尺寸落卡；导入的 12×2 被回正为 12×9；未知视图 id 丢弃 |
| `panelPlacement.test.ts` | 视图从控件库直加；第二张 `view-limit`；拒因文案全覆盖 |

## 11. 手测脚本（用户自行执行，agent 不操作用户电脑）

1. 打开「2D 曲线」停靠面板 → 页签 chrome 点「内嵌到控制画布」→ 卡片出现，曲线继续、视野不跳；
2. 拖卡片标题条换位置；在曲线区拖动/滚轮 → 只平移/缩放曲线，不移动卡片；
3. 右键卡片「移回停靠」→ 回到页签，视野仍是内嵌前那段；
4. 左侧「控件」导轨 →「面板」分组拖「Hex 数据流」到画布 → 出现 Hex 卡，滚轮/滚动条可用；
5. 同一面板再拖一次 → 出现「已在画布内嵌」toast；停靠中再点 chrome → 出现「已在停靠区」toast；
6. 把页面缩小到放不下最小格数 → 出现「页面太小 / 没有空位」toast；
7. 切到别的控制页再切回 → 卡片与视野保留（视图态随卡片存档）；
8. 浅色主题下检查标题条、边框、手柄不重叠、不越界。
9. 控件库「面板」拖「姿态 3D 模型」→ 卡片只出现模型，没有面板工具栏/侧栏/状态栏；
10. 卡片内左键拖 = 旋转、右键拖 = 平移、滚轮 = 缩放；点标题条锁按钮后再拖卡片 → 视角不动，图标变锁；
11. 再拖一张姿态视图 → 出现「姿态视图最多同屏 1 个」toast；
12. 卡片拖右下角缩放 → 宽高比保持 4:3，且不会小于 4×3 格。

## 12. 回滚

本批不迁移持久数据（`EmbedCard.viewState` 是可缺省字段）。若需回滚：`git revert` 单提交即可；已导出的 v2 存档在旧版本会被版本检查拒绝，不会静默丢卡。

## 13. 卡布拖拽/滚轮缺陷修复（2026-11-11 追加）

### 13.1 控件拖成一条 / 内嵌卡只剩阴影（同一个根因）

**根因（DOM 与 React 共管同一组样式）**
1. `ControlCanvas` 的 resize 结束逻辑先把 `el.style.width = ""` / `el.style.height = ""` 清空，再 `store.patchCard`；
2. React 的 style diff 只重写「值发生变化」的属性——只改一个轴的 resize，另一个轴的值没变，React 不再写回；
3. 未写回的轴落到 `auto`，而 `.ctl-card` 是 `container-type: size`（尺寸包含，没有内容内在尺寸），`auto` 解析为收缩到内容宽/高 → 卡片塌成一条，看起来只剩边框阴影。

无头 Chrome + CDP 取证（`Input.dispatchMouseEvent` 真实拖拽）：
- 只改高度：`styleWidth` 为空，实测 `22px × 60px`（竖条）；
- 只改宽度：`styleHeight` 为空，实测 `196px × 14px`（横条）。

**修法**
- 新增 `features/controls/cardBox.ts`：`applyCardBox(el,w,h,step,gap)` **原子地写两轴**，永不写空串，非有限值/0 格回落 1 格；
- resize 过程、提交、以及"页面消失"兜底路径全部改为 `applyCardBox`，不再清空；
- 提交后按 `store.findCardById` 的最终值再写一遍，覆盖嵌入卡宽高比/最小格数的归一化；
- 只读（Operator）下不进入拖拽/resize，避免"拖得动、松手弹回"。

**为什么不会再复发**：`cardBox.test.ts` 钉住「只改一轴时另一轴仍必须被写回」与「永不写空/NaN」；代码里不再存在任何 `style.width/height = ""`。塌陷链路的两个必要条件（清空 + React 不补写）同时被移除。

### 13.2 姿态 3D 卡片滚轮同时滚动画布

**根因**：`ControlCanvas` 在 `.ctl-grid` 上挂了非被动 wheel（`preventDefault` + `scrollTop += dy`）；`OrbitControls` 只在 canvas 上 `preventDefault`，**不 stopPropagation**，事件继续冒泡到 `.ctl-grid`。

**修法**：`AttitudeModelView` 在宿主上挂 `{ passive:false }` 的 wheel，未锁定时 `stopPropagation + preventDefault`；锁定时不拦，滚轮交还画布。缩放量取 `deltaY`，不依赖坐标，全局 CSS zoom 不影响。

无头取证：指针在卡片内 `scrollTop 0→0`；卡片外 `0→120`；锁定后卡片内 `0→120`。

### 13.3 同类排查

- 画布内其它卡片：resize 全走 `applyCardBox`，不再有单轴写入；
- 只读态：拖拽与 resize 都不起手；
- 事件绑定：拖拽/缩放的 window 监听在 effect cleanup 中移除，theme/zoom 变化会重建而不是叠加；
- 未改动 `theme.css` 与命令库树（另一会话正在改），本批只做精准 JS/CSS 之外的 Edit。

> 手测补充：13.1 用「拖右下角只沿一个方向缩放」验证：另一个轴必须保持原尺寸；13.2 用滚轮分别在卡片内/外验证。

## 14. 轨迹视图段（trajectory3d，2026-11-11 追加）

### 14.1 形态与白名单

`trajectory3d` 是第二个**视图**形态，只渲染 3D 轨迹内容（画布 + 轴标签 + 最小 HUD），
不挂 `Plot3D` 的组托盘 / 时间条 / 统计栏 / 右键菜单。整板 `plot3d` **仍然不可嵌**（保持现状），
两者是不同 id：整板停靠与轨迹视图可以同屏，各算各的 WebGL 预算。

- `embedPanels.ts`：`EMBED_VIEW_IDS = ["attitude3d", "trajectory3d"]`；
  `EMBED_ID_MIN.trajectory3d = { w: 5, h: 4 }`（300×240 @60px 格，容得下 3 个图例点与轴标签）；
  `EMBED_ID_ASPECT.trajectory3d = 4 / 3`（与姿态同口径，竖条会裁掉轴标签，16:9 扁条会压扁轨迹）；
  `embedName` 中文「3D 轨迹视图」/ 英文「3D Trajectory View」；
  `sanitizeEmbedViewState` 对两个视图 id 都返回 `null`。
- 控件库、导入导出、`canAddEmbedCard`、`ControlCanvas.setEmbeddedPanels` 全部自动继承 `EMBED_IDS`，不再加第二张表。

### 14.2 复用与抽取（不另起一套并列实现）

| 公共件 | 位置 | 谁用 |
| --- | --- | --- |
| 卡片宿主、标题条、锁按钮、rAF 可见性 | `panels/embedHost.tsx`（已存在） | 全部内嵌 |
| 降级阶梯状态机 `makeLadder(tiers)` | 新增 `panels/viewQuality.ts` | 姿态、轨迹各传自己的 tiers |
| 非被动 wheel 分流 `attachViewWheelGuard(host, isLocked)` | 新增 `panels/viewQuality.ts` 同文件 | 姿态、轨迹 |
| 像素比 `pixelRatioFor(dpr, zf, level)` | `makeLadder` 返回值 | 姿态、轨迹 |

`attitudeViewQuality.ts` 改为「配置 + 转出」薄层：`TIERS` 保持现值，导出名
（`nextQuality` / `dprCapOf` / `targetFpsOf` / `pixelRatioFor` / `QualityLevel`）全部保留，
现有 7 例测试不改语义。`AttitudeModelView` 的 wheel 监听改调 `attachViewWheelGuard`（行为不变）。

`embedHost` 的可见性上报修正为 `card.panelId`（此前传 `card.id` 的 uuid，与
`setEmbeddedPanels` 的 panelId 集合对不上，滚出视口从未真正生效）；同 id 至多一张卡由放置互斥保证。

### 14.3 数据侧（只订阅 `plotStore` + `plot3dStore`）

- `plot3dStore` 增加**第二个 sink**：`setViewSink(cb)` / `viewSink`，与停靠面板的 `sink` 并列；
  `pumpOnce` 门控改为 `isOpen("plot3d") || isOpen("trajectory3d")`；每个 tick 先 `sink(entries,cursorSec)`
  再 `viewSink(entries,cursorSec)`（两个 if，不建数组）。泵定时器在任一 sink 存在时运行，都为空才停。
- 新 sink 注册时把现有组的 `replay` 置真（沿用 `setSink` 的续传机制），后挂的视图拿到保留历史重灌，
  不与已挂实例抢同一份水位；`setSink(null)` 仍只清校准会话，`setViewSink(null)` 不清。
- `plotStore.init` 的采集门控增加 `!isOpen("trajectory3d")`：只开轨迹视图也有数据入库。
- 视图组件用 `useSyncExternalStore` 分别订阅 `plotStore`（channels）与 `plot3dStore`（settings），
  不新增第三个订阅；每帧路径只调 `scene.applyBatch` / `applySettings`（后者按 `s3d`、通道签名、`themeTick` 去重）。

### 14.4 `TrajectoryView.tsx`

新增 `src/features/plot3d/TrajectoryView.tsx`（`locked` prop，与 `AttitudeModelView` 同形）：

1. 复用 `createScene(host, { onContextLost, isVisible })`，不复制渲染器 / LOD / 拾取逻辑；
2. `scene.setViewSink((entries, cursorSec) => scene.applyBatch(entries, cursorSec))`；卸载 `setViewSink(null)` → `dispose()`；
3. `applySettings(settings, channels, cbSafe, accent)`；`setFollow` / `setAutoRotate` 与停靠面板同款 effect；
4. 主题切换 `scene.applyTheme()`（不重建场景，不重置相机）；
5. 每 1s 读一次 `scene.stats().fps` 走轨迹阶梯；不可见时跳过采样并重置窗口（避免 0fps 误降级）；
6. `locked` → `scene.setInteractionsEnabled(false)`，恢复时置真；wheel 分流用公共 guard（锁定时放行给画布）。

`scene.ts` 只加四个薄 API（均无每帧分配）：
`setPixelRatio(r)`、`setFpsCap(fps)`（0 = 不限，仅 L2 用 20）、`setInteractionsEnabled(on)`、
`setAxisLabelsVisible(on)`；渲染循环内 `fpsCap` 只多一次数值比较。`createScene` 的 `cbs` 增加可选
`isVisible?: () => boolean`，循环在原有 `IntersectionObserver` 之外再判一层（宿主页签/控制页不可见时整帧跳过，
回到可见时补一帧：`needsRender = true`）。

### 14.5 实例上限与降级阶梯（`trajectoryViewQuality.ts`）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `TRAJECTORY_VIEW_MAX_INSTANCES` | 1 | 轨迹视图同屏上限；第二张 `view-limit` 拒 |
| `TRAJECTORY_WEBGL_BUDGET` | 2 | 轨迹自身：停靠 1 + 视图 1，**不与姿态相加** |

| 级别 | dprCap | 目标 fps | 降级条件（只降不升，重挂载回 L0） |
| --- | --- | --- | --- |
| L0 | 2 | 30 | rAF 实测 < 22fps 持续 2500ms → L1 |
| L1 | 1.5 | 30 | < 18fps 持续 2500ms → L2 |
| L2 | 1 | 20 | 终点；仅此级给 `setFpsCap(20)` |

阈值比姿态略宽（22/18 vs 24/20，dwell 2500 vs 2000）：轨迹每实例最多 3 组 ×（12 万尾窗 + 10 万全景），
且是事件驱动渲染，短暂 GC / 导入抖动更容易造成假降级；L2 的 20fps 上限是真正削减 GPU 占用的那一步。
`pixelRatioFor(dpr, zf, level) = clamp(dpr × zf, 1, dprCap, 2)`，`zf = zoom / 100`，与本轮全局缩放口径一致。

### 14.6 相机与视图态：不迁移

结论：切页 / 重启回到默认机位，`viewState` 恒为 `null`，与姿态视图一致。

理由：
1. 轨迹视图没有停靠↔内嵌的搬运动作（`movePanelToDock` 对视图一律拒绝），不存在「接手上一处视野」的语义；
2. `scene` 把三组并集包围盒归一化到 ±0.8，默认机位 `(1.9, 1.5, 2.1)` 看向原点必定看全轨迹，默认值本身可读；
3. 迁移要把 `position/target/zoom` 写进 FlowDoc，增加 schema 字段、旧版本兼容与失效面，收益仅是省一次拖拽。

代价：切页回来需重新摆视角；不带相机也让存档更小、跨机器导入不会落进一个别人摆的奇怪角度。

### 14.7 指针语义与长按测距

- 左键旋转 / 右键（或中键）平移 / 滚轮缩放：沿用 `scene.ts` 的 `OrbitControls.mouseButtons`，不另写手势；
- 卡片内滚轮：未锁定 `stopPropagation + preventDefault`（非被动监听），只缩放轨迹不滚 `.ctl-grid`；
  锁定时不拦，滚轮交还画布 —— 与姿态视图同一套 `attachViewWheelGuard`；
- **长按测距不保留**。理由：① 视图定位是「监视同屏」，测距是分析动作，属于整板 `plot3d`；
  ② 长按与卡片拖动/触控笔手势语义冲突，锁定交互后更难解释；③ 保留就得把测量气泡、命中拾取、
  测距菜单一起搬进来，卡片尺寸下必然与图例/HUD 抢空间。需要测距请用停靠面板（数据同源，结果一致）。

### 14.8 尺寸收敛（HUD / 轴标签 / 图例）

容器宽度分三档，由 `ResizeObserver` 读 `wrap.clientWidth`（只在跨档时写一次 DOM/开关）：

| 容器宽度 | 图例 | 轴标签（scene sprite） | 统计 HUD |
| --- | --- | --- | --- |
| ≥ 300px | 色点 + 组名 | 显示 | 点数 + fps |
| 220–299px | 仅色点 | 隐藏（`setAxisLabelsVisible(false)`） | 点数 + fps |
| < 220px | 隐藏 | 隐藏 | 隐藏 |

CSS 只管排布（`flex-wrap`、`min-width:0`、不叠放），不出现 `transform: scale`；卡片高度不足时图例先于画布隐藏。

### 14.9 测试

| 文件 | 用例 |
| --- | --- |
| `trajectoryViewQuality.test.ts`（新） | 姿态/轨迹预算分开、L0→L1→L2 阈值与 dwell、只降不升、`pixelRatioFor` 三条、`TRAJECTORY_WEBGL_BUDGET=2` |
| `viewQuality.test.ts`（新） | 通用阶梯：同一 tiers 下等价于旧姿态实现；`pixelRatioFor` 夹到 [1, min(cap,2)]；两个 guard 的锁定分支 |
| `embedPanels.test.ts` | `EMBED_IDS` 含 `trajectory3d`；5×4 / 4:3；两个视图 `viewState` 恒 null；未知 `plot3d` 仍不可嵌 |
| `controlsStore.test.ts` | 轨迹视图按 5×4 落卡、`aspectLock:true`；12×2 导入回正；未知 id 丢弃 |
| `panelPlacement.test.ts` | 轨迹视图直加、第二张 `view-limit`、拒绝文案覆盖 |
| `plot3dStore.test.ts` | 双 sink 同批下发、只开视图仍泵、停靠关视图在泵继续、两 sink 全空停泵 |
| `panelActivity.test.ts` | `setEmbeddedCardVisible(panelId)` 生效（配合宿主的 id 修正） |

### 14.10 无头验证（静默截图，允许）

沿用 `.tmp/repro-ctl.mjs`（gitignored）：seed 一页含 `trajectory3d` 卡片 → CDP 截图确认画面非空白、
卡片不塌；`Input.dispatchMouseEvent` 在卡片内滚轮 → `.ctl-grid.scrollTop` 不变，卡片外 → 变化；
点锁按钮后卡片内滚轮 → 变化；拖右下角只改一轴 → 另一轴保持、比例 4:3。

### 14.11 验收与回滚

- `plot3d` 整板行为零变化；轨迹视图第二张被 `view-limit` 拒且文案可读；
- 全量门禁七项全绿；工作树只含本批改动，`theme.css` 仅追加 `.ctl-embed`/`.tv-*` 规则，不动既有选择器；
- 回滚：本批不迁移持久数据（`trajectory3d` 是新增 id，旧版本导入按未知 id 丢弃并告警），`git revert` 单提交即可。

### 14.12 实施结果（2026-11-11）

- 代码：`panels/viewQuality.ts`（新）、`features/plot3d/trajectoryViewQuality.ts`（新）、
  `features/plot3d/TrajectoryView.tsx`（新）、`plot3dStore.setViewSink`、`scene.ts` 四个薄 API、
  `embedPanels` / `controlsStore` / `panelPlacement` / `embedHost` / `plotStore` 各一处接点。
- 无头（`.tmp/verify-traj.mjs`，注入最小 Tauri IPC 存根）：卡片 332×264、canvas 330×236 非空白；
  滚轮 内 `0→0` / 外 `0→120` / 锁定 `0→120`；resize 332×264 → 468×332（7×5、两轴同步、画布 466×304）；
  `data-chrome` 0→1→2 且 180px 下图例/HUD 收起、无相交矩形；控制台 0 error。
- 门禁：插件四文件 151 / 全量 vitest 2757（226 文件）/ tsc 0 / eslint 0 错 22 警告 /
  check:all OK(17) / vite build / cargo check 0 错（4 条既有 warning）。
- 偏差：`check-empty-copy` 需为 `TrajectoryView.tsx` 登记 15 字空态文案（门要求新空态显式入册），
  已按"一句回执、不写说明墙"的口径登记。

