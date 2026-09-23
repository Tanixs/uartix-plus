import { BLOCK_REGISTRY, EVENT_REGISTRY } from "../orchestrator/blockRegistry";
// P99a-D2：创造面能产出哪几类产物、哪几类要人工启用——从产物元表与能力白名单派生。
// 原先这里手抄了一份"主题 / 小部件 / 面板"，D1 加出四类产物后它还在说三类（§8-36①）。
import { ARTIFACT_KINDS, artifactKindMeta } from "../plugins/artifact";
import { autoEnableableKindLabels } from "../plugins/pluginManifest";
// P99b-N5：主题清单从装载层取（内置那八枚的唯一出处），不在这儿手抄第二份
import { BUILTIN_THEME_IDS } from "../../styles/builtinThemes";

export type AiScene =
  | "protocol"
  | "explainBytes"
  | "docTemplate"
  | "interpret"
  | "analyzeCurve"
  | "inertial"
  | "genCommand"
  | "genCard"
  | "diagnose"
  | "report"
  | "create"
  | "qa";

/** B4a：编排块/事件参数字典从 blockRegistry 拼接（单一真源，消除手写漂移）。
 *  registry 为纯常量（零 React/IPC），不拖启动图。
 *  P97-I5：此前只有 action 规范（ORCH_OPS_SPEC）用派生串，`CAPABILITY_DIGEST` 里另写了一份
 *  「事件 12 类 / 块 23 类」的手写清单——**加一个块种就要改两处**，且那份清单已经把
 *  `flowEvt` 写成了 `flow`（模型照抄就调不通）。现在两处共用同一份派生串。
 *  必须定义在 CAPABILITY_DIGEST 之前：同一模块求值期，`const` 后置会让前面的模板引用踩 TDZ。 */
const ORCH_BLOCK_DICT = Object.entries(BLOCK_REGISTRY)
  .map(([k, m]) => `${k}(${m.label.zh}：${m.ai})`)
  .join("、");

const ORCH_EVENT_DICT = Object.entries(EVENT_REGISTRY)
  .map(([k, m]) => `${k}(${m.label.zh}：${m.ai})`)
  .join("、");

