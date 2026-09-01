# Uartix+ Qt/C++ 一比一复刻规格书

> 目的：本文档 + 本仓库源码共同构成完整规格。目标读者是执行复刻的 AI/工程师。
> 版本基准：v0.3.0（2026-09-01，commit 4f42a4f 时代）。
> 源码：https://github.com/Tanixs/uartix-plus（React+TS 前端 / Rust 后端）。
> **冲突裁决**：凡本文档与源码行为不一致处，以源码为准；凡源码含历史 bug 修复痕迹处（见 §4.10 被否定方案与各面板"红线"），必须保留修复后的行为，不得"合理化重构"回退。

---

## 0. 给复刻 AI 的总纲

1. **使命**：用 Qt 6 + C++ 一比一复刻 Uartix+ 全部功能与交互，视觉与操作手感应达到"老用户无缝上手"的程度。
2. **双源依据**：本文档给结构化规格；仓库源码给像素级细节（颜色、间距、交互阈值、文案）。遇到本文档未覆盖的细节，直接读源码对应文件（每节已给出源文件映射）。
3. **复刻原则**：
   - 行为优先于实现：跨进程 IPC、浏览器 DOM、CSS zoom 等 Web 特有机制应替换为 Qt 等价物（§3.3），但**外部可见行为必须逐一对齐**；
   - 所有用户数据格式（协议模板/控制页/命令库 JSON）**必须与 0.x 版本字节兼容**（§7.4），保证老用户配置文件直接导入；
   - 每个面板的"红线"小节列出了历史上踩过坑、被用户明确要求过的行为，违反即返工。
4. **沟通语言**：界面默认中文，英文为可切换翻译。

---

## 1. 产品定义

- **产品名**：Uartix+
- **一句话定位**：面向嵌入式工程师（惯导/机器人/航模/自动控制）的高自由度可视化串口/网络协议分析仪。
- **核心差异化**（竞品 Serial Studio/VOFA+/LLCOM 均无）：在原始 Hex 字节流上**鼠标拖拽框选定义私有协议帧**（零代码），实时映射为物理量、2D 曲线、3D 姿态，并通过可视化控件向下位机发送格式化指令——"观察 → 分析 → 控制"双向闭环。
- **形态**：Windows（NSIS 安装包）/ Linux（AppImage/deb）桌面安装包，开源 MIT，本地运行不做网页部署，带自动更新。
- **目标窗口尺寸**：默认 1440×900，最小 1100×700，无边框自绘标题栏。

## 2. 技术选型建议

| 领域 | 原实现 | Qt 复刻建议 |
|---|---|---|
| 框架 | Tauri2 (Rust) + React 19 | **Qt 6.7+ Widgets（C++17/20）+ CMake**；不用 QML（本应用是工具型密集布局，Widgets 更可控） |
| 停靠面板 | dockview-react | **QDockWidget 自定义样式** 或 KDAB::KDocking / Advanced Docking System（实现页签合并/悬浮/分屏，需定制样式对齐 §4.6） |
| 2D 曲线 | uPlot + 大量 canvas 自绘 | **自绘 QOpenGLWidget 或 QWidget+QPainter**（§5.4 说明为何不建议 QCustomPlot：游标层/堆叠/徽标等大量自绘需求，自绘更可控）；数据结构与抽稀算法照搬 |
| 3D 姿态 | Three.js (GLB/GLTF) | **Qt3D 或直接集成 three 级等价**：推荐 Qt3DRender + 自建四轴/立方体网格；GLB 加载用 Qt3DRender::QSceneLoader |
| 串口 | serialport crate | QSerialPort（注意：保留 50ms 轮询读 + 33ms/16KB 批量推送节奏，§6.1） |
| 网络 | std::net 线程 | QTcpSocket/QUdpSocket + 专用线程（QtNetwork 对象留在所属线程，信号槽跨线程队列连接） |
| 高频数据总线 | Tauri Channel 二进制事件 | **进程内信号槽（Qt::QueuedConnection）+ 环形缓冲共享**，无需真实 IPC（§3.3） |
| 脚本 | JS 子集（窗口内 eval 沙箱） | 内嵌 **QJSEngine**（API 见附录 D，逐一对齐） |
| 表格 | React 虚拟列表 | QTableView + QAbstractTableModel（30 行滚动窗等价） |
| Excel 导出 | xlsx 库 | QXlsx（第三方头文件库）或 CSV 兜底 |
| 持久化 | localStorage | QSettings（INI）存轻量偏好；大结构（模板/布局/命令库）存 `%APPDATA%/UartixPlus/*.json` |
| 自动更新 | tauri-plugin-updater + minisign | 自实现：启动/手动检查 latest.json（固定 URL §7.5）→ 下载 .sig 校验（Qt Crypto 或 minisign C 移植）→ 静默安装重启 |

## 3. 总体架构

### 3.1 线程模型（对齐源码节奏）

```
[读线程 xN]        串口1 / TCP1 / UDP / 演示源     （Qt: QThread 内 QSerialPort 等）
     │ 50ms 轮询读 4KB
     ▼
pipeline::ingest()  统一入口（唯一）：
     ring.append(bytes)                        32MB 环形缓冲 + 时间戳环 8192
     parserEngine.feed()                       多模板并行状态机 → FrameRow
     spans 更新 / 录制落盘
     发射批事件（33ms 或 16KB 双阈值）          Qt: 信号 queued → UI 线程各面板消费
     ▼
[UI 线程] 各面板独立消费：
  帧画布/Hex/表格：rAF(≈60fps) 脏标记循环 + 拉取/裁剪（不随数据逐条刷新）
  2D 曲线：120ms tick 增量合并 → 视窗裁剪 → 抽稀 → 重绘
  3D：独立 30fps 限帧循环，数值走旁路裸对象（不进事件系统）
  控制台：100ms 定时器批量直写
```

