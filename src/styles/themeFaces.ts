/**
 * P150 · 主题面表：把"所有区域都要覆盖到"从一句人话变成一张能对账的表。
 *
 * 为什么要它：用户列过一串名词（面板/侧边栏/…/表单 + 基础控件 + 分层背景），而"覆盖到了吗"
 * 此前只能靠肉眼。肉眼那次说"看起来啥也没变"。这张表的每一行都要回答三问，答不上就是**登记在册的缺口**
 * （可见的失败，不是隐身的失败）：
 *   ① 这一面在屏幕上真的存在吗？不存在的话，代替它的是什么？（不许留空蒙过去）
 *   ② 主题够得着它吗——走签名槽 / 宿主词汇 / 令牌，还是只能逐类点名？
 *   ③ 它有哪几档状态需要被覆盖？
 *
 * 判据在 `themeFaces.test.ts`：探针必须是 `.tools/class-census.json` 里**运行时真渲染过**的类名
 * （CSS 里存在不等于屏幕上存在——本表已经把 `.tb-menu`、`.seg` 这两枚"有规则没渲染点"的排除在探针之外）。
 */

/** 主题够得着这一面的途径。`name` = 只能逐类点名（那是未来每枚主题都要重犯的债）。 */
export type FaceHandle = "slot" | "hook" | "token" | "name" | "none";

export interface ThemeFace {
  id: string;
  zh: string;
  /** false = 用户列了，但本仓没有这一面；`instead` 必须说清代替是什么 */
  exists: boolean;
  instead?: string;
  /** 探针：一个运行时真的存在的类名（不带点），闭合测试拿它对着普查账本核 */
  probe?: string;
  /** 探针落在普查的 14 面之外（sentinel/modbus/plot3d/xfer/orchestrator 这几族没跑过），标出来别当已证 */
  probeUnverified?: boolean;
  via: FaceHandle[];
  states: string[];
  /** 诚实栏：已知缺口、死钩子、寄生关系 */
  note?: string;
}

/** 交互态的常用组合，省得每行重抄一遍（重抄就是等着漂） */
const CTL = ["rest", "hover", "active", "focus-visible", "disabled", "on"];

