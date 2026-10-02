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
import {
  OVERFLOW_TOLERANCE_PX,
  parseRenderColor,
  type BoxSample,
  type HitSample,
  type TextSample,
} from "../../styles/renderAudit";
import type { Rgba } from "../../styles/themeCore";
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

/* ================= P131-B1：渲染层审计的采样侧 ================= */

/** 能被"点"的元素——命中区只量这些，量到纯排版元素上就是噪声 */
const INTERACTIVE_SELECTOR =
  "button,a[href],input,select,textarea,summary,[role=button],[role=tab],[role=menuitem],[role=checkbox],[role=switch]";

export const AUDIT_DEFAULTS = { maxSamples: 260, maxOverflow: 40, maxHits: 40 } as const;

export interface AuditInput {
  /** 看得见的文字节点：前景色 + 祖先背景（由内到外）+ 字号字重 */
  textSamples: TextSample[];
  /** 内容越过自己格子的宿主（判据与 dev/overflowAudit 同一条，阈值也同源） */
  overflow: BoxSample[];
  /** 可点元素的盒子（CSS px，未折缩放） */
  hits: HitSample[];
  /** 当前缩放档：命中区写成 `calc(24px / var(--zoom))`，不折回去就会冤枉窄控件 */
  zoom: number;
  visited: number;
  truncated: boolean;
  perf: { styleBytes: number; rules: number; sheetsSkipped: number };
}

/** 采到的颜色解析不了（currentColor / color() 之类）就当没采到，不猜 */
function colorOf(cs: CSSStyleDeclaration, prop: string): Rgba | null {
  return parseRenderColor(cs.getPropertyValue(prop) ?? "");
}

/** 祖先背景，由内到外；遇到不透明层就停（再外面那层根本参与不了合成） */
function backdropOf(el: Element): Rgba[] {
  const out: Rgba[] = [];
  let cur: Element | null = el;
  for (let guard = 0; cur && guard < 24; guard++, cur = cur.parentElement) {
    const bg = colorOf(getComputedStyle(cur), "background-color");
    if (!bg || bg.a <= 0) continue;
    out.push(bg);
    if (bg.a >= 1) break;
  }
  return out;
}

function ownText(el: Element): string {
  const direct = [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => (n.textContent ?? "").trim())
    .join(" ");
  const raw = (direct || (el.childElementCount === 0 ? el.textContent ?? "" : "")).trim().replace(/\s+/g, " ");
  return raw.slice(0, 40);
}

/**
 * 走一遍活 DOM，把审计要的原始量采出来。**判定一条都不在这里做**（那些阈值与算法
 * 全在 `styles/renderAudit.ts`，为的是每条判据都能在 node 里被断言反驳）；
 * 这里只负责"看得见吗、压在谁身上、多大个"。
 *
 * 只读：不碰 class、不碰 style、不触发重排之外的任何东西。
 */
export function collectAuditInput(
  opts: { root?: string; maxSamples?: number } = {},
): AuditInput {
  const rootSel = opts.root?.trim() || "body";
  const maxSamples = Math.min(Math.max(opts.maxSamples ?? AUDIT_DEFAULTS.maxSamples, 20), 800);
  const textSamples: TextSample[] = [];
  const overflow: BoxSample[] = [];
  const hits: HitSample[] = [];
  if (typeof document === "undefined") {
    return {
      textSamples, overflow, hits, zoom: 1, visited: 0, truncated: false,
      perf: { styleBytes: 0, rules: 0, sheetsSkipped: 0 },
    };
  }
  const rootEl = document.querySelector(rootSel);
  const zoomRaw = getComputedStyle(document.documentElement).getPropertyValue("--zoom") || "1";
  const zoom = Number.parseFloat(zoomRaw) || 1;
  let visited = 0;
  let truncated = false;
  if (!rootEl) {
    return {
      textSamples, overflow, hits, zoom, visited: 0, truncated: false,
      perf: readPerf(),
    };
  }
  const nodes = [rootEl, ...rootEl.querySelectorAll("*")];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.visibility === "collapse" || cs.display === "none") continue;
    if (Number.parseFloat(cs.opacity || "1") === 0) continue;
    visited++;

    const text = ownText(el);
    if (text && textSamples.length < maxSamples) {
      textSamples.push({
        selector: usableSelector(el),
        text,
        fontSizePx: Number.parseFloat(cs.fontSize) || 12,
        fontWeight: weightOf(cs.fontWeight),
        fg: colorOf(cs, "color"),
        backdrop: backdropOf(el),
      });
    }

    // 溢出：判据是"孩子的右缘越过自己的右缘"，不是 scrollWidth>clientWidth——
    // 后者会漏掉 overflow:visible 的容器（内容照样画出去，容器不记账）。出处同 dev/overflowAudit。
    const selfClip = cs.overflowX !== "visible" || cs.textOverflow === "ellipsis";
    if (!selfClip && overflow.length < AUDIT_DEFAULTS.maxOverflow) {
      for (const kid of el.children) {
        const kpos = getComputedStyle(kid).position;
        if (kpos === "absolute" || kpos === "fixed") continue; // 骑在分界线上是设计，不是事故
        const kr = kid.getBoundingClientRect();
        const over = Math.round(kr.right - r.right);
        if (kr.width > 0 && over > OVERFLOW_TOLERANCE_PX) {
          overflow.push({ selector: usableSelector(el), overPx: over });
          break;
        }
      }
    }

    if (el.matches?.(INTERACTIVE_SELECTOR) && hits.length < AUDIT_DEFAULTS.maxHits) {
      hits.push({ selector: usableSelector(el), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, zoom });
    }
  }
  if (visited >= maxSamples) truncated = true;
  return { textSamples, overflow, hits, zoom, visited, truncated, perf: readPerf() };
}

function weightOf(raw: string): number {
  if (/bold/i.test(raw)) return 700;
  if (/light/i.test(raw)) return 300;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 400;
}

/** 样式表总量：注入层也算进去（它正是"这屏为什么变慢"的第一嫌疑人） */
function readPerf(): { styleBytes: number; rules: number; sheetsSkipped: number } {
  let styleBytes = 0;
  let rules = 0;
  let sheetsSkipped = 0;
  for (const sheet of Array.from(document.styleSheets ?? [])) {
    try {
      const list = sheet.cssRules;
      rules += list.length;
      for (const r of Array.from(list)) styleBytes += r.cssText?.length ?? 0;
    } catch {
      sheetsSkipped++; // 跨源表读不到规则，如实报数而不是当 0
    }
  }
  return { styleBytes, rules, sheetsSkipped };
}