### 3.2 后端→前端事件契约（Qt 内化为信号）

原 Rust→前端事件（现为 Qt 信号，payload 结构不变，见 `src/ipc/types.ts` 单一事实源）：

| 信号 | 载荷 | 消费者 |
|---|---|---|
| `portsChanged` | — | 接口下拉刷新 |
| `stateChanged` | iface/连接状态/端口名/波特率/重连中 | 标题栏接口区、状态栏、面板门控 |
| `rxBatch{bytes,tsFirst,tsLast}` | 33ms/16KB 批 | 控制台、图传、图例计数 |
| `txBatch{bytes}` | 同上 | 控制台 TX 显示 |
| `frames{rows,total,errors}` | 30Hz 批 FrameRow | 帧画布/表格/变量/图传 RAW |

命令（原 Tauri invoke → Qt 直接方法调用）：`listPorts/openPort/closePort/sendData(mode,text)/startRecord/stopRecord/parserSetRules/hexFetch(start,end)/hexClear/demoStart/Stop/Running/saveTextFile/readTextFile/readBinaryFile/listLocalAddrs/saveBinaryFile/hexSearch(上限500命中)`。

### 3.3 Web 特有机制 → Qt 等价（复刻对照表）

| Web 机制 | 问题 | Qt 等价 |
|---|---|---|
| CSS zoom 全局缩放（90~125%） | 指针坐标全部要除 zoom 因子（源码踩坑 3 次） | **Qt 无此问题**：用 QScaler/QDPI 或仅提供 90~125% 界面字号/尺寸档；所有坐标数学保持逻辑像素 |
| canvas `style.width` 不同步导致高 dpr 漂移 | 指针/格子错位 | QWidget 尺寸即逻辑像素，devicePixelRatio 只影响绘制；paintEvent 用 `QPainter(scale dpr)` |
| rAF 脏标记循环 | — | QPainter 面板用 `update()` 合并请求 + `paintEvent`；动画循环用 QTimer(16ms) 或 QOpenGLWidget 内部循环 |
| DOM 直写控制台 | React 卡顿 | QListWidget/QPlainTextEdit append 批量 + 400 块上限等价（QPlainTextEdit maximumBlockCount=400） |
| localStorage | — | QSettings + JSON 文件（键名映射表见 §7.3） |
| window.uartixPlot 桥（删模板清曲线） | 规避 store 循环依赖 | 直接信号槽：TemplatesPanel 删除 → PlotStore.removeByTpl |

## 4. 全局 UI 框架规格

### 4.1 无边框窗口与自绘标题栏（源：shell/TitleBar.tsx）

- `decorations:false` 等价：`Qt::FramelessWindowHint` + 自实现拖动/缩放边缘。双击标题栏最大化。
- 布局（左→右）：品牌图标+「Uartix+」+动态版本号（单一来源：构建配置）｜**数据接口下拉菜单**（串口✓ / TCP 客户端 / TCP 服务端 / UDP——切换时若连接中先断开）｜spacer｜⚙ 设置｜? 帮助｜📌 置顶（toggle，激活高亮）｜— □ ✕（最小化/最大化/关闭；maximize 图标随状态切换 restore）。
- 窗口背景色 `#f5f6f8` 缓解启动白闪（Qt：窗口背景直接设置）。
- 红线：版本号绝不允许硬编码在 UI 代码（v0.3.0 曾翻车，标题栏显示 0.2.0）。

### 4.2 顶部工具栏（App.tsx + serial/SerialToolbar.tsx + NetIfaceBar）

左→右：
1. **SerialToolbar**（串口模式）：连接按钮（胶囊+呼吸灯圆点，连接后变断开）/端口下拉（USB 友好名，热插拔 1.5s 刷新）/波特率**组合框**（手动输入 + ▾ 14 档预设 1200/2400/4800/9600/14400/19200/38400/57600/76800/115200/230400/460800/921600/3000000）/数据位 8/校验无/停止位 1。**波特率必须手输+下拉共存**（用户明确要求，不许只下拉）。
2. **NetIfaceBar**（TCP 客户端/服务端/UDP 模式）：远程 IP+远程端口（客户端）/本地监听端口（服务端/UDP）+默认对端（UDP）、连接/断开、连接后显示对端地址。
3. spacer｜**[+面板 ▾]**（已关闭面板重新加入）｜**预设布局下拉**（协议调试/数据分析/姿态调参/纯串口/图传）｜**重置布局**｜**编辑布局** toggle。

### 4.3 默认工作区布局（App.applyDefaultLayout）

- 左列 25%：协议模板侧栏；中列 50% 上半：**帧画布**（激活最前，与 Hex 数据流、控制台同组页签堆叠）；右列 25% 上半：属性面板；上下 1:1。
- 底行：数据表格｜2D 曲线（中列各半）+ 控制画布（右列下）。**3D 姿态默认不加入**（+面板可加）。
- 工作区预设 5 种：协议调试（上述默认）/数据分析（曲线+3D 大区，无帧画布重复）/姿态调参（3D 入中组+底行+「姿态调参」控制页含 6 个 2×1 滑条）/纯串口（Hex+控制台+控制画布）/图传（templates|video 大区 + hexview|properties + console 右下）。
- 启动恢复上次所选预设与布局；「重置布局」清缓存按窗口比例重建。
- 编辑布局模式：每个显示区四边"+"生长新空区 + 清空按钮。

