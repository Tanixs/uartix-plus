# P87 详设 · 3D 惯导轨迹调试分析面板升级 + P88 AI 闭环调参通道

> 状态：**方案待用户确认，未动任何代码**。
> 角色基线：优先复用现有 plot3d / plotStore / TemplatesPanel 图例拖拽 / 控制画布 / sessionStore / sentinel / orchestrator / MCP 全家桶，不重复造轮子。
> 硬约束继承：HANDOFF §7.1 帧画布规范、§8 全部红线（pointerDrag、zoom 补偿、禁 React 高频 state、关了不后台跑、guardLocked 定性、lucide SVG 图标、theme.css 串行编辑）、「不再提供混合模式」。

---

## 〇、一句话总览

- **P87**：把 3D 轨迹面板从「XYZ 三轴绑一条轨迹」升级为「三组独立轨迹（惯导推算 / 实际导航 / 目标轨迹），每组独立选点位·点集·连线三种显示模式」，补齐朝向/模型/坐标对齐/分段着色/标记/时间轴三方联动/AI 分析包导出；波形、控制按钮、记录回放、告警全部复用现有面板，零平行实现。
- **P88**：打通 AI 持续闭环调参通道——MCP 桥加长任务回执（修 3s 超时实锤 bug）+ 应用内「AI 调参台」（采集证据→模型提案→数值钳位→审批闸门→下发→稳态等待→回测指标的受控 loop，预算+急停+台账）。

---

## 一、源码现状分析（本批的承重地基）

### 1.1 plot3d 现状（src/features/plot3d/，共 ~7800 行）

| 文件 | 现状 | 关键结论 |
|---|---|---|
| `plot3dStore.ts` (754L) | `Plot3DSettings{axisX,axisY,axisZ,colorBy,colorCh,fade,style,density,autoRotate,follow,showGrid,gridDensity,keyFlight,zoomToCursor,calibMode,pairMode,pairTolMs,axisScale}`；持久化 `vs.plot3d.settings`；泵 120ms + `lastT` 水位 + 签名重灌 + Sink 三参游标 | **单条轨迹**模型；三轴=plotStore 通道 id；泵与配对内核可直接按组复制 |
| `scene.ts` (1712L) | 双层 LOD（尾窗 120k + 全景 100k，copyWithin 半压）、大坐标重锚（f32 归一列 + f64 真值副列）、ShaderMaterial（turbo/viridis × 时间/通道 × 渐隐，切色带零重建）、`setTimeCursor` drawRange 截断零重建、follow/键盘飞行/测距/校准层/pick | 渲染核心成熟；**轨迹对象是单个 Line+Points 共享 BufferGeometry**——多组需要「每组一份」的实例化改造，重锚改全局跨组 |
| `Plot3D.tsx` (2215L) | HUD 四角（tl 三轴下拉 / tr 胶囊托盘 / bl 校准 HUD / br 统计+配对诊断）、右键五组级联、底部时间条三态徽标、导出 CSV/PNG | UI 骨架成熟；tl 三下拉将升级为「组行列表」；校准 HUD 不动 |
| `pairTriples.ts` / `ellipsoidFit.ts` | 三轴时间戳配对（interp/nearest/union + 容差）/ 椭球拟合九参数 | 配对内核**逐组复用**，零改动 |

**现状缺口对照用户诉求**：①只有一条轨迹 → 要三组；②`style:"line|points|line+points"` 是全局显示开关，非每组独立的点位/点集/连线语义（点位=只留最新点、点集=纯散点、连线=时序折线+平滑子选项）；③无朝向/模型/GLTF（GLTFLoader 只在 attitude 面板有先例）；④无分组段着色、无标记、无轨迹导入导出；⑤撤销栈缺失（全项目仅 templateStore/FrameCanvas 有）；⑥2D 游标是 Plot2D 组件私有 ref，外部无法注入 → 波形-3D 游标联动缺一根线。

### 1.2 可复用集成面（调研实锤）

- **通道/数据**：plotStore `Channel{id,tplId,fieldId,name,color,visible}`，通道 id 是全应用共享键（2D/频谱/3D/编排器阈值事件同一 id）；`buildPairedTriples`、`interpAt`、`getChanData`、`sampleRate` 全部现成；采集门控三选一 `isOpen("plot2d"|"spectrum"|"plot3d")`。
- **拖拽源**：TemplatesPanel 图例行 `beginPointerDrag(kind:"vs-field", data:{tplId,fieldId,name,type})`——Plot2D/控制画布/编排器三区已接，3D 组行接同一个 `attachPdragZone` 即成第四区。
- **控制与下发**：controlsStore 11 卡型（slider/button/switch/monitor/joystick/keymon/group/custom…）、`formatTemplate` printf+hex 展开、`variableStore.resolveVars` `{var}` 插值下发、`vs-control-trigger` 程序化触发卡；回执语义现成参考 = modbus pollStore 在途-超时状态机 + scriptRunner `waitParse`。
- **记录/回放/标注**：sessionStore 全套（recording→playing 状态机、`seek(ratio,speed)`、`annotate`/`getAnnotations`/`annotationRatio`）；Plot2D 已画琥珀虚线标注，plot3d 时间条已镜像回放游标——**「实时/回放切换 + 三组同步刷新」今天就已经成立，零新引擎**。
- **告警**：sentinel `SentinelAlert{ts,kind,level,channel?,fieldId?}` + 200ms 快照 + AI 证据链 `buildEvidence` + `maybeAutoDiag`（全项目唯一事件→AI 回路先例）。
- **导出**：前端 CSV 拼串（BOM+CRLF）→ `save_text_file`；`export_xlsx{path,rows}`；plot3d 已有全量重配对同源导出先例（`exportCsv`，与显示严格同源）。
- **AI 面**：39 个 App Action（`plot3dRead`/`plot3d` HIGH_ONLY 写、`orchestrator` 写、`readPlot` 截图回看）；MCP 10 工具；orchAiBuild（AI 搭编排块，条件/表达式刻意不放开）；contextCollector（曲线统计 ≤800 点 stride 采样，2D 与 MCP 同口径）；prompts 11 场景。
- **PID 闭环先例**：编排器内置 `pid-relay` 继电反馈整定模板（阈值事件→测 Tu→Z-N 公式→`send "AT+PID=..."`→自动下发）——**「轮询→判断→下发」的确定性 loop 已是产品级**，P88 要补的是「AI 在环」和「异步回执」两块。

### 1.3 已实锤的系统性缺口（P88 的立项依据）

1. **MCP 桥 3 秒硬超时**（bridge.rs:28）：`run_sequence` 前端 await 跑完可能几十秒 → CLI 必收「主窗口未响应」，结果 `bridge_respond` 因 pending 表已清被**静默丢弃**。AI 拿不到任何 >3s 任务的回执。
2. **对 AI 无数据推送**：bridge 明言「无推送无轮询」；外部 AI 只能 pull `get_fields` 自轮询，「改参数→等 3 秒看响应」没有原语。
3. **应用内无 agentic loop**：严格一问一答；AI 面板关即掐流；无轮次预算/参数钳位/终止判据。
4. **提示词漂移**：prompts.ts:29 宣称「连续失败熔断自停」，engine 无对应实现（只有触发风暴熔断）。

