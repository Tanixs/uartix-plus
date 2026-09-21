/**
 * P97-I1：界面自省的两个出口。
 *
 * 为什么要它（真机反馈 5）：*"它似乎获取不到现有的面板、每个面板的按钮、菜单栏、标题栏、输入框"*。
 * 在此之前，模型对界面的全部认知来自 `prompts.ts` 里我手写的 58 行散文——界面一改它就漂，
 * 而且**它拿不到真实类名**，于是写出来的样式选择器命中 0、看起来"只会改背景色"。
 *
 * 两条腿：
 *  ① `collectInventory` —— 从 registry 派生的能力清单（面板/控件/块/动作/token/授权域），零手写平行清单；
 *  ② `censusSurface` —— 直接读**活 DOM**，给出真实存在的类名、命中数、可粘回的选择器与当前计算样式。
 *
 * 依赖纪律：`panels/panels.tsx` 挂着全部面板组件，静态引它会把 agent 链闭成环（§8-33），
 * 所以面板清单走动态 `await import()`；其余都是轻叶子模块。
 */
import { getLocale } from "../../i18n/strings";
import { APP_ACTION_KINDS } from "../ai/appActionKinds";
import { CONTROL_TYPES } from "../controls/controlsStore";
import { BLOCK_REGISTRY, EVENT_REGISTRY } from "../orchestrator/blockRegistry";
import { PANEL_GROUPS, panelGroupLabel } from "../../panels/panelMenu";
import { APPEARANCE_TOKENS } from "./appearanceStore";
import { fxCatalog } from "./fxRecipes";
import { DOMAINS, DOMAIN_TIP, DOMAIN_ZH } from "./scopeTiers";

export const INVENTORY_SECTIONS = ["panels", "controls", "blocks", "actions", "tokens", "domains", "fx"] as const;
export type InventorySection = (typeof INVENTORY_SECTIONS)[number];

type BlockMeta = {
  label?: string | { zh: string; en: string };
  tip?: string | { zh: string; en: string };
  ai?: string;
};

/** 注册表里的 label 是 {zh,en}（面板/块共用），清单按当前语言出一句 */
function pick(v: BlockMeta["label"] | BlockMeta["tip"]): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  return getLocale() === "en" ? v.en : v.zh;
}

/** 面板清单（panels.tsx 重模块动态取，只为拿显示名） */
export async function panelRows(): Promise<{ group: string; panels: { id: string; title: string }[] }[]> {
  const { panelTitleOf } = await import("../../panels/panels");
  return PANEL_GROUPS.map((g) => ({
    group: panelGroupLabel(g),
    panels: g.ids.map((id) => ({ id, title: panelTitleOf(id) })),
  }));
}

export function controlRows(): string[] {
  return [...CONTROL_TYPES];
}

export function blockRows() {
  return Object.entries(BLOCK_REGISTRY as unknown as Record<string, BlockMeta>).map(([kind, meta]) => ({
    kind,
    label: pick(meta?.label) ?? kind,
    ...(meta?.ai ? { ai: meta.ai } : {}),
  }));
}

export function eventRows() {
  return Object.entries(EVENT_REGISTRY as unknown as Record<string, BlockMeta>).map(([kind, meta]) => ({
    kind,
    label: pick(meta?.label) ?? kind,
  }));
}

export function actionRows(): string[] {
  return [...APP_ACTION_KINDS] as string[];
}

export function tokenRows(): string[] {
  return [...APPEARANCE_TOKENS];
}

export function domainRows() {
  return DOMAINS.map((d) => ({ domain: d, label: DOMAIN_ZH[d], tip: DOMAIN_TIP[d] }));
}

/** 动效配方（CSS 与清单同源：fxRecipes.ts） */
export function fxRows() {
  return fxCatalog();
}

/**
 * 模型常把"不指定段"写成 `section:"None"` / `"all"` / `""`（真机实录：传了 `None` ⇒
 * `unknown_section`，然后它花 1m44s 猜用户到底要什么，白烧一轮）。这是一份**只读清单**，
 * 宽容归一没有任何安全含义；真正拼错的段名仍然报错并回 `want` 清单让它自己纠正。
 */
const SECTION_ALIASES = new Set(["", "all", "*", "none", "any", "everything", "全部", "所有"]);

/** 汇总清单（超 8 KiB 由 adapter 的 rememberArtifact 走"存原文 + artifactRef"，这里不自己裁） */
export async function collectInventory(rawSection?: string): Promise<Record<string, unknown>> {
  const lowered = typeof rawSection === "string" ? rawSection.trim().toLowerCase() : "";
  const section = lowered && !SECTION_ALIASES.has(lowered) ? lowered : undefined;
  const want = (s: InventorySection) => !section || section === s;
  const out: Record<string, unknown> = {};
  if (section && !(INVENTORY_SECTIONS as readonly string[]).includes(section)) {
    return { error: "unknown_section", want: [...INVENTORY_SECTIONS], got: rawSection };
  }
  if (want("panels")) out.panels = await panelRows();
  if (want("controls")) out.controls = controlRows();
  if (want("blocks")) out.blocks = { items: blockRows(), events: eventRows() };
  if (want("actions")) out.actions = actionRows();
  if (want("tokens")) out.tokens = tokenRows();
  if (want("domains")) out.domains = domainRows();
  if (want("fx")) out.fx = fxRows();
  return out;
}