### 4.4 状态栏（App.tsx:550）

左→右：接口连接状态（含重连中闪烁）/端口名或对端地址/波特率/RX 字节+bps/TX 字节/帧统计（有效·滤除/错误）/⚡ PerfHud toggle（FPS/>50ms 长任务累计/渲染计数，PerformanceObserver 等价 = 自实现帧计时）。

### 4.5 设置窗口（features/settings/SettingsModal.tsx）——5 页

左目录：通用/工作区/数据·诊断/导入导出/关于。行布局：**label 左对齐，min-width 108px，高内容行（主题色卡/预设卡）label 顶部对齐**。

| 页 | 设置项（控件/可选值/默认） |
|---|---|
| 通用 | 界面语言（下拉 中文/English，默认中文）；界面主题（**色卡网格** 9 款：亮色/暗色/跟随系统/浅蓝/深蓝/护眼绿/活力橙/海棠/琉璃，默认亮色）；界面缩放（分段按钮 90%/100%/110%/125%，默认 100%） |
| 工作区 | 预设布局 5 种 + 重置布局；控制画布格尺寸（48 紧凑/60 标准/72 宽松/90 更宽松/110 超宽松，默认 60） |
| 数据/诊断 | 图例小数位（数字输入 0~6，默认 2）；PerfHud 开关 |
| 导入/导出 | 协议模板（含簇名）/控制画布/命令库三组导出/导入按钮；JSON 格式 `{kind:"uartix-templates|controls|commands", version:1, data}` |
| 关于 | 版本（getVersion 动态）、仓库链接、LICENSE、检查更新（真实现）、作者行（22px 圆头像+Tanix，无边框简洁链接，hover 变色下划线——**禁用胶囊/圆角大框**，用户明确否决过）、官网 larix.teuioe.cn |

### 4.6 主题系统

- 机制：9 款主题全量 CSS 变量组（背景/面板/文字/accent/边框/inset…），实现为 Qt QSS 变量或代码级 QPalette+QSS 组合。**切换必须全窗口即时生效，包括 canvas 类自绘面板**（源码踩坑：canvas 不自动重绘残留暗底——Qt 中所有自绘 widget 需注册主题变更通知并 update()）。
- 色值从 `src/styles/theme.css` 逐一提取（`[data-theme=...]` 变量块），共 9 套；dockview 容器色也随主题。
- **红线**：主题变量必须整组切换，禁止"部分变量回落默认"导致明暗混杂（P20/P21 两次事故）。

### 4.7 i18n

`t(key)` 机制；中英两份（src/i18n/strings.ts，zh 全量+en 覆盖约 60+ 条 tb.*/st.*/con.*/hx.*/tbl.*）。**深度面板（帧画布/属性面板/控制画布深处/帮助正文）保留中文**（用户拍板：目标用户中文为主）。切换即时生效。

### 4.8 帮助窗口（HelpModal）

五节：快速入门五步/九面板总览表/协议画布教程/脚本命令详解（API+3 实例）/快捷键表。「X」术语渲染为 accent 色代码芯片。

### 4.9 快捷键与全局交互

- Ctrl+F：Hex 搜索（Esc 关闭搜索或右键菜单）。
- 右键菜单统一规范：portal 等价=独立顶层 popup、实测尺寸边界 clamp（贴底上翻/贴边夹紧）、**点击展开并钉住的子菜单**（不依赖 hover 时序）、Esc/外部按下/滚轮关闭、500ms 鼠标离开延迟关闭。
- 全局禁用系统默认右键菜单（输入框豁免保留粘贴）。
- 菜单/浮层一律不得被容器裁剪（源码教训：overflow:hidden 裁掉菜单）。

### 4.10 被否定的 UI 方案（复刻时禁止出现）

- 帧画布悬空标签行（8×8 堆叠必重叠）→ 字段名块内右下角 11px 小字。
- 帧画布半透明柔光块/多层格内文字/虚线框选/虚线跳线 → 实色块+单文字层+全实线。
- 每帧型一个页签 → 按簇分组一页签+帧型下拉。
- 控制台 React 大字符串 → 直写（Qt:批量 append）。
- 共享 X 轴+null 填充多通道 → 每通道独立存储+归并对齐。
- 关于页作者胶囊框 → 无边框简洁链接。
- 波特率仅下拉 → 组合框。
- 双游标合并十字线 → 时间/幅值两套独立游标。
- 外挂网格尺寸角标 → 卡片内角标。

## 5. 面板规格

> 通用规则（适用于所有自绘面板）：① 指针↔格子必须像素级精确（历史三次漂移事故：dpr/CSS zoom/resize 不同步——Qt 下注意 devicePixelRatio 与 widget 尺寸，任何"高亮块漂离指针"都是 bug）；② 面板不可见时跳过重绘但**数据照常缓冲**，可见时一次补刷；③ 面板**关闭=彻底停止**本面板数据采集/归档（重开从新数据继续）——用户明确要求"关闭了的面板绝不允许后台运行"；④ 堆叠页签中非前台面板降级（停止渲染，仅缓冲）。

### 5.1 帧画布（核心交互引擎）— 源 framecanvas/FrameCanvas.tsx + protocol/templateStore.ts

**布局**：顶部工具栏单行（协议页签分组◀▶/⚡跟随导航、💾 保存、撤销/重做、前后帧、跟随、清空、统计 chip「帧数·字节·滤N」）；主体 canvas 字节格网格；左缘行偏移尺（十六进制首偏移）。

