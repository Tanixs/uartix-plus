# P74c 最近批次审查与修复方案（P66 ~ P74b）

> 审查对象：工作区 22 个未提交文件 + `src/features/orchestrator/`（新增 12 文件）+ `src/features/plot3d/`（新增 6 文件）
> 审查方式：静态读码（逐文件对照 HANDOFF 7.1/7.2/八/十四 红线清单 + 用户既有强制约定），不操作真机
> 结论：**功能主体成立，但存在 7 处状态闭环断点、3 处视觉约定回退、若干可维护性缺口**。全部为可定点修复项，无需架构返工。

---

## 1. 结论概览

| # | 级别 | 问题 | 用户可感知后果 | 位置 |
|---|---|---|---|---|
| A1 | P0 | 编排变量「持久」从不落盘 | 按验收清单 ⑧ 重启必失败，变量全部回落默认值 | `orchestratorStore.ts` / `engine.ts:191` |
| A2 | P0 | 「手动」事件块是死代码 | 加了看起来有效、实际永不命中 | `engine.ts:728` vs `:221` |
| A3 | P0 | 组冷却 / 满队列策略无任何 UI | 事件风暴无法抑制，只能改 JSON | `types.ts:132` / UI 缺入口 |
| A4 | P0 | `groupCap=32` 写入侧不拦截 | 第 33 个组静默不触发，无任何提示 | `orchestratorStore.addGroup/duplicateGroup` |
| A5 | P0 | WebGL 重建后校准点云/线框不重放 | context lost 后「有结果无点云」假象 | `Plot3D.tsx:147-174` + `calSentRef` |
| A6 | P0 | `queueCap=8` 死常量 | 文档承诺的 FIFO 队列不存在；`dropOld` 语义与文案矛盾 | `engine.ts:296-329` |
| A7 | P1 | `runSuite(wait)` 靠对象身份识别完成 | 极端情况静默挂到 30 分钟 | `orchestratorBind.ts:351-375` |
| B1 | P1 | 字符图标大规模回归（▶ ⧉ ⠿ ▸ ▾ × ＋ ⟳ ◎ ✓ ○ ●） | 违反用户 2026-09-04 强制约定，观感与既有面板割裂 | 编排器全量 / 3D 轨迹 / 频谱 |
| B2 | P1 | 空事件槽无占位提示 | 分不清「会自动触发」还是「只能手动跑」 | `OrchestratorPanel.tsx:615` |
| B3 | P1 | 校准 HUD 无最大高度/滚动 | 矮面板里六面清单被裁到看不见 | `theme.css:6517` |
| B4 | P1 | `calibMode` 是持久化的操作态 | 重启/关面板后重开直落空点云校准模式 | `plot3dStore.ts:139-149` |
| B5 | P1 | 校准模式下时间条仍可 scrub | 拖动无任何可见反馈（轨迹已隐藏） | `Plot3D.tsx:1406` |
| B6 | P2 | `+ 面板` 18 项扁平列表 | 新面板难找 | `App.tsx:665` |
| B7 | P2 | 从序列导入无二次确认/无新组定位 | 点错即多一个组 | `OrchestratorPanel.tsx:443` |
| B8 | P2 | JSON 导出走 `<a download>`，CSV/PNG 走 save 对话框 | 同一面板两套导出体验 | `OrchestratorPanel.tsx:476` |
| C1 | P2 | Operator 只读锁未覆盖编排器 / 3D | 只读模式下仍可编辑编排并**发数据** | `operator/lock.ts` + 新 store |
| C2 | P2 | AI 动作 / MCP 未接入编排器与 3D | 与「说出来即发生」哲学不一致 | `ai/appActions.ts` / `mcp/mcpTools.ts` |
| C3 | P2 | `onFrames` 无条件逐帧构造轻量投影 | 未挂帧事件时仍为 200Hz 流做分配 | `orchestratorBind.ts:200-213` |
| C4 | P2 | 新面板硬编码语义色未纳入主题校验 | 8 套主题下对比度未验证 | `theme.css:6751-6758` 等 |
| C5 | P2 | HANDOFF 验收项 ⑧ 与实现不符 | 文档失真（承诺 > 实现） | `HANDOFF.md` P74 节 |

---

## 2. 逻辑链路与状态闭环梳理

### 2.1 自动编排器：触发 → 传递 → 回退

