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

## 视图段：embed 下沉到视图（attitude3d，2026-11-11）

- [x] V1 `embedPanels.ts`：`EMBED_PANEL_IDS` / `EMBED_VIEW_IDS` / `EMBED_IDS`、`EMBED_ID_MIN`、`EMBED_ID_ASPECT`、`isEmbedId` / `isEmbedPanelId` / `isEmbedViewId`、`embedKindOf` / `embedName` / `sanitizeEmbedViewState`
  - [x] `embedPanels.test.ts` 6 例
- [x] V2 `attitudeViewQuality.ts`：预算（姿态 2 / 轨迹 1 分开计）、L0-L2 降级阶梯、`pixelRatioFor(dpr×zf, cap 2)`
  - [x] `attitudeViewQuality.test.ts` 7 例
- [x] V3 `AttitudeModelView.tsx`：只渲染模型、只订阅 `attitudeStore`、OrbitControls 默认手势、锁交互、rAF 可见性、主题切换不重置相机
- [x] V4 `View3D.tsx` 导出 `buildModel` / `addStickerArrow`，两处共用同一模型
- [x] V5 `attitudeStore` 收数门控：`isOpen("view3d") || isOpen("attitude3d")`
- [x] V6 `controlsStore`：`panelId: EmbedId`、`EMBED_ID_MIN`、4:3 宽高比钳制、`countEmbedCards`、导入未知视图 id 丢弃
- [x] V7 `panelPlacement`：`VIEW_INSTANCE_CAP` / `view-limit`、`addEmbedFromGallery`、视图不参与 `movePanelToDock`
- [x] V8 `embedHost`：视图分支 + 标题条锁按钮（SVG、`aria-pressed`）+ `embedName`
- [x] V9 `WidgetGallery` / `ControlCanvas`：`EMBED_IDS`、视图图标、右键「移回停靠」仅整板
- [x] V10 `operatorStore`：导入丢弃回执（`droppedPanels`）
- [x] V11 `theme.css`：`.ctl-embed-lock`、`.att-view*`（无 `transform: scale`）
- [x] V12 门禁全绿（插件四文件 151 / vitest 2734 / tsc 0 / eslint 0 错 22 警告 / check:all OK(17) / vite build / cargo check）
- [x] V13 `HANDOFF.md` 追加视图段（本地，gitignore）
- [x] V14 提交并输出阶段报告

## 缺陷修复段：拖拽塌陷与滚轮分流（2026-11-11）

- [x] F1 复现：无头 Chrome + CDP 真实拖拽，抓到 `styleWidth/styleHeight` 为空、卡片 22×60（竖条）/196×14（横条）
- [x] F2 根因：resize 提交前清空 React 管理的 `style.width/height`；React style diff 不回写未变轴；`container-type: size` 把 `auto` 解析成内容宽高 → 塌成一条
- [x] F3 新增 `features/controls/cardBox.ts`（`applyCardBox` 原子写两轴、永不写空/NaN）+ `cardBox.test.ts` 3 例
- [x] F4 `ControlCanvas` resize 全过程 / 提交 / 页面消失兜底 / 归一化回写全部改走 `applyCardBox`
- [x] F5 只读（Operator）下拖拽与 resize 不起手
- [x] F6 `AttitudeModelView` 宿主非被动 wheel：未锁定截停冒泡、锁定放行；卡片内只缩放模型，卡片外滚画布
- [x] F7 无头取证：卡内 `scrollTop 0→0`、卡外 `0→120`、锁定后卡内 `0→120`；内嵌卡移动后尺寸不变、单轴 resize 后另一轴保持
- [x] F8 门禁全绿（插件四文件 151 / vitest 2737 / tsc 0 / eslint 0 错 22 警告 / check:all OK(17) / vite build / cargo check）
- [x] F9 提交、同步 HANDOFF 与 spec，输出阶段报告

## 轨迹视图段：trajectory3d（2026-11-11）

- [x] R1 `panels/viewQuality.ts`：`makeLadder(tiers)` + `attachViewWheelGuard(host, isLocked)`；`viewQuality.test.ts`
- [x] R2 `attitudeViewQuality.ts` 改为薄配置层（导出名与阈值不变）；`AttitudeModelView` 改用公共 wheel guard
- [x] R3 `trajectoryViewQuality.ts`：`TRAJECTORY_VIEW_MAX_INSTANCES=1`、`TRAJECTORY_WEBGL_BUDGET=2`、L0/L1/L2（22/18fps，dwell 2500，L2 fpsCap 20）；单测
- [x] R4 `embedPanels.ts`：加入 `trajectory3d`（min 5×4、aspect 4/3、双语名、viewState null）；测试同步
- [x] R5 `plot3dStore`：`setViewSink` 第二 sink、泵门控含 `isOpen("trajectory3d")`、任一无 sink 才停泵；单测
- [x] R6 `plotStore.init` 采集门控增加 `trajectory3d`
- [x] R7 `scene.ts` 四个薄 API：`setPixelRatio` / `setFpsCap` / `setInteractionsEnabled` / `setAxisLabelsVisible`；`cbs.isVisible` 门控
- [x] R8 `TrajectoryView.tsx`：复用 `createScene`，只订阅 `plotStore`+`plot3dStore`，锁交互、wheel 分流、主题、1s 阶梯采样、三档 HUD 收敛
- [x] R9 `embedHost`：轨迹分支 + 锁按钮复用；可见性上报改 `card.panelId`
- [x] R10 `panelPlacement`：`VIEW_INSTANCE_CAP.trajectory3d`；`view-limit` 文案通用化；测试
- [x] R11 `theme.css` 精准追加 `.tv-*`（无 `transform: scale`，不改既有选择器）
- [x] R12 无头静默截图验证：非空白、滚轮分流（内/外/锁定）、单轴 resize 不塌
- [x] R13 七项门禁全绿（插件四文件 / vitest / tsc / eslint / check:all / vite build / cargo check）
- [x] R14 提交（说明原因）、同步 HANDOFF 与 spec、输出阶段报告

