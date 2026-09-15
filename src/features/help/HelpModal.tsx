import { useState } from "react";
import { Section } from "../../shared/Section";
import { tx, useLocale } from "../../i18n/strings";
import * as tourStore from "../tour/tourStore";
import { TOUR_STEPS } from "../tour/tourSteps";
import { IconPlay } from "../../shared/icons";

export function HelpModal({ onClose }: { onClose: () => void }) {
  useLocale();
  const [tab, setTab] = useState("start");
  const tabs: { key: string; label: string }[] = [
    { key: "start", label: tx("快速入门", "Quick Start") },
    { key: "panels", label: tx("面板总览", "Panels Overview") },
    { key: "ai", label: tx("AI 助手详解", "AI Assistant Guide") },
    { key: "canvas", label: tx("协议画布教程", "Protocol Canvas Guide") },
    { key: "plot3d", label: tx("3D 轨迹面板", "3D Trajectory Panel") },
    { key: "orchestrator", label: tx("自动编排器", "Orchestrator") },
    { key: "script", label: tx("脚本命令详解", "Scripting Guide") },
    { key: "keys", label: tx("快捷键与技巧", "Shortcuts & Tips") },
    { key: "export", label: tx("导出文件格式", "Export Formats") },
    { key: "operator", label: tx("部署与分发", "Deploy & Distribute") },
  ];
  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal set-modal help-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{tx("帮助与入门", "Help & Getting Started")}</div>
        <div className="set-body">
          <div className="set-nav">
            {tabs.map((x) => (
              <button key={x.key} className={tab === x.key ? "on" : ""} onClick={() => setTab(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
          <div className="set-content help-content">
            {tab === "start" && (
              <>
                <div className="help-tour-row">
                  <button
                    className="btn primary"
                    onClick={() => {
                      onClose();
                      tourStore.start(TOUR_STEPS);
                    }}
                  >
                    <IconPlay />
                    {tx("启动交互式教学（分步带你走通主流程）", "Start the guided tour (walks the main flow step by step)")}
                  </button>
                </div>
                <p><b>Uartix+</b> 是一台跑在电脑上的可视化上位机：定义协议 → 自动筛选有效帧 → 在干净数据上查看、绘图并反向控制设备。</p>
                <Section title="五步上手">
                  <ol className="help-ol">
                    <li>标题条选择<code>数据接口</code>（串口 / TCP 客户端 / TCP 服务端 / UDP / 蓝牙 BLE），在工具栏完成参数设置后点击<code>连接</code>。</li>
                    <li>左侧<code>协议模板</code>面板点<code>＋ 预设</code>，导入一个协议（如 匿名 V7、维特 WIT、Modbus RTU / TCP）；也可<code>＋ 新建</code>自己画。</li>
                    <li>没有设备？点左下角<code>启动演示源</code>，软件会生成混合协议数据流；想扮演一台有脾气的具体设备（温漂/丢帧/命令应答，还能 UDP/TCP/串口对外发），开<code>虚拟设备工坊</code>面板。</li>
                    <li>中央<code>帧画布</code>查看每帧的字节结构（绿色=字段、橙=帧头、粉=校验），悬停可看数值。</li>
                    <li>底部<code>2D 曲线</code>点亮字段图例的眼睛即可实时绘图；<code>数据表格</code>查看帧列表。</li>
                  </ol>
                </Section>
                <Section title="自己定义协议（零代码）">
                  <ol className="help-ol">
                    <li>帧画布中，按住左键在字节格上拖出一片区域 → 右键<code>定义为字段</code>。</li>
                    <li>字段可设名称/角色/类型/缩放；右键字段可锁定、删除、编辑。</li>
                    <li>右键帧头/帧尾区域可改字节（甚至删除——无帧头的逗号文本帧也支持）。</li>
                    <li>改完点画布左上角<code>💾 保存</code>，立即生效并持久化（平时改动也会自动同步解析内核）。</li>
                    <li>页签下方细条是<code>结构覆盖条</code>：红色段=还没被字段覆盖的字节，点一下直接定义；新建/AI/考古得到的协议在未启用时显示为<code>灰色页签</code>，点它一键启用。</li>
                    <li>工具栏<code>对比</code>按钮把当前帧设为基线，←/→ 翻帧时差异字节左上角标红，用于协议考古与版本对比。</li>
                    <li>把左侧协议模板面板的<code>字段</code>直接拖到 2D 曲线=开通道、拖到控制画布=建监视卡、拖到编排器=秒挂阈值事件组；字段改名后曲线图例与通道标签同步更新。</li>
                  </ol>
                </Section>
                <Section title="网络接口（TCP / UDP）">
                  <ol className="help-ol">
                    <li><b>TCP 客户端</b>：填对方的 IP 与端口，主动连接；断线后自动重连。</li>
                    <li><b>TCP 服务端</b>：只填<code>本地端口</code>监听，等设备来接入；新设备接入会替换旧连接。</li>
                    <li><b>UDP</b>：填<code>本地端口</code>（设备往这个端口发数据）和<code>远程地址</code>（你发数据去的默认对端）。</li>
                    <li>网络数据与串口走完全相同的解析/绘图/控制管线；首次监听端口时请在 Windows 防火墙弹窗中允许访问。</li>
                    <li>提示：远程地址填 127.0.0.1 时数据会发给自己（本机回环），适合自测；发送前请确认状态栏已显示<code>已连接 地址</code>。</li>
                  </ol>
                </Section>
                <Section title="AI 助手">
                  <ol className="help-ol">
                    <li>先到<code>设置 → AI 服务</code>选服务商预设（OpenAI 兼容 / DeepSeek / 智谱 GLM / 通义千问 / 本地 Ollama / Claude），选<code>接口格式</code>并填入 API Key；如需代理可填 HTTP 代理地址。</li>
                    <li>按 <code>Ctrl+K</code> 或点标题栏星形按钮唤起 AI 浮窗；浮窗可拖动、缩放、最小化到角落气泡，也可一键<code>停靠为面板</code>（面板内可再弹出为浮窗）。</li>
                    <li><b>识别协议</b>：在 Hex 数据流框选一段字节 → 右键「AI 识别协议」，AI 输出候选帧结构表（帧头/长度/字段/校验+置信度），点「写入协议模板」即可直接解析。</li>
                    <li><b>解读数据 / 分析曲线</b>：一键概括设备状态、诊断振荡与噪声；发现坏帧率偏高、数据停滞、字段突变时面板顶部会主动提示。</li>
                    <li><b>生成指令 / 生成卡片</b>：自然语言生成命令模板或控制卡片，回复内直接点「加入命令库」「临时发送」「写入控制画布」，生成即可用。</li>
                    <li>发送前可在输入框上方勾选「本次发送的上下文」（协议摘要/数据样本/Hex 选区等），AI 只看你授权的内容。</li>
                  </ol>
                </Section>
                <Section title="控制台与快捷指令">
                  <ol className="help-ol">
                    <li>发送框上方是<code>快捷指令</code>栏：命令芯片<b>左键立即发送</b>，鼠标悬停可预览实际内容（自动识别 Hex/ASCII/脚本）。</li>
                    <li><code>指令工厂</code>内置 WIT 寄存器、匿名 V7 触发/参数、Modbus RTU 与校验工具，组帧和校验全自动；也可<code>＋ 新建自定义协议</code>用可视化模板（固定字节 + 变量字段 + 校验段）定义自己的协议。</li>
                    <li><code>存为指令</code>后命令进入命令库，可拖挂到控制画布变成实体按键。</li>
                    <li>控制台时间戳以彩色显示；RX/TX 可分别隐藏。</li>
                  </ol>
                </Section>
              </>
            )}
            {tab === "ai" && (
              <>
                <Section title="基础操作">
                  <ol className="help-ol">
                    <li>先到<code>设置 → AI 服务</code>：选服务商预设（OpenAI 兼容 / DeepSeek / 智谱 GLM / 通义千问 / 本地 Ollama / Claude）→ 填 API Key → 需要代理时在「高级连接」里填。</li>
                    <li>按 <code>Ctrl+K</code> 或点标题栏星形按钮唤起 AI 浮窗；可停靠为面板（工具栏「+ 面板」）。</li>
                    <li>输入框：<code>Enter</code> 发送；<code>Shift+Enter</code> 或 <code>Ctrl+Enter</code> 换行。</li>
                    <li>发送前在输入框上方勾选「本次发送的上下文」；<b>协议清单</b>（一行式，便宜）默认带，<b>协议完整定义</b>只在需要精确分析时勾。上下文栏实时显示 ≈token 消耗估算。</li>
                    <li>支持思维链模型（如 deepseek-v4-pro / glm-5.3）：思考过程实时流式显示并计时，正文开始后自动折叠，可在设置关闭显示。</li>
                    <li>消息悬停出现操作钮：复制 / 编辑重发 / 重新生成 / 删除；会话侧栏支持多会话、搜索、双击重命名。</li>
                  </ol>
                </Section>
                <Section title="快捷按钮（顶部工具条）">
                  <table className="help-table">
                    <tbody>
                      <tr><td>识别协议</td><td>先在 Hex 数据流框选字节 → 点击 → AI 推断帧结构并输出「写入协议模板」按钮</td></tr>
                      <tr><td>解读数据</td><td>概括最近帧的设备状态、数值范围、趋势与异常</td></tr>
                      <tr><td>分析曲线</td><td>统计各通道均值/极值/周期/趋势斜率，诊断振荡与噪声</td></tr>
                      <tr><td>生成指令</td><td>描述需求 → 生成命令模板（写入命令库或临时发送）</td></tr>
                      <tr><td>生成卡片</td><td>描述需求 → 生成控制卡片（直接写入控制画布）</td></tr>
                      <tr><td>创造扩展</td><td>主题 / 样式 / 挂件 / 面板 / 脚本（需开启创造模式）</td></tr>
                      <tr><td>诊断</td><td>结合连接状态与异常巡检给出结构化排查清单</td></tr>
                      <tr><td>调试报告</td><td>汇总本次会话生成 Markdown 报告，可存档</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="哨兵 × AI 诊断">
                  <ul className="help-ol">
                    <li><b>手动诊断</b>：哨兵面板顶部点<code>AI 诊断</code>，会自动携带结构化证据（连接状态、健康度、近期报警、异常通道评分、帧型与错误率统计）打开 AI 助手发起诊断，无需手动描述现象。</li>
                    <li><b>自动诊断</b>：哨兵面板底部参数区开启<code>自动 AI 诊断</code>后，出现<b>严重报警</b>（通信静默、重大突变等）会自动发起诊断并直接写入 AI 会话——不弹窗、不抢焦点，打开 AI 助手即可看到结论。</li>
                    <li><b>冷却</b>：自动诊断按所选冷却时间（1~60 分钟）去重，避免报警风暴时连环调用；未配置 AI 服务时会提示先到 设置 → AI 服务 配置。</li>
                  </ul>
                </Section>
                <Section title="十种代码块（回复中直接可用）">
                  <table className="help-table">
                    <tbody>
                      <tr><td>动作执行<br /><code>uartix-action</code></td><td>让 AI 直接操作软件：打开面板、切主题/布局、清空画布、删除配置、开关连接、读写编排器与 3D 轨迹、生成并启动虚拟设备等（39 个白名单动作）。回复中显示操作卡片，点「执行」逐个运行。<b>对 AI 说「清空控制画布」「打开曲线面板」「主题换成琉璃」即可。</b></td></tr>
                      <tr><td>控制卡片<br /><code>uartix-card</code></td><td>生成滑条/按钮/开关/LED/摇杆/组合控件，或 <b>custom 自定义卡片</b>（任意 HTML 界面）。批量生成用 {"{"}"cards":[…]{"}"}。</td></tr>
                      <tr><td>命令库命令<br /><code>uartix-command</code></td><td>单条或批量（{"{"}"commands":[…]{"}"}）写入命令库「AI 生成」分组，可带脚本。</td></tr>
                      <tr><td>协议模板<br /><code>uartix-template</code></td><td>生成帧结构模板（截帧边界/字段/校验），写入协议面板；多帧型协议支持 {"{"}"group":"簇名","templates":[…]{"}"} 一次写入整簇并自动建组归档，默认停用待你启用。</td></tr>
                      <tr><td>指令工厂协议<br /><code>uartix-codec</code></td><td>生成自定义协议（帧头/变量/长度/校验段），写入指令工厂「我的协议」，填参数即组帧。</td></tr>
                      <tr><td>主题包<br /><code>uartix-theme</code></td><td>JSON 配色 + 整页风格 CSS（动效/光效/液态玻璃/贴图/面板级定制）。</td></tr>
                      <tr><td>样式层<br /><code>uartix-style</code></td><td>纯 CSS 精细化定制任意界面元素，可预览再保留。</td></tr>
                      <tr><td>沙箱小部件<br /><code>uartix-widget</code></td><td>自包含 HTML 浮窗，自动注入 <code>window.uartix</code> API：数据快照、AI 对话状态（思维链）、提问 AI、键盘/鼠标、串口发送、软件动作、窗口控制全套可用；支持无边框透明形态。</td></tr>
                      <tr><td>自定义面板<br /><code>uartix-panel</code></td><td>与小部件同格式，安装为可停靠面板，适合大面积常驻可视化。</td></tr>
                      <tr><td>行为脚本<br /><code>uartix-script</code></td><td>主窗口 JS（高权限）：读字段/发指令/联动控件/<b>api.app.* 控制软件</b>。</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">主题/样式/挂件/面板/脚本需在 设置 → AI 服务 开启「创造模式」；安装均需你点击确认，可在扩展管理启停/删除/导出。</p>
                </Section>
                <Section title="动作执行（uartix-action）示例">
                  <p>对 AI 说「清空控制画布，然后打开 2D 曲线」，AI 输出：</p>
                  <pre>{`{"actions":[
  {"kind":"clearPage","args":{}},
  {"kind":"openPanel","args":{"panel":"plot2d"}},
  {"kind":"toast","args":{"msg":"已清空并打开曲线"}}
]}`}</pre>
                  <p>点「执行」逐步运行，每步结果显示在卡片上。含破坏性动作（清空/删除）时卡片红色标注。</p>
                </Section>
                <Section title="小部件 uartix API 与无边框形态">
                  <ul className="help-ol">
                    <li>所有沙箱组件（小部件 / 自定义面板 / 自定义卡片）自动注入全局 <code>window.uartix</code>，AI 生成的代码直接调用：onSnap 数据快照、<b>onChat 感知 AI 对话（phase + 思维链/正文尾部）</b>、ask 向 AI 提问、send 串口发送、app 软件动作、onKey 键盘（浮窗悬停即收）、onCursor 鼠标跟随、screen 屏幕尺寸、resize 高度。</li>
                    <li>窗口控制 <code>uartix.win.*</code>：menu 弹菜单、close、popOut 弹出独立桌面窗、moveTo/moveBy/resizeTo/get、top 置顶、through 点击穿透（60 秒自动恢复）；移动类自动钳制屏幕边界，不会拖丢。</li>
                    <li>右键菜单可完全自定义：<code>uartix.menu.define(items)</code> 换掉默认菜单（支持子菜单/分隔线/勾选/多组命名菜单），<code>uartix.onMenu(cb)</code> 接收点击，<code>uartix.menu.off()</code> 关闭自动菜单改由组件自己处理右键。</li>
                    <li>无边框形态：AI 声明 <code>{"<meta name=\"uartix:chrome\" content=\"none\">"}</code>（卡片带「无边框形态」角标）——无标题栏、窗口透明，内容完全自绘：悬浮通知条、贴角信息窗、计时器、互动桌宠等任意形态。</li>
                    <li>无边框形态开箱行为：按住空白处即拖动（按住跟随、松开即停、自动跳过按钮/输入框、限制不出屏幕）、右键自动弹菜单——由宿主内置，AI 不需要也不允许自己写拖拽代码。</li>
                    <li>管理动作：listWidgets / openWidget / closeWidget / popWidget / removeWidget——「把某挂件弹出到桌面」「关闭某挂件浮窗」一句话直达。</li>
                    <li>示例：对 AI 说「做一个无边框透明桌宠，眼睛跟随鼠标，AI 思考时冒问号，回答时气泡打字机，点击它能向 AI 提问，右键菜单里加『闹脾气』『睡觉』，串口断线时沮丧」。</li>
                  </ul>
                </Section>
                <Section title="脚本 api.app.*（39 种动作速查）">
                  <table className="help-table">
                    <tbody>
                      <tr><td>界面控制</td><td>openPanel({"{"}panel{"}"}) · applyPreset({"{"}preset{"}"}) · setTheme({"{"}theme{"}"})</td></tr>
                      <tr><td>查询</td><td>listProtocols() · listCommands() · listCards() · listWidgets()</td></tr>
                      <tr><td>曲线</td><td>addChannel({"{"}tpl,field{"}"}) · clearChannels()</td></tr>
                      <tr><td>写入</td><td>writeCard / writeCommand / writeTemplate / writeCodec（参数 {"{"}json:"…"{"}"}，writeTemplate 支持协议簇批量）</td></tr>
                      <tr><td>控制页</td><td>clearPage()【破坏性】· addPage({"{"}name{"}"}) · patchCard({"{"}name,patch{"}"})</td></tr>
                      <tr><td>删除</td><td>removeCard / removeProtocol / removeCommand / removeCodec / removeWidget（按 name）【破坏性】</td></tr>
                      <tr><td>挂件</td><td>openWidget / closeWidget / popWidget({"{"}name{"}"}) 浮窗管理与弹出桌面</td></tr>
                      <tr><td>连接</td><td>openPort() · closePort()（需开启「小部件可发送数据」）</td></tr>
                      <tr><td>传输</td><td>xferStart({"{"}path,proto{"}"}) 预填文件传输对话框（path 可数组多文件排队；开始发送仍需用户点击）</td></tr>
                      <tr><td>Modbus</td><td>modbus({"{"}op:"…"{"}"}) 操作工作台：<code>status</code> · <code>slave.start/stop/configure/write/writeMany/resize</code> · <code>poll.add/remove/clear/configure/start/stop/reset</code>（需脚本高权限，会占用总线发数据）</td></tr>
                      <tr><td>读图</td><td>readPlot({"{"}ask{"}"}) 截取当前 2D 曲线面板画面发给模型分析（面板未开会自动打开）</td></tr>
                      <tr><td>哨兵</td><td>sentinel({"{"}op:"status/enable/ackAll/mute/clear"{"}"}) 异常监测查询与控制（需脚本高权限）</td></tr>
                      <tr><td>结构发现</td><td>xrayEvidence() / xrayCrack() 读协议考古证据链（帧长/帧型簇/校验爆破/轮询周期，面板需先「采样分析」）· xrayReport() 生成引用证据编号的考古报告（需脚本高权限）</td></tr>
                      <tr><td>编排器</td><td>orchestratorRead() 只读快照（总开关/在跑实例/各组统计/变量现值/日志）· orchestrator({"{"}op:"enable/run/stopAll/groupAdd/groupUpdate/groupRemove/eventAdd/eventRemove/blockAdd/blockRemove/varsSet"{"}"}) 写操作（需高权限——发送块会真实发包；eventAdd/blockAdd 能把自动化「说出来即搭」）</td></tr>
                      <tr><td>3D 轨迹</td><td>plot3dRead() 只读快照（轴绑定/校准采样/拟合结果/六面进度）· plot3d({"{"}op:"bind/set/calib"{"}"}) 写操作（需高权限；calib 子动作 enter/exit/start/stop/clear/solve6）</td></tr>
                      <tr><td>虚拟设备</td><td>vdev({"{"}op:"status/list/create/start/stop"{"}"}) 虚拟设备工坊（需高权限——设备占据数据管线等同发送）：create/start 带整台设备规格 JSON（信号模型+故障注入+命令应答+可选 net 段），自然语言即可生成虚拟传感器</td></tr>
                      <tr><td>通知</td><td>toast({"{"}msg{"}"})</td></tr>
                    </tbody>
                  </table>
                  <pre>{`// 脚本示例：首次收到数据时自动切到分析布局
api.app.applyPreset({ preset: "analyze" });
await api.app.openPanel({ panel: "plot2d" });
const protos = await api.app.listProtocols();
console.log(protos.length);`}</pre>
                  <pre>{`// 脚本示例：本机当从站（40003=1234），再用主站轮询读回来画曲线
await api.app.modbus({ op: "slave.configure", address: 1 });
await api.app.modbus({ op: "slave.write", area: "holding", index: 2, value: 1234 });
await api.app.modbus({ op: "slave.start" });
await api.app.modbus({ op: "poll.add", slave: 1, fn: 3, addr: 0, qty: 3, periodMs: 500, varName: "MB温度" });
await api.app.modbus({ op: "poll.start" });`}</pre>
                  <p className="help-tip">小部件/自定义卡片内通过 postMessage 桥 {"{"}type:"aiw:app", action:{"{"}kind,args{"}"}{"}"} 调用同一套动作（不含高权限动作：破坏性、modbus、sentinel、考古报告、编排器/3D 写入、虚拟设备等——只有脚本且开启高权限才能用）。</p>
                </Section>
                <Section title="常用诉求 → 一句话指令">
                  <table className="help-table">
                    <tbody>
                      <tr><td>清空控制画布</td><td>「帮我清空控制画布」</td></tr>
                      <tr><td>批量加控件</td><td>「加 6 个电机速度滑条，模板 MOTOR1~6，2×1 大小流式排布」</td></tr>
                      <tr><td>自定义控件</td><td>「做一个圆表盘电压表卡片，实时显示 VOLT 字段，0~15V」</td></tr>
                      <tr><td>生成命令</td><td>「生成一条归零指令加入命令库」「生成 3 条不同频率的采样指令」</td></tr>
                      <tr><td>做协议</td><td>「做一个指令工厂协议：帧头 AA 55、命令 u8、长度、数据、CRC16-Modbus」</td></tr>
                      <tr><td>协议考古</td><td>「结构发现面板分析完了吗？分析一下这个协议是什么结构，给我一份考古报告」</td></tr>
                      <tr><td>换主题</td><td>「主题换成琉璃，加一点液态玻璃感」</td></tr>
                      <tr><td>做挂件</td><td>「做一个桌面电压监视挂件，低于 10V 变红闪烁」</td></tr>
                      <tr><td>无边框挂件</td><td>「做一个无边框透明挂件贴在屏幕角落，AI 回答时气泡提示」</td></tr>
                      <tr><td>桌宠（示例）</td><td>「做一个无边框桌宠，AI 思考时冒问号，回答时气泡打字机」</td></tr>
                      <tr><td>挂件管理</td><td>「把 XX 弹出到桌面」「关闭 XX 浮窗」「重新打开 XX」</td></tr>
                      <tr><td>自动化</td><td>「写个脚本：每 100ms 上报一次 roll，越界时蜂鸣」</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="MCP 服务器（接入 Claude Desktop / Cursor）">
                  <p className="help-tip">
                    让写代码的 AI 顺手看板子：IDE 里的智能体经 MCP 直接读 Uartix+ 的实时遥测、发指令、跑测试序列。
                    三步接入：
                  </p>
                  <ol className="help-ol">
                    <li>设置 → 集成：打开「启用 MCP 桥」（默认端口 7731，token 自动生成）。</li>
                    <li>
                      构建桥接 CLI：<code>npm run build:mcp</code>，得到 <code>dist-cli/uartix-mcp.cjs</code>
                      （需要本机 Node ≥ 18）；把它的绝对路径填进「桥接 CLI 路径」。
                    </li>
                    <li>
                      点「复制 MCP JSON」，粘贴到 Claude Desktop 的{" "}
                      <code>%APPDATA%\Claude\claude_desktop_config.json</code> 或 Cursor 的{" "}
                      <code>~/.cursor/mcp.json</code>，重启客户端即可看到 uartix 的 10 个工具
                      （含编排器 / 3D 轨迹的只读快照）。
                    </li>
                  </ol>
                  <p className="help-tip">
                    安全：服务只绑定 127.0.0.1 + 首行 token 握手 + 单客户端；<b>允许远程发送</b>关闭时 send / run_sequence
                    直接拒绝；删除/开关连接类动作需另开「允许高权限动作」；每次调用在设置页留审计。改端口无需改客户端配置（客户端经发现文件自动定位）。
                  </p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>读</td><td>get_status 连接总览 · get_fields 变量快照 · get_frames 最近帧 · get_plot_stats 曲线统计 · get_alerts 哨兵健康 · get_orchestrator 编排器快照 · get_plot3d 3D 轨迹与校准快照</td></tr>
                      <tr><td>写</td><td>send 发送（ascii 支持 \r \n \t \xNN）· run_action 白名单动作（含 orchestrator / plot3d 两组）· run_sequence 跑测试序列并返回逐步结果</td></tr>
                      <tr><td>调试</td><td><code>node uartix-mcp.cjs --status</code> 检查发现文件与连通性；<code>npm run mcp:e2e</code> 跑协议层冒烟</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="成本控制（省钱技巧）">
                  <ul className="help-ol">
                    <li>上下文默认只带「协议清单」（几十 token）；「协议完整定义」按需勾选。</li>
                    <li>系统提示按需注入：AI 只在需要某格式时自动加载对应规范，普通问答不带全量提示词。</li>
                    <li>多轮长对话定期「新对话」；历史只带最近 20 条。</li>
                    <li>协议识别建议温度 ≤0.3；本地 Ollama 零成本。</li>
                  </ul>
                </Section>
              </>
            )}
            {tab === "panels" && (
              <Section title="面板一览与推荐工作流">
                <table className="help-table">
                  <tbody>
                    <tr><td>协议模板</td><td>协议簇管理：导入预设、新建、启停解析、复制/粘贴帧型</td></tr>
                    <tr><td>帧画布</td><td>核心编辑器：字节格上框选定义字段，帧头帧尾可编辑</td></tr>
                    <tr><td>Hex 数据流</td><td>原始字节流总览，同样支持框选定义与 Ctrl+F 搜索</td></tr>
                    <tr><td>属性</td><td>选中模板/字段后编辑其全部参数</td></tr>
                    <tr><td>数据表格</td><td>逐帧列表，可排序/筛选/导出 CSV·XLSX</td></tr>
                    <tr><td>2D 曲线</td><td>字段图例点眼睛开曲线；支持平移/框选缩放/双击复位</td></tr>
                    <tr><td>频谱分析</td><td>FFT 频谱（主峰/频率分辨率/线性或 dB）与直方图（均值/σ/分布）双模式；与 2D 曲线共享通道数据，选通道点数窗函数，可冻结谱面观察</td></tr>
                    <tr><td>3D 姿态</td><td>把欧拉角或四元数字段映射到 3D 模型（+面板可添加）</td></tr>
                    <tr><td>3D 轨迹</td><td>三路变量当空间坐标画实时三维轨迹（着色/拖尾/网格/跟随/自动旋转/键盘飞行/光标缩放/底部时间条历史回看与回放联动）；内置椭球校准（八象限点云采样 → 九参数拟合：硬磁偏置×3 + 软磁对称校正矩阵×6，给 CV 与残差 RMS，支持残差着色、校正前后对比、在线补偿预览，一键复制 JSON/C 数组）与六面校准（加计专用，六姿态各静置 2 秒直接解算）</td></tr>
                    <tr><td>图传</td><td>把每帧数据渲染为画面：暂停/回看/保存帧、镜像翻转、缩放拖动；「解析设置」定义帧定界方式</td></tr>
                    <tr><td>控制画布</td><td>拖拽部署滑条/按钮/开关/LED/蜂鸣器等控件向下位机发指令；拖动时虚线幽灵框指示落点，松手只会落到空格</td></tr>
                    <tr><td>控制台</td><td>原始收发日志（时间戳彩色），可发 ASCII/Hex、发送文件、录制日志；上方快捷指令栏一键发送，指令工厂可组各协议帧</td></tr>
                    <tr><td>结构发现</td><td>未知协议考古：对原始字节做周期/帧头统计推断、校验算法爆破与帧型序列分析，勾选帧型一键批量生成模板；AI 可引用其证据链生成推理报告</td></tr>
                    <tr><td>哨兵</td><td>静默异常监测：数值通道突变（双 EMA z-score）、新帧型出现、错误帧率超限、通信静默四类报警；报警自动降噪合并，可最小化成右下角浮球或弹出桌面挂件驻留报警（面板、浮球与桌面挂件全部关闭才停止监测），支持合成提示音；一键或自动发起 AI 诊断（携带证据，见 AI 助手详解）</td></tr>
                    <tr><td>Modbus 工作台</td><td>模拟从站（本机当从站应答，四张可编辑数据表 + 故障注入）与主站轮询表（按周期读寄存器/线圈，值直接写成变量）；关掉面板仍在运行，工具栏有绿色徽标</td></tr>
                    <tr><td>测试序列器</td><td>拖积木组出自动化测试：发送/等待/等帧/断言/分组/备注六类步骤，帧到达触发自动运行、单步调试、failFast；自包含 HTML 报告一键导出；JSON 导入导出分享套件；配套 CLI（内置回环设备）可进 CI 无硬件跑断言。关面板即停，绝不后台发包</td></tr>
                    <tr><td>自动编排器</td><td>事件-条件-动作编排：组头部事件槽挂事件块（帧命中/坏帧/新帧型/阈值/通道变化/定时器/会话开断/哨兵/变量变更/自定义事件/通信静默共 12 类）自动触发，组内块流 23 类块——除发送/等待/等帧/跑序列/调用组/变量/通知/提示音与如果/循环/跳出/中止/子组外，还有操作画布控件、写 Modbus、截图/导 CSV/剪贴板、发自定义事件等自动化工具箱；「从模板新建」内置报警通知/看门狗/定时轮询/收发握手/PID 继电反馈整定五套模板（导入默认停用）；总开关 + 冷却 + 熔断多重保护（详见帮助页签）</td></tr>
                    <tr><td>AI 助手</td><td>AI 调试助手：协议识别、数据解读、曲线分析、指令/卡片生成、诊断排查、调试报告；Ctrl+K 唤起浮窗，可停靠为面板（+面板 可添加）</td></tr>
                    <tr><td>虚拟设备工坊</td><td>可编程虚拟数据源（与真实接口互斥，关面板仍在跑，状态栏有徽标）：信号模型（常量/正弦/方波/三角/一阶对象/镜像）+ 温漂/丢帧/卡死/毛刺故障注入 + 命令应答（匹配前缀可捕获数值写输入量、回应答帧）；可选 net 段走 UDP/TCP 客户端/TCP 服务端/串口对外收发；启动即自动配套协议模板；内置「温控炉」（PID 教学被控对象）与「虚拟 MPU6050」（WIT 兼容帧）；设备库存档/导出 JSON 分享，也可让 AI 按自然语言生成（+面板 可添加）</td></tr>
                  </tbody>
                </table>
                <p className="help-tip">推荐流：Hex/帧画布定义协议 → 表格与曲线观察 → 控制画布下发指令闭环调试。没有硬件？「虚拟设备工坊」载入内置设备即可全链路体验；新手推荐先点「快速入门」顶部的「启动交互式教学」。</p>
              </Section>
            )}
            {tab === "canvas" && (
              <>
                <Section title="Modbus 工作台：没有硬件也能测">
                  <p>面板分两页，<b>同一时刻只能开一页的服务</b>（自己问自己答会得出"设备健康"的假象）：</p>
                  <ul className="help-ol">
                    <li><b>模拟从站</b>：设本机从站地址（也可"应答所有地址"当多从站），四张数据表就是被读的内容——线圈/离散输入点位格子点击翻转，保持/输入寄存器直接填数（可切 HEX，悬停显示 4x 手册编号）。<b>故障注入</b>可让它不回应答（复现主站超时）、一律回某异常码、或隔一次回一次异常；还能加应答延时模拟慢速从站。主站写进来的值会实时反映在表里。</li>
                    <li><b>主站轮询</b>：一行 = 问谁、用什么功能码、起始地址、数量、周期、值写进哪个变量（还能指定取第几个元素与倍率）。响应解析在这里完成，<b>不需要再配协议模板</b>，变量直接可画曲线、进表格、被脚本读。半双工保护：一条请求没回应答前不会发下一条，1 秒无应答记一次超时。</li>
                    <li><b>帧格式</b>：RTU 与 TCP 是<b>帧格式</b>选择而不是接口选择——RTU 完全可以跑在 TCP 串口隧道上，反之不成立，所以 Modbus TCP 只在网络接口下可用。</li>
                    <li><b>自环演示</b>：两台实例（或一台跑从站、另一台跑轮询）接在同一对串口/网络上即可对打；也可用「指令工厂 → Modbus RTU」手发一条请求看从站应答。</li>
                  </ul>
                </Section>
                <Section title="虚拟设备工坊：让软件扮演一台设备">
                  <p>面板在「+ 面板 → 数据接入」。设备 = 一份 JSON 规格：信号模型（常量/正弦/方波/三角/<b>一阶惯性对象</b>/镜像）+ 噪声/温漂 + 丢帧/卡死/毛刺故障 + 帧格式 + 命令匹配。启动即自动配套协议模板；运行中锁定编辑（停机再改）。内置两台：<b>温控炉</b>（HEAT ON/OFF 控温、SET DUTY 45 捕获数值直调加热功率，PID 整定模板的被控对象）与<b>虚拟 MPU6050</b>（维特 WIT 兼容帧 + 温漂 + 丢帧 + 毛刺）。设备库存档管理：载入库条目编辑后点<code>保存</code>原位更新（改名不产生重复；新建/内置/另存副本/导入均为未保存态，脏了按钮亮起）。</p>
                  <p><b>网络收发（像真设备一样在链路上）</b>：规格里可选 net 段——UDP 把帧逐字节发到指定 host:port（.255 自动广播，可加 ≤4 个额外目标一帧多投，可选监听端口收外部命令）；TCP 客户端拨出、TCP 服务端监听（≤8 客户端广播）；串口独占 COM 口直写（接收端可用 com0com 虚拟串口对）。命令去向：本机控制台/编排器与网络来令走同一匹配器，网络来令的应答原路返回。运行中状态行实时显示发出的帧数/收令数/客户端数与最近命令。</p>
                  <p><b>双机教学</b>：A 机启动温控炉开 UDP 发射 9010 → B 机数据接口选 UDP 服务端监听 9010 + 「+ 预设 → 虚拟设备·温控炉」→ 两台看到同一条曲线。绑 0.0.0.0 允许局域网接入（首次可能弹防火墙授权）。</p>
                </Section>
                <Section title="协议簇">
                  <p>一个协议可含多个帧型（如匿名 V7 的 22 种功能码）：左侧列表一行代表整簇，点行选中，点行首箭头展开帧型；簇内右键可复制/粘贴帧型。画布顶部页签与左侧联动。</p>
                </Section>
                <Section title="三种截帧模式与变长载荷">
                  <p>截帧方式在模板属性里选择，画布拖拽定义的字段按<b>固定偏移</b>解析：</p>
                  <ul className="help-ol">
                    <li><code>固定长度</code>：整帧字节数固定（如 11B），收满即成帧。</li>
                    <li><code>帧头＋长度字段</code>：帧内自带长度计数器，解析器读它算出本帧总长（总长 = 长度域原始值 + 修正）。把某格定义为「数据长度(LEN)」并选 u8/u16，其偏移与宽度自动同步为长度域配置；属性面板反向修改长度域同样会移动 LEN 字段。</li>
                    <li><code>帧头＋帧尾</code>：收到帧尾字节即成帧，中间数据长度天然不定。</li>
                  </ul>
                  <p>载荷长度逐帧可变的协议：把数据区字段勾选<code>延伸至载荷尾（自适应变长）</code>——字段从其偏移一直覆盖到校验/帧尾之前，随每帧实际长度伸缩，画布上该块带 ↔ 标记。再选<code>元素类型</code>（默认 float32 小端）：载荷区按元素宽度逐个解码，输出 <code>名称1..N</code> 动态数值变量（可绘图、可脚本引用，上限 64，随每帧实际长度自适应，缩放/字节序逐元素生效）；选「文本」则输出一整个 HEX/ASCII 字符串变量。均匀序列（三轴角度、N 点采样）用元素模式；混合结构请定义固定偏移字段，只把均匀的尾段交给自适应。图例中自适应字段的眼睛为组开关：一下开整组曲线，再点移除。</p>
                  <p><b>校验闭环</b>：画布上把某格定义为「和校验(CK1)」时即可选择算法（默认 sum8），<b>保存即启用</b>——覆盖范围自动设为帧首至校验域前，校验不过的帧直接被过滤；字段宽度自动匹配算法产出（sum8=1B、CRC16/SC+AC=2B、CRC32=4B），不一致会被模板校验拦下。CK2 仅是视觉标注位。校验块悬停可看当前算法与覆盖范围，未启用时会明确提示。<b>变长帧（长度字段/帧尾模式）的校验域自动锚定帧尾</b>：定位 = 帧长 − 校验宽度 − 帧尾字节数，字段的固定偏移仅作画布标注，随每帧长度自适应（Modbus RTU、MAVLink 即此布局）。</p>
                  <p><b>尾锚字段（负偏移）</b>：字段偏移支持负数=距帧尾（<code>−1</code> 即最后一字节，<code>−2</code> = 末两字节起始）。变长帧里位于尾部、位置随帧长浮动的数据（帧尾状态字节、帧计数、尾校验前的字段）用它定义，随每帧长度自适应。属性面板偏移直接填负数，或框选尾部字节后在字段对话框选「帧尾起算」。短帧放不下时该字段自动跳过。</p>
                </Section>
                <Section title="自适应文本帧（JustFloat 式）">
                  <p><code>＋ 新建 → 自适应文本帧</code>：设分隔符（, \ ;）与元素类型（float/uint8…），按每帧实际段数动态生成 通道1…通道N，各通道可单独绘图、供脚本引用。</p>
                </Section>
                <Section title="Modbus RTU / TCP 抓包">
                  <p><code>＋ 预设 → Modbus RTU / Modbus TCP</code> 一次导入整簇帧型（RTU 13 种 / TCP 15 种），无需自己画：</p>
                  <ul className="help-ol">
                    <li><b>整条总线一次收</b>：帧头写成 <code>?? FC</code>——首字节位掩码 0x00 = 通配，任意从站地址（含广播 0）都能解，不必逐台改模板。</li>
                    <li><b>寄存器区自动展开</b>：读响应按 byteCount 定帧，数据区按大端 uint16 展开为 <code>寄存器1..N</code>，每个都是可绘图、可脚本引用的数值变量。</li>
                    <li><b>线圈按位展开</b>：FC01/02 的长度域是「位数」，引擎按 0.125 倍率换算字节数，并把线圈区逐位展开为 <code>线圈1..N</code>（0/1 一通道，每字节低位在前）。</li>
                    <li><b>异常直接可读</b>：异常响应用 <code>FC &amp; 0x80</code> 位掩码一条覆盖所有功能码，异常码自带规范文字（表格显示 <code>2 非法数据地址</code>）。</li>
                    <li><b>TCP 无 CRC 也能分主从</b>：MBAP 长度域的奇偶就是方向标识（请求恒 6＝偶、响应 3+2N＝奇），嗅探 502 端口时主站请求与从站响应不会互相误判。</li>
                    <li><b>RS485 注意</b>：抓 485 半双工总线要把 USB 转串口接在<b>总线两端之外</b>（或用带接收的监听头），并注意 A/B 线反接时字节全是垃圾；3.5 字符静默在 USB 转串口上不可靠，因此本软件按<b>长度域 + CRC</b> 定帧，不依赖帧间隔。主站轮询与从站应答共用功能码，两条模板同时命中属正常，引擎会按有效行覆盖关系自动去掉噪声坏帧。</li>
                  </ul>
                </Section>
                <Section title="值标签（枚举注解）">
                  <p>字段属性里的<code>值标签</code>把状态码翻译成文字：填 <code>0=就绪; 1=运行; 2=故障</code>（支持 <code>0x</code> 十六进制），命中时数据表格、帧画布悬停、图例与 CSV/Excel 导出都会显示「数字 文字」。这是纯显示层能力——数值通道、曲线、变量、脚本仍拿到原始数字。</p>
                </Section>
                <Section title="骨架编辑">
                  <p>选中一个模板但还没有收到匹配数据时，画布显示骨架格（按模板定义推算长度）——此时就能框选定义字段；协议完全匹配后格子才切换为真实数据。帧头/帧尾格固定显示模板字节。</p>
                </Section>
                <Section title="图传（视频链路）">
                  <p>把数据流按帧渲染成画面（如无人机摄像头的 JPEG 帧流）。使用步骤：</p>
                  <ol className="help-ol">
                    <li>工具栏点<code>解析设置</code>，选择帧定界方式（定长 / 长度域 / 帧尾）——每解析出一帧即刷新画面。</li>
                    <li>点<code>暂停</code>后可点选历史帧回看，点<code>保存</code>导出当前显示的帧。</li>
                    <li><code>水平镜像</code>、<code>垂直翻转</code>矫正画面方向；滚轮缩放、拖动平移，双击复位。</li>
                    <li>数据来源与串口/网络完全一致：TCP/UDP 接收图传流同样可用。</li>
                  </ol>
                </Section>
              </>
            )}
            {tab === "plot3d" && (
              <>
                <p><b>3D 轨迹面板</b>把三个通道画成空间轨迹（航迹/相图/姿态积分），支持大坐标（经纬度）自动重锚、双层 LOD 长跑不卡。工具栏「+ 面板」添加。</p>
                <Section title="绑定与视角">
                  <ol className="help-ol">
                    <li>左上三个下拉把 <b>X / Y / Z</b> 绑到通道（与 2D 图例共享通道；建议同帧打包三轴，时间对齐最准）。三轴来自不同帧/不同采样率时，右键「数据」里可切<b>配对模式</b>（插值/最近点）与容差，HUD 有配对统计行；三轴值域悬殊可切<b>逐轴独立缩放</b>，避免小值域轴被压成直线。</li>
                    <li>右上视角托盘（毛玻璃胶囊，三段分组）：<b>俯视 / 侧视 / 正视 / 等轴</b>四预设、重置视角、聚焦最新点、跟随模式、自动旋转、椭球校准、<b>清空数据</b>（历史清零、新数据从零画，带确认；与右键菜单「清空轨迹显示」只清画面不清数据不同）。左键拖动旋转、右键拖动平移、滚轮缩放。</li>
                    <li><code>跟随模式</code>：视角平滑锁定最新点；<code>自动旋转</code>：展台展示（两者互斥）。</li>
                    <li>右键菜单按「模式 / 视图 / 测量 / 数据 / 设置」分组；悬停任意点显示真实坐标，可一键复制。</li>
                  </ol>
                </Section>
                <Section title="键盘飞行与缩放">
                  <ol className="help-ol">
                    <li>右键菜单「视图」开启<code>键盘飞行</code>后，鼠标悬停在画布上即可用键盘漫游（不悬停时不响应，不抢其他面板按键）。</li>
                    <li><code>W/A/S/D</code> 水平平移（相机朝向为准），<code>Q/E</code> 降/升，<code>方向键</code>绕目标旋转，<code>F</code> 切换跟随，<code>R</code> 重置视角。</li>
                    <li>飞行速度与视角距离成比例（越近越慢，精细贴近观察）。</li>
                    <li>右键菜单「视图」可开<code>缩放到光标</code>：滚轮朝指针位置缩放（默认关闭，绕视线中心缩放）。</li>
                  </ol>
                </Section>
                <Section title="时间条与回放">
                  <ol className="help-ol">
                    <li>底部时间条拖动即<code>时间游标</code>：轨迹截断显示到该时刻，可与 2D 曲线回放联动。</li>
                    <li>双击时间条或菜单「数据 → 回到最新」清除游标恢复实时。</li>
                  </ol>
                </Section>
                <Section title="椭球校准（磁力计 / 加计九参数）">
                  <ol className="help-ol">
                    <li>用途：评估磁力计/加计的<b>硬磁偏置（offset）</b>与<b>软磁畸变（校正矩阵 W）</b>，输出九参数给固件做补偿。</li>
                    <li>流程：绑定原始三轴 → 右键「模式 → 椭球校准模式」（或工具栏 ◎ 按钮）→ 点<code>开始采样</code> → 缓慢翻滚传感器覆盖全空间（画 8 字）→ <code>拟合椭球</code>。校准 HUD 顶部可切「<b>椭球拟合</b>（磁/加通用）」与「<b>六面向导</b>（加计专用）」两个子页，切换会清空对方采样。</li>
                    <li>点云越接近球面越好；<b>象限覆盖 8/8</b> 才允许拟合（只转半圈会被拒绝并提示）；<code>CV</code> 校正后半径变异系数（&lt;3% 为优）、<code>RMS</code> 为球面残差。</li>
                    <li>拟合成功后点云自动<b>残差着色</b>（绿 = ±3% 内 / 黄 = ±8% 内 / 红 = 出界）；<code>显示：原始 / 校正后</code>一键对比——校正后点云应收缩为均匀球壳（附参考球线框）。</li>
                    <li><code>补偿预览</code>：拟合成功后实时绘制校正后幅值 r=|W·(x−offset)| 迷你图——转动传感器时曲线贴 1.0 线小幅抖动 = 校准有效，单轴靠近铁磁物会明显抬升/下凹；拟合后继续采样会挂起预览（灰显），重新拟合自动恢复。</li>
                    <li>结果可<code>复制 JSON</code> 或<code>复制 C 数组</code>（mag_offset[3] + mag_matrix[3][3]，直接贴进固件）。</li>
                    <li>采样中更换绑定/密度会清空重采；采到 20000 点自动停止；拟合后再采样，结果会标记「基于旧采样」。</li>
                    <li><b>六面向导（加计专用）</b>：利用重力先验，六个面依次<b>朝上静置</b>点「采集该面」（自动采 2 秒，晃动会被 σ 门拒绝）→ 六面齐后<code>计算参数</code> → 输出 acc_offset / acc_gain（校正后 ≈ 1g），附三轴尺度一致性 CV 与面偏差指标；顺序摆错（两面同轴）会被拒绝并提示。</li>
                    <li>退出校准模式即恢复原轨迹（数据不清空）；校准属于操作态，不会被打进 Operator 部署包。</li>
                  </ol>
                </Section>
                <Section title="导出">
                  <ol className="help-ol">
                    <li><code>导出轨迹 CSV</code>：相对秒 t_s + 三个绑定通道全量数据（UTF-8 BOM，Excel 可直接打开）。</li>
                    <li><code>快照 PNG</code>：当前视角整帧截图保存。</li>
                  </ol>
                </Section>
              </>
            )}
            {tab === "orchestrator" && (
              <>
                <p><b>自动编排器</b>＝测试序列器（线性流程）× 触发器（事件驱动）：组是编排单元，头部事件槽挂事件块自动触发，组内块线性执行。工具栏「+ 面板」添加；编辑随时可做，运行中的实例不受影响（下次触发生效）。</p>
                <Section title="组与事件槽">
                  <ol className="help-ol">
                    <li>组头部：勾选框启用（禁用后事件不触发、运行按钮也不跑）、<b>运行</b>按钮手动跑一次（不受熔断限制）、复制整组、删除；双击标题重命名，标题行箭头折叠。</li>
                    <li>事件槽在标题下方独立一行：点徽标在右侧检查器编辑参数，「添加事件」挂事件，徽标可拖动排序，移除按钮删除。<b>事件块只能放进事件槽</b>——拖进块流会被拒绝并提示。</li>
                    <li>事件 12 类：手动 / 帧命中（可设 1/N 抽稀 stride）/ 坏帧命中 / 新帧型出现（逆向现场新固件上线瞬间报警）/ 阈值穿越（进入/回落 + 去抖）/ 通道值变化（可设最小间隔节流）/ 定时器（≥50ms）/ 会话开断 / 哨兵告警（warn/crit）/ 变量变更 / 自定义事件（配「发自定义事件」块做跨组解耦）/ 通信静默（超时无帧触发，数据恢复自动重武装）。</li>
                    <li>检查器里可为组设<code>触发冷却</code>（上次触发后 N ms 内新事件直接丢弃）与<code>满队列策略</code>（丢新 / 挤掉最旧 / 中止最旧）。</li>
                  </ol>
                </Section>
                <Section title="块：执行与逻辑">
                  <table className="help-table">
                    <tbody>
                      <tr><td>发送</td><td>HEX / ASCII / 命令库条目 / 指令工厂<b>多帧</b>（逐帧过令牌桶限速），内容支持 {"{var}"} 取编排变量</td></tr>
                      <tr><td>等待 / 等待帧</td><td>定时等待；等到匹配帧才继续（超时可填 <code>0</code>=一直等到匹配；失败可「继续」跳过或「中止」本组）</td></tr>
                      <tr><td>运行序列 / 运行组</td><td>调用测试序列器的套件，或把另一个编排组当子程序调用（均可选等待完成）；「运行组」不等待 = 触发</td></tr>
                      <tr><td>设置变量 / 通知 / 提示音</td><td>写变量（常量 / 通道值 / 表达式 / 事件字段）；弹提示（支持 $&#123;表达式&#125; 插值）；warn 单音 / crit 三连音</td></tr>
                      <tr><td>如果</td><td>多条件 AND 分支（通道比较 / 变量比较 / 表达式 / 事件字段 / 会话状态），成立走「那么」否则走「否则」</td></tr>
                      <tr><td>循环</td><td>按次数或按条件反复执行子流（≤1000 轮，可设轮间隔）；「跳出」结束最近一层循环，「中止」立即结束本组</td></tr>
                      <tr><td>子组</td><td>纯分组收纳容器（无触发语义），嵌套深度 ≤4</td></tr>
                      <tr><td>自动化工具箱</td><td>设控件（写控制画布变量）· 切开关（直接翻转开关卡档位）· 写 Modbus（FC05/06 编成 RTU 帧走发送路由）· 日志 · 截取曲线图存图片库 · 导出 CSV · 停止序列 · 发自定义事件（配「自定义事件」事件块跨组解耦）· 写剪贴板 · 复位变量（可静默不触发变量变更链）</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">条件与赋值里的表达式在沙箱中求值（纯计算、无系统访问），支持四则/比较/逻辑与白名单函数 abs · floor · ceil · round · min · max · clamp · if · len · fmt，外加 <code>now</code>（当前毫秒，测时间间隔用，如 PID 整定数摆动周期）；「evt.字段」可读触发事件的载荷（如帧号、越限值）。每个块行首拖柄按住拖动排序（可拖入容器内、可跨组拖动），勾选框临时停用，块尾「中止/继续」标签点击切换失败策略；复制按钮克隆含子树。</p>
                </Section>
                <Section title="变量库与插值">
                  <ol className="help-ol">
                    <li>类型化全局变量（number / string / bool），勾「持久」跨重启保留当前值；上限 64 个。右侧检查器无选中块时即变量库视图。</li>
                    <li>引用方式：表达式（如果 / 循环条件 / 设置变量）直接写变量名；发送内容用 {"{var}"}；通知文本用 $&#123;表达式&#125;。</li>
                    <li>「变量变更」事件：变量值<b>实际变化</b>时触发组——可做链式编排（A 组算完写变量 → B 组接手）。检查器里可实时看到当前运行值。</li>
                  </ol>
                </Section>
                <Section title="PID 继电反馈自整定（内置模板）">
                  <p>「从模板新建」里有两套现成的<strong>继电反馈法（Åström-Hägglund 临界比例度法）</strong>整定模板——串口工具圈少有的自动调参能力，全部用现成块搭成：</p>
                  <ol className="help-ol">
                    <li><b>PID 继电反馈整定</b>（2 个组）：被控量高于 SP+hys → 发「关执行器」并记穿越时刻；低于 SP−hys → 发「开执行器」。上穿越间隔即摆动周期 Tu；攒满 6 个周期后自动算 <code>Ku=4d/(πa)</code>、按 Ziegler-Nichols 经典式给 <code>Kp=0.6Ku、Ti=Tu/2、Td=Tu/8</code>，并自动发送 PID 参数帧（<code>{"{Kp}"}</code> 插值）。</li>
                    <li><b>整定·阶跃验证</b>：整定完成后自动施加一次全量阶跃，配合 2D 曲线观察超调与稳定时间。</li>
                    <li>导入后按组备注检查 4 处：两个阈值事件的通道与值（SP±hys）、开关命令换成自己设备的指令、变量 <code>d</code>（继电输出步进）与 <code>amp</code>（摆幅，按曲线峰谷修正）。</li>
                    <li>运行时打开「变量库」可实时看到 Tu/Ku/Kp 的求解过程；跑完对 AI 说「<b>解读整定结果</b>」，AI 会读编排器快照给出参数解读与下一步建议。</li>
                    <li>无硬件练习：虚拟设备工坊载入「温控炉」（一阶加热对象，HEAT ON/OFF 命令）→ 导入 PID 模板 → 启用 + 总开关，看曲线进入等幅摆动、参数自动算出发送。</li>
                  </ol>
                </Section>
                <Section title="安全红线与互操作">
                  <ol className="help-ol">
                    <li>顶部<code>编排总开关</code>关闭后所有自动事件与手动运行都停止；顶部实时显示空闲 / 运行中实例数。</li>
                    <li>多重熔断：循环 ≤1000 轮、嵌套 ≤4 层、单实例超时自动中止、发送令牌桶限速、触发风暴全局熔断（帧流等高频事件本身不计入，只有实际触发组才计数）。</li>
                    <li>空画布上有「从模板新建」下拉：内置<b>报警通知 / 看门狗 / 定时轮询 / 收发握手 / PID 继电反馈整定</b>五套组模板，导入后<b>默认未启用</b>（参数是示意值，检查后再手动打开）；也可以点「让 AI 帮我搭」一句话生成整条编排。</li>
                    <li><code>从序列导入</code>：把测试序列器的套件转成一个编排组（onFrame 触发转成帧事件块、断言转成如果块），<b>导入后默认停用</b>——检查无误后手动勾选启用。</li>
                    <li>编排文档可<code>导入 / 导出 JSON</code> 备份或分享；条件与表达式在沙箱中求值（纯计算，无系统访问）。</li>
                  </ol>
                </Section>
              </>
            )}
            {tab === "script" && (
              <>
                <p>滑条/按钮/开关/摇杆与命令库均支持 <b>类 C 脚本（JS 子集）</b>，异步执行，勾选<code>启用脚本</code>后原模板串不再发送。</p>
                <Section title="内置函数">
                  <table className="help-table">
                    <tbody>
                      <tr><td>send(text, mode?)</td><td>发送指令；mode 省略按命令的 ASCII/Hex 设置。如 send("AT+RST")、send("AA 55 01", "hex")</td></tr>
                      <tr><td>beep(freq, ms)</td><td>蜂鸣提示，如 beep(1000, 200)</td></tr>
                      <tr><td>delay_ms(ms)</td><td>异步延时，await delay_ms(500)</td></tr>
                      <tr><td>get(name)</td><td>读取变量当前值，如 get("温度")</td></tr>
                      <tr><td>set(name, v)</td><td>写入变量（配合模板 {"{name}"} 插值发送）；同名解析帧到达时会被覆盖</td></tr>
                      <tr><td>await waitParse(name, ms?)</td><td>等待解析字段出现并取值（默认超时 5s），校准流程用</td></tr>
                      <tr><td>setControl(控件名, v)</td><td>驱动控制画布滑条/开关等控件的值（自动化联动）</td></tr>
                      <tr><td>await repeat(n, i=&gt;…)</td><td>循环语法糖；也可直接用 JS 的 for / while / if</td></tr>
                      <tr><td>log(text)</td><td>输出到控制台（前缀 [脚本]），调试脚本用</td></tr>
                      <tr><td>变量名</td><td>启用模板的字段名直接可用（重名自动 _1/_2）；自适应帧为 通道1/通道2…</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="示例 1：条件报警">
                  <pre>{`if (get("温度") > 60) {
  beep(2000, 300);
  send("ALARM ON");
}`}</pre>
                </Section>
                <Section title="示例 2：顺序连发">
                  <pre>{`send("AT+MODE=1");
await delay_ms(200);
send("AA 01 02", "hex");
await delay_ms(200);
send("AT+SAVE");`}</pre>
                </Section>
                <Section title="示例 3：滑条映射（滑条脚本）">
                  <pre>{`// 滑条值在变量 value 中（0~100）
const duty = Math.round(value * 2.55);
send("PWM:" + duty);`}</pre>
                  <p className="help-tip">模板串写法：<code>{"{温度:.1f}"}</code> 按格式插值、<code>{"{名称:str}"}</code> 文本插值、<code>{"%d"}</code> 等printf风格用于命令库。</p>
                </Section>
                <Section title="控件联动（setControl）">
                  <p>
                    <code>setControl("控件名", 值)</code> 可以在任意脚本里<b>真正触发</b>其他控件（按控件名）：
                    <b>按钮</b> = 触发一次发送；<b>开关</b> = 切到目标档位并发送该档指令（2 档用 0/1）；<b>滑条</b> = 设值并立即发送；<b>键盘遥控</b> = 模拟按下方向（0上/1下/2左/3右）。
                  </p>
                  <pre>{`// 例：温度超过阈值 → 报警灯亮、蜂鸣器响、油门清零
if (get("温度") > 60) {
  setControl("报警灯", 1);
  setControl("警报声", 1);
  setControl("油门", 0);
  send("ALARM ON");
} else {
  setControl("报警灯", 0);
  setControl("警报声", 0);
}`}</pre>
                  <p className="help-tip">控件名 = 卡片左下角显示的名称，双击卡片可改名；联动目标控件不需要启用脚本。</p>
                  <p>
                    <b>LED 灯 / 蜂鸣器</b>是变量驱动的显示控件：在控件属性里绑定一个解析变量与条件（如 变量「报警」 &gt; 0），脚本里 <code>set("报警", 1)</code> 后即点亮/鸣响，<code>set("报警", 0)</code> 恢复。用变量而非 setControl 驱动它们，可以保证状态来源唯一、不与解析数据打架。
                  </p>
                  <pre>{`// 例：解析帧到达 → 报警变量置位 → LED/蜂鸣器自动响应
set("报警", get("温度") > 60 ? 1 : 0);`}</pre>
                  <p className="help-tip">
                    键盘遥控/单键监控也可以被联动：<code>setControl("方向键盘", 0)</code> 等价于按下「上」。四个方向共享一个脚本，用 <code>dir</code>（0上/1下/2左/3右）与 <code>phase</code>（press/release）区分：
                  </p>
                  <pre>{`// 键盘遥控脚本示例：不同方向发不同指令
if (dir === 0) send("FWD:" + phase);
else if (dir === 1) send("BAK:" + phase);
else if (dir === 2) send("LFT:" + phase);
else send("RGT:" + phase);`}</pre>
                </Section>
                <Section title="JS 基础语法速查">
                  <table className="help-table">
                    <tbody>
                      <tr><td>变量</td><td>let x = 1; const name = "abc";（const 不可重新赋值）</td></tr>
                      <tr><td>判断</td><td>if (x &gt; 0) {"{ … }"} else if (x === 0) {"{ … }"} else {"{ … }"}；比较：&gt; &lt; &gt;= &lt;= ==（值）!= ===（值+类型）</td></tr>
                      <tr><td>逻辑</td><td>&amp;&amp;（且）||（或）!（非），如 if (a &gt; 0 &amp;&amp; b &lt; 10)</td></tr>
                      <tr><td>循环</td><td>for (let i = 0; i &lt; 10; i++) {"{ … }"}；while (条件) {"{ … }"}；await repeat(10, i =&gt; {"{ … }"})</td></tr>
                      <tr><td>函数</td><td>function 步进(n) {"{ return n * 2; }"} 或 const 步进 = (n) =&gt; n * 2;</td></tr>
                      <tr><td>数学</td><td>Math.abs(-5)=5 · Math.min(a,b) · Math.max(a,b) · Math.round(1.6)=2 · Math.floor(1.9)=1 · Math.random()∈[0,1)</td></tr>
                      <tr><td>文本</td><td>"共" + n + "帧" 拼接；s.toFixed(2) 保留2位小数；s.includes("ON") 包含判断</td></tr>
                      <tr><td>数组</td><td>const arr = [1, 2, 3]; arr[0]; arr.push(4); arr.length; for (const v of arr) {"{ … }"}</td></tr>
                      <tr><td>异步</td><td>await delay_ms(500) 等待；await waitParse("温度") 等解析帧；顶层可直接 await</td></tr>
                      <tr><td>异常</td><td>throw new Error("原因") 中止脚本并在控制台提示</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">解析字段的字段名可直接当变量使用（重名自动 _1/_2）；字符串模板支持 {"{字段名:.2f}"} 格式化插值。</p>
                </Section>
              </>
            )}
            {tab === "keys" && (
              <table className="help-table">
                <tbody>
                  <tr><td>Ctrl+F</td><td>Hex 数据流搜索（Esc 关闭）</td></tr>
                  <tr><td>Ctrl+K</td><td>AI 助手浮窗开关；AI 输入框内 <code>Enter</code> 发送、<code>Shift/Ctrl+Enter</code> 换行、<code>Ctrl+V</code> 粘贴截图</td></tr>
                  <tr><td>M</td><td>录制/回放中给时间轴打标注（2D 曲线显示琥珀虚线，点击标注列表可 seek）</td></tr>
                  <tr><td>Ctrl+Z / Ctrl+Y</td><td>协议编辑撤销 / 重做（全局 50 步）</td></tr>
                  <tr><td>← / →</td><td>帧画布上一帧 / 下一帧</td></tr>
                  <tr><td>W/A/S/D · Q/E · 方向键</td><td>3D 轨迹面板键盘飞行（右键菜单「视图」开启，鼠标悬停画布才响应）；F 跟随、R 复位</td></tr>
                  <tr><td>双击</td><td>帧画布帧头/帧尾直接打开编辑框；2D 曲线图区=保形回实时；3D 时间条=回到最新</td></tr>
                  <tr><td>Esc</td><td>取消框选 / 关闭菜单 / 退出教学引导</td></tr>
                  <tr><td>左键拖拽</td><td>Hex/帧画布框选定义字段</td></tr>
                  <tr><td>右键</td><td>帧画布：字段/帧头/帧尾/簇 菜单；曲线区：更多设置；3D：视图/测量/模式/数据/设置</td></tr>
                  <tr><td>拖拽图例</td><td>把字段拖到 2D 曲线区直接开线</td></tr>
                </tbody>
              </table>
            )}
            {tab === "export" && (
              <>
                <Section title="外层信封（三种文件通用）">
                  <p>设置 → 导入 / 导出 中的三类文件均为 JSON，外层统一包裹，导入时按 <code>kind</code> 校验类型：</p>
                  <pre>{`{
  "kind": "uartix-templates | uartix-controls | uartix-commands",
  "version": 1,
  "data": { ... }
}`}</pre>
                </Section>
                <Section title="协议模板（kind = uartix-templates）">
                  <p>data 含 <code>templates</code>（帧型数组）与 <code>groups</code>（协议簇名映射）。导入时以副本追加，重名自动加后缀。</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>id / name / color / enabled</td><td>帧型唯一标识、名称、图例颜色、是否启用解析</td></tr>
                      <tr><td>presetKey / groupKey</td><td>预设协议标识（自建为 null）/ 自建簇的分组 key</td></tr>
                      <tr><td>boundary.mode</td><td>定界方式：fixedLength 定长 / lengthField 长度域 / footer 帧尾</td></tr>
                      <tr><td>boundary.headerBytes</td><td>帧头同步字节数组，如 [170, 85]（即 AA 55）</td></tr>
                      <tr><td>boundary.headerMask</td><td>帧头逐字节位掩码（与 headerBytes 等长）：按 <code>(字节 &amp; mask) == (值 &amp; mask)</code> 匹配，0xFF 精确 / 0x00 通配。省略即全精确。用于「任意从站地址」「任意异常功能码（bit7=1）」这类通配帧头</td></tr>
                      <tr><td>boundary.fixedLength</td><td>定长模式的帧总长（字节）</td></tr>
                      <tr><td>boundary.lengthOffset / lengthSize / lengthEndian / lengthAdjust</td><td>长度域模式的：域偏移 / 位宽 / 字节序 / 修正值（总帧长 = 原始值 × 倍率 + 修正）</td></tr>
                      <tr><td>boundary.lengthScale</td><td>长度域倍率（缺省 1）：长度域计的是「位数」等非常规单位时换算，如 Modbus FC01/02 读线圈响应 = ⌈位数/8⌉ 字节 → 0.125</td></tr>
                      <tr><td>boundary.footerBytes</td><td>帧尾模式：帧尾字节序列</td></tr>
                      <tr><td>boundary.maxLength</td><td>安全上限，超长候选帧直接丢弃重新同步</td></tr>
                      <tr><td>boundary.discs</td><td>帧识别字段列表：{"{ offset, value: number[], mask?: number[] }"}，用于同簇多帧型筛选；mask 同上可只比较某些 bit</td></tr>
                      <tr><td>checksum.algo</td><td>none / sum8 / sumadd / xor8 / crc16_modbus / crc16_ccitt / crc32</td></tr>
                      <tr><td>checksum.coverageStart / coverageEnd</td><td>校验覆盖区间；正数=帧头偏移，负数=距帧尾（-1 = 不含最后 1 字节）</td></tr>
                      <tr><td>checksum.endian</td><td>校验值存储字节序：little / big</td></tr>
                      <tr><td>fields[].role</td><td>header / addr / id / seq / length / data / payload / checksum / checksum2 / footer</td></tr>
                      <tr><td>fields[].type</td><td>uint8 / int8 / uint16 / int16 / uint32 / int32 / float32 / float64 / ascii / bcd / bits / csv</td></tr>
                      <tr><td>fields[].offset / endian</td><td>帧内字节偏移（负数=距帧尾）/ 解析字节序：little(DCBA) / big(ABCD) / big-word-swap(CDAB) / little-word-swap(BADC)，后两档用于 32 位量占两个 16 位寄存器的协议</td></tr>
                      <tr><td>fields[].scale / offsetValue / unit</td><td>物理值 = 原始值 × scale + offsetValue；unit 为显示单位</td></tr>
                      <tr><td>fields[].labels</td><td>值标签（枚举注解）：{"[{ v: 2, t: \"非法数据地址\" }]"}。命中时表格 / 悬停 / 导出显示「数字 文字」，数值通道与曲线仍用原始数字（属性面板「值标签」框可填 <code>2=非法数据地址</code>，多条用分号或换行分隔）</td></tr>
                      <tr><td>fields[].disc</td><td>帧识别值（本字段偏移处应有的固定字节串）</td></tr>
                      <tr><td>fields[].bits / csvDelim / csvType</td><td>位域：{"{ index, count }"}；文本帧：分隔符 / 元素类型</td></tr>
                      <tr><td>fields[].spanTail / spanElem</td><td>变长数组区：延伸至载荷尾（自动扣除校验域）+ 元素类型（uint8…float64），输出 <code>名称1..N</code> 数值变量；<code>spanElem: "bit"</code> 表示按位展开（一位一通道、每字节低位在前，如 Modbus 线圈区）</td></tr>
                    </tbody>
                  </table>
                  <pre>{`{
  "templates": [{
    "id": "…uuid…", "name": "姿态帧", "color": "#e5534b", "enabled": true,
    "boundary": { "mode": "fixedLength", "headerBytes": [187, 102],
      "fixedLength": 12, "maxLength": 512, "discs": [] },
    "checksum": { "algo": "crc16_modbus", "coverageStart": 0, "coverageEnd": -2, "endian": "little" },
    "fields": [
      { "id": "…", "name": "Roll", "role": "data", "offset": 4,
        "type": "int16", "endian": "big", "scale": 0.1, "unit": "°", "color": "#3fb950" }
    ],
    "presetKey": null, "groupKey": "usr-…"
  }],
  "groups": { "usr-…": { "name": "我的协议" } }
}`}</pre>
                </Section>
                <Section title="控制画布（kind = uartix-controls）">
                  <p>data 为控制页数组（导入取第一个，生成新页，不影响现有页面）。</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>页级字段</td><td>id / name / cols(2~24) / rows(2~48) / locked / cards[]</td></tr>
                      <tr><td>卡片公共字段</td><td>id / type / name / x / y / w / h（网格坐标与宽高）</td></tr>
                      <tr><td>slider 滑条</td><td>template / sendMode(ascii|hex) / min / max / step / defaultValue / sendTrigger(onRelease|continuous) / minIntervalMs / useScript / script</td></tr>
                      <tr><td>button 按钮</td><td>template / sendMode / holdRepeat(长按连发) / minIntervalMs / useScript / script</td></tr>
                      <tr><td>switch 开关</td><td>positions(2|3) / templates[] / labels[] / sendMode / state / useScript / script</td></tr>
                      <tr><td>led 指示灯</td><td>varName / op(gt|ge|lt|le|eq|ne) / value / strValue / onColor</td></tr>
                      <tr><td>buzzer 蜂鸣器</td><td>varName / op / value / strValue / onColor / freq / volume / durationMs / repeat</td></tr>
                      <tr><td>monitor 数值监视</td><td>varName / unit / decimals</td></tr>
                      <tr><td>joystick 摇杆</td><td>template(%x,%y) / sendMode / range / minIntervalMs / springBack / useScript / script</td></tr>
                    </tbody>
                  </table>
                  <pre>{`[{
  "id": "…", "name": "控制页 1", "cols": 12, "rows": 12, "locked": false,
  "cards": [{
    "id": "…", "type": "slider", "name": "油门",
    "x": 0, "y": 0, "w": 2, "h": 1,
    "template": "PWM:%.2f!", "sendMode": "ascii",
    "min": 0, "max": 100, "step": 1, "defaultValue": 50,
    "sendTrigger": "onRelease", "minIntervalMs": 50,
    "useScript": false, "script": ""
  }]
}]`}</pre>
                </Section>
                <Section title="命令库（kind = uartix-commands）">
                  <p>data 为分组数组，<b>递归树</b>：节点含 <code>items</code> 即分组，否则为命令。导入按顶层分组名合并，重名自动改名。</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>分组节点</td><td>{"{ id, name, items: [子节点…] }"}，items 可继续嵌套分组</td></tr>
                      <tr><td>命令节点</td><td>id / name / template（发送串）/ sendMode(ascii|hex) / note / script / scriptEnabled</td></tr>
                    </tbody>
                  </table>
                  <pre>{`[{
  "id": "…", "name": "电机控制",
  "items": [
    { "id": "…", "name": "复位", "template": "RST!",
      "sendMode": "ascii", "note": "下位机复位", "script": "", "scriptEnabled": false },
    { "id": "…", "name": "子分组", "items": [ /* … */ ] }
  ]
}]`}</pre>
                </Section>
              </>
            )}
            {tab === "operator" && (
              <>
                <Section title="什么是 Operator 部署包（.uopk）">
                  <p><b>.uopk</b> 是 Uartix+ 的工作区发行物：把工程师在开发机上调好的<b>协议模板、控制页、命令库、面板布局与外观设置</b>打包成一个文件，交给现场操作员。操作员端导入后以<b>只读模式</b>运行——可以连接设备、发命令、看数据，但改不了任何配置，保证现场与调试环境一致、不误触。</p>
                </Section>
                <Section title="生成部署包（工程机）">
                  <ol className="help-ol">
                    <li>先把工作区调好：协议能解析、控制页与命令库可用、面板布局满意。</li>
                    <li>打开<code>设置 → 数据</code>，找到 <code>Operator 部署包（.uopk）</code> 块。</li>
                    <li>填<b>包名</b>与<b>说明</b>（会显示在操作员端横幅），勾选要进包的部件：协议模板 / 控制页 / 命令库 / 面板布局 / 外观设置 / 3D 面板设置——<b>至少勾一项</b>才能生成（空包等于把对方永久锁进只读）。</li>
                    <li>点<code>生成部署包</code>，保存为 <code>.uopk</code> 文件。</li>
                  </ol>
                  <p className="help-tip">随包的设置只含外观与交互子集（主题、语言、小数位、工作区预设、曲线配色、自动重连等）；AI 密钥、MCP 端口、窗口缩放等本机私有项不会进包。</p>
                </Section>
                <Section title="导入与运行（操作员机）">
                  <ol className="help-ol">
                    <li><b>方式一</b>：<code>设置 → 数据 → 导入并运行</code>，选择 .uopk 文件。</li>
                    <li><b>方式二</b>：直接<b>双击</b> .uopk 文件（安装版已注册文件关联）。应用未启动时会自动拉起；已启动时在当前窗口打开并聚焦，同一包不会重复导入。</li>
                    <li>导入后进入<b>只读模式</b>：标题栏横幅显示包名与退出按钮；协议、控制页、命令库替换为包内容；布局整屏应用。</li>
                    <li>重启应用会自动恢复该部署包（保持只读），直到点横幅上的<code>退出</code>。</li>
                  </ol>
                </Section>
                <Section title="只读模式：能做什么 / 不能做什么">
                  <table className="help-table">
                    <tbody>
                      <tr><td>能做</td><td>连接串口 / 网络 / BLE 设备；用控制页与命令库发指令；看帧画布、数据表格、2D 曲线、频谱等全部观测面板；哨兵监测照常运行；编排器<b>可运行</b>（运行按钮手动跑、组照常触发，向设备发数据）、3D 校准<b>操作</b>（采样/拟合/六面）放行</td></tr>
                      <tr><td>不能做</td><td>编辑/新建协议模板与字段；增删改控制页卡片、命令库与编排<b>结构</b>（组/事件/块/变量）；修改 3D 轴绑定与设置；修改设置；导入其它配置文件（改动都会被拦截并提示「Operator 模式：配置只读」——守卫在 store 层，AI/MCP/扩展面板等一切调用方同等受约束）</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="退出只读模式">
                  <p>点标题栏横幅上的<code>退出</code>：解锁并清除持久化的部署包。<b>已导入的协议、控制页、命令库会保留在界面中</b>，此时可像普通工程模式一样继续编辑——适合把现场配置拿回来二改。</p>
                </Section>
              </>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <span />
          <button className="btn primary" onClick={onClose}>{tx("开始使用", "Get Started")}</button>
        </div>
      </div>
    </div>
  );
}