/* ================= 活 DOM 现场 ================= */

/** 组件级样式最常要调的属性——只采这些，别把 300 条计算样式灌给模型 */
export const SAMPLED_PROPS = [
  "background-color", "color", "border-color", "border-radius", "box-shadow",
  "font-size", "padding", "opacity", "transition", "animation", "position", "display",
] as const;

export const SURFACE_DEFAULTS = { depth: 3, maxNodes: 120, maxClasses: 60 } as const;

export interface SurfaceNode {
  /** 可直接粘回 style_patch 的选择器（优先 #id，其次前两个类名） */
  selector: string;
  tag: string;
  classes: string[];
  box: [number, number];
  /** 短文本（按钮/标题这类"是哪个控件"的关键线索），超 40 字截断并标记 */
  text?: string;
  textTruncated?: boolean;
  styles: Record<string, string>;
  children?: SurfaceNode[];
}

export interface SurfaceCensus {
  root: string;
  matched: number;
  /** 真实存在的类名与全局命中数——这是"选择器写不对"的解药 */
  classes: { name: string; hits: number }[];
  nodes: SurfaceNode[];
  visited: number;
  truncated: boolean;
  note: string;
}

/** 给元素挑一个"模型能直接用"的选择器 */
function usableSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const cls = [...el.classList].filter((c) => !/^(is-|has-|css-)/.test(c)).slice(0, 2);
  if (cls.length) return `.${cls.join(".")}`;
  return el.tagName.toLowerCase();
}

function sampleStyles(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const p of SAMPLED_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v && v !== "none" && v !== "normal" && v !== "auto") out[p] = v.slice(0, 120);
  }
  return out;
}

function shortText(el: Element): { text?: string; textTruncated?: boolean } {
  const own = [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => (n.textContent ?? "").trim())
    .join(" ");
  const raw = (own || (el.childElementCount === 0 ? el.textContent ?? "" : "")).trim().replace(/\s+/g, " ");
  if (!raw) return {};
  return raw.length > 40 ? { text: raw.slice(0, 40), textTruncated: true } : { text: raw };
}

/**
 * 现场清单：从 root 选择器往下走 depth 层，返回真实类名/命中数/可粘选择器/采样计算样式。
 * 只读，不改任何东西；root 命中 0 时如实回 matched:0（配合 ui_inventory 的类名清单自纠）。
 */
export function censusSurface(
  root: string,
  opts: { depth?: number; maxNodes?: number; maxClasses?: number } = {},
): SurfaceCensus {
  const depth = Math.min(Math.max(opts.depth ?? SURFACE_DEFAULTS.depth, 1), 6);
  const maxNodes = Math.min(Math.max(opts.maxNodes ?? SURFACE_DEFAULTS.maxNodes, 1), 400);
  const maxClasses = opts.maxClasses ?? SURFACE_DEFAULTS.maxClasses;
  let roots: Element[];
  try {
    roots = [...document.querySelectorAll(root)];
  } catch {
    return { root, matched: 0, classes: [], nodes: [], visited: 0, truncated: false, note: "选择器语法非法，换一个（可先用 ui_inspect 的 root=\"body\" 看类名清单）" };
  }
  const counts = new Map<string, number>();
  for (const el of document.querySelectorAll("*")) {
    for (const c of el.classList) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  /**
   * 类名清单：只列**本次作用域里真的出现**的类，但报的是全局命中数——
   * 模型需要同时知道"这个类在这儿有"和"用它当选择器会打到多少个"，否则又会写出打偏的规则。
   */
  const scope: Element[] = roots.length
    ? roots.flatMap((r) => [r, ...r.querySelectorAll("*")])
    : [...document.querySelectorAll("*")];
  const inScope = new Set<string>();
  for (const el of scope) for (const c of el.classList) inScope.add(c);
  let visited = 0;
  const walk = (el: Element, level: number): SurfaceNode | null => {
    if (visited >= maxNodes) return null;
    visited++;
    const node: SurfaceNode = {
      selector: usableSelector(el),
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList].slice(0, 6),
      box: [Math.round(el.clientWidth), Math.round(el.clientHeight)],
      ...shortText(el),
      styles: sampleStyles(el),
    };
    if (level < depth) {
      const kids = [...el.children]
        .slice(0, 14)
        .map((k) => walk(k, level + 1))
        .filter((x): x is SurfaceNode => !!x);
      if (kids.length) node.children = kids;
    }
    return node;
  };
  const nodes = roots.map((r) => walk(r, 1)).filter((x): x is SurfaceNode => !!x);
  const top = [...inScope]
    .map((name) => ({ name, hits: counts.get(name) ?? 0 }))
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name))
    .slice(0, maxClasses);
  return {
    root,
    matched: roots.length,
    classes: top,
    nodes,
    visited,
    truncated: visited >= maxNodes,
    note: roots.length
      ? `classes 是全局命中数（写选择器前先看它）；nodes 只展开 ${depth} 层、上限 ${maxNodes} 个`
      : "没有元素命中这个 root：先按 classes 里的真实类名重写，或退一层用 ui_inventory",
  };
}
