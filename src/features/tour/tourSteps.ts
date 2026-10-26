/**
 * 教学引导步骤定义（P78a，P99a-D2 回写）。
 *
 * 步骤设计原则（用户视角）：每步只讲一件事；带 do() 的步骤软件自己先动起来，
 * 用户只需要看高亮处 + 点「下一步」；随时 Esc 退出不留痕迹。
 *
 * **编号与步数一律派生**（D2）：欢迎语里的"接下来 N 步"、每条标题的"第 i 步"都由数组算出来。
 * 之前它们是手写的，于是出现过三种口径打架：欢迎语说 8 步、`TourOverlay` 显示"共 9 步"、
 * 标题手工编号只排到第 7 步——加一步就要改三处，漏一处就是错话（`tourSteps.test.ts` 钉这条）。
 */
import * as tourStore from "./tourStore";
import { requestOpenPanel } from "../ai/appBus";
import * as templateStore from "../protocol/templateStore";
import type { RailKey } from "../../shell/railState";

const openPanel = (panel: Parameters<typeof requestOpenPanel>[0]) => () => {
  requestOpenPanel(panel);
};

/** 演示源没开就开（已开则保持，步骤文案两态通用） */
const ensureDemo = () => () => {
  if (!templateStore.getSnapshot().demoRunning) void templateStore.toggleDemo();
};

/** 首尾两张卡不参与"第 N 步"编号 */
const WELCOME_ID = "welcome";
const DONE_ID = "done";

type RawStep = {
  id: string;
  title: { zh: string; en: string };
  body: { zh: string; en: string };
  selector?: string;
  /** 锚点住在导轨二级面板里时声明这一项：导览会先把它展开（见 `tourStore.TourStep.rail`） */
  rail?: RailKey;
  /** 环扩到目标那组面板的停靠框外框（面板类步骤用；见 `tourStore.TourStep.frame`） */
  frame?: boolean;
  do?: () => void | Promise<void>;
  settleMs?: number;
};