**触发条件（7 类事件 → 命中判定）**

| 事件 | 产生点 | 命中判定 | 节流机制 |
|---|---|---|---|
| manual | UI ▶ → `runManual()` | **不经过 `emit`，直接入队** | 豁免熔断 / 豁免冷却 |
| session | `serialStore.subscribe` 状态跃迁 | `phase` 严格相等 | 首次同步不触发 |
| frame | `onFrames` 每行 | `testFrameMatch`（复用序列器） | `stride` 每 N 帧抽样 |
| threshold | 100ms `tick()` 读通道末值 | `blockId` 身份匹配 | `debounceMs` 持续确认 + `enter/exit` 边沿 |
| timer | 100ms `tick()` | `blockId` 身份匹配 | `intervalMs`（≥50ms），防休眠补偿轰炸 |
| sentinel | `sentinelStore.subscribe` 告警头变化 | 级别 `warn`/`crit` | 头部 id 变化才触发 |
| varChanged | `engine.setVar()` 内生派发 | `varName` 相等 | 同值不派发（防自循环） |

**传递路径**
`事件源 → engine.emit() → matchGroup() → enqueue() → runInst() → execNodes() → deps.{send,resolveSend,waitFrame,runSuite,chanLatest,toast,sound}`
`UI 编辑 → orchestratorStore.emit() → bind.syncFromStore() → engine.setDoc()（含 stopAll）+ rebuildSources() + clearWaiters()`

**已闭环的回退出口（✅ 设计良好，保持勿动）**
- 块级：`abort` 块 → 清实例；`onFail=abort|continue` 逐块策略
- 组级：`stopOld` 策略、`stopAll()`、`sessionStop()`、`sessionStop` 复位非持久变量
- 全局：总开关、熔断（1s >100 次）、send 令牌桶 50/s、实例块数帽 10000、实例时长帽 5min、递归深度 ≤8、等待环检测、表达式 deadline 50ms
- 生命周期：关面板 → `stopAll() + clearWaiters()`（红线达成）

**闭环断点**
1. **A1 持久变量无写盘出口**：`persist` 仅影响 `sessionStop()` 的复位行为（`engine.ts:195`），运行值从不写入 localStorage，`setDoc` 重启后 `this.vars` 为空 → 全部落 `mkSlot(v)` 默认值。缺「写」半边，「持久」语义不成立。
2. **A2 manual 侧链断裂**：`FlowEvent{kind:"manual",groupId}` 全仓无生产者（`grep` 证实仅类型声明），`evtMatches` 的 manual 分支不可达 → 事件槽里的「手动」块是装饰品。
3. **A3 组级节流无入口**：`cooldownMs`/`queuePolicy` 全链路（类型/normalize/引擎/导入）齐备，仅缺 UI。阈值与哨兵事件天然高频，用户目前**没有产品内的抑制手段**。
4. **A4 容量红线只在读侧**：`normalizeDoc`（载入）与 `setDoc`（引擎）都截断 32，`addGroup`/`duplicateGroup` 不限 → 静默丢弃。
5. **A6 队列语义与文档不一致**：三策略下队列实际长度 ≤2，`queueCap:8` 从未被引用；`dropOld` 在「仅 1 个在跑」时退化为 `dropNew`，日志仍写「丢弃新触发」。
6. **A7 序列调用完成判定脆弱**：靠 `progress` 对象引用不相等 + `status==="finished"`；异常路径（序列被面板按钮停止后进度对象被覆盖）会一直轮询到 `SUITE_WAIT_CAP_MS = 30min`。
7. **缺「编辑即停跑」的用户告知**：任何文档编辑都会 `stopAll()`，但界面无 toast／无「已中止 N 个实例」反馈，用户会以为自动化卡死。

### 2.2 3D 轨迹面板：状态机与互斥矩阵

已正确联动的互斥/联动（✅）：
`follow ↔ autoRotate`（store 层互斥）、`calibMode → autoRotate=follow=false`、`calibMode ↔ measure`（进入校准退测距 + 长按测距禁用）、`椭球采样 ↔ 六面采集`（互相让路、切换互清缓冲）、`fitted + 继续采样 → 陈旧挂起`、`重拟合 → 预览缓冲重置恢复`、`换绑定/换密度/换通道 → 全套清空重灌`、`面板关闭 → setSink(null) 停泵 + 清校准`、`绑定通道被删 → sanitizeBinds 自动解绑`。