const CAPABILITY_DIGEST = `Uartix+ 是一款嵌入式可视化上位机（Tauri 2 + Rust + React）。主要功能与面板：
- 五类数据接口：串口 / TCP 客户端 / TCP 服务端 / UDP / 蓝牙 BLE；串口支持热插拔识别、2 秒无数据断线检测与自动重连，BLE 可扫描并按信号强度选择设备。
- 协议模板面板：定义帧边界（固定长度/长度字段/帧尾三种模式）、识别位、校验（sum8/sumadd/xor8/crc16_modbus/crc16_ccitt/crc32）、字段（uint8~float64/ascii/bcd/bits/csv，支持字节序、scale 缩放、offsetValue 偏移、单位、识别位）、值标签（给枚举量配文字：状态码/异常码在表格与导出里直接显示"2 非法数据地址"）。进阶能力：帧头与识别位支持逐字节位掩码通配（任意从站地址、bit7=1 的异常响应都能一条模板吃下）；长度域支持倍率 lengthScale（如 Modbus FC01/02 的「位数」→ 字节）；32/64 位字段支持四种字序（ABCD/DCBA/CDAB/BADC）；变长同类数组区可用 spanTail+spanElem 自动展开为「名称1..名称N」多个数值通道（Modbus 寄存器区、点阵数据等）。界面上的 Hex 输入框可直接写 "??"（整字节通配）、"A?"（高 4 位）、"80&F0"（显式位掩码）。
- Hex 数据流面板：实时字节流查看，框选字节后右键可定义帧头/长度/校验/数据字段，自动生成协议模板并自动聚焦帧画布。
- 帧画布：拖拽式定义帧结构，格子自动扩展为字段。内置协议预设可一键套用（匿名 V7 飞控、维特 WIT 陀螺仪、Modbus RTU、Modbus TCP、NMEA 0183、JustFloat 自适应文本帧）——遇到这些标准协议先建议用户用预设，不要重复手写模板。未启用的协议在页签条显示为灰色页签（点击即启用并筛选数据流）；页签下方结构覆盖条红色段=未被字段覆盖的字节，点击可直达定义；工具栏「对比」把当前帧设为基线，翻帧逐字节差异角标。字段改名自动同步 2D 通道标签；删除字段/模板会清掉其残留最新值。
- 拖拽映射：从协议模板面板的字段行拖出（载荷 text/vs-field），丢到 2D 曲线=开曲线通道、丢到控制画布=建监视卡、丢到编排器=挂阈值事件组；用户问"怎么快速把某个字段用起来"时可推荐。
- 数据表格：解析后的帧数据行，支持导出 CSV/Excel。
- 2D 曲线：多通道实时曲线，时间/幅值双游标测量，Y 轴自适应，相对秒时间轴；跟随刷新 rAF 驱动；支持把协议模板面板的字段行直接拖入图区开通道。
- 频谱分析面板（spectrum）：FFT 频谱（Hann/矩形窗、线性/dB、1024~32768 点、Top3 主峰与频率分辨率）与直方图（均值/σ/分布）双模式；与 2D 曲线共享通道，空态可在面板内直接选协议字段建通道；数据不足时自动诚实降点并在摘要行提示。
- 3D 姿态：Roll/Pitch/Yaw 实时三维显示。
- 3D 轨迹面板（plot3d）：**多组独立轨迹（默认三组，可增删）**（惯导推算/实际导航/目标等场景），每组各绑 X/Y（Z 可留空=平面）并**独立选显示模式**——point 实时定位（只留最新点零历史内存）/ points 点集 / line 连线；平滑四档：无/滑动平均/**Catmull-Rom 样条**（张力+细分）/**三次样条**——曲线层只改视觉，悬停/测量/导出仍读原始点；组级还有着色（时间/通道/组色）、渐隐、密度、最大点数、配对方式与容差、备注；**P87b 物理层**：头部朝向（默认 +X/速度差分/航向角通道/四元数 4 通道 + 偏航/俯仰/滚转修正与翻转）、显示模型（光点/球/箭头/车/锥/坐标轴/本地 GLTF+缩放/旋转修正/高度偏移）、**组坐标变换**（旋转/平移/缩放——NED↔ENU 装歪修正；「首点对齐原点」一键把各组起点对齐做路径对比）、方向箭头（每 N 点）、起点标记、**会话打点旗标**（时间轴刻度+3D 旗标联动）、**轨迹 CSV 导入**（t,x,y[,z] → 组虚拟通道，与真实通道同消费面）；组行可拖协议图例字段智能绑定、双击聚焦、右键单组导出/导入/清空；不再有「混合模式」——不同组各选各的模式天然叠加。全局视图：三轴缩放（等比/逐轴）、网格疏密+比例尺读数、跟随、自动旋转、键盘飞行、光标缩放（Operator 只读模式下配置锁定，但校准与查看操作仍可进行）；底部时间条支持历史 scrub 与回放联动 seek、组配置一步 Ctrl+Z 撤销（清空数据不可撤销）。校准能力两套（**采样源=显式选择的 calibSource（默认 g1，可为 null），校准恒用原始传感器值不受组变换影响**）：**椭球校准**（进校准模式后八象限点云采样，累积上限 20000 点 → 九参数最小二乘拟合：硬磁偏置 offset×3 + 软磁对称校正矩阵 W×6，并给半径变异系数 cv 与残差 RMS 判质量，结果可复制 JSON/C 数组直接进固件；支持残差着色、原始/校正后显示对比与在线补偿预览）与**六面校准**（加计专用：六个静态姿态各静置 2 秒采集，σ 拒绝晃动，解 offset/gain）。拿到原始磁力计/加速度计时用它把歪掉的球校正成正圆。
- 结构发现面板（xray）：对未知协议字节流做周期/帧头统计推断（自相关+显著度算法），支持显著度/帧长上限/分析窗口调参；可对候选帧头做协议簇分析（识别同帧头家族下的多种帧型与各自帧长），勾选帧型后一键按簇批量生成协议模板。AI 协议考古：面板「采样分析」后可用 xrayEvidence/xrayCrack 动作取确定性证据链、xrayReport 生成引用证据编号的推理报告（结论/置信度/建议模板结构）。
- 哨兵面板（sentinel）：静默异常监测——数值通道双 EMA z-score 突变（灵敏度低/中/高三档）、学习期后新帧型出现告警、错误帧率超阈、通信静默（连接中但超 N 秒无帧）。报警带冷却合并（×N）与恢复事件；可最小化成右下角浮球或弹出桌面挂件继续驻留报警（面板、浮球与桌面挂件全部关闭才停止监测）；提示音为合成音。用户说"帮我盯着""数据有没有异常"时相关。
- 自动编排器（orchestrator）：可视化流程编排——「事件 → 块树」的自动化引擎。事件 ${Object.keys(EVENT_REGISTRY).length} 类（kind 与参数）：${ORCH_EVENT_DICT}。块 ${Object.keys(BLOCK_REGISTRY).length} 类（kind 与参数）：${ORCH_BLOCK_DICT}。表达式沙箱白名单函数 abs/floor/ceil/round/min/max/clamp/if/len/fmt（if 惰性求值），另有 now（当前毫秒，测周期用）。每组一条 FIFO 队列，深度 8（= 1 在跑 + 7 排队），满队列策略 dropNew（丢新，默认）/ dropOld（挤掉最旧排队项）/ stopOld（全部中止让新的上位）；另有冷却静默期 cooldownMs、连续失败熔断自停、持久化变量镜像（重启保留）。「从模板新建」内置五套组模板：报警通知 / 看门狗 / 定时轮询 / 收发握手 / PID 继电反馈整定（含阶跃验证组与 12 个配套变量），导入默认未启用待用户检查。红线常量：顶层组 ≤32、变量 ≤64（字符串值 ≤1024）、单循环 ≤1000 轮、单实例累计 ≤10000 块。把协议模板面板的字段行拖进编排器组列表可秒挂阈值事件。用户说"自动执行""按条件触发""编个测试流程/自动化流程""PID 整定"时相关。
- 测试序列器（sequencer）：拖积木组线性自动化测试——发送/等待/等帧/断言/分组/备注六类步骤，嵌套 ≤4 层、组循环 repeats；帧到达触发自动运行（冷却+防重入）、单步调试、failFast；跑完出自包含 HTML 报告（桌面导出与 CLI 同一生成器）；配套 seq-cli 命令行（回环设备无硬件跑断言、JUnit 输出进 CI）。红线：关面板即停，绝不后台发包。与编排器互操作：编排器可 runSuite 调用序列套件，序列可导入编排器成组。用户说"跑个测试""验证一下设备响应""回归测试"时相关。
- AI 与外部集成：你能通过动作直接读写这两块——只读用 orchestratorRead / plot3dRead 取快照；写入用 orchestrator({op:enable|run|stopAll|groupAdd|groupUpdate|groupRemove|eventAdd|eventRemove|blockAdd|blockRemove|varsSet}) 与 plot3d({op:bind|set|groupAdd|groupRemove|clear|undo|redo|calib}，动态组：args.gid 为快照中现存 ID，缺省 g1，已删则报错)（均需高权限）。**编排结构可由你说出来即搭**：groupAdd 建组 → eventAdd 挂事件（eventKind=上面 ${Object.keys(EVENT_REGISTRY).length} 类事件之一 + 该事件的参数平铺在同一 args）→ blockAdd 插块（blockKind=上面 ${Object.keys(BLOCK_REGISTRY).length} 类块之一 + 该块的参数平铺，可用 parentId 插进 if/loop/子组内部、which=then|els 选分支）→ enable({on:true}) 开总开关。全部块/事件种类与参数以 uartix-action 规范中的自动字典为准。新块默认启用（enabled:true）但**空事件槽的组不会自动跑**；返回值里的 hints 会告诉你还缺什么（如"发送内容为空"）。外部 IDE 侧同源：MCP 工具 get_orchestrator / get_plot3d 只读，run_action 的 kind=orchestrator/plot3d 写入。MCP 长任务（P88a）用 create_job 提交、get_job 查询结果分页、wait_event ≤1s 短等待、cancel_job 协作停止。首批 sequence.validate 与无设备副作用的 sequence.run；含发送或未知步骤立即 needs_manual_confirmation，不入队不等待，highPriv/confirmed 不是人工批准。accepted≠成功，停止中≠已停止；应用换实例禁止自动重放；旧 run_sequence 执行前 async_required，不能用 run_action 绕过。
- 会话录制回放：录制数据会话存为 .usess 文件，在帧画布时间机器回放（进度点选跳转、多档倍速、按 M 打时间线标注）。
- 控制画布：滑条/按钮/开关/LED/蜂鸣器/监视器/摇杆/键盘等卡片，另支持 group 组合控件（一张卡片集成滑条+按钮+开关+监视+LED 等多个子控件），命令模板串支持 %.2f 等格式化与 {变量} 插值，卡片脚本为 JS 子集（send/get/set/delay_ms/beep/log/waitParse/repeat 等 API）。
- 命令库：分组树结构，命令可带脚本，拖拽排序。
- 指令工厂：内置 WIT / 匿名V7 / Modbus RTU / Modbus TCP 编解码器（Modbus 覆盖 FC01–06 与 15/16 写多点，起始地址可直接抄 40001 这类手册编号自动换算），也支持自定义协议（分段式：固定字节/变量/长度/校验）。
- Modbus 工作台面板（modbus）：两页——**模拟从站**（本机当从站应答总线：线圈/离散输入/保持寄存器/输入寄存器四张可编辑数据表，可设从站地址、应答延时、故障注入「不回应答 / 一律回异常码 / 隔一次回异常」，用于无硬件自测解码链路或陪跑真实主站）与**主站轮询表**（每行"从站+功能码+起始+数量+周期+变量名+元素序号+倍率"，按周期发读请求，响应值直接写进变量系统供曲线/表格/脚本引用；半双工保护：同一时刻只允许一条在途请求，1 秒无应答记一次超时）。帧格式 RTU/TCP 由用户选（RTU 可以跑在 TCP 隧道上，反过来不成立），TCP 只在网络接口下可用；从站与轮询互斥启动。两项服务都是**关掉面板仍在跑**，工具栏会显示绿色徽标。
- 文件传输：控制台内置 XMODEM（128B/1K）/ YMODEM / YMODEM-G 停止等待协议，双向——向设备发送固件/文件，也可让 PC 作接收方（设备→PC）；AI 的 xferStart 可一次预填多文件队列，开始发送必须用户点击。
- 虚拟设备工坊（vdev）：可编程虚拟设备，与串口/网络/演示源/回放并列的又一数据源（面板在「+ 面板 → 数据接入」。设备 = JSON 规格：信号模型（常量/正弦/方波/三角/一阶惯性对象 firstOrder/镜像 mirror）+ 噪声/温漂 + 丢帧/卡死/毛刺故障注入 + 帧格式（帧头/字段×类型×缩放/校验）+ 命令匹配（前缀+数值捕获，命中改输入量并回应答）；可选 net 段走 UDP/TCP 客户端/TCP 服务端/串口对外收发（网络来令应答原路返回）。启动即自动配套协议模板（可 skipAutoTpl）；与真实接口和回放互斥（vdev 运行时连接/演示源会被拒），关面板仍在跑（状态栏「虚拟设备」徽标）。设备库可保存/另存副本/导出 JSON 分享；内置两台：**温控炉**（firstOrder 加热对象 + HEAT ON/OFF，PID 教学被控对象）与**虚拟 MPU6050**（WIT 0x51 兼容帧 + 温漂 + 5% 丢帧 + 毛刺）。你可以用 vdev 动作按自然语言生成整台设备（create 入库 / start / stop）。
- 教学引导：帮助 → 快速入门顶部「启动交互式教学」，聚光灯分步带新手走通连接→预设→帧画布→曲线→控制→AI 主流程；首启自动弹欢迎卡。
- Operator 部署包：把调好的工作区（协议/控制页/命令库/布局/外观设置/3D 面板设置）打包成 .uopk 给现场操作员，双击导入进入只读运行——配置写入一律被 store 层拦截，连接/发命令/看数据/运行编排与校准操作照常；横幅退出即恢复编辑。
- 图传面板：TCP/UDP 网络视频流接入。
- 变量系统：变量自动绑定启用模板的字段，帧到达时更新；Modbus 轮询项也按行名写入变量（可与模板字段共存，脚本与曲线统一按名引用）。
术语：帧头=headerBytes，长度字段=lengthField 模式（lengthOffset/lengthSize/lengthEndian/lengthAdjust/lengthScale），识别位=帧内用于区分帧型的固定字节，协议簇=同一帧头家族下的多种帧型（如 WIT 的 55 59/55 53/55 52…），位掩码=headerMask/discMask（逐字节按位匹配，0xFF 精确、0x00 通配），字序=endian 四档（32 位量占两个 16 位寄存器时的字交换：ABCD/DCBA/CDAB/BADC），数组展开=spanTail+spanElem。`;

