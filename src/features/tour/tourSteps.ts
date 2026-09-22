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
  do?: () => void | Promise<void>;
  settleMs?: number;
};

const CONTENT: RawStep[] = [
  {
    id: "connect",
    title: { zh: "连接设备", en: "Connect" },
    body: {
      zh: "标题条选数据接口（串口 / TCP / UDP / BLE），工具栏设好参数后点这个「连接」按钮。没有硬件？直接点「下一步」，我们用内置演示源。",
      en: "Pick an interface in the title bar, set parameters, then hit Connect. No hardware? Just continue — we'll use the built-in demo source.",
    },
    selector: '[data-tour="connect"]',
  },
  {
    id: "demo",
    title: { zh: "启动演示源", en: "Demo source" },
    body: {
      zh: "演示源已开始生成混合协议数据流（匿名 V7 + 维特 WIT + CSV + Modbus，含坏帧）。左下角这个按钮随时可以停。",
      en: "The demo source now streams mixed protocols (V7 + WIT + CSV + Modbus, with bad frames). This button toggles it.",
    },
    selector: '[data-tour="demo"]',
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
  },
  {
    id: "framecanvas",
    title: { zh: "帧画布：拖拽定义协议", en: "Frame canvas" },
    body: {
      zh: "这里是核心交互：在字节格上按住左键框选 → 右键「定义为字段」，零代码定义私有协议。绿色是数据字段、橙是帧头、粉是校验，悬停看实时值。",
      en: "The core interaction: drag over byte cells, right-click → define field. Zero-code private protocols. Green = data, orange = header, pink = checksum.",
    },
    selector: '[data-panel="framecanvas"]',
    do: openPanel("framecanvas"),
    settleMs: 800,
  },
  {
    id: "plot",
    title: { zh: "2D 曲线：点亮即绘图", en: "2D plot" },
    body: {
      zh: "左侧字段图例点眼睛即实时绘图；曲线支持拖动回看、双击回实时、游标测量。选中通道后还能在「频谱分析」面板做 FFT。",
      en: "Toggle the eye icon on a field to plot it live. Drag to pan, double-click to follow, cursors to measure. Spectrum panel does FFT on any channel.",
    },
    selector: '[data-panel="plot2d"]',
    do: openPanel("plot2d"),
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
    do: openPanel("controls"),
    settleMs: 800,
  },
  {
    id: "ai",
    title: { zh: "AI 助手：两层选择决定它动多少", en: "AI assistant" },
    body: {
      zh:
        "配好 API Key 后，输入框下方那颗 pill 是 Agent 的唯一入口，里面是两个各自独立的选择：先选「普通对话 / Agent 任务」（要不要让它动手），再选授权档「仅预览 / 界面创造 / 全权执行」（它能改什么）；要中间态就展开 pill 里的「高级 · 具体授权域」逐项勾。Agent 任务会读这个软件自己的现状（连接、协议字段、控件、帧统计，每轮重读一次），也会改设置、画界面；发送、删除、覆盖、命令行仍然一条条弹批准卡。",
      en:
        "With an API key, the pill under the input is the only Agent entry, and it holds two independent choices: 普通对话 / Agent 任务 (should it act at all), then 仅预览 / 界面创造 / 全权执行 (how much it may change); 高级 lets you tick domains. A task re-reads the app's own state each round, and writes, deletes and shell calls still ask you one by one.",
    },
    selector: '[data-tour="ai"]',
  },
  {
    id: "create",
    title: { zh: "让它造东西，也给它装东西", en: "Let it build things" },
    body: {
      zh:
        "同一条 Agent 任务能把成果存成插件留在你机器上：主题 / 小部件 / 面板 / 工作区预设 / 任务模板，存下就自动启用，之后在 设置 → 插件管理 统一启停、导出、退回上一版。带 JS 的「逻辑模块」是例外——它跑在专用 Worker 里、启用前先自证封网，永远不会自动启用，要你自己点一次。",
      en:
        "The same task can save its output as local plugins: themes / widgets / panels / workspace presets / task templates auto-enable and are managed under 设置 → 插件管理. JS-bearing 逻辑模块 never auto-enables — it runs in a dedicated Worker and must prove its network lockdown first.",
    },
    selector: '[data-tour="ai"]',
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
    zh: "进阶玩法：自动编排器搭自动化、3D 轨迹看姿态、虚拟设备工坊无硬件仿真、录制定整场会话随时回放。帮助（? ）里可随时重看本引导，AI 与插件的细节在「AI 助手详解」「插件与创造」两页。",
    en: "Next: orchestrator for automation, 3D trajectory, the virtual device workshop for hardware-free testing, and session recording/replay. Replay this tour from Help (?); the AI and plugin pages go deeper.",
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
