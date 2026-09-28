/**
 * P104-B7 首启欢迎轮播：两张卡的**内容数据**。
 *
 * 为什么单独一个 `.ts`（不塞进 `Welcome.tsx`）：
 * 1. 组件文件混导出常量会让 Fast Refresh 整页失效（`railState.ts` 头讲的就是这个坑）；
 * 2. 徽标坐标与锚点是**要被门禁读的事实**，测试引数据比引组件轻得多（不用 render）。
 *
 * 文案为什么写成 `{ zh, en }` 而不是 `tx()`：与 `tourSteps.ts` 同一族——这是渲染层之外的
 * 数据模块，`tx()` 在那边只有一路中文可写。`check-i18n` 的口径第 1 条也不把 `.ts` 算进 UI 串。
 *
 * ⚠ 卡 2 的底图是**截图**，会过期。三道防线里这一文件占两道：
 *  - `SHOT_FACTS`：图里印着的词 + 它的声明行，改名不改图 ⇒ `welcome.test.ts` 判红；
 *  - `badges[].anchor`：徽标指的那个东西还在不在源码里 ⇒ 同一条测试判红。
 *  拦不住的是"东西还在但挪了位置"——那靠 `npm run welcome:snap` 重拍 + 交付时实拍。
 *
 * 尾部的 `welcomeSeen()/markWelcomeSeen()` 是壳层状态，放这儿而不是 `Welcome.tsx`：
 * 组件文件混导出函数会让 Fast Refresh 整页失效（本文件头第 1 条讲的就是它）。
 */

/** 徽标指向的界面元素。`kind` 决定测试去源码里找什么。 */
export type ShotAnchor =
  | { kind: "class"; value: string }
  | { kind: "panel"; value: string };

export interface ShotBadge {
  /** 编号，与 `leads` 同序（图上那个圆里的数字） */
  n: number;
  /** 相对底图宽高的比例（底图 1440×900）；用比例而不是 px ⇒ 缩放档下与图同步缩放 */
  x: number;
  y: number;
  anchor: ShotAnchor;
}

export interface WelcomeSlide {
  id: string;
  title: { zh: string; en: string };
  /** 编号要点。卡 2 里第 i 条与 `badges[i]` 同号。 */
  leads: { zh: string; en: string }[];
  badges?: ShotBadge[];
}

/**
 * 卡 1 的管线四节点。
 *
 * 文案住在 `.ts` 而不是 `Welcome.tsx`：`check-i18n` 只扫渲染层（`.tsx`），
 * 组件里写一份 `{ zh, en }` 字面量就会被判"未翻译"——那不是门的错，是**放错了地方**：
 * 两张卡的文案本来就该在同一处，卡 2 的在 `WELCOME_SLIDES`，卡 1 的没理由例外。
 */
export interface PipeNode {
  /** `shared/icons.tsx` 里的出处名，渲染层按名取组件（数据模块不引 JSX，见文件头第 1 条） */
  icon: "plug" | "frame" | "lanes" | "monitor";
  zh: string;
  en: string;
  subZh: string;
  subEn: string;
}

export const PIPELINE_NODES: readonly PipeNode[] = [
  { icon: "plug", zh: "字节流", en: "Bytes", subZh: "串口 · TCP · 演示源", subEn: "serial · TCP · demo" },
  { icon: "frame", zh: "筛帧", en: "Frames", subZh: "协议模板校验", subEn: "template-checked" },
  { icon: "lanes", zh: "字段", en: "Fields", subZh: "温度 · 转速 · CRC", subEn: "temp · rpm · CRC" },
  { icon: "monitor", zh: "用它", en: "Use it", subZh: "曲线 · 表格 · 3D · 指令", subEn: "plot · table · 3D · send" },
];

export const WELCOME_SEEN_KEY = "vs.welcome.seen";

/**
 * 读/写"首启欢迎已看过"。
 *
 * 容错口径与 `tourStore` 原来那份一致：拿不到 localStorage 时**当作已看过**，
 * 因为这条是"要不要挡在第一次打开的人面前"的判断，读不到就别挡。
 */