**视觉规范 V2（用户逐像素验收，严禁回退）**：
- 字节格实色块：fill 主题色 α0.46/stroke α0.9、圆角 4、块间缝 BLOK_PAD 4、行高紧凑 ROW_XTRA=8（64B 单屏容纳）。
- 角色配色：绿=数据字段、橙=帧头、粉=校验、灰 gap（更淡底+边框，悬停提示「未定义字节」）。
- 字段名=块内**右下角** 11px 小字（块宽≥52px 才显示，省略号截断防溢出）；实时值=右上角（宽≥100px）；**全图任何文字不得重叠**。
- 禁止一切虚线（选区实线 α0.18+1.4px）；hover=精确单格（淡填充+实框）；拖选中选区右下角「nB」字节徽标。
- hex 值等宽字体（Cascadia 系）；骨架态帧头/帧尾格显示模板真实 Hex，数据区显 `--`。

**交互**：
- 左键框选字节→右键「定义为字段」→对话框（名称/角色/类型/字节序/缩放/偏置/单位/识别值）。角色四组：帧结构(帧头/帧尾)/控制(目标地址/功能码/序号/数据长度)/数据(数据内容/数据载荷)/校验(和校验/附加校验)。
- 字段尺寸自动扩展：fieldSize=max(类型尺寸，识别值长度)；冲突→「覆盖并继续」确认；超帧长红色拒绝。
- 右键帧头/帧尾：Hex 编辑对话框（±1 字节/清空/保存）；**帧头可为空**（纯逗号文本流也是协议帧）。
- 定长模式右键插入/删除格：帧长 ±1、后继字段偏移自动平移、占用/帧头内/超长给明确提示、禁止删帧头。
- 点击字段→属性面板编辑；点击帧头/校验块→选中模板本身；字段悬停整区域高亮（全部行段 2px accent 圆角框+6% 填充）。
- 识别位（同栈多帧型区分）：字段级 `disc` 属性（如 V7 功能码 off2、WIT TYPE@1），不匹配帧静默丢弃（不计数）。
- 保存状态机：idle→saving→ok(绿✓1.6s)/err(红⚠抖动4s+常驻「模板校验未通过」chip，点击展开具体原因)。
- 撤销/重做：全部模板变异统一入栈（50 层）；删除模板/字段联动清理 2D 曲线通道。
- 页签=协议簇（预设同名折叠一个页签，组内帧型下拉含帧计数）；帧型右键复制/粘贴（跨簇）/重命名/删除/整组启停。
- 骨架模式：模板有定义无数据时按 skeletonLen 铺格（定长=定长；其余=帧头+字段最大终点+校验尾夹 8~64），可正常框选；**严禁拿其他模板的帧顶数**。

### 5.2 协议模板侧栏 — protocol/TemplatesPanel.tsx

- 「＋新建」（单协议=帧长/协议簇=簇名+条数 1~64+帧长/自适应文本帧=分隔符+元素类型+行尾）、「＋预设▾」（V7 全 22 帧型/维特 WIT 10 帧型/Modbus RTU/NMEA-0183/CSV——导入**可编辑副本**，重名自动 (2)）。
- 列表行=色点+名称+预设徽标+帧数+启用勾选+删除×；组行/子行右键菜单；列表/图例可拖分隔条（比例持久化）。
- 字段图例（下部）：每字段行=眼睛开关（联动 2D 曲线通道）+色点+名称+**实时值**（小数位全局设置 0~6）+采样率 Hz（通道芯片）；csv 字段自动展开 `字段#1..#N`。
- 启用模板的字段名自动注册为**变量**（重名 _1/_2），供脚本/控制引用。

### 5.3 Hex 数据流 — hexview/HexView.tsx

- Canvas 虚拟渲染：**不订阅整流**，按滚动视口调 hexFetch(start,end) 拉切片；rAF 脏标记循环绘制；右下角字节率。
- 右下按钮组：跟随最新 ↓（toggle）/暂停 ⏸▶（**独立暂停**：暂停时数据后台照常累计缓冲，恢复立即补刷——P27 后改为 onRx 事件驱动置脏）/清空。
- 拖拽框选定义字段（同帧画布，右键两级级联：模板→长度/校验/数据，禁用项写明原因）；右键「复制为 Hex」完整字节。
- Ctrl+F 搜索（按模式长度逐格高亮+命中行居中；后端 hexSearch 上限 500 命中）；Esc 关闭。
- 中键按住拖动=平移滚动（grabbing 光标）。
- 控制台暂停联动冻结 Hex 刷新（数据仍后台解析）。

### 5.4 2D 曲线（最复杂面板）— plot/Plot2D.tsx + plotStore.ts

**数据层（照搬算法）**：
- 每通道独立 `{t[],v[]}`，MAX_POINTS=30000 超限砍半；**严禁共享 X+null 填充**。
- `buildAligned()`：渲染时多通道按时间 K 路归并对齐（每通道单调，O(N·logK)），每 120ms tick **增量合并**（只处理新增点）。
- **视窗裁剪喂数**：只喂当前视野 ±5% 边距内的点（FED_CAP=16000）。
- **峰谷保形抽稀** `decimate`：每桶保留 2+2k 点（桶首+桶末+每可见通道各自 min/max 索引，排序去重）+ **强制保留序列末点**；k=可见通道数。红线：抽稀只许峰谷保形，**不许降频/丢特征**（用户明确）。
- **X 源悬空自愈**：xSource 指向已删除通道时自动回落 "time" 并持久化（P27 根因：悬空曾致裸毫秒轴+裁剪失效+最新线漂移连锁）。
- 游标读数 `interpAt`：二分查找+线性插值，读原始值（不受堆叠变换影响）。

