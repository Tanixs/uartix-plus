/**
 * P99b-N5 / P174-R4：外观选择器的**派生层**（详设 §8-48：新增一面先分派生层）。
 *
 * 为什么单独一个文件：设置页那张网格里每一格——谁在画、点亮不亮、点下去会发生什么、
 * 有几项沿用兜底——都必须能指回主题表与插件记录。写进 `SettingsModal` 就没法测，
 * 而这个界面过去恰恰在说谎（`settings.theme` 那枚卡永远显示"选中"，界面其实被插件压着）。
 *
 * v3 之后"插件主题"只有一种：已装插件 `contributes.themes` 里的 CSS，由用户显式选为
 * 当前主题（`pluginEngine.setActiveTheme`）。主题插件也走同一道启用门：**只有启用且已批准**
 * 的插件，它的主题才出现在这张表里；停用/失批时正在画的那枚退回内置（引擎 reload 里判）。
 * "启用"仍然是可用性，不是"点了自动选中"——选哪一身皮仍由这张表决定。
 *
 * 话术（tooltip / 回执 / 那行"当前在画的是谁"）在本层用 `tx()` 就近双语；
 * 但主题**名字**仍由组件经 `labelOf` 注入——内置那几枚的名字住在中心键表里。
 */
import { BUILTIN_THEMES, baselineFor } from "../../styles/builtinThemes";
import { resolveScheme, swatchOf, themeCoverage, type ThemeScheme, type ThemeSource } from "../../styles/themeCore";
import { varsFromThemeCss } from "../plugins/engine/themeVars";
import type { InstalledPlugin } from "../plugins/engine/pluginEngine";
import { setActiveTheme } from "../plugins/engine/pluginEngine";
import { tx } from "../../i18n/strings";
import { patch as patchSettings } from "./settingsStore";

/**
 * `contributes` 键 → 人话（tooltip 要说清"这枚主题来自哪个插件、它还有什么"）。
 * 表里存的是**中英两条**，取值时才翻：在模块求值期翻一次，语言就被钉死在那一刻了。
 */
const SHIP_LABEL: Record<string, readonly [string, string]> = {
  panels: ["面板", "panels"],
  widgets: ["小部件", "widgets"],
  commands: ["命令", "commands"],
  themes: ["主题", "themes"],
  sections: ["面板插槽", "panel sections"],
  mutations: ["面板布局改动", "panel mutations"],
};

const shipLabel = (key: string): string => {
  const pair = SHIP_LABEL[key];
  return pair ? tx(pair[0], pair[1]) : key;
};

export interface ThemeCard {
  /** 内置用主题 id，`system` 是元选项；插件主题用 `plg:<pluginId>:<themeId>` */
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
  /** 插件主题才有：点它要写的主题键 */
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
  /** 在画那枚（来自 `uiRuntime.activeThemeFacts()`，本层不许自己再判一次） */
  drawnId: string | null;
  drawnName: string | null;
  drawnPluginId: string | null;
  records: readonly InstalledPlugin[];
  builtins?: readonly ThemeSource[];
  /**
   * 内置那几枚的中文名（名字住在中心键表 `set.theme.*` 里，由组件注入；
   * 本层翻的是**话术**，不是名字 —— 见文件头那条）。
   */
  labelOf?: (id: string) => string;
}

/** 插件包除了这枚主题之外还带什么（面板/小部件/命令/另一枚主题）。 */
function shipsBesides(entry: InstalledPlugin, themeId: string): string[] {
  const out: string[] = [];
  const c = entry.manifest.contributes;
  if (c.panels?.length) out.push(shipLabel("panels"));
  if (c.widgets?.length) out.push(shipLabel("widgets"));
  if (c.commands?.length) out.push(shipLabel("commands"));
  if ((c.themes ?? []).some((t) => t.id !== themeId)) out.push(tx("另一枚主题", "another theme"));
  if (entry.manifest.inject.sections?.length) out.push(shipLabel("sections"));
  if (entry.manifest.inject.mutations?.length) out.push(shipLabel("mutations"));
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
      name: label("system"),
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
      talk: tx(
        `系统配色切到${input.sysDark ? "亮" : "暗"}色时，界面跟着换到另一枚内置主题`,
        `When the system flips to ${input.sysDark ? "light" : "dark"}, the UI switches to the other built-in theme`,
      ),
      alsoShips: [],
    });
  }

  for (const t of builtins) {
    const p = previewOf(t);
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
        ? tx("当前在画的就是这一枚", "This is the one on screen")
        : serving
          ? tx("「跟随系统」现在用的就是这一枚", "This is the one “System” is drawing right now")
          : drawnIsPlugin
            ? tx(
                `点它会切到这一枚，插件主题「${input.drawnName ?? "?"}」随之撤下（一次只有一枚在画）`,
                `Click to use this one and drop plugin theme “${input.drawnName ?? "?"}” (only one is on screen)`,
              )
            : tx("点它切到这枚内置主题；内置不可卸载", "Click to use this built-in theme; built-ins can't be uninstalled"),
      alsoShips: [],
    });
  }

  for (const rec of input.records) {
    // 与面板/小部件/命令同一条门：未启用或未批准的主题插件不进外观表。
    if (!rec.enabled || rec.verdict !== "trusted") continue;
    for (const theme of rec.themes) {
      const vars = varsFromThemeCss(theme.css);
      const t: ThemeSource = {
        id: theme.key,
        name: theme.title,
        builtin: false,
        scheme: theme.scheme,
        vars,
      };
      const p = previewOf(t);
      const drawn = input.drawnId === theme.key;
      const ships = shipsBesides(rec, theme.id);
      cards.push({
        key: theme.key,
        name: theme.title,
        builtin: false,
        meta: false,
        drawn,
        serving: drawn,
        installed: true,
        enabled: rec.enabled,
        pluginId: theme.key,
        swatch: p.swatch,
        overrides: Object.keys(vars).length,
        inherited: p.inherited,
        scheme: p.scheme,
        talk: drawn
          ? tx("当前在画的就是这一枚（插件主题）", "This is the one on screen (plugin theme)")
          : ships.length
            ? tx(
                `点它把插件「${rec.manifest.name}」的这枚主题设为当前主题（同时还有它的${ships.join("、")}）`,
                `Click to make this theme of “${rec.manifest.name}” the active theme (it also ships ${ships.join(", ")})`,
              )
            : tx(
                `点它把插件「${rec.manifest.name}」的这枚主题设为当前主题`,
                `Click to make this theme of “${rec.manifest.name}” the active theme`,
              ),
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
    talk: c.inherited > 0
      ? tx(
          `${c.talk}（自带 ${c.overrides} 项，另 ${c.inherited} 项沿用兜底）`,
          `${c.talk} (gives ${c.overrides} keys, ${c.inherited} come from the baseline)`,
        )
      : c.talk,
  }));
}