export function welcomeSeen(): boolean {
  try {
    return localStorage.getItem(WELCOME_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
  } catch {
    /* 无痕模式：内存里关掉就够了，下次启动本来也是无痕 */
  }
}

/** 底图尺寸：`gen-welcome-shot.mjs` 与徽标坐标共用这一份，漂了坐标就全错 */
export const SHOT_W = 1440;
export const SHOT_H = 900;

export const WELCOME_SLIDES: WelcomeSlide[] = [
  {
    id: "pipeline",
    title: { zh: "字节怎么变成曲线和指令", en: "From bytes to curves and commands" },
    leads: [
      {
        zh: "三条源：串口 / TCP / 内置演示源。演示源不需要硬件，今天就能看见东西在动。",
        en: "Three sources: serial, TCP, or the built-in demo — the demo needs no hardware, so something moves today.",
      },
      {
        zh: "协议模板把字节流切成完整帧，坏帧进不来，后面的图和表才可信。",
        en: "Protocol templates carve the stream into frames; bad frames never reach your charts.",
      },
      {
        zh: "解析出的字段是这里唯一流通的东西——曲线、控件、AI 说的都是它。",
        en: "Parsed fields are the only currency here — charts, widgets and the AI all speak them.",
      },
      {
        zh: "同一批字段四种用法：表格、曲线、3D，外加反向发指令回到设备。",
        en: "One set of fields, four uses: table, plot, 3D — plus commands back to the device.",
      },
    ],
  },
  {
    id: "interface",
    title: { zh: "界面在哪", en: "Where things live" },
    leads: [
      {
        zh: "左侧导轨五类抽屉：接入、协议、控件、命令、视图。",
        en: "Five drawers on the rail: link, protocol, widgets, commands, views.",
      },
      {
        zh: "第二条栏是干活的那条：当前工作区、接口与连接、录制回放，最右边那枚「+ 面板」下拉把面板加回来。",
        en: "The second bar is the working one: workspace, interface and connect, recording - and the “+ Panel” dropdown at its right end brings panels back.",
      },
      {
        zh: "帧画布上框选字节 → 右键定义为字段，零代码定义私有协议。",
        en: "Drag over bytes in the frame canvas, right-click to define a field. No code.",
      },
      {
        zh: "下面三块是产出：数据表格、2D 曲线、控制画布。",
        en: "The bottom row is the output: table, 2D plot, control canvas.",
      },
    ],
    badges: [
      { n: 1, x: 0.026, y: 0.222, anchor: { kind: "class", value: "rail2" } },
      { n: 2, x: 0.208, y: 0.059, anchor: { kind: "class", value: "tbar" } },
      { n: 3, x: 0.417, y: 0.278, anchor: { kind: "panel", value: "framecanvas" } },
      { n: 4, x: 0.556, y: 0.545, anchor: { kind: "panel", value: "plot2d" } },
    ],
  },
];

/**
 * 底图上**印着**的每个词，以及它今天在哪个文件的哪一行声明。
 *
 * 截图不会跟着改名走，而十道门没有一道看得懂像素——所以把"图与事实不符"里
 * 可判的那半钉成测试（详设 §5）。只钉结构性名词（导轨项 / 栏上按钮 / 面板页签），
 * 不钉空态句子：那些字在图里小到看不清，钉了只会让门天天红。
 *
 * 为什么是 `{ word, file, key }` 三元组而不是一个词表：第一版只查"这个词还在 `src` 里吗"，
 * 证伪当场失败——把工具栏那颗 `tx("录会话", "Record")` 改成「录日志」，门**没红**，
 * 因为同一句"回放中无法录会话"还留在它上面的 tooltip 里。
 * **一个词在仓库里活着 ≠ 图上那个位置还叫这个名字**，所以必须落到文件 + 声明行。
 */
export interface ShotFact {
  /** 图上看到的那个词 */
  word: string;
  /** 相对 `src/` 的声明处 */
  file: string;
  /** 声明行的识别符（面板 id / 导轨 key / 中心键名 / 类名 / 英文孪生串）；与 `word` 同行才算数 */
  key: string;
}

export const SHOT_FACTS: readonly ShotFact[] = [
  { word: "Uartix+", file: "shell/TopBars.tsx", key: "tb-brand" },
  { word: "协议调试", file: "i18n/strings.ts", key: "set.preset.proto" },
  { word: "连接", file: "i18n/strings.ts", key: "tb.connect" },
  { word: "录制回放", file: "App.tsx", key: "Record" },
  { word: "未连接", file: "i18n/strings.ts", key: "st.disconnected" },
  { word: "接入", file: "shell/railState.ts", key: "link" },
  { word: "协议", file: "shell/railState.ts", key: "templates" },
  { word: "控件", file: "shell/railState.ts", key: "widgets" },
  { word: "命令", file: "shell/railState.ts", key: "commands" },
  { word: "视图", file: "shell/railState.ts", key: "views" },
  { word: "帧画布", file: "panels/panels.tsx", key: "framecanvas" },
  { word: "Hex 数据流", file: "panels/panels.tsx", key: "hexview" },
  { word: "控制台", file: "panels/panels.tsx", key: "console" },
  { word: "属性", file: "panels/panels.tsx", key: "properties" },
  { word: "数据表格", file: "panels/panels.tsx", key: "table" },
  { word: "2D 曲线", file: "panels/panels.tsx", key: "plot2d" },
  { word: "控制画布", file: "panels/panels.tsx", key: "controls" },
  // P115：底图右上角那枚「+ 面板」下拉是工具栏布局段里的一个 `<select>`（App.tsx），
  // 不是导轨「视图」的替代品——两处入口并存。图上印着它，所以它也得进这张表：
  // 哪天改名或删掉而不重拍，这条就红。
  { word: "+ 面板", file: "App.tsx", key: "+ Panel" },
];
