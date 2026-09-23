/**
 * P99b-N5：外观选择器的**派生层**（详设 §8-48：新增一面先分派生层）。
 *
 * 为什么单独一个文件：设置页那张网格里每一格——谁在画、点亮不亮、点下去会发生什么、
 * 有几项沿用兜底——都必须能指回主题表与插件库记录。写进 `SettingsModal` 就没法测，
 * 而这个界面过去恰恰在说谎（`settings.theme` 那枚卡永远显示"选中"，界面其实被插件压着，
 * 见详设 §1-8）。
 *
 * 三条口径：
 *  1. **同级**：内置与插件主题排成一张列表，`drawn` 只有一格为真；内置的差别只标在"不可卸载"上；
 *  2. 预览格按**这一格自己**的明暗归属取兜底 —— 只给 `--accent` 的差量主题不该画成灰块；
 *  3. 点一颗插件主题＝**启用那个包**（它会带别的产物一起上屏），这句必须写在 tooltip 里，
 *     不能等点了才发现"我的面板怎么多了一块"。
 */
import { BUILTIN_THEMES, baselineFor } from "../../styles/builtinThemes";
import { resolveScheme, swatchOf, themeCoverage, type ThemeScheme, type ThemeSource } from "../../styles/themeCore";
import { setEnabled, themeArtsOf, type PluginRecord } from "../plugins/pluginStore";
import { patch as patchSettings } from "./settingsStore";

/** `contributions` 键 → 人话（tooltip 要说清"还会一起装载什么"） */
const SHIP_LABEL: Record<string, string> = {
  styles: "样式层",
  widgets: "小部件",
  panels: "面板",
  tools: "工具",
  logics: "逻辑模块",
  workflows: "工作流模板",
  commands: "命令",
  presets: "预设",
};

export interface ThemeCard {
  /** 内置用主题 id；`system` 是元选项；插件主题用它的影子扩展 id（与"在画那枚"同一个口径） */
  key: string;
  name: string;
  builtin: boolean;
  /** 元选项「跟随系统」不是一枚主题，它解析到内置之一 */
  meta: boolean;
  /** 选择器里"选中"的那一格——只可能有一格为真 */
  drawn: boolean;
  /** 这一枚是否正在实际供值（`system` 被选中时，被它代表的那枚内置也是 true） */
  serving: boolean;
  installed: boolean;
  enabled: boolean;
  /** 插件主题才有：启停只能拿它去 `pluginStore.setEnabled` */
  pluginId: string | null;
  swatch: { bg: string; panel: string; accent: string };
  /** 自己给了几项 / 几项沿用兜底（详设 R6：差量合法，但要说） */
  overrides: number;
  inherited: number;
  /** 预览按哪张底画 */
  scheme: ThemeScheme;
  /** 点这颗会发生什么 */
  talk: string;
  /** 同包里其它会一起装载的产物（已翻成人话） */
  alsoShips: string[];
}

export interface PickerInput {
  /** 设置里那枚内置选择（含 `system`） */
  settingsTheme: string;
  sysDark: boolean;
  /** 在画那枚（来自 `extRuntime.activeThemeFacts()`，本层不许自己再判一次） */
  drawnId: string | null;
  drawnName: string | null;
  drawnPluginId: string | null;
  records: readonly PluginRecord[];
  builtins?: readonly ThemeSource[];
  /** 内置那几枚的中文名（i18n 在组件手里，本层不引 locale：缺省就照 id 显示） */
  labelOf?: (id: string) => string;
}

/** 插件包里的 theme 产物枚举住在 `pluginStore.themeArtsOf`（详设 §8-48：什么叫"带主题产物的包"只能有一处答案）。 */
function shipsBesides(pkg: PluginRecord["pkg"], themeEntryId: string): string[] {
  const out: string[] = [];
  for (const [key, list] of Object.entries(pkg.contributions ?? {})) {
    if (key === "themes") {
      if ((list ?? []).some((it) => it.id !== themeEntryId)) out.push("另一枚主题");
      continue;
    }
    if (list?.length) out.push(SHIP_LABEL[key] ?? key);
  }
  return out;
}