/**
 * 内置与插件主题之间那道横线插在哪：第一枚非内置卡的下标，一枚都没装时 -1。
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
    `${f.name}${f.builtin ? tx("（内置）", " (built-in)") : tx("（插件）", " (plugin)")}`,
    tx(`覆写 ${f.overrides} 项`, `overrides ${f.overrides} keys`),
    f.inherited
      ? tx(
          `${f.inherited} 项沿用${f.baseline === "dark" ? "暗" : "亮"}底兜底`,
          `${f.inherited} inherit the ${f.baseline} baseline`,
        )
      : tx("核心色键全部由它自己给", "it supplies every core color key itself"),
  ];
  if (f.schemeOrigin === "inherit")
    parts.push(tx("这份主题没给明暗依据，明暗沿用当前兜底层", "no light/dark basis declared, so it follows the current baseline"));
  if (f.conflicts.length)
    parts.push(tx(`检测到 ${f.conflicts.length} 枚插件主题同时启用，在画的只有这一枚`, `${f.conflicts.length} plugin themes enabled at once — only this one is on screen`));
  if (f.fellBack) parts.push(tx("设置里记的那枚内置已不存在，回落到第一枚", "the built-in recorded in settings is gone, fell back to the first one"));
  else if (!f.builtin && f.fallbackId)
    parts.push(tx(`切回内置主题会回到「${f.fallbackId}」`, `switching back to a built-in returns to “${f.fallbackId}”`));
  return parts.join(" · ");
}

/** 互斥那颗按钮的话术：撤下在画那枚 / 启用某颗。 */
export function themeButtonTalk(kind: "drawn" | "other", name: string): string {
  return kind === "drawn"
    ? tx(`撤下「${name}」，界面回到当前选中的内置主题`, `Remove “${name}” and return to the selected built-in theme`)
    : tx(`选用「${name}」，它会挤掉现在在画的那枚主题`, `Use “${name}” — it takes over from the theme on screen`);
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
 * 切换主题＝**选中那一枚**。内置走 `settings.theme`，插件主题走 `engine.setActiveTheme`。
 * 两个方向都不新增确认弹层（§8-44）：点卡就是那一次决定，回执里说清换掉了谁。
 */
export async function selectTheme(
  card: SelectableCard,
  drawn: { pluginPkgId: string | null; name: string | null },
): Promise<{ ok: boolean; msg: string }> {
  if (card.builtin) {
    patchSettings({ theme: card.key as never });
    if (drawn.pluginPkgId) {
      try {
        await setActiveTheme("");
      } catch (e) {
        return { ok: false, msg: tx(`已选中内置主题「${card.name}」，但撤下插件主题失败：${String((e as Error)?.message ?? e)}`, `Selected built-in “${card.name}”, but removing the plugin theme failed: ${String((e as Error)?.message ?? e)}`) };
      }
      await reapply();
      return {
        ok: true,
        msg: tx(
          `已切到「${card.name}」；插件主题「${drawn.name ?? "?"}」已撤下（一次只有一枚在画）`,
          `Switched to “${card.name}”; plugin theme “${drawn.name ?? "?"}” removed (only one is on screen)`,
        ),
      };
    }
    await reapply();
    return { ok: true, msg: tx(`已切到「${card.name}」`, `Switched to “${card.name}”`) };
  }
  if (!card.pluginId) return { ok: false, msg: tx("这颗卡没有对应的插件主题", "This card has no plugin theme behind it") };
  try {
    await setActiveTheme(card.pluginId);
  } catch (e) {
    return { ok: false, msg: tx(`没换成：${String((e as Error)?.message ?? e)}`, `Not switched: ${String((e as Error)?.message ?? e)}`) };
  }
  await reapply();
  return { ok: true, msg: tx(`已切到插件主题「${card.name}」`, `Switched to plugin theme “${card.name}”`) };
}

/** 落地：三个入口都只经这一个函数碰到 `data-theme` / 变量层（详设 G6 的钉就钉在这句话上） */
async function reapply(): Promise<void> {
  const m = await import("../ai/uiRuntime");
  m.applyThemeRuntime();
}