闭环断点：
1. **A5 WebGL 重建不重放**：`gen+1` 只重建 scene 并重新应用 settings；`calSentRef` 未归零 → 新场景不会收到点云；`setCalibEllipsoid(fit)` 与 `setCalibDisplay(mode)` 也未重放 → UI 有结果、画布空。
2. **B4 calibMode 是「操作态却持久化」**：`exportSettingsForPkg` 明确剥离它（说明归类为操作态），但 `setSetting` 照常 `persist()`；关面板不清、重启后回来直接空采样模式。
3. **B5 校准模式 + 时间条**：时间条仍可拖动 scrub，但轨迹层已隐藏 → 拖动只有 br 数字在跳，无视觉因果。
4. **B3 校准 HUD 无溢出策略**：`.p3d-calib` 仅 `max-width:360px`，`bottom` 锚定向上生长，矮面板下顶部行被裁且无法滚动。

### 2.3 面板生命周期门控链（跨模块，已验证闭环 ✅）

| 面板 | 关闭时 | 打开时 |
|---|---|---|
| frame canvas / table / 2D / 3D 姿态 | store 停采 | 从当前时刻继续（缓存保留） |
| plot2d / spectrum / plot3d | 三者全关才停采 | 任一打开即采集 |
| sequencer | `runner.stopRun()` | 帧触发生效 |
| orchestrator | `stopAll() + clearWaiters()` | 事件源恢复 |
| plot3d | `setSink(null)` 停泵 + 清校准 | 挂 sink 起泵 |

结论：门控链完整。唯一待补的是「关闭时的用户告知」与 Operator 锁的交叉（C1）。

### 2.4 Operator 只读链

`guardLocked()` 仅挂在 `templateStore.patch` / `controlsStore`(5 处) / `commandStore`(5 处)。
→ **编排器文档（可发送数据）与 3D 设置/校准完全绕过锁**。这是策略空白而非实现 bug，需要用户拍板边界（建议：编排器禁编辑、保留运行；3D 设置过锁、校准属操作态放行）。

---

## 3. 逐项修改建议

### 批次 1（P0 功能正确性，建议优先）

**A1 编排变量持久化补完「写」半边**
- 方案：`orchestratorStore` 增 `vs.orchestrator.vars` 运行值区，`persistNow()` 时把 `persist===true` 的变量现值一并写入（`bind` 暴露 `snapshotPersistVars()`）；引擎 `setDoc` 后由 bind 回填现值（同型才回填，异型落默认并记一次日志）。
- 变更点：`orchestratorStore.persistNow/load`、`orchestratorBind.syncFromStore`、`engine.setDoc` 增加可选 `seed: Record<string, value>` 参数（保持引擎纯逻辑可测）。
- 边界：`removeVar` 同步清运行值区；改类型 → 清该变量现值。
- 一致性验证点：① 原「断开连接复位非持久变量」行为不变 ② 变量库「持久」勾选/取消语义不变 ③ 引擎单测 350 全绿 ④ 新增 2 例单测（持久值回填 / 异型丢弃）。

**A2 「手动」事件块接线（推荐方案 B）**
- 方案：`▶` 按钮改为经 `emit({kind:"manual", groupId})` 入口；`runManual` 内部复用同一路径但标记 `exemptFuse`（保持「手动豁免熔断/冷却」不变）。这样事件槽里的「手动」块获得真实语义（可被移除 → 该组不再可手动跑），UI 文案同步改为「手动触发源：挂上后本组才会响应 ▶」。
- 备选方案 A（更省事但语义更弱）：删除该事件类型，`▶` 恒可用。
- 一致性验证点：① `▶` 仍豁免熔断/冷却 ② 无事件的组仍可被 `runGroup` 调用 ③ 序列导入的组（无 manual 块）行为不变 —— **需用户在这两方案中选择**。

**A3 组级节流 UI 补齐**
- 方案：组卡头部「⋯」菜单（复用全站 `Flyout`）新增「组设置」：冷却 ms（0~600000）、满队列策略（三选，带人话说明）、备注。组卡头部显示「冷却 2s」胶囊（仅非零时）。
- 变更点：`OrchestratorPanel.GroupCard`、复用 `updateGroup`（已支持两字段）。
- 一致性验证点：冷却/策略的引擎语义不变（仅新增入口）；导入 JSON 的取值照常生效。