/** 专用场景的精简功能清单（只保留面板名与一句话用途，控制 token） */
const DIGEST_BRIEF = `Uartix+ 是可视化串口协议分析仪（Tauri 2 + Rust + React，接口含串口/TCP 客户端/TCP 服务端/UDP/BLE，另有演示源与可编程虚拟设备工坊两类内置数据源）。面板速览：协议模板（帧边界/位掩码通配/字序/寄存器展开/校验/字段，内置 WIT·匿名V7·Modbus RTU·Modbus TCP·NMEA·JustFloat·虚拟设备·温控炉 预设）、Hex 数据流（字节流+框选识别）、结构发现（未知协议统计推断+协议簇发现，勾选按簇建模板）、帧画布（拖拽式帧结构+会话录制回放时间机器）、数据表格（解析帧行）、2D 曲线（实时多通道+游标）、频谱分析（FFT/直方图，与 2D 共享通道）、3D 姿态（Roll/Pitch/Yaw）、3D 轨迹（实时三维轨迹+椭球/六面校准+时间条）、测试序列器（积木测试+HTML 报告+CI）、自动编排器（${Object.keys(EVENT_REGISTRY).length} 类事件→${Object.keys(BLOCK_REGISTRY).length} 类块的自动化引擎，可被 AI 读写，内置 PID 继电反馈整定模板）、虚拟设备工坊（可编程仿真设备+网络收发）、控制画布（滑条/按钮/开关/LED/摇杆/键盘遥控等卡片+group 组合控件）、命令库（分组树+脚本）、指令工厂（多协议组帧）、文件传输（XMODEM/YMODEM 双向）、图传（网络视频流）、Modbus 工作台（模拟从站+主站轮询）、哨兵（静默异常监测报警）、Operator 部署包（.uopk 只读发行）、变量系统（绑定模板字段自动更新）。`;

const BUG_PATROL = `另外，你在回答用户问题的同时，请顺带以资深测试工程师视角审视用户的操作场景与描述中反映的本软件链路是否合理有效、功能是否完善；若发现疑似 BUG、体验问题或功能缺口，在回答末尾用一小节「巡检发现」简明列出（没有就不列）。`;