**交互契约（VOFA+ 示波器模型，用户验收标准）**：
- **跟随态**（默认）：X 窗口固定 span 钉住最新——`min=last-0.95span, max=last+0.05span`（**span 恒定**，历史 bug：复利 ×1.05）；锚点=**可见通道末点**（`lastVisibleX`，非喂数末点、非理论值——0x52 停止 0x51 还在到货时最新线必须贴住可见曲线末端）。
- **浏览态**：拖动/框选/滚轮后视图**绝对冻结**（用户拍板"拖到哪停哪"），新点照常入缓冲；最新点超出右缘→「跟随最新 ›」角标（显示积压点数）点击回实时。拖动 4px 阈值内不丢跟随；panRef 卡死保护（指针释放丢失时 `buttons==0` 复位）。
- 滚轮：图区=以鼠标锚点 X/Y 等比缩放（连续 `k=exp(deltaY*0.0012)`）；X 轴区=只缩 X；Y 轴区=只缩 Y。
- **Y 轴双模式**：yAuto 开=连续自动贴合（每 tick 按**当前视野内**数据 min/max+10% 余量，拖动后仍自动贴回——仅 yAuto 关闭时交互才锁 yManual）；yAuto 关=手动优先保持直到 Auto/双击/复位。
- **一次性 Auto 键** `fitView`：X=全量数据范围+2% 边距一步适配；Y=该 X 范围内 min/max；关闭跟随；**按一次执行一次**，不连续接管（与 yAuto 是两个独立功能，用户强调"这是不一样的！！！"）。
- 双击：保形回实时（保留窗宽/Y 范围仅平移到最新）；右键「复位视图」=回实时+Y 自适应。
- 双游标系统（**两套独立**）：时间游标（垂直线·Δt）/幅值游标（水平线·ΔV）各自开关；开启后单击图区空白依次铺 A（青绿）、B（橙）；2px 线+双端三角旗标+字母徽标；拖线 24px（抓取 32px 阈值、±10px resize 光标反馈）；越界贴边有边缘指示箭头；**整体移动**模式。测量面板：显示 A、B 各自坐标与 A−B 差值（时间游标显示各通道 V1→V2/ΔV）；面板可拖标题栏移动、位置持久化；「清除」按钮**只清游标不关功能**（用户纠正过）。
- 指针交叉线：跟随指针的十字虚线+自动吸附最近可见曲线交点，**就近显示「x · y」原始值**（28 layout pixels 内、通道颜色、二分插值取值）；堆叠模式按原始值读数。
- 时间轴：**相对秒**（相对首点 0s/60s/1.2h 格式化；内部 ms，显示层除 1000）。
- 堆叠模式：每可见通道独立归一化（自身 min/max+10% 余量）映射均分槽位（占槽 76%），槽位分隔线+通道名与量程；Y 域 [0,1] 刻度隐藏。
- 线型三选：直线/阶梯(ZOH)/平滑样条；宽度 1~3；点模式；通道颜色取字段属性色；图例徽章点击 solo 聚焦；通道芯片显示实时采样率 Hz。
- 工具栏图标按钮（含 tooltip）：Y 自动 toggle / Auto 适配 / 清空 / 堆叠 toggle / 游标（下拉选时间/幅值）/ 跟随 toggle。全部图标化+文字 tooltip（用户要求图标清晰+tooltip 说明）。
- 绘图层：曲线用绘图库/自绘路径；**游标线/旗标/徽标/锚点线/堆叠分隔/测量带/框选矩形全部自绘叠加**（Web 版因 uPlot DOM cursor 层与 CSS zoom 不兼容而自绘；Qt 中同样建议全自绘统一坐标系）。
- 右键菜单：X 轴源（时间/序号/以某通道为 X）/Y 轴源（通道显隐）/线型/堆叠/游标/复位视图；子菜单可点击钉住。

### 5.5 数据表格 — table/DataTable.tsx + framesStore.ts

- 虚拟列表（30 行滚动窗）；动态列=启用模板字段（+时间/模板列）；列显隐菜单/点击表头排序/过滤输入。
- 工具栏：暂停/继续、清空、缓存行数下拉（上限设置防内存失控）、过滤、CSV/XLSX 导出（仅显示列）。
- 后台页签：停止 React 重渲染等价=停止 view 刷新，数据缓冲 150ms 批 flush，切回补齐。

### 5.6 3D 姿态 — attitude/View3D.tsx + attitudeStore.ts

- 模型四选：四轴飞行器（精细建模：双层机身/透明前挡风/电池绑带/滑橇/4 斜臂/电机铃/**双叶对桨反向自转**/机头 accent 条）/立方体（边线+机头锥+顶部箭头）/Cesium 官方 GLB/自定义 GLB（加载后等比缩放+居中+机头朝向修正，失败回退内置四轴）。
- 绑定：**跨模板**字段选择（层级浮层：模板→数值字段，7 个绑定槽：roll/pitch/yaw 或 qw/qx/qy/qz）；选模板后按字段名关键词自动匹配（roll/pitch/yaw、qw…）；欧拉六种旋转顺序+XYZ 轴取反开关。
- 数据旁路：数值写裸对象，渲染循环 30fps 直读（不进事件系统）；面板关闭停止解析。
- HUD：当前角度数值显示；复位按钮；滚轮缩放+拖动旋转视角。

### 5.7 控制画布 — controls/ControlCanvas.tsx + controlsStore.ts + CardViews.tsx

