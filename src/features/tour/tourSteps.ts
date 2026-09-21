/**
 * 教学引导步骤定义（P78a）：纯数据 + 动作回调。
 *
 * 步骤设计原则（用户视角）：每步只讲一件事；带 do() 的步骤软件自己先动起来，
 * 用户只需要看高亮处 + 点「下一步」；随时 Esc 退出不留痕迹。
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

export const TOUR_STEPS: tourStore.TourStep[] = [
  {
    id: "welcome",
    title: { zh: "欢迎使用 Uartix+", en: "Welcome to Uartix+" },
    body: {
      zh: "这是一台嵌入式可视化上位机：定义协议 → 自动筛选有效帧 → 在干净数据上画曲线、发指令。接下来 8 步带你走通主流程（约 2 分钟），随时按 Esc 退出。",
      en: "Uartix+ turns raw bytes into live curves and commands. The next 8 steps walk the main flow (~2 min); press Esc anytime to quit.",
    },
  },
  {
    id: "connect",
    title: { zh: "第 1 步 · 连接设备", en: "Step 1 · Connect" },
    body: {
      zh: "标题条选数据接口（串口 / TCP / UDP / BLE），工具栏设好参数后点这个「连接」按钮。没有硬件？直接点「下一步」，我们用内置演示源。",
      en: "Pick an interface in the title bar, set parameters, then hit Connect. No hardware? Just continue — we'll use the built-in demo source.",
    },
    selector: '[data-tour="connect"]',
  },
  {
    id: "demo",
    title: { zh: "第 2 步 · 启动演示源", en: "Step 2 · Demo source" },
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
    title: { zh: "第 3 步 · 导入协议", en: "Step 3 · Import a protocol" },
    body: {
      zh: "「＋ 预设」里选一个协议（如 匿名 V7 / 维特 WIT / Modbus RTU）。导入的是可编辑副本——改崩了删掉副本重新导入即可，预设源头永不污染。",
      en: "Pick a preset protocol (V7 / WIT / Modbus RTU…). Imports are editable copies — break one, delete and re-import; presets stay pristine.",
    },
    selector: '[data-tour="preset"]',
  },
  {
    id: "framecanvas",
    title: { zh: "第 4 步 · 帧画布：拖拽定义协议", en: "Step 4 · Frame canvas" },
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
    title: { zh: "第 5 步 · 2D 曲线：点亮即绘图", en: "Step 5 · 2D plot" },
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
    title: { zh: "第 6 步 · 控制画布：反向发指令", en: "Step 6 · Control canvas" },
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
    title: { zh: "第 7 步 · AI 助手：说出即发生", en: "Step 7 · AI assistant" },
    body: {
      zh: "配置好 API Key 后，AI 能识别协议、生成指令/卡片/编排，还能直接操作本软件（打开面板、写入配置）。标题栏星形按钮或 Ctrl+K 唤起。\n输入框下方的 pill 有两层选择：先用「普通对话 / Agent 任务」决定要不要让它动手，再用「仅预览 / 放手改界面 / 全面放手」授权。不确定就先选「仅预览」，看它打算怎么做再放开。",
      en: "With an API key, the AI recognizes protocols, generates commands/cards/flows, and operates the app directly. Star button or Ctrl+K.\nThe pill under the input has two choices: first 普通对话 / Agent 任务 (should it act at all), then 仅预览 / 放手改界面 / 全面放手 (how much power). Unsure? Pick 仅预览 first and watch what it plans.",
    },
    selector: '[data-tour="ai"]',
  },
  {
    id: "done",
    title: { zh: "完成 · 去哪继续", en: "Done · Where to go next" },
    body: {
      zh: "进阶玩法：自动编排器搭自动化、3D 轨迹看姿态、虚拟设备工坊无硬件仿真、录制定整场会话随时回放。帮助（? ）里可随时重看本引导。",
      en: "Next: orchestrator for automation, 3D trajectory, the virtual device workshop for hardware-free testing, and session recording/replay. Replay this tour from Help (?).",
    },
  },
];