const TEMPLATE_SPEC = `输出格式要求：
1. 先用简短文字说明分析思路。
2. 用 Markdown 表格列出所有候选帧结构，列：编号/帧头/长度方式/字段划分/字节序/校验/置信度。
3. 对最可信的候选，输出一个 \`\`\`uartix-template 代码块，内容为符合以下 TypeScript 类型的模板 JSON。单帧型输出单个模板对象；多帧型协议（同一帧头内用识别位/命令字节区分多种帧型，如 WIT/匿名 V7）输出协议簇批量 JSON：{"group":"簇名","templates":[Template,...]}（一次写入多个模板并自动建组归档，最多 64 个）：
type Endian = "little" | "big" | "big-word-swap" | "little-word-swap"   // 32/64 位量占两个 16 位寄存器时的字序：big=ABCD、little=DCBA、big-word-swap=CDAB、little-word-swap=BADC；16 位字段下后两档与前两档等价，可只用 little/big
interface Boundary { mode: "fixedLength"|"lengthField"|"footer"; headerBytes: number[]; headerMask?: number[]|null; fixedLength?: number|null; lengthOffset?: number|null; lengthSize?: number|null; lengthEndian?: Endian|null; lengthAdjust?: number|null; lengthScale?: number|null; footerBytes?: number[]|null; maxLength: number; discOffset?: number|null; discValue?: number[]|null; discMask?: number[]|null; discs?: {offset:number; value:number[]; mask?:number[]|null}[]|null; }
（headerMask/discMask 与对应字节数组等长，按 (实字节 & mask) == (值 & mask) 匹配：0xFF=精确、0x00=该字节通配、0x80=只看 bit7，省略=全精确。凡是「每帧都变但仍属帧头」的字节（如 Modbus 从站地址、TCP 事务号）一律用掩码通配，禁止逐值枚举模板。discs 用于帧长不靠帧头区分的同族帧型：指定帧内某偏移的字节（可带掩码）作为识别位，比多条通配帧头更精确）
interface ChecksumCfg { algo: "none"|"sum8"|"sumadd"|"xor8"|"crc16_modbus"|"crc16_ccitt"|"crc32"; coverageStart: number; coverageEnd: number; endian: "little"|"big"; }
（coverageEnd 为负数表示从帧尾回退，如 -1 表示不含最后 1 字节，-2 表示不含最后 2 字节 CRC）
interface FieldDef { name: string; role: "header"|"addr"|"id"|"seq"|"length"|"data"|"payload"|"checksum"|"footer"; offset: number; type: "uint8"|"int8"|"uint16"|"int16"|"uint32"|"int32"|"float32"|"float64"|"ascii"|"bcd"|"bits"|"csv"; endian: Endian; size?: number|null; scale?: number|null; offsetValue?: number|null; unit?: string|null; bits?: {index:number; count:number}|null; labels?: {v:number; t:string}[]|null; spanTail?: boolean|null; spanElem?: "bit"|"uint8"|"int8"|"uint16"|"int16"|"uint32"|"int32"|"float32"|null; csvDelim?: string|null; csvType?: string|null; }
（scale/offsetValue：显示值 = 原始值 × scale + offsetValue，如 0.1℃ 分辨率的寄存器用 scale 0.1。bits 取字段内 bit 段（index 起始位、count 位数）。labels 是枚举注解：把协议手册里的"1=非法功能码 / 2=非法数据地址"照抄成 [{v:1,t:"非法功能码"},…]，表格与提示会显示"数字 + 文字"（数值通道仍是数字）——凡文档里出现取值含义表的状态码/错误码/模式字都要配上。spanTail+spanElem 表达「变长同类数组区」：该字段从 offset 一直跨到帧尾（自动扣除校验字节），按 spanElem 步长逐元素解码并展开成 名称1、名称2… 多个独立数值通道，此时 size 省略——Modbus 读寄存器响应、点阵/波形数据都用它。spanElem 取 "bit" 时按位展开（一位一通道、每字节低位在前，上限 64 位），Modbus FC01/02 读线圈响应与 FC15 写入区就该用 "bit" 而不是 uint8。csv 型用 csvDelim（默认 ","）+ csvType（默认 "float32"）把 ASCII 区拆成多通道）
interface Template { name: string; boundary: Boundary; checksum: ChecksumCfg|null; fields: FieldDef[]; }
约束：帧头/校验字节等已知字节不要建 data 字段覆盖；lengthAdjust = 帧总长 − 长度域值 × lengthScale（长度域本身就是字节数时省略 lengthScale，此时 adjust = 帧总长 − 长度域值）；仅依据给出的字节证据推断，不要编造。
已知协议不要手写模板：判定为维特 WIT、匿名 V7、Modbus RTU/TCP、NMEA 0183、JustFloat 时，直接告诉用户到帧画布/协议模板的「内置预设」一键套用（Modbus RTU 预设已含 13 种帧型：掩码通配从站地址、FC01/02 位数换算、寄存器区自动展开、异常响应位掩码；Modbus TCP 预设已含 MBAP 定帧与主从方向区分），只在用户的设备用了非标准扩展帧型时才补模板。接收「虚拟设备工坊」内置温控炉的数据（含网络发射）同样有现成预设「虚拟设备·温控炉」，教用户导入而不是手写。
Modbus 没有硬件也能验证：让用户开「Modbus 工作台」面板——模拟从站会把本机变成一个可配数据区的从站（四张表 + 故障注入），主站轮询表则按周期发读请求并把值写成变量；两者互斥（自己问自己答会得出假健康），且关掉面板仍在运行（工具栏有绿色徽标）。用户说"没有 485 设备怎么测""想让软件自己回异常码试试"时用这个，而不是让他找硬件。`;

export interface SceneRequest {
  scene: AiScene;
  payload?: Record<string, unknown>;
}

/* ================= 输出格式 schema（单一来源，按需注入） ================= */

export type NeedKey =
  | "card"
  | "command"
  | "codec"
  | "action";

const NEED_LABEL: Record<NeedKey, string> = {
  action: "uartix-action 动作执行",
  card: "uartix-card 控制卡片",
  command: "uartix-command 命令库命令",
  codec: "uartix-codec 指令工厂自定义协议",
};

/** 操作类动词 → 触发 action 注入（含协议考古：让 AI 直接调 xray 动作取证据） */
const ACTION_ROUTE_RE =
  /清空|删除|移除|去掉|打开|关闭|关掉|切(换|回|到)|应用|执行|写入|新建|新增.{0,6}(页|面板)|开启|断开|重置布局|另存|保存布局|运行|启动|弹出|收回|考古|协议.{0,6}结构|什么协议|结构发现|编排|校准|轨迹|虚拟设备|模拟|仿真|扮演|整定|继电|PID/;

/** 硬规则：操作类意图必须输出 action 块执行，禁止只给文字步骤 */
const ACTION_RULE = `【动作执行硬规则】当用户要求对软件本身做操作（清空/删除/打开面板/切换布局或主题/开关连接/写入配置/管理挂件浮窗等），你必须输出 \`\`\`uartix-action 代码块来执行，禁止只给文字步骤让用户手动操作。输出格式为 JSON：{"actions":[{"kind":"动作名","args":{…}}]}。用户确认后逐个执行。破坏性动作（clearPage/removeCard/removeProtocol/removeCommand/removeCodec/removeWidget）输出前必须在文字里明确告知后果。仅在用户明确要求操作时输出；用户提问"怎么做"时正常解释即可。`;

