import { tx } from "../i18n/strings";
import { panelGroupsAddable } from "../panels/panelMenu";
import { WORKSPACE_META } from "./workspaceMeta";
import { RAIL_ITEMS, type RailKey } from "./railState";
import type { WorkspacePreset } from "../features/settings/settingsStore";

/**
 * P104-B9：命令面板的条目来源。
 *
 * 一条硬规矩决定了这个文件的存在方式：**条目从已有的事实源派生，不另立清单**。
 * 面板来自 `panelGroupsAddable()`、预设来自 `WORKSPACE_META()`、导轨项来自 `RAIL_ITEMS`，
 * 命名槽由 App 注入（它才读得到 layoutsStore 的快照）。
 * 之所以这么较真：这三样在本仓各自已经有 2~3 个消费方（导轨「视图」、`+面板` 下拉、
 * 设置页、`ui_inventory`），再手抄一份就是第四份真值 —— 而"哪几个面板存在"这种事
 * 抄错的表现不是报错，是**面板在列表里凭空少一个**，没人会去对。
 *
 * 执行动作一律走 App 注入的 `deps`：dockview api、录制、连接这些只在 App 手里
 * （和 `appBus` 同一个理由）。本模块不 import store、不碰 React，所以能在 node 下直接测。
 */

export interface PaletteCommand {
  id: string;
  /** 分组标签（已翻译）；面板里按这个分节显示 */
  group: string;
  title: string;
  /** 右侧灰字：状态或后果（"已打开" / "Ctrl+K" / 预设说明） */
  hint?: string;
  /** 额外检索词（小写、空格分隔）。中文界面下没有它就搜不到英文动作名。 */
  keywords?: string;
  run: () => void;
  disabled?: boolean;
}

export interface PaletteDeps {
  /** 面板显示名。由 App 注入而不是这里 import `panels.tsx` ——
      那个文件急加载全部面板组件，直接引会把整个应用拖进本模块和它的测试
      （`defaultLayout.ts` 头注释讲的正是这个坑，B1 抽 applyDefaultLayout 时就绕开过一次）。 */
  panelTitleOf: (id: string) => string;
  openPanel: (id: string) => void;
  /** 当前已打开的面板 id，用来标"已打开" */
  openPanels: string[];
  applyPreset: (key: WorkspacePreset) => void;
  resetLayout: () => void;
  editLayout: () => void;
  slots: { id: string; name: string }[];
  applySlot: (id: string) => void;
  openRail: (key: RailKey) => void;
  toggleConnect: () => void;
  connected: boolean;
  toggleRecord: () => void;
  recording: boolean;
  toggleDemo: () => void;
  demoOn: boolean;
  openAi: () => void;
  openMarket: () => void;
  openSettings: (tab?: string) => void;
  openHelp: () => void;
  restartTour: () => void;
  setTheme: (mode: string) => void;
  setLocale: (loc: "zh" | "en") => void;
  setZoom: (pct: number) => void;
  locale: "zh" | "en";
  zoom: number;
}

const G_PANEL = tx("面板", "Panels");
const G_LAYOUT = tx("布局", "Layout");
const G_RAIL = tx("导轨", "Rail");
const G_LINK = tx("连接与采集", "Link & capture");
const G_PREF = tx("偏好", "Preferences");
const G_HELP = tx("帮助", "Help");