**A4 组数量红线写入侧拦截**
- 方案：`addGroup`/`duplicateGroup` 达上限返回 `null` 并由 UI toast「编排组已达上限 32，请先删除或合并」；顶栏显示 `n/32`。
- 一致性验证点：`normalizeDoc`/`setDoc` 的截断逻辑保留（防御旧数据）。

**A5 WebGL 重建后重放校准态**
- 方案：`gen` 变化后 `setReady(true)` 的分支里统一重放：`calSentRef.current = 0` → `setCalibPoints(calibPoints(), 0)` → `setCalibEllipsoid(getCalibFit())` → `setCalibDisplay(calibDisp)` → `setTimeCursor(lastCursorSec())` → `setFollow/setKeyFlight`（后两者已由 effect 覆盖）。
- 一致性验证点：正常（无 context lost）路径零行为变化；重建后点云/线框/游标与丢失前一致。

**A6 队列语义对齐（二选一，见 §6 待确认项）**
- 方案 1（保守，推荐）：删 `queueCap` 常量，把 `dropOld` 文案改为真实语义（「忙碌时丢弃新触发（同 dropNew）；仅当已有排队时挤掉最旧」），并在类型注释里写明「队列深度实际为 1 跑 + 1 排队」。
- 方案 2（实现文档语义）：按 `queueCap=8` 真做 FIFO，`dropNew` 仅在满 8 时丢弃。
- 一致性验证点：engine.test 的队列三策略 20 例保持不变（方案 1）；方案 2 需同步补 3 例。

### 批次 2（P1 易用性与视觉一致性）

**B1 字符图标全面替换为 SVG（用户强制约定）**
- 范围清点：编排器 `▶ ⧉ ⠿ ▸ ▾ × ＋`；3D 轨迹 `⟳ ◎ ● ○ ✓ ▶`；频谱 `▶ 继续`。
- 方案：`shared/icons.tsx` 补 `IconPlay / IconCopy / IconGrip / IconChevronRight / IconChevronDown / IconClose / IconPlus / IconTarget / IconCheck / IconCircle / IconDot / IconRotate`，全部 lucide 风格 1.5px 描边、`currentColor`；替换处保留 `title` 与 `aria-label`。菜单里的 `●/○` 单选态改用 `IconDot`（选中）/ 空 `<span>` 占位，避免行宽跳动。
- 顺带：把频谱的 `.plot-bar .icon-btn.txt` 覆写升级为显式语义类 `.btn.sm.ghost`（消除「往图标钮塞文字」的可再犯路径），并把 `#24` 红线补进 HANDOFF。

**B2 空事件槽占位与「是否自动化」判定**
- 方案：`g.events.length === 0` 时槽内显示弱化文案「未挂事件 · 仅可手动 ▶ 或被其他组调用」；组卡头部新增「事件 n」计数胶囊。让「这个组会不会自己跑」一眼可判。

**B3 校准 HUD 溢出策略**
- 方案：`.p3d-calib { max-height: calc(100% - 96px); overflow-y: auto; }`（96px 让出时间条 + br 行）；`.p3d-a6-list` 保持内滚；窄面板（宽度 < 520px）时把「偏移/增益」结果栅格降为单列。

**B4 calibMode 改为会话级操作态**
- 方案：`setSetting` 白名单把 `calibMode` 排除出 persist（其余设置照旧持久化）；面板关闭时 `setSetting({calibMode:false})`。`exportSettingsForPkg` 的剥离逻辑保留（防御旧包/旧存储）。
- 一致性验证点：Operator 包仍不带 calibMode；用户显式设置的其他 3D 设置照常持久。

**B5 校准模式下时间条**
- 方案：`s3d.calibMode` 时给 `.p3d-timebar` 加 `disabled` 态（降低不透明度 + `pointer-events:none` + title「校准模式下时间游标不适用」），或在 br 行提示。

**B6 `+ 面板` 分组**
- 方案：`PANEL_TITLES` 增 `PANEL_GROUPS`（数据接入 / 解析与画布 / 可视化 / 下行控制 / 测试与自动化 / AI），`+ 面板` 用 `<optgroup>` 渲染；「最近使用」置顶 3 项（localStorage）。