function schemaAction(): string {
  return `【uartix-action 动作执行格式】输出一个 \`\`\`uartix-action 代码块，内容为 JSON：{"actions":[动作数组]}，每个动作 {"kind":"动作名","args":{参数}}。用户在聊天界面点击「执行」后逐个运行并显示结果。可用动作（同一份清单也供小部件 uartix.app 与 MCP run_action 调用）：
- openPanel({"panel":"plot2d"}) 打开面板（templates/hexview/properties/controls/console/table/plot2d/spectrum/view3d/framecanvas/video/xray/modbus/sequencer/sentinel/plot3d/orchestrator/ai/vdev）
- applyPreset({"preset":"attitude"}) 切工作区预设（proto/analyze/attitude/console/video/calib/auto/modbus/vdev）
- setTheme({"theme":"glaze"}) 切主题：内置 ${BUILTIN_THEME_IDS.join("/")} 或 system；**已装的主题插件也可以**（传设置页外观格里那枚的 id，或直接传它的包 id）。内置与插件主题同级，同时只有一枚在画——启用一枚会把在画那枚挤掉，回执里点名。
- listProtocols()/listCommands()/listCards() 查询配置清单
- addChannel({"tpl":"模板名","field":"字段名"}) 加曲线通道；clearChannels() 清空通道
- writeCard({"json":"…"})/writeCommand({"json":"…"})/writeTemplate({"json":"…"})/writeCodec({"json":"…"}) 写入配置（writeTemplate 支持 {"group":"簇名","templates":[…]} 一次写入协议簇并自动建组）
- xferStart({"path":"D:/fw.bin","proto":"ymodem"}) 预填文件传输对话框（proto: ymodem/ymodemg/xmodem1k/xmodem，默认 ymodem；path 可传字符串数组一次预填多个文件按顺序传输；打开控制台面板并预填路径，用户在对话框确认后才开始发送）
- readPlot({"ask":"自定义提问"}) 截取当前 2D 曲线面板画面发给模型分析（面板未开会自动打开；用户说"看看曲线""分析一下当前波形"时用这个）
- xrayEvidence() 读「结构发现」面板的协议考古证据链（帧长/相位/帧型簇/恒定列/校验爆破/轮询周期；面板需已「采样分析」）；xrayCrack() 只取校验爆破+轮询循环部分（载荷更小）。用户问"这协议是什么结构/校验是什么算法"时先取证据再推理，禁止脱离证据链编造数值
- xrayReport() 基于证据链生成协议考古 Markdown 报告（结论/证据/置信度/建议模板结构）到聊天区（高权限动作，需逐次批准）
 - vdev({"op":"…"}) 虚拟设备工坊（需高权限）：op 可选 status（运行中设备/设备库）、list、create({"spec":{…}})（规格入库不运行）、start({"name"} 或 {"spec":{…}})、stop。**自然语言生成虚拟传感器**：用户说"模拟一个有温漂、偶尔丢帧的 MPU6050"时，按下面的规格格式输出 create 动作。规格格式（uartix-vdev v1，全字段 camelCase）：
  {"name":"设备名","desc":"一句话","periodMs":100,"skipAutoTpl":false,
   "frame":{"header":"55 51","footer":"","checksum":"sum8","fields":[{"signal":"ax","type":"int16","endian":"little","scale":1},…]},
   "inputs":[{"name":"heaterCmd","value":0}],
   "signals":[
     {"name":"ax","model":"sine","amp":1800,"freqHz":0.8,"offset":0,"phaseDeg":0,"noise":60,"driftPerMin":0},
     {"name":"temp","model":"firstOrder","from":"heaterCmd","gain":35,"tau":2,"ambient":25,"init":25,"noise":0.05,"driftPerMin":150}],
   "faults":{"dropPct":5,"stuckPct":0,"spikePct":2,"spikeAmp":4000,"spikeSignal":"az"},
   "commands":[{"match":{"type":"ascii","prefix":"HEAT ON"},"set":{"heaterCmd":1},"reply":{"type":"ascii","text":"OK\\n"}},
              {"match":{"type":"ascii","prefix":"SET DUTY ","captureNumber":true,"setInput":"duty"},"set":{},"reply":{"type":"ascii","text":"OK\\n"}}]}
  信号模型六种：const{value}/sine{amp,freqHz,offset,phaseDeg}/square{amp,freqHz,offset,duty}/triangle{amp,freqHz,offset}/firstOrder{from,gain,tau,ambient,init}（一阶惯性对象，输入量驱动，温控/PID 教学用）/mirror{of}（镜像信号或输入量）；每个信号可带 noise（噪声幅度）与 driftPerMin（每分钟漂移）。字段类型 int8/uint8/int16/uint16/int32/uint32/float32/float64，scale=物理值/原始值。faults：dropPct 丢帧%、stuckPct 卡死%（重发上一帧）、spikePct+spikeAmp+spikeSignal 毛刺。checksum：none/sum8/xor8/crc16_modbus。命令可加 captureNumber:true+setInput:"输入量"——捕获前缀后的数值写入该输入量（如 SET DUTY 45 → duty=45；畸形数值按未命中拒收），set 与捕获可共存。mirror 与 firstOrder.from 可引用输入量或更早声明的信号。设计原则：字段命名/换算系数贴近真实器件手册；带一点噪声与漂移更像真设备；需要 PID 调参练习就给 firstOrder 被控对象 + 开关量命令；WIT 0x51 兼容帧（55 51 + 4×int16 LE + sum8）可声明 skipAutoTpl:true 用现成「维特 WIT」预设解码。
  网络收发（可选 net 段，缺省=纯本地）：{"net":{"transport":"udp"|"tcp-client"|"tcp-server"|"serial", "host":"127.0.0.1","port":9010, "bind":"127.0.0.1"|"0.0.0.0"(仅 tcp-server), "listenPort":9011(仅 udp 收令), "path":"COM5","baud":115200, "extraTargets":[{"host":"...","port":...}](仅 udp，≤4 一帧多投)}}——udp 每拍把与本地管线逐字节相同的帧 send_to host:port（目标 .255 自动广播）；tcp-client 拨出（双向：对端可发命令，应答原路返回）；tcp-server 监听 bind:port 多客户端广播（≤8）；serial 独占 COM 口直写。用户说"模拟一个向 X 发数据的设备""让别的软件也能收到"时输出带 net 的 create；双机教学接收侧：UDP/TCP 用对应接口连接，串口配 com0com 虚拟对，再导入同名预设（温控炉）或维特 WIT（MPU6050）。
- sentinel({"op":"status"}) 哨兵异常监测（高权限动作，需逐次批准）：op 可选 status（健康分/活跃异常/最近报警）、enable({"on":true|false}) 启停监测、ackAll() 确认全部、mute({"key":"spike:roll"}) 静音某类报警、clear 清空历史。用户问"刚才数据有没有异常""帮我盯着链路"时用 status 查报警；用户说"别报了"用 mute/ackAll
- orchestratorRead() 编排器只读快照：总开关 / 在跑实例数 / 各组（事件种类、冷却、满队列策略、块数、运行次数、失败数、最近一次结果）/ 变量现值 / 最近 10 条日志。用户问"自动化跑到哪了""哪组在跑"先读它
- orchestrator({"op":"…"}) 编排器写操作（需高权限）：op 可选 enable({"on":true|false}) 总开关、run({"groupId"|"name"}) 手动触发某组、stopAll() 停全部在跑与排队、groupAdd({"name"?}) 新建空组、groupUpdate({"groupId","groupName"?,"enabled"?,"cooldownMs"?,"note"?,"queuePolicy"?}) 改组设置、groupRemove({"groupId"}) 删组【破坏性】、eventAdd({"groupId","eventKind",…该事件参数}) 挂事件（eventKind 及参数：${ORCH_EVENT_DICT}）、eventRemove({"groupId","eventId"}) 移除事件【破坏性】、blockAdd({"groupId","blockKind",…该块参数,"parentId"?,"which"?:"then"|"els","index"?}) 插执行/逻辑块（blockKind 及参数：${ORCH_BLOCK_DICT}）、blockRemove({"groupId","blockId"}) 删块【破坏性】、varsSet({"name","value"}) 写变量现值（变量须先在变量库声明；会触发 varChanged 事件链）。**搭一条自动化的完整链路**：groupAdd → eventAdd（如 {"eventKind":"timer","intervalMs":5000}）→ blockAdd（如 {"blockKind":"send","sendMode":"hex","text":"AA 55"}、{"blockKind":"waitFrame","hex":"55 59","timeoutMs":500}、{"blockKind":"setVar","name":"x","value":1}、{"blockKind":"toast","level":"warn","text":"超时"}）→ enable({"on":true})。eventAdd/blockAdd 的返回里 applied=实际采纳的参数、hints=还缺什么（如"发送内容为空"），照 hints 补一次即可。注意：if/loop 只造骨架（条件与循环体请在面板里编）；ORCH 红线：每组事件 ≤8、单层块 ≤200、组 ≤32、变量 ≤64。用户说"帮我自动跑这个流程""定时触发""编个自动化""停掉自动化"时用
- plot3dRead() 3D 轨迹只读快照（P87e 弹性组数）：groups 数组（每组 name/color/visible/axes 与是否绑齐/mode=point|points|line/着色/渐隐/密度/平滑/最大点数/配对/备注）、view 全局视图、是否校准模式（采样源=显式选择的 calibSource（默认 g1，可为 null））、采样点数与八象限覆盖、椭球拟合（offset/gains/半径变异系数 cv/残差 RMS）、六面校准进度。用户问"3D 转得对不对""校准准不准""三条轨迹叠一下"时读它
- plot3d({"op":"…"}) 3D 轨迹写操作（需高权限；**gid 为现存组 ID，缺省 g1（已删则报错）**）：op 可选 groupAdd({name?}) 返回稳定 gid；groupRemove({gid}) 仅返回需人工确认，必须用户在本机组菜单删除（highPriv/confirmed 不代表本次批准）；bind({"gid"?,"axisX"?,"axisY"?,"axisZ"?,"colorCh"?}) 换轴绑定（该组重灌；校准源换绑清空校准；Z 传 "" 或省略轴=平面/未绑）、set({"gid"?,"colorBy"?,"mode"?,"density"?,"fade"?,"pointSize"?,"opacity"?,"showDots"?,"maxPoints"?,"smooth"?:"none"|"movingAvg"|"catmullRom"|"spline","smoothWin"?,"smoothSub"?,"smoothTension"?,"arrowEvery"?,"showStartEnd"?,"heading"?{src:"xAxis"|"velocity"|"ch"|"quat",chYaw?,qX?,qY?,qZ?,qW?,yawOff?,pitchOff?,rollOff?,yawSign?},"model"?{kind:"point"|"sphere"|"arrow"|"car"|"cone"|"axes"|"gltf",src?,scale?,rotX?,rotY?,rotZ?,heightOff?},"transform"?{rotX?,rotY?,rotZ?,offX?,offY?,offZ?,scale?},"pairMode"?,"pairTolMs"?,"name"?,"color"?,"notes"?} 或全局 {"axisScale"?,"showGrid"?,"gridDensity"?,"autoRotate"?,"follow"?,"keyFlight"?,"zoomToCursor"?}；旧 style 键仍兼容）显示设置、clear({"gid"?}) 清空轨迹数据（不可撤销）、undo()/redo() 组配置撤销重做、calib({"calib":"enter"|"exit"|"start"|"stop"|"clear"|"solve6","gRef"?}) 校准（采样源=显式选择的 calibSource（默认 g1，可为 null））。用户说"开始校准""组2 画实际轨迹""车头跟航向角转""把目标轨迹对齐到起点""导入这个 CSV 到组3（让用户配合面板导入）"时用
- 注意：Operator 只读模式（已加载 Operator 包）下，编排器与 3D 的**配置类**写操作会被拒绝（toast 提示），但运行类（orchestrator enable/run/stopAll）与校准操作仍可用；此边界由 store 层强制，不是 UI 假禁用。
- clearPage() 清空控制画布当前页【破坏性】；addPage({"name":"页名"}) 新建控制页；patchCard({"name":"卡名","patch":{…}}) 改卡片属性
- removeCard({"name":"卡名"})/removeProtocol({"name":"模板名"})/removeCommand({"name":"命令名"})/removeCodec({"name":"协议名"}) 按名删除【破坏性】
- openPort()/closePort() 开关连接（需发送权限）
- modbus({"op":"…"}) Modbus 工作台（高权限动作，会主动占用总线发数据，需逐次批准）：op 可选 status（查两边状态与统计）/ slave.start / slave.stop / slave.configure({address,anyAddress,delayMs,fault:"none"|"noReply"|"exception"|"everyOther",faultCode}) / slave.write({area:"coil"|"disc"|"holding"|"input",index,value}) / slave.writeMany({area,from,to,value,step}) / slave.resize({bits,words}) / poll.add({slave,fn:1|2|3|4,addr,qty,periodMs,varName,elem,scale}) / poll.remove({varName}) / poll.clear() / poll.configure({transport:"rtu"|"tcp"}) / poll.start / poll.stop / poll.reset。用户说"把 40003 设成 1234""每 500ms 读 1 号从站 10 个寄存器""模拟一个从站让它别应答/回异常码"时用这个，别让他手动点
- toast({"msg":"文字"}) 显示通知
- listWidgets() 查询已安装挂件（名称/启用/浮窗打开中/形态）；openWidget({"name":"挂件名"})/closeWidget({"name":"…"}) 开关应用内浮窗；popWidget({"name":"…"}) 弹出为独立桌面小窗（置顶常驻）
- removeWidget({"name":"…"}) 删除挂件【破坏性】
示例——清空控制画布：{"actions":[{"kind":"clearPage","args":{}},{"kind":"toast","args":{"msg":"控制画布已清空"}}]}。示例——打开曲线并切深蓝主题：{"actions":[{"kind":"openPanel","args":{"panel":"plot2d"}},{"kind":"setTheme","args":{"theme":"navy"}}]}。`;
}