**网格**：正方形格（列宽=行高），格尺寸设置 5 档；背景淡网格线（透明度 0.22，浅色可见）；页面 N×M 显式设置（4~24 列/4~48 行，默认 12×12）；inner 尺寸=cols*STEP+GAP，双方向滚动；**格物理尺寸与列数解耦**。

**9 种控件**（Base{id,type,name,x,y,w,h}，默认尺寸：joystick 2×2/keypad 3×3/monitor 2×2/其余 1×1）：
滑条（值+模板串发送+脚本）、按钮（按下发送/释放可选）、开关（2|3 位）、LED（变量+六种比较 gt/ge/lt/le/eq/ne+阈值，颜色自适应卡片 22~110px）、蜂鸣器（同 LED 判定+freq 2000Hz/volume/durationMs 200ms/repeat 循环+试听）、数值监视（2×2）、摇杆（**锁 n×n 正方形**，模板 "%x %y"，range，springBack）、键盘遥控（n×n 方阵）、单键监控（**不锁正方形**，用户明确）。

**拖拽（react-grid-layout 语义）**：
- 拖入：控件库/命令树拖入→ghost 幽灵框预览（可放=accent 虚线、区域满=红虚线）、**2 格半径**螺旋搜索最近合法位、找不到=红框+松手回原位。
- 移动：指针锚定 1:1 跟随（初始位置+位移/liveScale，任何缩放都咬住鼠标）；**卡片本体原地变暗，只有幽灵框移动**（机制性防重叠）；落点自动 resolveOverlaps。
- 缩放：卡片内右下角 accent 角标拉伸；按格吸附；碰撞时先缩自己到原尺寸下限、仍重叠→挪邻居（**绝不把自己挤成 1×N 竖条**——用户两次反馈）。
- **normalizeGeometry 统一出口**：数值防护（NaN/Infinity 收敛）、最小 1×1、页边界钳制、正方形锁；加载时 **declump 数据自愈**（历史坏坐标排序重排）。
- 复制粘贴：卡片右键复制、画布空白右键粘贴（全属性深拷贝、名字 _1/_2 递增、被占就近找空位）。
- 页级锁定 locked：禁拖禁缩放仅操作控件；多页面页签管理。
- 右键菜单：编辑/复制/删除/挂载命令（**级联浮层**按命令树递归分组，多级 Flyout 逐级展开）。

**脚本（每控件可启用）**：API `send(x)/beep(freq,ms,volume)/delay_ms(ms)/get(变量)/set(变量,值)/log(text)/await waitParse(字段,ms)/setControl(控件名,值)/await repeat(n,i=>…)`；变量插值 `{温度:.1f}`、printf 风格 `%d`；变量来自启用模板字段自动注册。

### 5.8 键盘遥控 — controls/（KeypadCard/KeymonCard）

- 键盘遥控卡片：按键映射指令，**按下触发**（支持按下/释放）；模式=直发模板/JS 脚本；切脚本模式自动填充 5 行示例（按 dir 分支发 FWD/BAK/LFT/RGT）；n×n 方阵布局。
- 单键监控：单键显示+触发，1×1 起。

### 5.9 视频传输 — video/VideoLink.tsx

- 数据源：rxBatch 原始字节流；**JPEG 模式**=FFD8FF…FFD9 状态机切帧（单帧>2MB 丢弃计数、缓冲 8MB 上限）；**RAW 模式**=解析设置弹窗（帧头 HEX 默认 5A A5/宽高来源：帧内 u16 偏移或固定值/像素格式 GRAY8|RGB565|RGB888/字节序），像素渲染，非法宽高丢帧重同步；配置持久化。
- 大画面：滚轮缩放 0.2~8×（鼠标锚点）+左/中键拖动平移+双击复位；最近 12 帧缩略图胶片条+回看。
- 按钮组（32×28、15px 图标）：暂停/继续（**accent 蓝底高亮**）、保存当前帧 JPG、水平镜像（激活态高亮）、垂直翻转、解析设置、清空（hover 效果）；统计：FPS/帧数/帧大小/丢弃。
- 背景/缩略图底色随主题。

### 5.10 控制台 + 快捷指令 + 指令工厂 — console/

**控制台**：模式 ASCII/Hex 下拉、时间戳开关（分色 accent `[TX hh:mm:ss.mmm]`）、自动滚动（滚离底部自动暂停，回底恢复）、RX/TX 显示开关、追加换行、暂停/继续（联动冻结 Hex）、清空、录制/停止（落盘）、发送文件（自动分块 Hex 发送）。
**大块二进制摘要**：>512B 只显示头部 64B+「⇥ 二进制 N B（详情见 Hex 数据流）」（图传时防 DOM 压垮）。
**发送区**：发送模式（ASCII/HEX）、换行选项、输入框（Enter 发送）、发送历史下拉、发送按钮。
**快捷指令栏**（可折叠横条，状态持久化）：命令芯片（与命令库同源）、左键立即发送（⚡脚本走脚本执行）、点击闪色反馈；悬停 300ms 弹预览窗（名称+HEX 绿/ASCII 蓝/脚本 黄徽标+实际内容+字节数+备注+"点击立即发送"）；「管理」弹窗增删改；「存为指令」；「预置常用指令」12 条（WIT 解锁/保存/重启/航向置零/校准×3/输出频率/波特率等，序列类为 delay_ms 脚本）。
**指令工厂**：6 编解码器+我的协议——**WIT 写寄存器**（30+ 寄存器+常用值下拉，`FF AA ADDR DATAL DATAH`，解锁→100ms→写→100ms→保存序列）；**匿名 V7 功能触发 0xE0**（24 条命令表，参数 U8/U16/S32 小端+量程校验，SC+AC 自动）；**V7 参数读 0xE1/写 0xE2**（PAR_ID U16+PAR_VAL S32 补码）；**Modbus RTU**（01~06，CRC16 低前）；**校验工具**（SUM8/XOR8/SUM16/CRC16-Modbus/CCITT-FALSE/X25/匿名 SC+AC，可追加帧尾）；**我的协议**（段编辑器：固定字节/变量字段 U8~U32·S16·S32·F32·ascii 大小端/长度段 U8 自动/校验段 7 种；实时试组预览+双重校验；导入导出）。每个协议顶部一行**人话流程提示**；帧预览**分段着色+色块下方字段名标注**（帧头灰/地址紫/功能码蓝/长度青/数据绿/校验金黄）。
**命令库**（commandStore）：递归分组树；行拖拽三区判定（上 1/3=行前插入线、下 1/3=行后、分组行中部=移入组末尾整行描边）；拖到控制画布部署卡片；命令项=单击发送/双击编辑；每命令独立 scriptEnabled（"不用不运行"）；叶子命令右键编辑/删除。