---

## 二、升级功能清单与优先级

**P0 = 本批必做（骨架与核心诉求）；P1 = 本批后段（体验完整度）；P2 = 明示的下一批/候选。**

### 批次 P87a · 三组轨迹核心（P0）

| # | 功能 | 验收锚点 |
|---|---|---|
| A1 | `TrajGroup` 模型（固定 3 组）+ 旧设置迁移（axisX/Y/Z→组1）+ normalize/持久化/Operator 包/appActions/MCP 读面兼容 | 老工程打开零丢失；新装默认组1=旧行为 |
| A2 | 泵逐组化：每组独立 签名/lastT 水位/配对（复用 `buildPairedTriples`）；通道跨组共享自动去重（同 plot 通道只读一份） | 三组同时 1kHz 不掉帧不重复 |
| A3 | scene 多组化：每组一套 Line/Points 渲染体 + 逐组材质 uniform；**全局重锚/包围盒跨组计算** | 大坐标经纬度组与小坐标组共存不炸精度 |
| A4 | 每组显示模式三选：点位（只刷最新点，零历史内存）/ 点集（全点不连线）/ 连线（P0 仅直线 + CR 平滑起步）；混合模式不存在 | 三组各选一种模式同屏自然叠加 |
| A5 | HUD 组行托盘（左下 tl 区）：每行 = 眼睛+色点+名称+模式徽标+XYZ 三个绑定下拉+设置按钮；行右键菜单=同设置入口+定位/导出/清空 | 拖 vs-field 落行=X/Y/Z 任一格即绑定 |
| A6 | 组设置弹层（复用 fc-dlg 范式）：名称/颜色/可见/模式与子选项/点大小/线宽/透明度/最大点数/比例·偏移说明 | 一次保存=一步撤销 |
| A7 | 配置类撤销/重做：plot3d 新增轻量快照栈（50 层，与全局撤销无关），绑定/模式/模型/变换/改名入栈；视图类（相机/跟随/网格/可见性）不入栈；清空=确认且不可撤销（数据已丢，如实标注） | Ctrl+Z 回退组配置不误伤模板撤销栈 |
| A8 | 每组单独清空 / 单独导出 CSV（沿用与显示同源的重配对导出）/ 单独隐藏 | br 统计按组显示点数 |

### 批次 P87b · 显示与物理语义（P1）