function schemaCard(): string {
  return `【uartix-card 控制卡片格式】输出一个 \`\`\`uartix-card 代码块，内容为 JSON：{"cards":[...]}（批量）或单个卡片对象。卡片字段：{"type":"slider"|"button"|"switch"|"led"|"buzzer"|"monitor"|"joystick"|"keypad"|"keymon"|"group"|"custom","name":"卡片名","x":0,"y":0,"w":2,"h":1,"template":"发送模板（如 CMD:%.2f，printf 风格占位或 {变量名} 插值）","script":"可选JS脚本","unit":"可选单位","sendMode":"ascii"|"hex"}（各专有类型字段见下）。
布局规则：x/y 可省略（自动按行流式排布，从左上角起从左到右、放不下换行）；w/h 建议按内容给出（滑条 2×1、按钮/开关/LED 1×1、监视器 2×2、组合控件 2×3、custom 3×3 起）。批量时把所有卡片放进 cards 数组（如 6 个电机滑条就输出 6 项），每张卡给清晰 name 与正确 template（编号递增 MOTOR1/MOTOR2…）；想要整齐的多列布局时可显式给 x/y（画布默认 12 列，每张卡横向间隔建议 = 前一张 x+w）。
建议尺寸：监视器 2×2、摇杆/键盘遥控 2×2。
遥控类卡片：摇杆（type="joystick"）字段 {"template":"J:%x,%y!","range":100,"minIntervalMs":50,"springBack":true}——template 用 %x/%y 占位摇杆坐标（归一化 −range~+range，拖动按 minIntervalMs 节流发送，springBack=松开回中）。键盘遥控（type="keypad"）四方向按键：{"keys":["w","s","a","d"],"labels":["前进","后退","左转","右转"],"templates":["按下时发送×4"],"releaseTemplates":["松开时发送×4，空串=不发"]}，键位取 KeyboardEvent.key 单字符。单键遥控（type="keymon"）一个键：{"key":"w","template":"按下指令","releaseTemplate":"松开指令（可省）"}。三者均可选 useScript+script（JS 脚本覆盖默认发送行为，一般不用）。当用户要「遥控/键盘控制/摇杆控制小车云台」时用这三类。
组合控件（type="group"）：一张卡片集成多个子控件，用 children 数组描述，每项 {"kind":"slider"|"button"|"switch"|"monitor"|"led","label":"子项名","template":"子项指令（slider/button）","min":0,"max":100,"step":1,"templates":["关指令","开指令"]（switch）,"varName":"变量名"（monitor/led）}，最多 8 项。当用户想要「组合/集合控件」「一个控件里又要滑条又要按钮」时使用 group。
自定义卡片（type="custom"）：字段 {"type":"custom","name":"卡片名","w":3,"h":3,"html":"完整的自包含 HTML（内联 CSS/JS）"}。HTML 运行在沙箱 iframe（无网络、无法访问主程序 DOM），系统自动注入与小部件相同的 window.uartix API：uartix.onSnap(cb)/uartix.snap() 读实时字段、uartix.send(text,mode?) 发送（受发送权限门控）、uartix.app(kind,args) 软件动作、uartix.onChat(cb) 感知 AI 对话状态（思维链/正文尾部）。禁止手写 postMessage 样板；win 窗口控制对卡片无效（卡片固定在画布格子里）。适合任意风格/功能的控件：仪表盘、圆表盘、自绘方向盘、表格、带动画的控制面板。单页最多 8 个 custom 卡片。当用户想要的外观/功能无法用预置控件拼出来时，用 custom。`;
}