## 6. 后端规格（C++ 侧实现）

### 6.1 时序参数表（逐一对齐，勿改）

| 参数 | 值 | 说明 |
|---|---|---|
| 读轮询超时 | 50ms | 串口读线程 wait |
| 批量推送双阈值 | 33ms / 16384B | 先到先发 |
| 读缓冲 | 4096B | 单次 read |
| 热插拔轮询 | 1500ms | 枚举端口变化→portsChanged |
| 自动重连轮询 | 1000ms | 断线后 |
| TCP 连接超时 | 3s | connect_timeout |
| 拔线检测 | 2000ms 无数据 | 主动核对端口存在性→消失即断开重连流程 |
| UDP 错误 | 短暂退避 50ms 续跑 | 不退出线程 |
| 服务端 accept 轮询 | 20ms | TCP server |
| 环形缓冲 | 32MB + 时间戳环 8192 | fetch(start,end) 视口取窗 |
| 帧事件批 | 30Hz | parser:frames |
| 归档池回收 | 水位线 4MB/20 万条→裁到 3MB/15 万 | **禁止逐条 shift**（主线程卡死真凶） |

### 6.2 串口（serial.rs → QSerialPort 封装）

枚举含 USB 友好名；open/close/sendData（ascii/hex 解析容错）；热插拔；断线自动重连（epoch 计数防新旧线程竞争）；录制 startRecord/stopRecord（原始字节落盘）；**命令不得阻塞 UI 线程**（原 async+spawn_blocking，Qt 中 open/listPorts 移工作线程）。

### 6.3 网络（net.rs → QTcpSocket/QUdpSocket）

TCP 客户端（3s 超时、断线重连、reconnecting 状态）/TCP 服务端（监听、新连接替换旧连接）/UDP（绑定+默认对端）；**与串口完全同源**：同一 ingest 入口、同一批事件（rx/tx/state）、sendData 优先走网络（未就绪时**明确报错**"网络连接尚未就绪"，不静默回落）。

### 6.4 解析引擎（parser.rs → 移植 + 14 个单元测试）

- 模板并行状态机（Hunt/Collect，帧头路由互不干扰）；三种截帧：fixedLength/lengthField（offset+size u8|u16+endian+adjust）/footer（可空）；maxLength=64 默认安全上限+重同步。
- **帧头可空**；**识别位**三路兼容（boundary 单/边界列表/字段级 disc），Complete 校验不匹配→静默丢弃不计数。
- 内嵌帧头重同步；fixedLength 禁用数据字节==帧头抢帧（回测用例 wit_back_to_back_stream_with_0x55_data）。
- 校验：sum8/sum16/xor8/crc16_modbus/crc16_ccitt/crc32/sumadd(SC+AC)；coverageEnd 支持负数=距帧尾。
- 字段解码：uint8/16/32/64、int8/16/32/64、float32/64、ascii、bcd、bits、**csv 自适应**（分隔符 split，动态输出 字段#1..#N 上限 64+整串 text）；scale/offsetValue。
- 模板合法性校验：帧头≤8、帧长上限、识别位与帧头重叠、长度字段宽度、字段偏移越界；错误信息**翻成人话**。
- **Rust serde 教训→C++ JSON 教训**：数组字段不接受 null——加载/同步前 sanitize 自愈（null→[]、双胞胎字段去重）。

### 6.5 演示源（demo.rs）

V7(0x01 加速度/0x03 欧拉/0x30 GPS)+WIT(0x51/0x52/0x53)+CSV 文本流多路混合；约 3~5% 坏帧注入；SC=sumadd(0..-2)+AC=SC+0xAA；用于无设备体验全链路。

### 6.6 文件（files.rs）

saveText/readText/readBinary/saveBinary/listLocalAddrs/hexSearch（环形缓冲搜索，上限 500）。

## 7. 数据模型与格式兼容

### 7.1 协议模板（vs.rules，250ms 防抖同步引擎）

```
FrameTemplate{id,name,color,enabled,boundary,checksum|null,fields[],presetKey?,groupKey?}
Boundary{mode:fixedLength|lengthField|footer, headerBytes[≤8可空], fixedLength?|
         lengthOffset+lengthSize(u8|u16)+lengthEndian+lengthAdjust|footerBytes(可空),
         maxLength=64, discOffset?+discValue?}
FieldDef{id,name,role,offset,type(11种+csv),endian,scale?,offsetValue?,unit?,color,bits?,disc?,locked?,csvDelim?,csvType?}
```
分组键归一：presetKey→groupKey→旧名族；簇名注册表 vs.grps。**未知字段必须忽略**（向前兼容）。