| # | 功能 | 说明 |
|---|---|---|
| B1 | 连线平滑子选项：无/滑动平均（因果，N 窗）/Catmull-Rom（向心，张力系数）/贝塞尔（切线控制点）/三次样条（worker）/**自定义（expr 沙箱白名单函数）**；平滑系数、采样间隔、最大点数 | 尾部 64 点 raw 缓冲重算 O(K)/批，append-only 与游标截断不破 |
| B2 | 头部朝向：源=默认 X 轴 / 航向角字段 / 四元数（四通道绑定向导，复用 attitudeStore 的 slerp 思路）/ 速度方向（位置差分）；偏航/俯仰/滚三偏移 + 高度偏移 | 点位模式下模型实时转向 |
| B3 | 组模型：内置 点/球/箭头/车/锥/坐标轴（程序化几何，X=车头约定）+ GLTF/GLB（复用 View3D loader 模式，本地文件+路径持久化，远程 URL 不做）；缩放/旋转偏移 | three 懒加载分包不变 |
| B4 | 坐标对齐与单位：组级变换 `rotEuler+offsetVec+scale`（NED↔ENU 歪装、航向系旋转）；「以组1首点为 ENU 原点」一键对齐；字段级 unit/scale 继续管工程单位（两层不重叠，effRange 式单一真相） | 三组单位不一致时可视化不错位 |
| B5 | 场景要素：起点/终点标记、方向箭头（连线组每 N 点，实例化）、比例尺、图例（组名+模式+颜色，点击=定位该组） | XY 平面/XYZ/俯视/自由 = 现有四预设，不动 |
| B6 | 悬停信息：时间/XYZ 真值/所属组/色标值；新增「最近标记 3.2s」提示 | 复用 pick，零新通道 |
| B7 | 轨迹点导入：CSV → 合成虚拟通道（plotStore 新增 `addVirtualChannel/appendPoint` 注入 API，不碰采集红线） | 与池 A「校准虚拟通道」共用一套 API |
| B8 | 打点标记：手动打点（写 sessionStore.annotate，回放条+时间条+2D 三方琥珀虚线自然出现）；3D 场景在对应轨迹点立旗标 Sprite | 事件自动打标（哨兵 crit→annotate）默认关、设置可开 |

### 批次 P87c · 联动与分析包（P1）

| # | 功能 | 说明 |
|---|---|---|
| C1 | 时间游标三方联动：Plot2D 游标上收/暴露 `setCursorMs/getCursorMs/onCursor`（仿 plot3d `setScrub` 先例）；3D 时间条 ↔ 2D 时间游标 ↔ 回放进度 三者互跟（开关默认：跟随开） | 波形-3D 共享时间轴的最后一公里 |
| C2 | 告警/标记→定位：点告警条目/标记旗标 → 3D 游标跳该时刻 + 2D 游标跳 + br 显示 t | 复用 `annotationRatio`/seek 语义 |
| C3 | 漂移分析面板级指标：零偏 b̂（静置段均值）、漂移率（deg/h，线性拟合）、温漂曲线（角度对温度散点）、与编码器的航向差分——`metrics.ts` 纯函数 + vitest | 「一会儿有一会儿没」变成可比较的数 |
| C4 | **分析包导出向导**：选时间范围（全程/最近 N 秒/回放区间）+ 组 + 通道 + 降采样率 → 选目录逐文件写出 `raw.csv / parsed.csv / trajectory_gN.csv×3 / waveform.csv / pid.csv / drift.csv / meta.json`（字段定义·单位·采样率·模板快照·组配置·时间范围）+「AI 提示词」生成/复制 | 单 zip 不做（不引新依赖），目录多文件 |
| C5 | AI 联动：新场景 `inertial`（惯导分析简报=组配置+漂移指标+告警计数+曲线统计摘要）→ 一键发 AI；分析结论可回填「面板备注」（per-group notes，进 meta.json 与 Operator 展示） | 数据文件交给 AI 对话的说明词自动生成 |

### 批次 P87d · 控制与调试（P1~P2）

| # | 功能 | 说明 |
|---|---|---|
| D1 | 「惯导调试台」控制画布预设页（一键生成，走 controlsStore 现成 CRUD）：Kp/Ki/Kd 滑块（onRelease+节流）、目标值输入、模式切换、开始/停止记录、打点、急停（高对比红）、校准按钮 | **卡片引擎零改动**，纯内容模板 |
| D2 | 下发回执徽章：卡级可选 `confirm:true`（复用 shared/Dialog.confirmDialog）+ settle 监视（下发后 timeoutMs 内观察绑定字段值变化→绿/灰/红徽章），纯函数状态机抄 pollStore 在途配对，controlsStore 加两字段 | 二次确认与回执闭环 |
| D3 | 参数集模板：当前变量值快照存/取/一键按序下发（复用 sendTpl `{var}` 插值） | 「将当前参数保存为模板」 |

### 批次 P88a · AI 通道：桥异步回执（P0，与 P87 并行价值最高）

| # | 功能 | 说明 |
|---|---|---|
| E1 | bridge.rs：`call` 前端回 `{state:"running",jobId}` → pending 条目转**长任务态**（3s 仅约束派发；长任务 15min 上限、上限 16 个 LRU）；新线协议 `job{jobId}` 查询 + `mcp://job` 完成回推 `bridge_job` | 修「>3s 任务静默丢弃」实锤 bug |
| E2 | 前端 `jobs.ts`：任务登记簿（runSuite/runGroup/waitEvent/waitFrame/tuneStep，有界+审计）；`run_sequence` 改派发即回 jobId（`e2e` 脚本同步改，等待语义用新 `get_job`） | MCP 侧 `compactFrame` 口径不变 |
| E3 | 新 MCP 工具 ×3：`create_job(kind,args)` / `get_job(jobId)` / `wait_event({chId,op,value,holdMs,timeoutMs≤60s})`（复用编排器 chanChanged/threshold 事件源）——AI 从此有「下发→等设备稳定」原语 | 只读工具权限面不变；写仍走 send/run_action 门 |
| E4 | mcp-cli.ts + `mcpTools.test.ts` + `build:mcp`/`mcp:e2e` 回归；cargo test（bridge.rs 触 Rust） | |

### 批次 P88b · AI 调参台（应用内受控 loop，P0 诉求「让 AI 持续工作调 PID」）

| # | 功能 | 说明 |
|---|---|---|
| F1 | 新 dockview 面板「AI 调参台」：目标选择（变量/卡片/指令）、**钳位包络**（每目标 min/max/maxΔ/冷却）、目标函数模板（跟踪误差 σ 最小 / 超调<5%+稳态<ε / 漂移率最小，基于 C3 metrics）、预算（maxRounds/wall-clock/send 速率）、审批三档：**每步确认（默认）/ 包络内自动 / 全托管** | 全托管仍保留钳位+预算+急停——安全从「每点一下」改成「预算内包络」 |
| F2 | Loop 执行器 `loopRunner.ts`（纯逻辑+deps 注入，可 vitest）：collect(证据窗口) → ask(AI 固定 harness prompt，输出 JSON `{action,params,reason,expect}`) → validate(schema+钳位+白名单) → gate(按审批档) → apply(variableStore.setVar/controls 触发卡/指令下发) → settle(wait_event/threshold 超时) → measure(前/后指标差) → 台账行 → 下一轮；终止判据=达标/预算尽/急停/连续失败 N 次自停（顺手把 prompts.ts:29 的漂移宣称变成**真实现**） | 不进 React 高频；面板关=loop 停（红线）——但 loop 运行时面板不可被关，关前 confirm |
| F3 | 台账 ledger：每轮记录（提案/钳位后/回执/指标/耗时），导出进 C4 分析包 + 一键发 AI 续会话（「基于这份调参履历继续分析」） | 状态闭环：结论回填面板备注 |
| F4 | 急停：常驻大红钮 + 通信静默 watchdog + 哨兵 crit 自动停 + Ctrl+Shift+X | 「迟早落伍」与「车别飞出去」的平衡点 |
| F5 | 权限复用现状：全托管档要求设置里 `aiActions` 高权限开关 + 一次性「我已理解风险」勾选（存 settings）；MCP 外部 loop 走 E1~E3 工具自组 | 不新开权限体系 |

### 明确不做（P2 及以后 / 出界）

- 多组数（>3）——固定三组是产品决策，行托盘/UI/菜单都按三设计；
- 地图底图、URDF/TF、LiDAR 点云（P69 详设原非目标继续有效）；
- Madgwick/Mahony 实时姿态解算预览（池 A 大件，独立批次）；
- 3D 面板内嵌波形子视图（用 dockview 分屏，不内嵌第二个 uPlot——冗余且踩 memo/生命周期红线）；
- 远程 URL 模型加载、zip 打包、HTML 单文件报告（分析包=目录多文件）。

---

## 三、UI 布局方案（线框）

```
┌ 3D 轨迹面板（单 dockview 面板，升级后）───────────────────────────┐
│ tl ┌组托盘──────────────┐        tr [四视角|重置|聚焦|跟随|自旋|校准|清空] │
│    │●眼睛 G1 惯导 ●line+⚙│                                             │
│    │●眼睛 G2 实际 ●pts +⚙│   ← 三行；每行XYZ三下拉；⚙=组设置弹层          │
│    │●眼睛 G3 目标 ●pt  ⚙│   ← 行=vs-field 拖放区（落点列=绑定轴）        │
│    └─────────────────┘                                             │
│                     [Three.js 主视口：三组叠加渲染]                     │
│ bl [校准HUD（现状位置）/ 空闲时为「自动识别变量」建议卡]      br [点数按组   │
│                                                      FPS · t=游标] │
│ 底部 [标记旗标轨] 0s ━━━━━━◆━━━━━━━━ 128s  [历史模式·回最新]  （现状时间条+标记）│
└──────────────────────────────────────────────────────────────┘
```
- **左「数据源/字段变量列」= 现有协议模板面板图例区**（拖拽源现成），不新增左栏。
- **中间主视图切换「3D/波形/分屏」= dockview 布局本身**（2D 曲线与 3D 轨迹并排即分屏；预设布局槽位存这套摆法）。
- **右属性 = 组设置弹层**（模态，焦点圈闭仿 FieldDialog；不在面板里做常驻右栏——三组配置低频改动，常驻栏挤渲染区）。
- **底部全局 = 现状状态栏 + 哨兵浮球**；「告警栏」= 点击 br 统计徽标弹出近 20 条告警快查（跳 C2 定位）。
- **控制调试 = 控制画布预设页**；**AI = 新「AI 调参台」面板**。
- 响应式：面板宽 <420px 时组托盘折叠为「G1/G2/G3 三 chip」，弹层宽度 min(520px,100%−32px)（沿用 P85 对话框规范）。

## 四、交互规则设计表（操作 × 条件 × 行为 × 反馈）

| 操作 | 条件 | 行为 | 反馈 |
|---|---|---|---|
| 拖 vs-field 到组行 X/Y/Z 格 | 字段数值型 | 绑定该轴；泵签名变→该组重灌 | 格高亮+行名变通道名；撤销一步回退 |
| 拖到组行名称区 | 字段是 XYZ 三元组直觉名（x/y/z、e/n/u…） | 弹「一键填三轴」建议 | toast + 一步可撤销 |
| 点位模式 | 该组无任何渲染历史点 | 只留最新位置模型 | 内存 O(1)；br 显「实时定位」 |
| 连线模式改平滑算法 | — | 尾窗 raw 重算全段（≤220k 点，worker 超阈值走进度） | 重算期间轨迹短闪可接受；一步撤销 |
| 组设置保存 | 朝向源=四元数但只绑 1 通道 | 拦截+引导四通道绑定向导 | 红条+「补齐」按钮 |
| 清空（组级/全局） | — | confirmDialog 后清；**明示不可撤销** | toast；水位重置 |
| 点告警条目 / 时间条旗标 | ts 在数据窗内 | 3D 游标+2D 游标跳该时刻（非回放态=scrub；回放态=seek） | br 显 t；标记旗标高亮 |
| 双击组行 | 该组有数据 | 相机聚焦该组轨迹包围盒 | 400ms tween（复用 focusPoint） |
| 组设置弹层 Esc | — | 丢弃未保存改动关闭 | 焦点回组行 |
| AI 调参台「开始循环」 | 未配置钳位/预算 | 禁止启动，引导补齐 | 表单红标逐项指位 |
| AI 提案越钳位 | maxΔ/min/max 任一违例 | 截断到包络内执行 + 台账记「已截断」 | toast 黄标；全托管仍发 |
| AI 提案动作=急停类（模式切到手动等） | 白名单外目标 | 拒绝执行 | 台账红行+原因 |
| watchdog 触发（静默>5s/哨兵 crit/手动） | loop 在跑 | 立即停+停发 | 大红状态+音效（可静音） |
| Operator 只读 | 任何组配置写 | `guardLocked()` store 层拦 | 「点不动」+锁条（现状模式） |

## 五、状态流转

```mermaid
stateDiagram-v2
  数据接收(Rust ingest 单点) --> plotStore通道入库(门控三选一→加plot3d组需求不变)
  plotStore通道入库 --> 泵120ms逐组配对 --> scene多组渲染
  scene多组渲染 --> 用户配置操作 --> 快照入撤销栈 --> persist
  sessionStore回放 --> 游标裁决(回放>scrub>null) --> 三方游标(3D时间条↔2D游标↔回放进度)
  控制下发 --> settle监视 --> 回执徽章 --> 变量/通道入库(原路)
  state "AI调参台" as L {
    [*] --> idle --> armed --> cycling
    cycling --> cycling: collect→ask→validate→gate→apply→settle→measure
    cycling --> halted: 达标/预算尽/急停/watchdog/连续失败N
    halted --> cycling: 用户重新启动
  }
```

## 六、与现有系统集成

1. **帧画布/协议模板**：零改动。组绑定引用 plot 通道 id，通道引用 `{tplId,fieldId}`；模板删/改名联动已存在（removeByTpl/renameChannels/dropFieldValues）——组绑定悬空时 `sanitizeBinds` 式解绑+行置灰提示「字段已删，请重映射」（异常处理「协议字段缺失」项落地）。
2. **数据表格**：parsed.csv 直接取 framesStore 行模型同源；导入轨迹走 B7 虚拟通道，不占表格。
3. **撤销重做**：plot3d 独立快照栈，不与 templateStore 全局栈互踩；Ctrl+Z 焦点在 3D 面板时才消费 3D 栈（焦点路由，仿 FrameCanvas 现状做法）。
4. **导出/录制/AI 面**：Operator 包 schema 升级带版本迁移（旧包 normalize 出组1）；`plot3dRead` 返回 groups 数组；`plot3d` 写 action 扩展 `groups` op 族（bind/mode/model/transform/clear/reveal，仍 HIGH_ONLY）；MCP `get_plot3d` 自动派生读面；帮助「3D 轨迹」页签 + 「AI 详解」页签随批更新；i18n 全量 zh/en。

## 七、三组数据模型 · 详细设计

```ts
interface TrajGroup {
  id: "g1"|"g2"|"g3";
  name: string; color: string; visible: boolean;
  chX: string; chY: string; chZ: string;           // plot 通道 id；Z=""→平面轨迹
  mode: "point"|"points"|"line";
  point: { size:number; opacity:number; maxKeep:number };        // points 模式用；point 模式只 maxKeep=1 语义
  line:  { width:number; smooth:"none"|"movingAvg"|"catmullRom"|"bezier"|"spline"|"custom";
           coeff:number; sampleMs:number; maxPoints:number; customExpr?:string };
  colorBy: "fixed"|"time"|"ch"; colorCh: string;                  // 分段着色：时间/任意通道(速度/偏差/PID输出皆通道)
  fade: 10|60|300|0;
  density: "high"|"mid"|"low";
  heading: { src:"xAxis"|"ch"|"quat"|"velocity"; chYaw?:string; quatChs?:[string,string,string,string];
             yawOff:number; pitchOff:number; rollOff:number; sign?:1|-1 };
  model: { kind:"point"|"sphere"|"arrow"|"car"|"cone"|"axes"|"gltf"; src?:string;
           scale:number; rotOff:[number,number,number]; heightOff:number };
  transform: { rotEuler:[number,number,number]; offsetVec:[number,number,number]; scale:number;
               alignToG1Origin?:boolean };
  pairMode: PairMode; pairTolMs:number;   // 逐组配对（三组采样节奏常不同）
  notes: string;                           // AI 结论回填处，进 meta.json
}
// 全局保留：视角/网格/键盘飞行/校准/自动旋转/时间条/axisScale；删除顶层 axisX/Y/Z/colorBy/colorCh/fade/style/density/pairMode/pairTolMs → normalize(v2)
```

- **渲染结构**：`groupLayers[i] = { tail:Line+Points(共享几何, 组材质uniform), overview:Line|null, marker:Object3D|null }`；point 模式不建 Line，`marker` 挂模型 + `setFromEuler/Quaternion`；重锚 `anchor/scaleVec` 全局唯一 = 所有可见组包围盒并集（大坐标语义不变），组 transform 先于归一化应用。
- **泵**：`st.groups[3] = {sig,lastT,valCarry,lastCursor}`；三组读同一通道时配对计算按组签名缓存避免重复；批次结构 `Plot3DBatchG { gid, t[],x[],y[],z[],val[],latest?:{t,x,y,z,q} }`，point 模式只下发 latest（内存不增长红线：点位模式不建尾窗）。
- **平滑的 append-only 兼容**：raw 尾缓冲 64 点 → 每批只重写「最后一个稳定点之后」的平滑段顶点（内核宽度+前瞻 K），全景 LOD 只存原始抽稀点不平滑（视觉一致：全景是暗线）。
- **偏差着色**：组间距离序列（|g1(t)−g3(t)| 时间对齐 interp）作为派生虚拟通道 `trajDev:g1g3` 进 plotStore（B7 API），2D/告警阈值/AI 同口径可见——**派生量进通道系统，不搞面板私有指标**（池 A 虚拟通道一并落地）。
- **朝向解析优先级**：quat 源→`quatToEuler`；heading→绕 Z 旋转（符号可翻）；velocity→差分 atan2；无→模型默认 X 朝前。

## 八、实施步骤 · 影响范围 · 风险 · 回退

| 批 | 天粒度步骤 | 触达文件 | 风险与对策 | 回退 |
|---|---|---|---|---|
| P87a | store 模型+migration+测试 → 泵逐组化 → scene 多组化 → HUD 组托盘+弹层+拖放 → 撤销栈 → appActions/MCP/Operator 读面 → 全量回归+浏览器冒烟 | plot3d 三文件、plot3dStore.test、theme.css（串行+grep 验证）、appActions、operatorPkg/Gen/Store、strings | scene 多组化是最大改动面——分两步：先 Line+Points 双组跑通再加 mode 枚举；重锚跨组用并集包围盒回归单组=旧行为（三组默认只有组1有数据时逐字节等价旧输出，写等价性测试） | revert 单 commit；`vs.plot3d.settings` 读出 v2 失败→ normalize 回落 v1 迁移 |
| P87b | 平滑内核纯函数+测试 → shader 尾段重写 → 朝向/模型/GLTF → 变换与对齐 → 标记/导入 | 新 `smoothing.ts`/`importExport.ts`、scene.ts、View3D loader 模式复用 | 样条 worker 复杂度——P1 先 CR+MA+spline 主线程（≤220k 点实测），worker 化留 P2；GLTF 路径失效→回落箭头+toast | 各子项独立 commit |
| P87c | Plot2D 游标上收（**动 2D 面板唯一红线区，最小 diff**）→ 三方联动 → metrics 纯函数 → 分析包导出 → AI 场景/备注 | Plot2D/plotStore（只加不改）、新 `metrics.ts`/`exportPkg.ts`、prompts.ts、HelpModal | 游标上收碰 Plot2D 内部状态机（骑行/跟随）——以「镜像 ref+外部注入 setter」最小侵入，uPlot 交互零改动；导出目录写用 `open({directory:true})`+save_text_file 循环，插件已在 capabilities（核对，缺则加目录权限行+重启 dev） | 同上 |
| P87d | controlsStore 加 confirm/settle 两字段+徽章渲染；预设页模板；参数集 | controls 四文件、commandStore 少量 | 触控制画布红线区（memo/拖动性能）——徽章走 200ms 降频批刷，不进卡面 React 高频路径 | revert |
| P88a | bridge.rs 长任务态 → jobs.ts → 3 新工具 → mcp-cli/测试/e2e → cargo test | bridge.rs、mcpServer/mcpTools、scripts/mcp-cli.ts、mcp:e2e | Rust 改并发 pending 表——用现 Mutex+notify 模式，超时任务计数有界；**协议向后兼容：旧 CLI 收不到 running 回执也只是等超时，行为不劣化** | revert；桥可关 |
| P88b | loopRunner 纯逻辑+测试（模拟时钟/假 AI）→ UI 面板 → 钳位/审批/急停 → prompts harness 模板 → 帮助/设置 | 新 `ai/loop/` 四文件、panels/types/strings/prompts/settingsStore/HelpModal | 真 AI 回路不可测——引擎侧全 mock 测，真机走 vdev 虚拟设备（MPU6050/温控炉预设）做无硬件 E2E；「面板关即掐流」红线：loop 运行中面板关闭需 confirm 或先停 loop | 独立 feature 目录，revert 干净 |

**全批统一回归基线**：tsc 0 错 / vitest 全绿（新增 ~40 例：组模型/迁移等价/配对逐组/平滑纯函数/metrics/loopRunner 状态机/jobs）/ eslint 0 error / vite build / cargo test（P88a 触 Rust）/ `check:aria` `check:theme` / 浏览器冒烟（三组叠加+拖绑+撤销+游标联动）。性能验收见 §九 T8。

## 九、验收标准与测试用例（编号→验证清单）

| # | 测试步骤 | 预期 | 通过判据 |
|---|---|---|---|
| T1 | 打开 v0.4.1 时期旧工程（旧 settings + 旧 Operator 包） | 组1 完整还原旧轨迹，视图设置不变 | 渲染点位逐帧一致；包导入不报错 |
| T2 | 三组分别设 点位/点集/连线，同时显示 | 三种视觉自然叠加，无「混合模式」选项存在 | HUD/弹层/右键/文档全库 grep 无混合模式残留 |
| T3 | demo 源 V7 跑 5min，组2 绑经纬度级大坐标 | 不丢精度、重锚正常、FPS 面板可见 ≥50 | 尾点坐标误差 <1e-6°；stats 双缓冲有界 |
| T4 | 组配置 8 类改动各撤销一步/重做一步 | 精确回退不牵连他组；清空不可撤销且弹确认 | 栈深 50 上限；Ctrl+Z 不误触模板撤销 |
| T5 | 连线组切 5 种平滑，回放中拖时间条向后→向前 | 截断零重建，平滑段与游标截断共存 | 无整条轨迹闪重建；drawRange 数值断言 |
| T6 | 航向角字段驱动「车」模型沿组1 轨迹点位移动 | 车头随动转向；四元数绑定向导缺通道拦截 | 朝向角与字段值偏差 <1°（静态段） |
| T7 | 打点→2D 虚线出现；点告警→3D/2D/回放三方跳时刻 | 三处游标一致 | t 值三方 DOM 断言相等 |
| T8 | 三组+12 通道 @1kHz（vdev 高频源）持续 10min | pump 无积压（br 配对诊断无 skip 增长）、界面可交互 | 事件循环 P95 <50ms；内存平台期 |
| T9 | 分析包导出 30s 窗 → 目录内 7 类文件+meta.json | CSV 与面板显示同源（抽 10 行对拍）；提示词含字段单位说明 | 文件齐全；对拍零差 |
| T10 | MCP：`create_job(run_suite)` 后立即 `get_job` 轮询到 done；`wait_event` 超时/命中两路 | 不再出现「主窗口未响应」假失败；结果不静默丢 | `mcp:e2e` 新增 4 用例全绿；旧 8 用例不回归 |
| T11 | AI 调参台（vdev 温控炉）：每步确认档跑 3 轮改 Kp；越界提案（Δ>maxΔ） | 提案截断到包络、台账「已截断」；确认后生效且指标列刷新 | 台账行数=轮数；钳位违例 0 |
| T12 | loop 中拔串口（停 vdev）5s | watchdog 急停+停发+红状态 | loop 状态 halted，reason=watchdog |
| T13 | 全托管档首次开启 | 一次性风险勾选+设置门双闸 | 未勾选时档位置灰 |
| T14 | 原功能回归包：帧画布/协议模板/2D/频谱/表格导出/序列器/编排器/哨兵/主题×9/缩放 zoom 补偿/Operator 生成激活 | 与 P86 后行为逐项一致 | 既有 495 前端测试+cargo 78 全绿 + 手工回归 12 项 |

## 十、待确认问题（开工前请逐条拍板或默认按推荐）

| # | 问题 | 推荐 |
|---|---|---|
| Q1 | 固定三组 or 允许 1~6 组动态增减？ | **固定三组**（UI/泵/菜单全按三设计，语义即「惯导/实际/目标」） |
| Q2 | 点位模式要不要保留极短余辉（如最近 3s 淡出）？ | 纯最新点 + 可选 3s 余辉开关（默认关，内存语义「只保留最新点」成立） |
| Q3 | GLTF 加载只本地文件 or 支持 URL？ | 仅本地文件+路径持久化（离线工具属性；URL 留 P2） |
| Q4 | 分析包 = 目录多文件 or 单 zip？ | 目录多文件（不引 zip 依赖；zip 留 P2） |
| Q5 | AI 全托管档要不要默认存在？ | 存在但默认关，且双闸（设置高权限+一次性风险勾选）+硬急停不撤——这是「不老是考虑安全问题」与「车别飞出去」的最小平衡 |
| Q6 | 长时高频（>5min@1kHz）内存策略：plotStore 30000/ch 砍半是既有限制 | 维持现状，长实验以 session 落盘为准（回放路径已全通）；若你要求面板连续 30min+ 在线，追加「plotStore 分块冷存」独立批次 |
| Q7 | 事件自动打标默认策略 | 哨兵 crit→annotate 默认关，设置可开 |
| Q8 | 「开始/停止记录」按钮语义 = 复用全局 SessionBar 还是面板内另开一条通道？ | **复用 SessionBar**（红线：严禁私开第二条数据通道；面板内按钮只是唤起同一 store） |
| Q9 | 调参台面板放 dockview 新面板 or AI 面板加页签？ | 新独立面板（与 AI 会话面板并存，会话可被用户正常聊天占用不互踩） |
| Q10 | 批次拆分确认：P87a/b/c/d + P88a/b 六个独立 commit 批次，先 a 再停等你真机验收 or 一次跑完？ | **先 P87a 交付验收**（骨架批，风险最高），其余批按序放行 |

## 十一、额外发现的不合理点与优化建议

| # | 发现 | 处置 |
|---|---|---|
| O1 | **MCP 3s 超时 × run_sequence 长等待=结果静默丢弃**（§1.3-1）——外部 AI 闭环的硬墙 | P88a 根治（E1） |
| O2 | Plot2D 游标组件私有 ref、无外部注入 API；plot3d 已有 setScrub 先例——同语义两套世界 | P87c 上收（C1），此后快照/标注/游标同一条总线 |
| O3 | prompts.ts 宣称「连续失败熔断自停」无实现（文档漂移） | P88b F2 顺手变成真实现+改文案 |
| O4 | plot3d 设置零撤销（与你的全局「操作可撤销」约定不一致） | P87a A7 补齐 |
| O5 | plotStore 通道强绑 `{tplId,fieldId}`，虚拟/导入/派生数据无家可归（池 A 虚拟通道、轨迹导入、偏差序列三处都卡在这） | B7/C 偏差着色共用 `addVirtualChannel` 一次性解套，**不动采集路径与门控** |
| O6 | scene.ts 1712 行单体、`void accent` 小遗留、P69 留的「短窗粗线」扩展位 | 本批只加「组图层」抽象不做全文件重构（风险控制）；粗线列入 P2 |
| O7 | 校准模式与三组的关系需要定义清楚，否则「模式组」语义打架 | 决策：校准是**独立操作态**（现状不变），绑定源=组1 三通道，HUD 明示「采样源：组1」 |
| O8 | attitude 面板与 3D 轨迹的面板合并问题：你要求「整合到 3D 轨迹面板」 | 本批通过 B2/B3 把「带朝向的模型跟随轨迹」能力吸收进 plot3d；**attitude 面板保留不动**（它是原地姿态仪，语义不同）——若你想彻底下线 attitude，P87b 验收后再议 |

---

**执行承诺**：确认后按 Q10 约定分批执行；每批 = 最小 diff、独立 commit、全量回归基线 + 浏览器冒烟；每批完成输出「每项功能→测试步骤→预期结果→实际结果→是否通过」验证清单；P88a 触 Rust 必过 cargo test；theme.css 串行编辑+grep 验证；不入库 HANDOFF/`.workbuddy/`/`arx.xml`/签名私钥；push 待你放行。

---

## 修订 R1（2026-09-16，用户质询后生效，覆盖正文对应小节）

用户两问：①"全托管"是否阉割、能否做完整 harness/loop、为未来考虑；②通用栏目宜独立面板。**裁决：按完整版执行，面板拆分采纳。**

### R1-1 P88b 重定义：固定相位调参状态机 → 通用 Agent Runtime（完整版 harness）

原 F2 的 collect→ask→validate→gate→apply→settle→measure 只是第一个任务模板的壳，底层引擎改为通用工具循环：

1. **真 function-calling**：`ai.rs` 增加 tools 通道——三种 endpoint 格式（chat/anthropic/responses）各自的 tools 参数编码与 `tool_calls` 增量解析（chatStore 侧攒批同 delta 管线）；工具面 = 39 App Action + `wait_event`/`create_job`/`get_job`（P88a）+ 曲线/3D/指标读取，schema 单一真源（扩展 mcpTools 的 TOOL_DEFS 模式）。**端点不支持 tools 时降级走现有围栏 JSON 块约定，同一 runtime 同一权限体系**；模型能力是外部变量，runtime 不背锅也不装死（不支持即在任务创建时明示）。
2. **循环所有权在引擎不在面板**：loop 引擎=store 级单例，运行中关面板继续活 + 工具栏徽标（**序列器/Modbus 主站先例照抄**），点开面板即接管查看/介入；「面板关即掐流」红线对 loop 会话豁免（普通聊天不变）。
3. **权限=一次性授权域，默认全托管**：只读工具永远自动；写工具在用户圈定的域内自动（指令模板白名单+每目标 min/max/maxΔ/冷却；run_action kind 勾选表；orchestrator 变量声明表）；**仅出域与破坏性动作升级问一次**。急停/静默 watchdog/预算（轮数·时长·发送速率）为仅剩三条硬线，不撤。逐次确认降级为设置里的保守选项——默认档不再要求用户点"执行"。
4. **任务模板层**：PID 调参只是首个模板（复用 C3 指标为目标函数）；同壳可跑「自主测试序列-修模板循环」「协议考古到通过率达标」等后续任务；台账/审批/急停/UI 全在任务壳层。
5. 风险注记：ai.rs 动流式解析=红线区（P51a 教训），tools 分支以「不带 tools 字段的请求路径逐字节不变」为回归测试目标；Ollama 老模型无 tools → 降级路径必须真机验。

### R1-2 面板拆分：3D 瘦身为纯空间语义，三块通用件独立

| 件 | 归属变化 | 复用面 |
|---|---|---|
| 指标分析（C3） | 新独立面板「指标分析」+ `metrics.ts` 纯函数单一真源 | 2D 右键/3D 组行/调参台/告警阈值同调一份；指标结果以虚拟通道回流（偏差着色同口径） |
| 分析包导出（C4） | 从 3D 面板抽出 → 全局「导出分析包」对话框（工具栏+表格/2D/3D/回放/指标各面板可唤起；各面板贡献自己的数据节，meta.json 聚合） | 3D 面板只留入口按钮 |
| AI 调参台（F） | 维持独立面板（agent runtime 的任务前端，不属于 3D） | — |

批次归属修订：C3 → **P87c 新面板**；C4 → **P87c 全局对话框**；其余批次划分不变。Q5 作废（默认全托管+三硬线），Q9 表述不变。

---

## 修订 R2（2026-09-16，业界开源 harness 调研后生效，覆盖 R1-1 的执行内核与优化器部分）

调研来源与采信结论：
- **12-factor agents**（humanlayer/12-factor-agents）——harness 工程清单：Own your context window / Tools are just structured outputs / **Unify execution state and business state** / **Launch-Pause-Resume via simple APIs** / **Contact humans with tool calls** / **Own your control flow** / Compact errors / Small focused agents / Stateless reducer。R1 设计对齐了大半，但「执行状态即业务状态」「可恢复执行」「联系人类也是工具调用」三条没有落成架构件——R2 补上。
- **SWE-agent（arXiv:2405.15793）ACI 结论**：为 agent 特化的工具接口显著提升成功率（pass@1 6→12.5% SWE-bench 等）。→ 不裸暴露 39 个 App Action 给 loop，改为**组合观测/动作工具层**。
- **CodeAct（arXiv:2402.01030）**：以可执行代码为动作空间比 JSON 工具调用成功率高至 +20%。→ **观测面放开受限分析脚本工具，执行面仍走带钳位的具名工具**（硬件场景 code-as-action 直接驱动执行不可接受，但"模型自己写数据处理"完全可沙箱化，复用 extRuntime 管线）。
- **OpenHands**：沙箱执行 + 多智能体协作印证「执行域与决策域分离」；本项目 vdev 虚拟设备即我们现成的沙箱 E2E 环境。
- 领域判断（控制工程常识，非引用）：**纯 LLM 做数值爬山在真车上又贵又差**——试次成本是卡丁车圈时，专用寻优算法（继电反馈/极值搜索/小维贝叶斯优化）样本效率碾压逐轮提案的模型。LLM 的不可替代价值在语义层：判断"这是传感漂移不是参数问题""该停""该换策略"、写报告。R2 据此重构优化器。

### R2-1 P88b 执行内核：回合制状态机 → 事件溯源 harness（覆盖 F2）

- **harness ≠ agent**：控制流（轮转、终止判据、审批、预算）100% 在 TS 引擎手里，模型只是可替换的**提案策略**——不实现"模型决定要不要继续"。
- **LoopState = 事件日志的 fold**（stateless reducer：`reduce(state, event) → state'`）：每步（提案/校验/截断/执行/回执/指标/watchdog）是 append-only 事件；**台账从"日志"升格为唯一运行时状态**——天然获得暂停/恢复/崩溃重启还原（localStorage 持久化 + 启动时「恢复中断的调参任务」横幅）、逐轮回放调试、vitest 纯函数可测（喂事件序列断言状态）。
- **联系人类 = 一种工具调用**：模型可主动发 `escalate(question, options)` 工具→弹审批卡/通知，回答作为事件回灌循环（对应 R1 审批升档路径，但改由模型在判断到域外时触发，而非我们穷举规则）。
- **上下文自持**：会话历史进 loop 的一律是结构化摘要（每轮 `{提案,Δ参数,指标前后差,耗时}` 三行式），原始数据永不出现在对话里；数据读取全部经观测工具按需拉取——token 经济性红线（§7.2-3）的 harness 级落实。
- **错误压缩**：工具失败返回结构化 `{ok:false, reason, hint}`（沿用 orchAiBuild 的 applied[]/pendingHints 模式），引擎折叠成一行差异注入下轮上下文。

### R2-2 工具面三层重构（ACI，覆盖 F 的"工具面=39 action 平铺"）

| 层 | 工具（首批） | 权限 |
|---|---|---|
| **观测层**（组合、返摘要） | `get_window_stats(ch, t0..t1)`（均值/σ/斜率/饱和计数）、`compare_windows(a,b)`（A/B 段指标差）、`get_metrics(taskId)`、`get_traj_groups()`、`get_recent_alerts()` | 永远自动 |
| **分析层**（CodeAct 式） | `analyze(code)`：受限 TS 沙箱（复用 expr.ts+extRuntime 白名单 API：getVar/curveStats/traj/interpAt，无 send/无 DOM），模型自写数据处理脚本，返回计算结果 | 只读=自动 |
| **执行层**（具名+钳位） | `apply_pid(kp,ki,kd)`（每参数 min/max/maxΔ/冷却，出域→escalate）、`send_cmd(id, args)`（指令模板白名单）、`set_orch_var(name,val)`（已声明变量表）、`annotate(text)`、`finish(result)`、`escalate(q)` | 授权域内自动，域外升级 |

外部 MCP 客户端与本引擎**共用同一张工具表**（TOOL_DEFS 单一真源，前端 loop 与桥分发同派生）——外部 agent 与内置 loop 能力面对齐，不出现两套 API 漂移。

### R2-3 优化器后端可插拔（本修订的核心未来性）

调参任务的"下一步参数提案"拆为四档后端，同一 harness 同一钳位同一台账：
- **`relay`（内置确定性）**：继电反馈+Z-N——已有编排模板收编为 loop 后端；
- **`extremum`（内置确定性）**：极值搜索/坐标轮换（dither±Δ 测响应梯度）——单峰粗调，样本效率最高；
- **`bo`（内置确定性）**：自研迷你贝叶斯优化（GP-EI 纯函数，≤6 维，vitest，不引依赖）——多参数联合精调；
- **`llm`（模型策略）**：模型看 R2-2 观测+历史做提案与**诊断决策**（何时停/何时换后端/疑似硬件故障上报）。
默认编排 = **llm 当教练、确定性后端当运动员**：模型可在轮间切换后端、调步长上限、宣布收敛；数值搜索本体交给专用算法。真车试次贵，这是样本效率与「不阉割」同时成立的唯一解；协议考古等新任务模板同理获得"专用算法+LLM 编排"结构。

### R2-4 批次重排（覆盖 Q10 的 P88b 单批）

- **P88b = harness 内核**：事件溯源 LoopState+reducer+持久化/恢复、三层工具面（含 MCP 共表）、授权域/审批/escalate、watchdog/预算/急停、`loopRunner.test.ts`（假时钟+假模型全测）；
- **P88c = 惯导调参任务模板**：`metrics.ts` 接线（目标函数）、relay/extremum/bo 三后端 + llm 策略、vdev 温控炉 E2E、调参台 UI、prompts harness 模板、帮助/i18n。
- 验收追加：**T15** 断电重启→「恢复中断任务」→从事件日志还原现场可继续；**T16** 同一事件序列喂 reducer 两次结果逐字段相等（确定性断言）；**T17** `analyze` 沙箱越权尝试（send/eval/fetch）注入测试全部拒绝；**T18** bo 后端在合成响应面（含噪 1kHz）上 30 轮到 <5% 次优（vitest 数值用例）。

R1 的权限默认档（全托管+三硬线）、面板拆分三件套、P87a~d/P88a 批次不变。

---

## 执行记录 R3（2026-09-17，P87a 落地批 · 用户指令：Q1 定案固定三组、默认全按推荐、Hermes 能移植不自写、新发现随批入档）

### P87a 已交付（本批 diff 范围）

- **store**：`TrajGroup` 三组模型（G1 蓝/G2 绿/G3 橙，mode=point|points|line、平滑 none|movingAvg、着色 time|ch|fixed、密度/渐隐/配对/上限/备注逐组）；`Plot3DSettings v:2` + v1 迁移（style→mode+showDots 映射，单轨迹→组1，等价性有测试）；泵逐组化（独立 sig/lastT/valCarry/配对统计，`GroupBatch{gid,b,reloaded}` 新 Sink 协议）；配置撤销栈（50 层 groups+axisScale 快照，重复值不压栈，clearData 不入栈）；`requestClearData`（AI/MCP 无 UI 通路的水位+场景清空）；`bindGroup/bindGroupFirstFree`（拖放智能落点）；`sanitizeBinds` 跨组扫描。
- **scene**：逐组双层 LOD 缓冲**懒建**（point 模式零缓冲 O(1) 红线；组间通道共享、重锚/包围盒跨组并集）；每组 4 渲染对象（tail Line+Points 共享几何 + ov Line/Points，全组独立 uniform）；滑动平均几何列从 f64 真实值副列重算——**平滑只改视觉，pick/测量/导出仍读原始值**；逐组游标 drawRange 截断零重建；pick 返回 gid（tooltip 归属）；`focusGroup`；组色全景/标记/最新点 tint。
- **UI**：组托盘三行（眼/色点/名称/模式/X·Y·Z 下拉/齿轮）；组设置弹层（一次确认=一步撤销；三轴未齐黄条提示；平滑/密度/上限说明文案写明语义）；vs-field 拖入组行=智能绑定（三槽已满→开弹层引导，绝不静默覆盖）；行右键=设置/隐藏/聚焦/单组导出/单组清空（确认+不可撤销如实标注）；撤销/重做钮+Ctrl+Z/Y（画布点击收焦的路由修复）；主菜单加「组」区，原 7 个组级设置子菜单全部移入弹层（菜单减重）。
- **外部面**：`plot3dRead` 返回 groups+view 新快照；`plot3d` 写 action 扩 `gid`/`clear`/`undo`/`redo`，旧 `axisX`/`style` 键兼容映射到 g1（AI/MCP 零改动不破）；Operator 包 v2 导出/导入（旧包自动迁移）；mcpTools 两工具描述、prompts 三处 3D 文案、HelpModal 3D 页随批更新；theme.css 追加 P87a 段（复用 fc-dlg 骨架+p3d-seg，串行编辑后 grep 验证完整）。
- **回归**：tsc 0 错；vitest **505/505**（plot3d +10：迁移等价×3、组独立×4、撤销栈×5；校准/预览/六面/游标全组化）；eslint 0 error；build ✓；`check:aria` `check:theme` ✓；Rust 零改动（cargo 78/78 基线未动）。

### 实现期偏差与决策（相对原方案，均为收敛不扩面）

| # | 偏差 | 理由 |
|---|---|---|
| D1 | 「CR 平滑起步」改为 **movingAvg 起步**；Catmull-Rom/贝塞尔/样条/自定义全部归 P87b B1 | CR 子细分破坏 tT↔几何 1:1 索引（游标二分/pick 前提），需要独立缓冲设计；MA 是 1:1 映射，零风险起步 |
| D2 | 线宽设置项**本批不提供** | WebGL `Line.linewidth` 恒 1px，做真线宽要上 Line2/fat-lines（P69 曾明确否决+留位）；列入 P87b「粗线短窗」扩展位一并评估，不做假选项 |
| D3 | Z 轴空=平面轨迹**推迟 P87b** | 配对内核以三轴为前提，plane 需扩 pair API；P87a 保持「三轴绑齐才画」（与 P69~P86 语义逐字一致，迁移零风险） |
| D4 | 校准「采样源=组1」实现为泵内硬绑定 | 与 R1 O7 决策一致；HUD/菜单/提示词三处同时标注，无隐藏耦合 |
| D5 | 点位模式透明度作用于最新点 sprite（1 处补齐） | 评审自查发现「改了没反应」感知 bug；同类：maxPoints 调小在无新数据时立即 trim（不等下一批） |
| D6 | 逐轴缩放/平滑切换后 GPU 立即上传（rewriteNorm 内联 flush） | 评审自查：静态数据下切设置原依赖下一批数据才刷，会「设了没反应」；现为同步生效 |

### P88 Harness 移植令（用户 2026-09-17 指令：「能直接移植开源就直接移植，不用自己写」）——P88b 开工前的评估清单（本批只记不做）

- **候选①（首选，事件溯源 harness 内核直接移植）**：**OpenHands**（arXiv:2407.16741，MIT）的 event stream + AgentController 预算模型——但其 Python 运行时无法进 Tauri webview，可移植的是**结构**（事件类谱、stateless reducer、condenser 压缩）：约 1:1 重写为 TS 纯模块（`ai/loop/events.ts`），量小且全可测。**结论：形状移植，代码不搬。**
- **候选②（工具循环直接复用）**：**Vercel AI SDK（ai package，MIT）**——自带多轮 tool-calling 循环、`stopWhen/maxSteps` 预算、三 provider 适配（OpenAI-compat/Anthropic/OpenAI-Responses 与本项目 ai.rs 的 format 一一对应）。障碍：本项目 LLM 流在 **Rust ai.rs**（代理设置/abort/usage 都在那），AI SDK 要求 JS 侧 fetch SSE。**评估结论：不搬 SDK（等于废掉 ai.rs），移植其「循环协议层」语义——`streamText+tools+stopWhen` 的等价物约 150 行 TS 事件机；P88b 详设时先做 1 天验证性 spike 定夺。**
- **候选③（数值后端外采）**：贝叶斯优化不自研？scikit-optimize/BoTorch 皆 Python；JS 生态（simple-statistics 无 GP-EI）不达标。**维持自研 ≤6 维 GP-EI 纯函数**（~200 行 + 合成面 30 轮收敛用例，R2-T18 不变）。
- 综上：**loop 骨架「事件溯源结构」直接照抄 OpenHands/12-factor 形状；provider 循环抄 AI SDK 语义；数值算法只有 BO 必须自研**——与用户「能移植就移植」的令一致，且 P88a 的 jobs/wait_event 原语本来就是给外部 harness 留的通用接口（外部 Claude/Cursor 即成自带 loop 的宿主，见 R2-3）。
- 本批新发现随批记录：`sanitizeBinds` 自动解绑不压撤销栈（撤销回旧绑定→再被解绑，自愈语义已测试钉死）；泵首拍对从未消费的组**不再下发空 reloaded 噪声批次**（ever 门），场景挂载更干净。