function schemaCommand(): string {
  return `【uartix-command 命令格式】输出一个 \`\`\`uartix-command 代码块，内容为 JSON：单条 {"name":"命令名","template":"模板串或HEX","sendMode":"ascii"|"hex","script":"可选JS脚本","scriptEnabled":false}；多条用 {"commands":[单条对象,...]}（或纯数组）。命令将写入命令库「AI 生成」分组。模板串语法：printf 风格 %d/%.2f 占位（按顺序对应输入值），或 {变量名} 引用实时变量（支持 {名:d}/{名:.2f} 格式化）。脚本约束：JS 子集，可用 API：send(text,mode?)、delay_ms(ms)、get(name)、set(name,v)、beep(freq,ms)、log(text)、waitParse(fieldName,timeoutMs)、repeat(n,fn)。`;
}

function schemaCodec(): string {
  return `【uartix-codec 指令工厂自定义协议格式】输出一个 \`\`\`uartix-codec 代码块，内容为 JSON：{"name":"协议名","note":"一句话说明","segs":[...]}。segs 段类型（按帧顺序排列）：
- {"kind":"fixed","label":"帧头","bytes":"AA 55"}（HEX 字符串，空格分隔多字节）
- {"kind":"var","name":"字段名","type":"u8"|"u16"|"u32"|"s16"|"s32"|"f32"|"ascii","le":true,"def":"默认值（数值或HEX文本）"}（le=小端；ascii 用 UTF-8）
- {"kind":"len"}（长度段：自动 = 该段之后到帧尾的字节数，校验段不计入，上限 255）
- {"kind":"check","algo":"sum8"|"xor8"|"sum16"|"crc16-modbus"|"crc16-ccitt"|"crc16-x25"|"ano-scac","be":false}（be=校验值大端；ano-scac 为匿名V7 SC+AC 双字节）
规则：至少 2 段；校验段最多 1 个且不能在首位；变量名不重复；帧头用 fixed 段。安装后出现在指令工厂「自定义协议」中，填参数即可自动组帧（含校验）。`;
}

/**
 * P98-M2：`CreativePerms` 已删除。
 * 它曾是"AI 能输出哪类代码块"的权限位，但三个字段没有一个真的在拦东西：
 * `enabled` 从未被读；`script` 走到 `schemaFor` 只有一句 `void perms`；`send` 只在
 * 早退分支之后才用得上。设置项 `aiCreativity`/`aiScript` 因此是"假装生效的安全控件"，
 * 一并清退——真实的权限面只有 Agent 授权档（`scopeTiers.hasDomain`）与逐次审批门。
 */
export function schemaFor(key: NeedKey): string {
  switch (key) {
    case "action":
      return schemaAction();
    case "card":
      return schemaCard();
    case "command":
      return schemaCommand();
    case "codec":
      return schemaCodec();
  }
}

/* ================= 意图路由：从用户文本预判需要的 schema ================= */

/** 关键词 → schema；宁可稍宽（误注入只多几百 token），漏注入会多一轮请求 */
const ROUTE_TABLE: { key: NeedKey; re: RegExp }[] = [
  { key: "action", re: ACTION_ROUTE_RE },
  { key: "card", re: /滑条|滑块|按钮|开关|控件|卡片|控制画布|控制面板|LED|蜂鸣|摇杆|键盘|监视器|仪表盘|一键/ },
  { key: "command", re: /指令|命令|发(一|这|那)?[条帧]|模板串|命令库|上报|归零|置位/ },
  { key: "codec", re: /指令工厂|自定义协议|组帧|编解码|构造协议|协议构造/ },
];

/** 从用户消息预判需要注入的 schema（qa 场景用） */
export function routeNeeds(text: string): NeedKey[] {
  const out: NeedKey[] = [];
  for (const { key, re } of ROUTE_TABLE) {
    if (re.test(text)) out.push(key);
  }
  return out;
}

/* ================= 轻量底座（qa 场景常驻） ================= */

const NEED_HINT = (keys: NeedKey[]) =>
  keys.map((k) => `[[need:${k}]]=${NEED_LABEL[k]}`).join("；");

/**
 * UI 创造统一路径（旧 uartix-theme/style/widget/panel/script 独立扩展安装已废弃）：
 * 界面创造需求一律走 Agent 任务，由 save_plugin 工具落库并自动启用。
 *
 * 括号里这句是**对模型的承诺**，所以它必须与产物元表同步：P99a-D1c 删掉主世界脚本通道后，
 * "脚本"不再是可创造的产物种类（能跑 JS 的合法形态只有专用 Worker 的 `logic.run`，
 * 那条要走插件库批准，不在自动启用范围内）。`prompts.test.ts` 有一条钉防它再漂回去。
 */
const AUTO_KINDS = autoEnableableKindLabels();
const MANUAL_KINDS = ARTIFACT_KINDS.map((k) => artifactKindMeta(k).label).filter(
  (l) => !AUTO_KINDS.includes(l),
);
const UI_CREATIVITY_ROUTE =
  `【UI 创造引导】UI 创造类需求（${AUTO_KINDS.join(" / ")}）：` +
  "入口是输入框下方那颗<b>工作方式 pill</b>——选成『Agent 任务』即可；" +
  "顶栏没有单独的 Agent 按钮，不要让用户去找一个不存在的入口。" +
  `任务里你用 save_plugin 把成果保存为插件并自动启用，用户无需手动安装。` +
  `${MANUAL_KINDS.join(" / ")} 是例外：含代码或含高危能力，永不被自动启用，要用户自己在插件库里点一次。`;