export function buildCommands(deps: PaletteDeps): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  const opened = new Set(deps.openPanels);

  for (const g of panelGroupsAddable()) {
    for (const id of g.ids) {
      const isOn = opened.has(id);
      out.push({
        id: `panel:${id}`,
        group: G_PANEL,
        title: deps.panelTitleOf(id),
        hint: isOn ? tx("已打开", "Open") : undefined,
        keywords: `${id} ${g.key} ${tx("打开", "open")} ${tx("聚焦", "focus")}`,
        run: () => deps.openPanel(id),
      });
    }
  }

  for (const m of WORKSPACE_META()) {
    out.push({
      id: `preset:${m.key}`,
      group: G_LAYOUT,
      title: tx("切到「{n}」布局", "Switch to “{n}” layout").replace("{n}", m.label),
      hint: m.desc,
      keywords: `${m.key} preset ${tx("工作区", "workspace")}`,
      run: () => deps.applyPreset(m.key),
    });
  }
  for (const s of deps.slots) {
    out.push({
      id: `slot:${s.id}`,
      group: G_LAYOUT,
      title: tx("应用布局槽「{n}」", "Apply layout slot “{n}”").replace("{n}", s.name),
      keywords: "slot layout",
      run: () => deps.applySlot(s.id),
    });
  }
  out.push(
    {
      id: "layout:reset",
      group: G_LAYOUT,
      title: tx("重置布局（回到当前预设）", "Reset layout (back to current preset)"),
      keywords: "reset layout",
      run: deps.resetLayout,
    },
    {
      id: "layout:edit",
      group: G_LAYOUT,
      title: tx("编辑布局（分组合并 / 拆分）", "Edit layout (merge / split groups)"),
      keywords: "edit layout group",
      run: deps.editLayout,
    },
  );

  for (const r of RAIL_ITEMS) {
    const label = tx(r.zh, r.en);
    out.push({
      id: `rail:${r.key}`,
      group: G_RAIL,
      title: tx("打开「{n}」导轨", "Open the “{n}” rail").replace("{n}", label),
      keywords: `${r.key} rail ${label}`,
      run: () => deps.openRail(r.key),
    });
  }

  out.push(
    {
      id: "link:connect",
      group: G_LINK,
      title: deps.connected ? tx("断开连接", "Disconnect") : tx("连接", "Connect"),
      keywords: "connect disconnect serial port 串口",
      run: deps.toggleConnect,
    },
    {
      id: "link:record",
      group: G_LINK,
      title: deps.recording ? tx("停止录制回放", "Stop recording") : tx("录制回放", "Record for replay"),
      hint: tx("记录解析后的帧流，可回放（非控制台的日志文件）", "Records parsed frames; replayable (not the Console log file)"),
      keywords: "record replay session 录制 回放 录制回放",
      run: deps.toggleRecord,
    },
    {
      id: "link:demo",
      group: G_LINK,
      title: deps.demoOn ? tx("关闭演示源", "Stop the demo source") : tx("启动演示源", "Start the demo source"),
      hint: tx("无设备时生成混合协议数据流", "Synthesises data when no device is attached"),
      keywords: "demo simulate 演示",
      run: deps.toggleDemo,
    },
    {
      id: "link:raw",
      group: G_LINK,
      title: tx("录原始字节流（控制台）", "Record raw bytes (Console)"),
      hint: tx("与「录制回放」是两件事：只写文件，不可回放", "Different from recording for replay: file only, not replayable"),
      keywords: "raw bytes console 录原始流",
      run: () => deps.openPanel("console"),
    },
  );

  out.push(
    { id: "ai", group: "AI", title: tx("打开 AI 助手", "Open the AI assistant"), keywords: "ai chat 问 ai", run: deps.openAi },
    { id: "market", group: "AI", title: tx("打开扩展市场", "Open the extension market"), keywords: "market plugin 插件 扩展", run: deps.openMarket },
    { id: "settings", group: G_PREF, title: tx("打开设置", "Open settings"), keywords: "settings 设置", run: () => deps.openSettings() },
  );
  for (const mode of ["dark", "light", "navy", "ocean", "matcha", "amber"] as const) {
    out.push({
      id: `theme:${mode}`,
      group: G_PREF,
      title: tx("切换主题：{n}", "Switch theme: {n}").replace("{n}", tx(THEME_ZH[mode], mode)),
      keywords: `theme ${mode} 主题`,
      run: () => deps.setTheme(mode),
    });
  }
  for (const pct of [90, 100, 110, 125]) {
    out.push({
      id: `zoom:${pct}`,
      group: G_PREF,
      title: tx("缩放 {n}%", "Zoom {n}%").replace("{n}", String(pct)),
      hint: deps.zoom === pct ? tx("当前", "Current") : undefined,
      keywords: "zoom 缩放",
      run: () => deps.setZoom(pct),
    });
  }
  out.push({
    id: "locale",
    group: G_PREF,
    title: deps.locale === "zh" ? "Switch to English" : "切换到中文",
    keywords: "language locale 语言",
    run: () => deps.setLocale(deps.locale === "zh" ? "en" : "zh"),
  });

  out.push(
    { id: "help", group: G_HELP, title: tx("打开帮助与入门", "Open help & getting started"), keywords: "help doc 帮助", run: deps.openHelp },
    { id: "tour", group: G_HELP, title: tx("重播入门引导", "Replay the guided tour"), keywords: "tour onboarding 引导", run: deps.restartTour },
  );

  return out;
}

const THEME_ZH: Record<string, string> = {
  dark: "暗色",
  light: "亮色",
  navy: "深蓝",
  ocean: "浅蓝",
  matcha: "护眼绿",
  amber: "活力橙",
};

/**
 * 过滤：**子序列匹配 + 连续段加权**，大小写不敏感，标题和 keywords 都参与。
 *
 * 为什么不是 `includes` 一刀：中文标题下用户会打英文动作名（"plot" 想找"2D 曲线"），
 * 所以 keywords 里塞了 id 与英文；又因为纯子序列匹配会把 "p-o-t" 这种隔很远的也捞上来，
 * 所以给**连续命中**加权 —— 排序上"贴着来的"比"蹦着命中的"优先。
 *
 * 纯函数、不依赖 DOM，所以能直接单测（面板本体反而难测：它要真挂载）。
 */
export function filterCommands(list: PaletteCommand[], query: string, limit = 40): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const scored: { c: PaletteCommand; s: number }[] = [];
  for (const c of list) {
  const hay = `${c.title} ${c.keywords ?? ""} ${c.group}`.toLowerCase();
    const exact = hay.indexOf(q);
    if (exact >= 0) {
      // 整串命中：越靠前越高
      scored.push({ c, s: 1000 - Math.min(exact, 200) });
      continue;
    }
    const s = subseq(hay, q);
    if (s > 0) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.title.localeCompare(b.c.title));
  return scored.slice(0, limit).map((x) => x.c);
}

/** 子序列命中打分：0 = 不命中；命中时按"连续段长度"加权 */
function subseq(hay: string, needle: string): number {
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (const ch of needle) {
    const at = hay.indexOf(ch, hi);
    if (at < 0) return 0;
    streak = at === hi ? streak + 2 : 1;
    score += streak;
    hi = at + 1;
  }
  return score;
}