### 7.2 其他持久化键（vs.* → QSettings/JSON 映射）

`vs.settings`(theme/locale/zoom/decimals/perfHud/workspace/cellSize) · `vs.controls`(控制页+卡片) · `vs.commands`(命令树) · `vs.userCodecs`(我的协议) · `vs.grps`(簇名) · `vs.attitude`(3D 绑定) · `vs.plotPanelPos`(游标面板位置) · `vs.qkbar.open` · `vs.decimals` · `vs.tplSplit` · `vs.video.raw` · 布局持久化。

### 7.3 JSON 导入导出格式（必须兼容 0.x）

`{kind:"uartix-templates|controls|commands", version:1, data}`；模板导出含簇名 meta；控制画布导入=新建页（同名不重复）；命令库导入=合并（重名组加后缀）。**格尺寸不入导出文件**（导出格数坐标）。

### 7.4 自动更新

endpoint 固定：`https://github.com/Tanixs/uartix-plus/releases/latest/download/latest.json`（ platforms→签名安装包 URL）；minisign 公钥内置；检查→下载→校验→静默安装→重启。

## 8. 性能红线与验收标准

1. **38 万帧持续灌入不卡不丢**（归档池水位线回收；禁止逐条 shift/前插）。
2. 2D 曲线：视窗裁剪喂数+峰谷抽稀+增量合并，tick 主线程成本 ≤2ms 量级；面板不可见跳渲染。
3. 3D：30fps 限帧；不可见跳渲染。
4. 控制台：批量直写+块上限+大块二进制摘要。
5. 表格：虚拟列表+150ms 批 flush；后台页签停止渲染仅缓冲。
6. 面板关闭=停采集；隐藏面板降级。
7. 高频收流时**壳层（标题栏/工具栏/状态栏）不得被拖动重渲染**（源码：App 仅计数器 200ms 降频重渲染；Qt 中状态栏计数用独立 widget 定时刷新）。
8. 所有命令/设备枚举不得阻塞 UI 线程。
9. 验收工具：内置 PerfHud（FPS/长任务/重绘计数）。

## 9. 复刻里程碑建议

| 里程碑 | 内容 |
|---|---|
| R1 | 壳：无边框窗口/标题栏/工具栏/状态栏/停靠系统/主题/i18n/设置窗口/串口开关收发/控制台 |
| R2 | 解析引擎+环形缓冲+演示源（含全部单测移植）/Hex 数据流/帧画布/协议模板侧栏/属性面板 |
| R3 | 数据表格/2D 曲线（数据层先行：独立通道+归并+抽稀；再交互：跟随/冻结/游标/堆叠） |
| R4 | 控制画布 9 控件+网格拖放+脚本+命令库+快捷指令+变量系统 |
| R5 | 指令工厂+我的协议/3D 姿态/图传/键盘遥控 |
| R6 | 网络 TCP/UDP+断联自愈+录制/导入导出/自动更新/打包签名 |

每里程碑按"用户实测反馈→根因修复→再交付"节奏（本项目 31 轮迭代的成功模式）。

## 附录 A：协议预设（presetKey → 组名）

- `v7` 匿名 V7：22 帧型全 enabled，帧头 [0xAB 0x05 0x5A b'\x02'=功能码识别]，SC+AC。
- `wit` 维特 WIT：10 帧型（0x51~0x5A），fixedLength=11，帧头 [0x55]+TYPE 识别位@1，sum8 cover 0..-1；字段缩放（0x51 ×16/32768 g+温度、0x52 ×2000/32768 °/s+电压、0x53 ×180/32768°、0x56 气压高度、0x57 ×1e-7°、0x59 四元数 ÷32768 等）。
- `modbus` Modbus RTU、`nmea` NMEA-0183、`csv` 自适应文本帧（header=[]、footer=[0x0A]、csv 字段）。
- 完整定义：`src/features/framecanvas/presets.ts`（复刻时逐字段照搬，含单位与 scale）。

## 附录 B：校验算法

sum8/sum16/xor8（逐字节）/crc16_modbus（poly 0xA001 init 0xFFFF refin/refout true xorout 0）/crc16_ccitt_false（poly 0x1021 init 0xFFFF）/crc16_x25（init 0xFFFF xorout 0xFFFF）/crc32/sumadd（SC=逐字节和截断 8 位，AC=(SC+0xAA)&0xFF）——coverageEnd 负数=距帧尾倒数。

## 附录 C：脚本 API（QJSEngine 注入）

`send(text)` 发送（支持模板插值）· `beep(freq,ms,volume=0.08)` · `delay_ms(ms)`（同步阻塞脚本协程）· `get(变量名)` · `set(变量,值)` · `log(text)` → 控制台 [脚本] 行 · `await waitParse(字段,ms=5000)` 超时抛错 · `setControl(控件名,值)` · `await repeat(n,i=>…)` · 变量插值规则：`{Name}`、`{Name:.2f}`、`{Name:str}`、`{Name:d}`；完整 JS 语法可用（QJSEngine 原生支持）。

## 附录 D：默认值速查

窗口 1440×900/min 1100×700 · 主题亮色 · 缩放 100% · 语言中文 · 小数位 2 · 格尺寸 60 · maxLength 64 · 簇上限 64 · MAX_POINTS 30000 · FED_CAP 16000 · 撤销 50 层 · 控制台 400 块 · 摘要阈值 512B/头部 64B · JPEG 单帧上限 2MB/缓冲 8MB/缩略图 12 帧 · 命令搜索 500 命中 · 网格默认 12×12。