**B7 序列导入确认与定位**
- 方案：选择套件后先弹确认（「将追加 1 个**未启用**组『X』（n 个块），检查后手动启用」）；确认后滚动定位到新组并高亮 1.5s。

**B8 导出入口统一**
- 方案：编排器 JSON 导出改走 `@tauri-apps/plugin-dialog.save()` + `invoke("save_text_file")`（与 DataTable / 3D CSV 同管线），浏览器降级路径保留 `<a download>`。

### 批次 3（P2 架构与一致性）

**C1 Operator 只读边界（需拍板，见 §6）**
- 建议：编排器 → 编辑类操作全部 `guardLocked()`，运行/总开关放行；plot3d → `setSetting/importSettingsFromPkg` 过锁（import 是激活流程内部调用，需绕过参数），校准/采样/六面放行（操作态）；并在 Operator 横幅文案里写明「编排与设置只读，测试运行可用」。

**C2 AI / MCP 接入新能力**
- 方案：`appActions` 增 `orchestrator`（`status / group.add / group.remove / group.update / block.add / run / masterOn / vars.set`，破坏性动作红标）与 `plot3d`（`bind / view / follow / export`）两组动作，动作总数 28 → ~40；`prompts.ts` 知识库补「自动编排器」「3D 轨迹与校准」两节（含红线常量与互斥矩阵）；`mcpTools` 增 `get_orchestrator` / `run_group`（只读优先，写操作需显式开关）。
- 风险控制：编排器可发数据 → 与 `send` 动作同级，走既有 HIGH_ONLY 权限与人工确认。

**C3 `onFrames` 惰性投影**
- 方案：bind 维护 `hasFrameEvent` 标志（`rebuildSources` 里计算）；为 false 时 `onFrames` 只更新 `lastFrameTs` 后立即 return，不做 `toLite`。预计高频流下每帧省一次对象 + 字段数组构造。

**C4 语义色入令牌**
- 方案：把 `#3fb950 / #d29922 / #db6d28 / #bc8cff / #39c5cf / #e8a13c / #e5534b` 提为 `--k-exec / --k-wait / --k-frame / --k-assert / --k-note / --k-logic / --k-group / --warn-line / --danger` 令牌，8 套主题各自给值，并纳入 `check:theme` CI 校验。

**C5 HANDOFF 同步**
- 待修复落地后：改写 P74 验收清单第 ⑧ 项为「变量『持久』重启保留现值（P74c 实现）」；新增 P74c 批次记录；把「字符图标禁用」升级为独立红线条目（原为个人约定，现应写入 §8）。

---

## 4. 易用性专项（用户视角）

**信息层级**
- 编排器右侧检查器固定 285px、左画布自适应：在宽度 < 720px 的面板里，检查器占比过高 → 建议加拖拽分隔条（与协议模板/属性面板同款），并提供「检查器折叠」。
- 组卡三层背景（画布 `--bg-inset` → 组卡浮影 → 容器子流微差底）方向正确，但**事件槽的 `1px dashed` 底边**与块内类型色左条混用，视觉上「虚线」在本项目有被用户否定的历史（帧画布红线）。建议事件槽改用 `color-mix` 浅底 + 实线，保持「全实线」语言一致。

**操作路径**
- 新建组 → 挂事件 → 开总开关是三步，但**总开关在顶栏左侧、事件在组卡中部、▶ 在组卡右侧**，视线跨度大。建议：空事件槽旁就地放「一键启用本组自动触发」（= 挂一个默认事件 + 开总开关 + 开组），把三步缩成一步（对应 §8-21「引导必须长在用户实际操作的面板里」）。
- 编排器空态三步引导已符合红线；但**组非空后引导消失**，建议在顶栏保留一个可折叠的「下一步」提示条（新用户第二次进来仍需要）。

**反馈提示**
- 缺 4 类反馈：① 编辑文档导致在跑实例被停（无提示）② 组达上限（无提示）③ 块被 `dropNew` 丢弃（只进日志，UI 无痕）④ 冷却丢弃（同上）。建议：①③④ 统一走 `LogEntry` → 面板底部「运行日志」抽屉（当前 `getLogs()` 已实现但**面板里没有日志视图**，引擎造了 800 条环形缓冲却无人消费 —— 这是最典型的「造了不用」）。这一条建议单独列为 **P0-UI**：新增「运行日志」抽屉（级别色点 + 时间 + 组名 + 详情 + 失败高亮），把 ③④ 从静默变可见。
- `GroupStatsChip` 已有「跑 N · 败 M」，与日志抽屉可互相跳转（点徽标过滤该组日志）。

