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
import { CTL_BUS_HOOK, CTL_HOOKS, CTL_SLOTS, ELEV_TIERS } from "../../styles/hostHooks";
import type { PartRuleSample, ShapeSample } from "../../styles/shapeAudit";

export const INVENTORY_SECTIONS = ["panels", "controls", "blocks", "actions", "tokens", "domains", "fx", "hooks"] as const;
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
  if (want("hooks")) out.hooks = hooksRows();
  return out;
}

/**
 * P148：宿主词汇与签名槽的**现场清单**。
 *
 * 为什么单开一档：P143 铺的 12 枚签名槽与 `data-ctl`/`data-elev` 两对钩子，此前对模型**完全不可见**
 * （提示词零提及、`ui_inspect` 不读 dataset），于是它每次都走最贵的那条路——逐类点名，
 * 点不全就是用户看到的"AI 做的主题比内置的还素"。这一档把"有哪几枚槽、屏幕上真挂了哪几个钩子"
 * 一次讲清，词汇表本体仍从 `styles/hostHooks` 现读（不在这抄第二份）。
 */
/** 纯函数那一半（DOM 计数交进来）：这张清单因此能在 node 里被断言反驳，不必养一个假 document。 */
export function hooksReport(onScreen: { ctl: Record<string, number>; elev: Record<string, number> }) {
  return {
    // 屏幕上此刻真挂着的（某档为 0 说明这一面没这类角色，不是词表错了）
    on_screen: onScreen,
    vocabulary: { ctl: [...CTL_HOOKS], elev: [...ELEV_TIERS] },
    slots: CTL_SLOTS.map((s) => ({ name: s.name, default_at_root: s.defaultAtRoot, gloss: s.gloss })),
    how_to_fill:
      '槽属于组件层：在 :root 或 :root[data-theme="<id>"] 里声明它们（它们不在 token 白名单里，' +
      '所以 theme_patch 到不了，也不该到——那里落成行内样式会压过宿主的减弱动效基线）。' +
      '填一枚槽 = 约 1,120 只可点元素同时换签名；先查槽，再逐类点名。',
  };
}