export function themeCards(input: PickerInput): ThemeCard[] {
  const builtins = input.builtins ?? BUILTIN_THEMES;
  const label = input.labelOf ?? ((id: string) => id);
  const drawnIsPlugin = !!input.drawnPluginId;
  const sysResolved = input.sysDark ? "dark" : "light";
  /** 「跟随系统」选中时，真正在供值的是它解析到的那枚内置 */
  const servingBuiltin = drawnIsPlugin ? null : input.settingsTheme === "system" ? sysResolved : input.drawnId;
  const cards: ThemeCard[] = [];

  const previewOf = (t: { scheme: ThemeScheme | null; vars: Record<string, string> }) => {
    const drawnTheme = builtins.find((b) => b.id === input.drawnId);
    const prev = drawnTheme
      ? resolveScheme({ scheme: drawnTheme.scheme, vars: drawnTheme.vars }, null).scheme
      : null;
    const { scheme } = resolveScheme(t, prev);
    const baseline = baselineFor(scheme);
    return { scheme, swatch: swatchOf(t.vars, baseline), inherited: themeCoverage(t.vars, baseline).inherited.length };
  };

  const sysTheme = builtins.find((t) => t.id === sysResolved);
  if (sysTheme) {
    const p = previewOf(sysTheme);
    cards.push({
      key: "system",
      name: `跟随系统（现在是${label(sysTheme.name)}）`,
      builtin: true,
      meta: true,
      drawn: !drawnIsPlugin && input.settingsTheme === "system",
      serving: false,
      installed: true,
      enabled: true,
      pluginId: null,
      swatch: p.swatch,
      overrides: Object.keys(sysTheme.vars).length,
      inherited: p.inherited,
      scheme: p.scheme,
      talk: `系统配色切到${input.sysDark ? "亮" : "暗"}色时，界面跟着换到另一枚内置主题`,
      alsoShips: [],
    });
  }

  for (const t of builtins) {
    const p = previewOf(t);
    /**
     * `drawn` 只认"设置里选的就是这一枚"，**不认"它正好在供值"**——后者是 `serving`。
     * 混起来的后果实测过：开着「跟随系统」时，元选项那一格和它代表的那枚内置会**同时**亮着，
     * 正是详设 §1-8 那句"选择器显示自己选中而界面是别的"的另一个方向。
     */
    const drawn = !drawnIsPlugin && input.settingsTheme === t.id;
    const serving = servingBuiltin === t.id;
    cards.push({
      key: t.id,
      name: label(t.name),
      builtin: true,
      meta: false,
      drawn,
      serving,
      installed: true,
      enabled: true,
      pluginId: null,
      swatch: p.swatch,
      overrides: Object.keys(t.vars).length,
      inherited: p.inherited,
      scheme: p.scheme,
      talk: drawn
        ? "当前在画的就是这一枚"
        : serving
          ? "「跟随系统」现在用的就是这一枚"
          : drawnIsPlugin
            ? `点它会切到这一枚，并停用插件主题「${input.drawnName ?? "?"}」（同级之后一次只有一枚在画）`
            : "点它切到这枚内置主题；内置不可卸载",
      alsoShips: [],
    });
  }

  for (const rec of input.records) {
    if (rec.state === "quarantined") continue;
    for (const art of themeArtsOf(rec.pkg)) {
      const t: ThemeSource = {
        id: art.extId,
        name: art.name,
        builtin: false,
        scheme: art.artifact.scheme === "dark" || art.artifact.scheme === "light" ? art.artifact.scheme : null,
        vars: (art.artifact.vars as Record<string, string>) ?? {},
      };
      const p = previewOf(t);
      const enabled = rec.state === "enabled";
      const drawn = enabled && input.drawnId === t.id;
      const ships = shipsBesides(rec.pkg, art.entryId);
      cards.push({
        key: t.id,
        name: t.name,
        builtin: false,
        meta: false,
        drawn,
        serving: drawn,
        installed: true,
        enabled,
        pluginId: rec.pkg.id,
        swatch: p.swatch,
        overrides: Object.keys(t.vars).length,
        inherited: p.inherited,
        scheme: p.scheme,
        talk: drawn
          ? "当前在画的就是这一枚（插件主题）"
          : enabled
            ? "已启用但没在画：还有更晚启用的一枚主题占着，互斥之下只有一枚上屏"
            : ships.length
              ? `点它会启用插件「${rec.pkg.name}」，同时装载它的${ships.join("、")}`
              : `点它会启用插件「${rec.pkg.name}」`,
        alsoShips: ships,
      });
    }
  }
  return cards.map((c) => ({
    ...c,
    /**
     * P102 卡面减负：差量覆盖那句从角标挪进 tooltip。卡上只留预览格与名字，
     * 但"这枚自己给了几项、几项是垫的兜底"不能因此消失——它决定你点下去看到的是什么。
     */
    talk: c.inherited > 0 ? `${c.talk}（自带 ${c.overrides} 项，另 ${c.inherited} 项沿用兜底）` : c.talk,
  }));
}