---

## 5. 可参考的业内优秀开源设计

| 参考 | 借鉴点 | 落到本项目 |
|---|---|---|
| **Node-RED** | 事件-动作连线、节点状态徽标（跑/错/空闲）、调试侧栏常驻 | 组卡状态徽标已有 → 补「运行日志抽屉」；未来可考虑「连线视图」作为高级形态 |
| **n8n / Zapier** | 触发器与动作的视觉分离（trigger 节点上行、动作下行）、每一步可单独「测试运行」 | 事件槽已分离 → 补「单块测试运行」（只跑选中块，忽略前置） |
| **Scratch / ScratchJr** | 积木形状编码语义（帽子块=触发）、拖拽落点高亮、快照式撤销 | 事件块做成「帽子形」（顶部圆角/上凸）以视觉区分执行块；补编排文档级撤销栈（当前无撤销，编辑不可逆） |
| **Foxglove Studio** | 3D 面板：图层树 + 可折叠设置面板 + 时间轴与数据源联动 | 3D 设置从右键菜单迁出为左侧可折叠设置区（右键菜单已 20+ 项，接近 VOFA+ 被诟病的「单列表菜单」） |
| **VOFA+ 反面教材** | 「控件不能缩放、太简洁、存文件不便」 | 已规避（卡片缩放/导出三件套）；但**导出入口不统一（B8）正是在重蹈「存文件不便」** |
| **Wireshark** | 显示过滤器 + 着色规则 + 可停靠的专家信息（Expert Info）侧栏 | 「运行日志 + 失败高亮」即本项目的 Expert Info |
| **Grafana Alerting** | 告警规则 = 查询 + 条件 + 持续时长（for）+ 冷却（silence） | 组冷却 UI（A3）应显式命名为「静默期」，与 Grafana 用语一致，工程师零学习成本 |

---

## 6. 工作批次与验证计划

### 执行顺序（建议）

| 批次 | 内容 | 依赖 |
|---|---|---|
| **批次 0** | 待你确认 §6 的两个选择题（A2 方案、A6 方案、C1 边界） | — |
| **批次 1** | P0：A1 A2 A3 A4 A5 + **运行日志抽屉（P0-UI）** | 批次 0 结论 |
| **批次 2** | P1：B1~B8 | 批次 1（B1 与 A3 同文件，合并一次改） |
| **批次 3** | P2：C1~C5 + 文档同步 | 批次 1、2 |

### 每批交付前必须跑的验证套件（不操作真机）

1. `npx tsc --noEmit` —— 0 错误
2. `npx vitest run` —— 现有 350 例全绿；本批新增用例计入
3. `npm run lint` —— 0 error（warning 不高于既有 19 条基线）
4. `npm run build` —— 通过
5. `npm run check:aria` / `npm run check:theme` —— 全绿（C4 落地后主题校验需覆盖新增令牌）
6. `npm run dev` 浏览器冒烟 —— **bind/模块求值路径有改动时必跑**（§8-23 TDZ 教训）
7. 关键路径的「与原功能一致性」对照检查（逐项列于 §3 各条「一致性验证点」）

### 需你确认的三个选择

1. **A2**：「手动」事件块 —— 接线成真（推荐，`▶` 走 emit 路径，事件块可移除）还是直接删掉该类型？
2. **A6**：队列语义 —— 保守改文档（推荐，删死常量 + 改文案）还是真实现 `queueCap=8` FIFO？
3. **C1**：Operator 只读边界 —— 编排器「禁编辑、允许运行」（推荐）还是整体禁用？3D 校准在只读模式放行还是禁用？

---

## 7. 本次不动的内容（明确保留）

- 帧画布 7.1 视觉契约、2D 曲线交互契约、AI 7.2 架构红线：**零改动**
- `dragDropEnabled:false`、面板 memo、控制台 DOM 直写、解析并行模型、ingest 单点入口：**零改动**
- 引擎红线常量（熔断/令牌桶/帽值/表达式沙箱）：**零改动**，仅补 UI 入口
- 3D 双层 LOD / 时间水位续传 / 游标裁决：**零改动**