/** P148：宿主词汇与签名槽的现场清单（详见 collectInventory 上方那段理由）。 */
function hooksRows(): Record<string, unknown> {
  const ctl: Record<string, number> = {};
  for (const el of document.querySelectorAll('[data-ctl]')) {
    const v = el.getAttribute('data-ctl') ?? '?';
    ctl[v] = (ctl[v] ?? 0) + 1;
  }
  const elev: Record<string, number> = {};
  for (const el of document.querySelectorAll('[data-elev]')) {
    const v = el.getAttribute('data-elev') ?? '?';
    elev[v] = (elev[v] ?? 0) + 1;
  }
  return hooksReport({ ctl, elev });
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
  /**
   * P148：`data-ctl` / `data-elev` 这两个宿主钩子。以前载荷里没有它们，
   * 模型在屏幕上看见一只 `data-ctl="tab"` 也看不见——它只能猜类名，猜不全就漏面。
   */
  hooks?: Record<string, string>;
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
      // 只带这两个词汇钩子：整张 dataset 会把 data-pdrag / data-id 这类内部状态一起灌给模型，
      // 而那些不是"主题能往哪一层写"的入口。
      ...(() => {
        const hooks: Record<string, string> = {};
        const ctl = el.getAttribute("data-ctl");
        const elev = el.getAttribute("data-elev");
        if (ctl) hooks["data-ctl"] = ctl;
        if (elev) hooks["data-elev"] = elev;
        return Object.keys(hooks).length ? { hooks } : null;
      })(),
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
/**
 * 命中区审计认"什么算可点物"。P148 补上 `[data-ctl]` 那一支——在此之前它和覆盖率脚本
 * （`.tools/ctl-coverage.mjs` 的 BUS，含 `[data-ctl]`）**认的不是同一批元素**：
 * 那些"靠宿主词汇才够得着"的控件（div 当页签、div 当表头、label 包出来的两段开关）
 * 在 24px 这条地板下面是隐形的。排除项从 `styles/hostHooks` 现读，不在这重抄一份。
 */
export const INTERACTIVE_SELECTOR =
  "button,a[href],input,select,textarea,summary,[role=button],[role=tab],[role=menuitem],[role=checkbox],[role=switch]," +
  CTL_BUS_HOOK;

export const AUDIT_DEFAULTS = { maxSamples: 260, maxOverflow: 40, maxHits: 40, maxShapes: 320, maxPartRules: 24 } as const;

export interface AuditInput {
  /** 看得见的文字节点：前景色 + 祖先背景（由内到外）+ 字号字重 */
  textSamples: TextSample[];
  /** 内容越过自己格子的宿主（判据与 dev/overflowAudit 同一条，阈值也同源） */
  overflow: BoxSample[];
  /** 可点元素的盒子（CSS px，未折缩放） */
  hits: HitSample[];
  /** P151：形状 artifact 的原始量（判定在 styles/shapeAudit，这里只采） */
  shapes: ShapeSample[];
  /** 点了原生控件部件伪元素的作者规则 + 那只控件的 appearance */
  partRules: PartRuleSample[];
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
/** `4px` / `0.5rem` 这类长度取不出 rem 的换算，这里只用到 px 与 0 */
const pxOf = (v: string) => Number.parseFloat(v) || 0;

/** 稳定路径键：判定核要在"候选枚 / 基准枚"两次采样之间认出同一只元素，所以键里不带文字与尺寸 */
function shapeKeyOf(el: Element): string {
  const seg: string[] = [];
  let n: Element | null = el;
  for (let d = 0; d < 4 && n && n.tagName; d++, n = n.parentElement) {
    const cls = typeof n.className === "string" ? n.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    let idx = 0;
    for (let sib = n.previousElementSibling; sib; sib = sib.previousElementSibling) idx++;
    seg.unshift(n.tagName.toLowerCase() + (cls ? "." + cls : "") + (idx ? "#" + idx : ""));
  }
  return seg.join(">");
}

/** 一只元素的形状事实。没画脸也没投影的返回 null（那两者都不在任何 artifact 的分母里） */
function shapeSampleOf(el: Element, cs: CSSStyleDeclaration): ShapeSample | null {
  const r = el.getBoundingClientRect();
  const bg = colorOf(cs, "background-color");
  const radius = Math.max(pxOf(cs.borderTopLeftRadius), pxOf(cs.borderTopRightRadius));
  const painted = (!!bg && bg.a > 0.02) || (!!cs.backgroundImage && cs.backgroundImage !== "none");
  const shadow = !!cs.boxShadow && cs.boxShadow !== "none";
  const line = colorOf(cs, "border-top-color");
  const borderVisible = pxOf(cs.borderTopWidth) > 0 && !!line && line.a > 0.02;
  if (!painted && !shadow) return null;
  let child: ShapeSample["child"] = null;
  if (painted && radius < 2) {
    // 只有"方底"这一侧才需要去找重合的圆身子，否则每只元素都要再算一遍子样式
    for (const k of el.children) {
      const kcs = getComputedStyle(k);
      const kbg = colorOf(kcs, "background-color");
      const kRadius = Math.max(pxOf(kcs.borderTopLeftRadius), pxOf(kcs.borderTopRightRadius));
      const kPainted = (!!kbg && kbg.a > 0.02) || (!!kcs.backgroundImage && kcs.backgroundImage !== "none");
      if (kPainted && kRadius > 0) {
        const kr = k.getBoundingClientRect();
        child = { radius: kRadius, painted: true, box: [kr.width, kr.height] };
        break;
      }
    }
  }
  return { key: shapeKeyOf(el), box: [r.width, r.height], radius, painted, bgAlpha: bg ? bg.a : undefined, shadow, borderVisible, child };
}

/**
 * 空转的部件规则（C 类）：作者规则点了 `::-webkit-slider-thumb` 这类原生控件部件，
 * 而那只元素的 `appearance` 还是 auto ⇒ Blink 整条不采纳，那是死代码不是样式。
 * P146 的滑杆就是这么"改了没反应"的。
 */
function collectPartRules(): PartRuleSample[] {
  const out: PartRuleSample[] = [];
  const PART = /::-(webkit|moz)-(slider|inner-text|outer-spin|color|search)/;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    const walk = (rs: CSSRuleList) => {
      for (const r of Array.from(rs)) {
        const sel = (r as CSSStyleRule).selectorText;
        if (!sel) { const nested = (r as CSSGroupingRule).cssRules; if (nested) walk(nested); continue; }
        if (!PART.test(sel)) continue;
        const base = sel.split(/::/)[0].replace(/\[[^\]]*\]/g, "").trim();
        if (!base) continue;
        let els: Element[] = [];
        try { els = Array.from(document.querySelectorAll(base)); } catch { continue; }
        out.push({
          rule: sel.slice(0, 90),
          hits: els.length,
          appearance: els.length ? getComputedStyle(els[0]).appearance : "n/a",
        });
        if (out.length >= AUDIT_DEFAULTS.maxPartRules) return;
      }
    };
    walk(rules);
    if (out.length >= AUDIT_DEFAULTS.maxPartRules) break;
  }
  return out;
}

export function collectAuditInput(
  opts: { root?: string; maxSamples?: number } = {},
): AuditInput {
  const rootSel = opts.root?.trim() || "body";
  const maxSamples = Math.min(Math.max(opts.maxSamples ?? AUDIT_DEFAULTS.maxSamples, 20), 800);
  const textSamples: TextSample[] = [];
  const shapes: ShapeSample[] = [];
  const partRules: PartRuleSample[] = [];
  const overflow: BoxSample[] = [];
  const hits: HitSample[] = [];
  if (typeof document === "undefined") {
    return {
      textSamples, overflow, hits, shapes, partRules, zoom: 1, visited: 0, truncated: false,
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
      textSamples, overflow, hits, shapes, partRules, zoom, visited: 0, truncated: false,
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

    /* P151：形状事实顺手采一份（判定在 styles/shapeAudit，这里只量不判） */
    if (shapes.length < AUDIT_DEFAULTS.maxShapes) {
      const sh = shapeSampleOf(el, cs);
      if (sh) shapes.push(sh);
    }

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
  return { textSamples, overflow, hits, shapes, partRules: collectPartRules(), zoom, visited, truncated, perf: readPerf() };
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