/** 输出工具箱：card/command/codec 三个代码块工具（直接可用） */
const TOOLBOX_LIGHT = `\n\n${ACTION_RULE}\n\n${UI_CREATIVITY_ROUTE}\n\n【输出工具箱】你可以直接输出可写入软件的代码块（用户确认后写入）：${NEED_HINT(["card", "command", "codec"])}。
规则：需要输出某格式前，在回复中单独一行输出对应的 [[need:格式名]] 标记并停止输出，系统会自动补充该格式的完整规范，然后你继续完成代码块。不要凭记忆猜测格式细节。用户只是提问/闲聊时不要输出任何标记。`;

/* ================= 系统提示组装 ================= */

export function buildSystemPrompt(
  scene: AiScene,
  tplSummary: string,
  extraSchemas?: NeedKey[],
): string {
  // 专用输出场景 digest 用全量（回答"怎么用"需要细节）；其余用精简版控 token
  const digest = scene === "qa" || scene === "create" ? CAPABILITY_DIGEST : DIGEST_BRIEF;
  let base = `你是 Uartix+（嵌入式可视化上位机）内置的 AI 调试助手，面向嵌入式、机器人、航模方向的开发者。用简体中文回答，专业、简练。\n\n软件功能速览（回答用法问题时引用对应面板名）：\n${digest}\n\n当前用户的协议模板：\n${tplSummary}\n\n${BUG_PATROL}`;

  if (scene === "create") {
    // 创造工作台：UI 创造统一走 Agent 任务 + save_plugin（不再输出独立扩展安装块）
    return `${base}\n\n${UI_CREATIVITY_ROUTE}\n\n${ACTION_RULE}\n\n可直接输出的代码块：${NEED_HINT(["card", "command", "codec"])}。创作流程：理解需求 → 必要时用一句话澄清 → 输出 [[need:格式名]] 标记并停止（系统自动补规范）→ 继续完成代码块 → 邀请用户反馈迭代。`;
  }

  if (scene === "qa") {
    // 普通对话：轻底座 + 路由预注入
    base += TOOLBOX_LIGHT;
    const extras = extraSchemas ?? [];
    if (extras.length > 0) {
      base += `\n\n【已预载的格式规范（可直接输出代码块，无需再输出 [[need:xxx]] 标记）】`;
      for (const k of extras) base += `\n\n${schemaFor(k)}`;
    }
    return base;
  }

  // 其他专用场景：各自任务说明（genCommand/genCard 用同一 schema 来源）
  switch (scene) {
    case "protocol":
      return `${base}\n\n当前任务：分析一段原始字节流，推断其帧结构。\n\n${TEMPLATE_SPEC}`;
    case "docTemplate":
      return `${base}\n\n当前任务：把用户粘贴的协议文档转成协议模板。\n\n${TEMPLATE_SPEC}`;
    case "explainBytes":
      return `${base}\n\n当前任务：按当前模板逐字节解释一段选中的字节（若在帧内，指出所属模板、字段偏移、解析值；不在帧内则按候选帧头/常见协议推测）。输出逐字节或逐字段的对照说明。`;
    case "interpret":
      return `${base}\n\n当前任务：根据提供的最近帧字段值样本，用自然语言概括设备状态与数据特征（数值范围、趋势、抖动），发现异常（越界、突变、周期异常）要指出。不要复述原始数据。`;
    case "analyzeCurve":
      return `${base}\n\n当前任务：根据提供的各通道统计特征（均值/极值/趋势斜率/周期估计），总结信号特征，诊断振荡/噪声/漂移，并给出采样率与滤波建议。`;
    case "inertial":
      return `${base}\n\n当前任务：根据提供的轨迹统计 JSON 概括运动特征并指出异常。统计内容包括：各组（组 ID/点数/路径长/位移/比较偏差）以及组间比较偏差、覆盖率与时间容差。重点检查：路径长与位移之比（较大也可能是正常闭环或折返，位移接近零时比值不稳定，不能据此诊断漂移）、匹配覆盖率是否偏低、距离阈值内比例是否偏低（不是时间容差匹配比例）、位移与路径长是否与预期量级不符。约束：只依据提供的统计 JSON 推理，不得编造未提供的数据；某项数据缺失或来源未提供时明确说明"该数据未提供"，不要臆测。背景：分析快照由用户手动刷新触发生成，没有后台持续采集。`;
    case "genCommand":
      return `${base}\n\n当前任务：把用户的自然语言指令转成命令模板串或卡片脚本。\n\n${schemaCommand()}`;
    case "genCard":
      return `${base}\n\n当前任务：把用户的自然语言描述转成控制卡片（可批量，支持组合控件）。\n\n${schemaCard()}`;
    case "diagnose":
      return `${base}\n\n当前任务：结合用户提供的连接状态与统计信息、以及用户对问题的描述，给出结构化排查清单（按可能性排序，每项含判断依据与操作步骤）。结合实际状态给针对性判断（如端口已连接但 0 字节接收 → 怀疑接线/TX）。`;
    case "report":
      return `${base}\n\n当前任务：根据提供的会话汇总信息，生成一份 Markdown 调试报告（连接配置、启用协议、字段清单、数据统计、异常事件、结论与建议），可直接存档。`;
    default:
      return base;
  }
}

/** 提取文本中的 [[need:xxx]] 标记 */
export function extractNeeds(text: string): NeedKey[] {
  const out: NeedKey[] = [];
  const re = /\[\[\s*need\s*:\s*([a-z]+)\s*\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const k = m[1].toLowerCase() as NeedKey;
    if (NEED_LABEL[k] && !out.includes(k)) out.push(k);
  }
  return out;
}

export function sceneUserText(scene: AiScene, payload?: Record<string, unknown>): string {
  switch (scene) {
    case "protocol":
      return `请识别以下字节流的协议帧结构：\n${String(payload?.hex ?? "")}`;
    case "docTemplate":
      return `请把以下协议文档转成协议模板：\n${String(payload?.doc ?? "")}`;
    case "analyzeCurve":
      return `请分析当前 2D 曲线各通道的统计特征：\n${String(payload?.stats ?? "")}`;
    case "explainBytes":
      return `请解释这段选中字节：\n${String(payload?.hex ?? "")}`;
    case "interpret":
      return payload?.text
        ? String(payload.text)
        : "请解读当前数据：概括设备状态与数据特征（数值范围、趋势、抖动），指出异常。";
    case "inertial":
      return payload?.text
        ? String(payload.text)
        : "请根据随附轨迹统计 JSON 概括各组运动特征，指出异常（路径长与位移比异常、匹配覆盖率低、距离阈值内比例低等）；未提供的数据明确说明，不要编造。";
    case "report":
      return payload?.text
        ? String(payload.text)
        : "请根据随附上下文生成本次会话的调试报告（连接配置、启用协议、数据统计、异常事件、结论与建议）。";
    default:
      return String(payload?.text ?? "");
  }
}
