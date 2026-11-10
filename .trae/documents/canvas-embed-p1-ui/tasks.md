# 画布内嵌 P1 · UI 接入任务清单（tasks）

> 规格：同目录 `spec.md`。勾选 = 已实现且该项验证通过。  
> 门禁：插件四文件 → vitest 全量 → tsc → eslint → check:all → vite build → cargo check。

- [x] T1 `panelActivity` 视口隐藏 API
  - [x] `hiddenEmbedded` + `setEmbeddedCardVisible` + `clearEmbeddedCardVisibility`
  - [x] `setEmbeddedPanels` 剪枝；`recompute` 排除隐藏
  - [x] `panelActivity.test.ts` 补 3 例
- [x] T2 `viewState.primePanelView` + 单测（不覆盖 pending）
- [x] T3 `embedVisibility.ts` 纯函数 + 单测（4 例）
- [x] T4 `controlsStore`：`addEmbedCard(viewState?)` / `canAddEmbedCard` / 抽 `checkEmbedPlacement`
  - [x] 单测：viewState 落库、干跑不改快照
- [x] T5 `dockBridge.ts` + `App.tsx` 注册/注销 + 单测
- [x] T6 `panelPlacement`：`movePanelToCanvas` / `movePanelToDock` / `placementRejectText` / `placePanelInCanvas(viewState?)`
  - [x] 单测：拒绝路径、dock 未就绪、文案全覆盖
- [x] T7 `EmbedCardView` + `EmbedPanelHost`（rAF 100ms 可见性、prime 视图态、标题条、卸载清理）
- [x] T8 `CardFrame.dragHandleOnly` + `embed` 类
- [x] T9 `ControlCanvas`
  - [x] `renderCard` 接 embed
  - [x] `setEmbeddedPanels` 同步/清理
  - [x] `vs-panel` 悬停预览 + 落下
  - [x] 右键「移回停靠」+ toast
- [x] T10 `WidgetGallery` 面板分组（仅白名单，SVG 图标，`vs-panel`）
- [x] T11 `Plot2D`：chrome「内嵌到控制画布」+ `isVisible` 数据门控
- [x] T12 `HexView`：chrome「内嵌到控制画布」+ rAF `isVisible` 门控
- [x] T13 `theme.css`：embed 卡片视觉、resize/最小尺寸提示、容器查询；无 `transform: scale`
- [x] T14 门禁全绿（7 项）
- [x] T15 `HANDOFF.md` 第十六节追加本批记录
- [x] T16 提交（说明原因）并输出阶段报告

## 完成定义

- 拖入/内嵌后卡片里是真 `Plot2D` / `HexView`，有数据、有缩放/平移/滚动；
- 双向切换后视野连续，无第二个实例、无重复订阅；
- 三种主要原因（docked / already-embedded / no-space）都有可读 toast；
- 卡片只可拖标题条，内容区不抢事件；
- 全量门禁绿，工作树只含本批改动。