const CONTENT: RawStep[] = [
  {
    id: "connect",
    title: { zh: "连接设备", en: "Connect" },
    body: {
      // 「这个连接按钮」以前是句谎话：环落在顶部工具栏那颗钮上，文案却说在左侧「接入」里，
      // 而且 TCP / UDP / BLE 三种接口当时根本没有锚点可圈（见 ifaces.tsx 的 data-tour）。
      zh: "接口与参数在左侧「接入」里选、在这里填；真去连，按的是圈着的这颗「连接」钮（它在顶部工具栏，四种接口共用这一颗）。没有硬件？直接点「下一步」，我们用内置演示源。",
      en: "Pick the interface and fill its parameters in the Link panel on the left; the button circled here is what actually opens it (it lives in the toolbar and all four interfaces share it). No hardware? Just continue - we'll use the built-in demo source.",
    },
    selector: '[data-tour="connect"]',
    rail: "link",
  },
  {
    id: "demo",
    title: { zh: "启动演示源", en: "Demo source" },
    body: {
      zh: "演示源已开始生成混合协议数据流（匿名 V7 + 维特 WIT + CSV + Modbus，含坏帧）。左侧「协议」底部这个按钮随时可以停。",
      en: "The demo source now streams mixed protocols (V7 + WIT + CSV + Modbus, with bad frames). This button at the bottom of the Protocol panel toggles it.",
    },
    selector: '[data-tour="demo"]',
    rail: "templates",
    do: ensureDemo(),
    settleMs: 900,
  },
  {
    id: "preset",
    title: { zh: "导入协议", en: "Import a protocol" },
    body: {
      zh: "「＋ 预设」里选一个协议（如 匿名 V7 / 维特 WIT / Modbus RTU）。导入的是可编辑副本——改崩了删掉副本重新导入即可，预设源头永不污染。",
      en: "Pick a preset protocol (V7 / WIT / Modbus RTU…). Imports are editable copies — break one, delete and re-import; presets stay pristine.",
    },
    selector: '[data-tour="preset"]',
    rail: "templates",
  },
  {
    id: "framecanvas",
    title: { zh: "帧画布：拖拽定义协议", en: "Frame canvas" },
    body: {
      zh: "这里是核心交互：在字节格上按住左键框选 → 右键「定义为字段」，零代码定义私有协议。绿色是数据字段、橙是帧头、粉是校验，悬停看实时值。",
      en: "The core interaction: drag over byte cells, right-click → define field. Zero-code private protocols. Green = data, orange = header, pink = checksum.",
    },
    selector: '[data-panel="framecanvas"]',
    frame: true,
    do: openPanel("framecanvas"),
    settleMs: 800,
  },
  {
    id: "plot",
    title: { zh: "2D 曲线：点亮即绘图", en: "2D plot" },
    body: {
      zh: "「协议」面板下半区的字段图例里点眼睛即实时绘图；曲线支持拖动回看、双击回实时、游标测量。选中通道后还能在「频谱分析」面板做 FFT。",
      en: "Toggle the eye icon on a field in the legend under Protocol to plot it live. Drag to pan, double-click to follow, cursors to measure. Spectrum panel does FFT on any channel.",
    },
    selector: '[data-panel="plot2d"]',
    frame: true,
    do: openPanel("plot2d"),
    settleMs: 800,
  },
  {
    id: "sendbuild",
    title: { zh: "TX组帧台：拖块组一帧要发的", en: "TX Frame Builder" },
    body: {
      zh: "发侧与收侧对称：从料板把帧头/数值/长度域/校验段摆上字节带，每块的值取固定字节、参数或自增序号；参数有默认值，那就是发出去的值。底部预览就是上线的字节，「存为指令」存的是一条引用——改这张谱，命令、序列器里那一步、控制画布上生成的卡片一起变。",
      en: "The send-side twin of the frame canvas: drag header, numbers, a length field and a checksum onto the byte strip; each block is fed by a constant, a parameter or an auto counter, and a parameter's default is exactly what goes out. The preview is the bytes that hit the wire, and Save as command stores a reference — edit the template and the command, the sequencer step and the generated card all follow.",
    },
    selector: '[data-panel="sendbuild"]',
    frame: true,
    do: openPanel("sendbuild"),
    settleMs: 800,
  },
  {
    id: "controls",
    title: { zh: "控制画布：反向发指令", en: "Control canvas" },
    body: {
      zh: "滑条/按钮/开关引用已解析的字段变量，点击即向设备发格式化指令——双向闭环调试的上行半边。",
      en: "Sliders/buttons/switches reference parsed variables and send formatted commands — the downstream half of the closed loop.",
    },
    selector: '[data-panel="controls"]',
    frame: true,
    do: openPanel("controls"),
    settleMs: 800,
  },
  {
    id: "ai",
    title: { zh: "AI 助手：两层选择决定它动多少", en: "AI assistant" },
    body: {
      zh:
        "配好 API Key 后，输入框下方那颗 pill 是 Agent 的唯一入口，里面是两个各自独立的选择：先选「普通对话 / Agent 任务」（要不要让它动手），再选授权档「仅预览 / 界面创造 / 全权执行」（它能改什么）；要中间态就展开 pill 里的「高级 · 具体授权域」逐项勾。Agent 任务会读这个软件自己的现状（连接、协议字段、控件、帧统计，每轮重读一次），也会改设置、画界面；到「全权执行」它就不再来烦你，只有实车发送、急停校准和它自己的权限开关仍然一条条弹批准卡。",
      en:
        "With an API key, the pill under the input is the only Agent entry, and it holds two independent choices: 普通对话 / Agent 任务 (should it act at all), then 仅预览 / 界面创造 / 全权执行 (how much it may change); 高级 lets you tick domains. A task re-reads the app's own state each round; on 全权执行 it stops interrupting you, and only sending to real hardware, safety actions and its own permission switches still ask one by one.",
    },
    selector: '[data-tour="ai"]',
  },
  {
    id: "create",
    title: { zh: "让它造东西，也给它装东西", en: "Let it build things" },
    body: {
      zh:
        "同一条 Agent 任务能把成果存成插件草稿：面板 / 主题 / 小部件 / 工作区预设 / 任务模板。草稿不是插件——不进已装清单、不能启动；可以先在草稿行点「预览」看效果，再点「转正为插件」并过权限批准卡。装进来默认停用，启用后它的面板才会进「+ 面板」；主题插件也是同一道启用门，启用并批准后它的主题才会出现在 设置 → 外观。",
      en:
        "The same task can save its output as plugin drafts: panels / themes / widgets / workspace presets / task templates. A draft is not an installed plugin — it cannot start; preview it first, then choose Convert to plugin and pass the permission card. Installed plugins start disabled; a panel joins + Panel and a theme plugin's themes enter Settings → Appearance only after you enable (and approve) it.",
    },
    selector: '[data-tour="ai"]',
  },
  {
    // P99b-N6：这一条指的是标题栏那颗，不是 AI 那颗——"别人的东西进我的机器"与"AI 造的东西"是两条信任链
    id: "market",
    title: { zh: "装东西的地方", en: "Where packages come from" },
    body: {
      zh:
        "标题栏这颗开「插件管理」；里面那颗「插件市场」按 GitHub 话题 uartix-plugin 检索，卡片带仓库封面，点开能看 README 预览。安装前逐条列出权限并要求批准，装进来是停用态，还要你启用才会生效。市场只在打开并搜索时联网。",
      en:
        "This title-bar button opens plugin management; its market searches the GitHub topic uartix-plugin, shows repo covers and README previews. Installing lists permissions and requires approval; packages land disabled until you enable them. The market is online only while you open and search it.",
    },
    selector: '[data-tour="plugins"]',
  },
];