/**
 * 内置与插件主题之间那道横线插在哪：第一枚非内置卡的下标，一枚都没装时 -1。
 *
 * 这条判断放在派生层：视图里写 `!c.builtin && cards[i - 1].builtin` 就是又开一处
 * "哪些算插件主题"的口径（P102 之前它连个形状都没有，全糊在卡面上）。
 */
export function pluginSectionStart(cards: readonly { builtin: boolean }[]): number {
  return cards.findIndex((c) => !c.builtin);
}

export interface DrawnFacts {
  name: string;
  builtin: boolean;
  scheme: ThemeScheme;
  schemeOrigin: "declared" | "bg" | "inherit";
  overrides: number;
  inherited: number;
  baseline: ThemeScheme;
  conflicts: string[];
  fellBack: boolean;
  fallbackId: string | null;
}

/**
 * 「当前在画的是谁」那一行的话术（面板要说出处，不能只写"插件主题层"）。
 * `schemeOrigin === "inherit"` 就是 Q2 的 ③ 那条的点名处：差量主题没给明暗依据，得让人看见。
 */
export function drawnTalk(f: DrawnFacts): string {
  const parts = [
    `${f.name}（${f.builtin ? "内置" : "插件"}）`,
    `覆写 ${f.overrides} 项`,
    f.inherited ? `${f.inherited} 项沿用${f.baseline === "dark" ? "暗" : "亮"}底兜底` : "核心色键全部由它自己给",
  ];
  if (f.schemeOrigin === "inherit") parts.push("这份主题没给明暗依据，明暗沿用当前兜底层");
  if (f.conflicts.length) parts.push(`检测到 ${f.conflicts.length} 枚插件主题同时启用，在画的只有这一枚`);
  if (f.fellBack) parts.push("设置里记的那枚内置已不存在，回落到第一枚");
  else if (!f.builtin && f.fallbackId) parts.push(`停用这枚插件主题后回到内置「${f.fallbackId}」`);
  return parts.join(" · ");
}

/** 互斥那颗按钮的话术：停用在画那枚 / 启用某颗。两处（设置页与插件库）共用一句。 */
export function themeButtonTalk(kind: "drawn" | "other", name: string): string {
  return kind === "drawn"
    ? `停用「${name}」，界面回到当前选中的内置主题`
    : `启用「${name}」，它会挤掉现在在画的那枚主题`;
}

/** 一颗卡上点下去要做什么，全应用只有这一个出口（详设 R7：设置页 / 市场 / AI 三处不许各写一份）。 */
export interface SelectableCard {
  key: string;
  name: string;
  builtin: boolean;
  meta: boolean;
  pluginId: string | null;
}

/**
 * 切换主题＝**选中那一枚，并让别的停止上屏**。
 *
 * - 内置（含 `system` 元选项）：写 `settings.theme`；若此刻是插件主题在画，顺手把它停用——
 *   同级之后"点哪枚就是哪枚"，留着那枚亮着的开关正是详设 §1-8 说的那种谎。
 * - 插件主题：只叫 `pluginStore.setEnabled(pkg, true)`，互斥由入口收敛执行
 *   （`enforceThemeMutex`），本层不自己写第二份"把别人关掉"的逻辑。
 *
 * 两个方向都不新增确认弹层（§8-44）：点卡就是那一次决定，回执里说清挤掉了谁。
 */
export async function selectTheme(
  card: SelectableCard,
  drawn: { pluginPkgId: string | null; name: string | null },
): Promise<{ ok: boolean; msg: string }> {
  if (card.builtin) {
    patchSettings({ theme: card.key as never });
    if (drawn.pluginPkgId) {
      const r = setEnabled(drawn.pluginPkgId, false);
      if (!r.ok) return { ok: false, msg: `已选中内置主题「${card.name}」，但停用插件主题失败：${r.msg}` };
      await reapply();
      return { ok: true, msg: `已切到「${card.name}」；插件主题「${drawn.name ?? "?"}」已停用（同级，一次只有一枚在画）` };
    }
    await reapply();
    return { ok: true, msg: `已切到「${card.name}」` };
  }
  if (!card.pluginId) return { ok: false, msg: "这颗卡没有对应的插件包，启停无处落地" };
  const r = setEnabled(card.pluginId, true);
  await reapply();
  return r;
}

/** 落地：三个入口都只经这一个函数碰到 `data-theme` / 变量层（详设 G6 的钉就钉在这句话上） */
async function reapply(): Promise<void> {
  const m = await import("../ai/extRuntime");
  m.applyStyleExts();
}