## 追加段：面板控件化适配清单（排在轨迹视图之后，需先出清单再动代码）

- [x] C1 适配分类清单（整板可嵌 / 只嵌视图 / 不嵌 + 成本与一句话理由），覆盖 2D、Hex、帧画布、数据表格、3D 轨迹、3D 姿态、AI、Modbus、序列器、编排器、哨兵、虚拟设备、X-Ray、TX 组帧台、插件面板
- [x] C2 按「用户价值 ÷ 成本」排波次，给每波交付物与验收方式
- [x] C3 清单经用户确认后才开始第一波

## 第一波：数据表格 / X-Ray / 频谱（整板可嵌，2026-11-11 开工）

- [x] W1-1 `embedPanels`：新增 `datatable` / `xray` / `spectrum`，最小格数 4×4 / 4×4 / 4×3，双语名与 `EMBED_PANEL_DOCK_ID`/`dockIdOf`
- [x] W1-2 `panelPlacement`：停靠互斥与移回停靠一律走 `dockIdOf`；第二张同 id 保持 `already-embedded`
- [x] W1-3 `embedHost`：三个 memo 与整板分支（不显示视图锁定按钮）
- [x] W1-4 `framesStore`：采集门 + 隐藏脏刷 + flush 可见性并集（`table` ∪ `datatable`）
- [x] W1-5 `SpectrumPanel` 可见性早退；`plotStore` 门控注释（已含 `spectrum`）
- [x] W1-6 控件库 SVG 图标（表格 / X-Ray / 频谱）
- [x] W1-7 单测同步（embedPanels / controlsStore / panelPlacement）
- [x] W1-8 无头静默截图验证 + 七项门禁 + 单独提交 + 阶段报告（插件四文件 151 / vitest 2764 / tsc 0 / eslint 0 错 22 警告 / check:all OK(17) / build / cargo 0）

## 第二波：序列器 / 哨兵 / 帧画布（2026-11-11 开工）

- [x] W2-1 `embedPanels`：`sequencer` 整板 + `sentinel`/`framecanvas` 视图，最小 6×5 / 6×5 / 5×4，`hasPointerLock`
- [x] W2-2 `panelPlacement`：视图也有停靠页签的互斥、每类上限 1、按 id 的 `docked` 文案
- [x] W2-3 `embedHost`：三个 memo 与分支，只有 3D 视图显示锁定按钮，哨兵传 `embedded`
- [x] W2-4 哨兵卡内「最小化」先收卡再缩浮球，运行态与停靠版一致
- [x] W2-5 帧画布：M 键卡内聚焦才接管；rAF 补 `isVisible` 门控
- [x] W2-6 控件库图标（序列器 / 哨兵 / 帧画布）与 `.ctl-embed-body` 窄卡规则
- [x] W2-7 单测同步（embedPanels / panelPlacement）
- [x] W2-8 无头静默验证 + 七项门禁 + 单独提交 + 阶段报告

## 第三波：TX 组帧台 / 插件面板（2026-11-11 开工）

- [x] W3-1 插件沙箱尺寸通知（**先做**）：`panelBridge` 的 `SIZE_EVENT`/`sizeMsg`、`buildSrcdoc` 初始 `INFO.size`、桥内 `resize` 更新 `uartix.size`；`PluginViewPanel` 在 `ready`/`onLoad` 补发并用 `ResizeObserver` 跟踪 iframe
- [x] W3-2 `embedPanels`：插件面板作为动态整板（`plugin-view-<插件>:<面板>`）、`PLUGIN_PANEL_MIN` 5×4、`embedMinOf`/`embedAspectOf`/`isEmbedTargetId`/`isEmbedPanelTarget`
- [x] W3-3 `controlsStore`：`EmbedCard.panelId` 放宽到 `EmbedTargetId`，迁移/钳制/放置走 `embedMinOf`/`embedAspectOf`
- [x] W3-4 `panelPlacement`：插件面板按整板互斥、搬运；`viewState` 的 capture/discard/prime 放宽到 string
- [x] W3-5 `embedHost` + `ControlCanvas`：插件面板 `bare` iframe 分支，拖放/右键「移回停靠」按动态 id
- [x] W3-6 `WidgetGallery`：TX 组帧台 `IconSend`；已启用插件面板动态列出（`IconPuzzle`，标题随卡片名带入）
- [x] W3-7 TX 组帧台整板：`sendbuild` 白名单、最小 5×4、`embedHost` 分支、窄卡容器查询（隐藏备注、收窄块栏）
- [x] W3-8 单测同步（panelBridge 尺寸协议 / embedPanels / controlsStore / panelPlacement）
- [x] W3-9 无头静默验证（TX 5×4 窄卡 0 溢出；尺寸协议真实 iframe 端到端）+ 七项门禁 + 单独提交 + 阶段报告