const WELCOME: RawStep = {
  id: WELCOME_ID,
  title: { zh: "欢迎使用 Uartix+", en: "Welcome to Uartix+" },
  body: {
    zh: `这是一台嵌入式可视化上位机：定义协议 → 自动筛选有效帧 → 在干净数据上画曲线、发指令。接下来 ${CONTENT.length} 步带你走通主流程（约 2 分钟），随时按 Esc 退出。`,
    en: `Uartix+ turns raw bytes into live curves and commands. The next ${CONTENT.length} steps walk the main flow (~2 min); press Esc anytime to quit.`,
  },
};

const DONE: RawStep = {
  id: DONE_ID,
  title: { zh: "完成 · 去哪继续", en: "Done · Where to go next" },
  body: {
    // 「帮助（? ）」那半句是假的：全软件没有 ? 这个键位（B12 之后帮助只有按钮与命令面板两条路）。
    zh: "进阶玩法：自动编排器搭自动化、3D 轨迹看姿态、虚拟设备工坊无硬件仿真、录制定整场会话随时回放；标题栏那颗拼图开的是「插件管理」，从那里进「插件市场」搜 GitHub 话题（只有打开并搜索时才联网）。想重看本引导：标题栏的「帮助」顶部那颗按钮，或按 Ctrl+Shift+P 搜「重播入门引导」。AI 与插件的细节在「AI 助手详解」「插件与创造」「插件市场」三页。",
    en: "Next: the orchestrator for automation, 3D trajectories, the virtual device workshop for hardware-free testing, and session recording/replay. The puzzle button in the title bar opens plugin management, where the market searches GitHub topics (online only while you search). To replay this tour use the button at the top of Help, or press Ctrl+Shift+P and search for the guided tour. The AI and plugin details live on the AI, plugins and market pages.",
  },
};

/** 对外的一步 = 原始定义 + 派生出来的「第 N 步」前缀 */
export const TOUR_STEPS: tourStore.TourStep[] = [
  WELCOME,
  ...CONTENT.map((s, i) => ({
    ...s,
    title: {
      zh: `第 ${i + 1} 步 · ${s.title.zh}`,
      en: `Step ${i + 1} · ${s.title.en}`,
    },
  })),
  DONE,
];