export const THEME_FACES: readonly ThemeFace[] = [
  /* ---------------- 区 ---------------- */
  { id: "panel", zh: "面板", exists: true, probe: "dv-groupview", via: ["token", "name"], states: ["active", "inactive", "hover"],
    note: "dockview 画的壳；观感走它公开的 --dv-* 入口，不是覆写私有类名（builtinStyles/fluent.css:83）" },
  { id: "railPanel", zh: "侧边栏（二级面板）", exists: true, probe: "rail-panel", via: ["token", "name"], states: ["rest", "hover"],
    note: "面板本体只有底色与 sash 两档状态" },
  { id: "navbar", zh: "导航栏", exists: false, instead: "导轨（rail2）+ 页签条（dv-tab / ctl-tabs）+ 设置页左导航 set-nav",
    probe: "set-nav", via: ["name"], states: ["rest", "hover", "on"],
    note: "本仓没有『导航栏』这一面；set-nav 是设置页里的导航，不是全局导航" },
  { id: "rail", zh: "导轨", exists: true, probe: "rail2-btn", via: ["slot", "hook", "name"], states: ["rest", "hover", "on"],
    note: "缺 focus-visible 与 disabled 两档规则；按压走 --ctl-press-tight" },
  { id: "toolbar", zh: "工具栏", exists: true, probe: "tb-btn", via: ["slot", "hook", "name"], states: CTL,
    note: "壳层 .tbar/.ibar 与面板内 .p-bar 是两层，幽灵化各自一套；面板自有工具栏另有 .fc-toolbar 一族" },
  { id: "menubar", zh: "菜单栏", exists: false, instead: "身份栏图标键 .tb-btn + 它下拉出来的 .tb-menu-item",
    probe: "tb-menu-item", via: ["slot", "name"], states: ["rest", "hover", "on"],
    note: ".tb-menu 有 CSS 规则但全仓无渲染点（死钩子），不能当探针" },
  { id: "statusbar", zh: "状态栏", exists: true, probe: "statusbar", via: ["token", "name"], states: ["rest", "hover", "err"],
    note: "底走 --elevation-1；可点的是 .ib-count 那几个计数，走总线" },
  { id: "tabs", zh: "标签页", exists: true, probe: "ctl-tab", via: ["slot", "hook", "name"], states: ["rest", "hover", "active"],
    note: "三套并存：dockview 的 .dv-tab（--dv-* 管）、自有 .ctl-tabs、帧画布 .fc-tabs；欢迎卡那排圆点是 role=tablist" },
  { id: "dock", zh: "停靠区", exists: true, probe: "dv-sash", via: ["hook", "token"], states: ["rest", "dragging"],
    note: "颜色走 --dv-sash-color / --dv-active-sash-color；命中区那档被 CTL_BUS_EXCLUSIONS 明确排除（1px 的条不该被 24px 量）" },
  { id: "disclosure", zh: "折叠区", exists: true, probe: "tpl-chev-btn", probeUnverified: true, via: ["slot", "hook", "name"], states: ["rest", "hover", "open"],
    note: "四处散着实现（modal-section / tpl-chev / fc-sync-warn / rp-item），没有统一基元——这就是『只能点名』那一档的债" },
  { id: "popover", zh: "弹出层", exists: true, probe: "ctx-menu", via: ["hook", "token", "name"], states: ["rest"],
    note: "表面档靠 data-elev=4 → --elevation-4；行项目状态在 .ctx-item 上" },
  { id: "dialog", zh: "对话框", exists: true, probe: "modal", via: ["hook", "token", "name"], states: ["rest"],
    note: "遮罩 .modal-mask 是方角半透明，本来就该是方的（P146 形状探测器把它列为已知误报）" },
  { id: "drawer", zh: "抽屉", exists: false, instead: "导轨 + 二级面板（P104-R3 把抽屉连状态一起删了）",
    probe: "rail-panel", via: ["token", "name"], states: [], note: "见 SideRail.tsx:13-15 那段说明" },
  { id: "bubble", zh: "气泡 / 提示", exists: true, probe: "help-bubble", via: ["hook", "token", "name"], states: ["rest"],
    note: "满屏的 title= 是引擎画的，主题进不去——这条是能力边界，不是漏覆盖" },
  { id: "toast", zh: "通知", exists: true, probe: "ai-toast", probeUnverified: true, via: ["hook", "token", "name"], states: ["rest"],
    note: "瞬态元素，14 面普查抓不到；探针按 CSS 与写入点认，标 probeUnverified 之外另需人工看一眼" },
  { id: "table", zh: "表格", exists: true, probe: "tbl-hcell", via: ["slot", "hook", "name"], states: ["rest", "hover", "err", "sorted"],
    note: "CSS grid 画的，不是 <table>；真 <table> 另有 .analysis-table/.md-table/.help-table 三族" },
  { id: "list", zh: "列表", exists: true, probe: "lbx-row", via: ["slot", "hook", "name"], states: CTL,
    note: "四族各写一套（spl-row / msp-row / cmdk-item / lbx-row），选中态一枚叫 .on、一枚叫 .sel——第二真值级别的分歧" },
  { id: "card", zh: "卡片", exists: true, probe: "set-card", via: ["token", "name"], states: ["rest", "hover", "on", "focus-visible"],
    note: "画布卡 .ctl-card 在普查 14 面里没渲染过" },
  { id: "form", zh: "表单", exists: true, probe: "set-row", via: ["token", "name"], states: ["rest"],
    note: "行容器；控件本体的状态在下面『控件』那组里" },

  /* ---------------- 基础控件 ---------------- */
  { id: "button", zh: "按钮", exists: true, probe: "btn", via: ["slot", "name"], states: CTL },
  { id: "iconButton", zh: "图标按钮", exists: true, probe: "icon-btn", via: ["slot", "name"], states: CTL,
    note: "20px 小键一档走 --ctl-press-tight；工具栏里静置态被幽灵化（没有脸就没有影，见 theme.css 那条不变式）" },
  { id: "switch", zh: "开关", exists: true, probe: "set-switch", via: ["name"], states: ["rest", "checked", "disabled"],
    note: "脸在子 span 上（P146 因二：画到 label 外壳上会支出一圈方角）；input 是 display:none ⇒ 键盘焦点态现在看不见" },
  { id: "input", zh: "输入框", exists: true, probe: "input", via: ["slot", "name"], states: CTL },
  { id: "select", zh: "下拉", exists: true, probe: "baud-combo", via: ["name"], states: CTL,
    note: "原生 select 已去原生皮（appearance: base-select + ::picker），所以主题真的能画到它" },
  { id: "picker", zh: "选择器（自建弹层）", exists: true, probe: "ui-dropdown", via: ["hook", "token"], states: ["rest"],
    note: ".lbx 容器没有自有规则，脸完全寄生 .ctx-menu" },
  { id: "checkbox", zh: "复选", exists: true, probe: "chk", probeUnverified: true, via: ["name"], states: ["rest", "checked", "disabled"],
    note: "input[type=checkbox] 是 appearance:auto + accent-color ⇒ 主题画不到本体，只能画 .chk-box 那族自绘的" },
  { id: "radio", zh: "单选", exists: true, probe: "chk", probeUnverified: true, via: ["name"], states: ["rest", "checked"],
    note: "与复选同一条宿主规则，没有专属档——本仓目前没有真 radio 组" },
  { id: "slider", zh: "滑块", exists: true, probe: "ctl-slider", probeUnverified: true, via: ["name"], states: ["rest", "hover", "disabled"],
    note: "appearance:auto ⇒ 主题对它无能为力（P146 因三实测：改 background 像素零变化）。P152 要补的就是这一条" },
  { id: "progress", zh: "进度条", exists: false, instead: "实时读数由 .ib-spark（迷你曲线）与 .fc-cov-seg 充当；.xfer-progress 只是传输对话框外壳",
    probe: "ib-spark", via: ["name"], states: [] },
  { id: "segmented", zh: "分段控件", exists: true, probe: "set-seg", via: ["slot", "hook", "name"], states: ["rest", "hover", "on", "disabled"],
    note: "基元 .seg 规则齐全但**全仓无渲染点**（死钩子，不能当探针）；真在跑的是 set-seg / toolbar-seg / ctl-sw-seg" },
  { id: "pagination", zh: "分页", exists: false, instead: "欢迎卡的点状导航 .wlc-dot，以及逐帧前后键（裸 .btn.sm.icon，没有专用类）",
    probe: "wlc-dot", via: ["name"], states: ["rest", "on"] },
  { id: "tag", zh: "标签 / 胶囊", exists: true, probe: "msp-badge", via: ["name"], states: ["rest"],
    note: "本仓没有独立 tag 基元，徽标与胶囊充当" },
  { id: "badge", zh: "徽标", exists: true, probe: "wlc-badge", via: ["name"], states: ["rest", "live"] },
  { id: "layers", zh: "分层背景", exists: true, probe: "statusbar", via: ["token", "hook"], states: [],
    note: "--elevation-0..4 + --elevation-shadow-0..4；实测只有 1/2/4 三档被消费，data-elev 只打了 4 这一档（P147 §3.2）" },
];

/** 用户列过、但本仓没有对应实现的那几面（表里必须仍然占一行，写清代替——否则"覆盖全了"是句假话） */
export const ABSENT_FACES = THEME_FACES.filter((f) => !f.exists).map((f) => f.id);

export function faceById(id: string): ThemeFace | undefined {
  return THEME_FACES.find((f) => f.id === id);
}
