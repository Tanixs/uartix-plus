/**
 * P97-I1/I2：界面自省与组件级样式工具（四支）。P99a-A2：迁入注册表，一条 entry 说清全部事实。
 *
 * 分工与授权（P92-C 的口径，现在由 `entry.domain` 单点声明、管线执行）：
 *  - `ui_inventory` / `ui_inspect` **只读不开门**（对齐 `theme_read`/`settings_read`）——
 *    看不到界面结构是"改不动界面"的前提，读本身不产生任何写入；
 *  - `style_patch` / `style_revert` 需要 `ui`（界面深改）授权域；写进去的是**会话内临时层**，
 *    持久化必须显式再调 `save_theme_extension`（用户已确认"默认临时、可一键清掉"）。
 * P99a 收编：此前"哪些工具存在 / 各要什么域 / 中文名 / 参数摘要"分成 4 处（defs、DOMAIN、
 * TOOL_LABEL、summarizeArgs），漏一处就静默；现在全在下面的 entry 里。
 */
import { DOMAIN_ZH } from "./scopeTiers";
import { censusSurface, collectInventory, INVENTORY_SECTIONS, SURFACE_DEFAULTS } from "./uiSurface";
import { buildStyleText, sanitizeStyleRules, STYLE_CAPS } from "../styles/styleSanitize";
import { applyLayer, listLayers, revertAll, revertByToken, revertLayer } from "./styleScratch";
import { defineTool, notExecuted as bad, type AgentToolEntry } from "./toolRegistry";
import type { ToolReceipt } from "./types";

/** 回执 callId 由管线覆盖；handler 用 ctx.callId 只是为了拼得出对象，不指望它当身份 */
const read = (callId: string, data: unknown): ToolReceipt => ({ callId, ok: true, status: "read", data });

/** 采样一个元素当前的计算值（before/after 的证据，不是回滚依据——回滚靠撤掉追加层） */
function readComputed(selector: string, props: string[]): Record<string, string> {
  const el = document.querySelector(selector);
  if (!el) return {};
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const p of props) {
    const v = cs.getPropertyValue(p);
    if (v) out[p] = v.slice(0, 120);
  }
  return out;
}

/** 选择器打偏时给几条真实类名（字面最接近的，按全局频次排；这是提示不是精确匹配） */
function nearClasses(selector: string, limit = 5): string[] {
  const want = selector.replace(/[^\w-]/g, " ").split(/\s+/).filter((t) => t.length > 2).pop()?.toLowerCase() ?? "";
  if (!want) return [];
  const counts = new Map<string, number>();
  for (const el of document.querySelectorAll("*")) {
    for (const c of el.classList) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const key = want.slice(0, 4);
  return [...counts.entries()]
    .map(([name, hits]) => {
      const low = name.toLowerCase();
      const score = low.startsWith(key) ? 3 : low.includes(key) || key.includes(low) ? 2 : low.includes(want) ? 2 : 0;
      return { name, hits, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, limit)
    .map((x) => `.${x.name}(${x.hits})`);
}

let patchSeq = 0;

const HOST = { kind: "host" } as const;

export const uiToolEntries: AgentToolEntry[] = [
  defineTool({
    name: "ui_inventory",
    labelZh: "查看界面清单",
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      "Enumerate what this app actually is: panel groups & panel ids, control (widget) types, orchestrator blocks/events, app-action kinds, themable token names, authorization domains. Derived from the live registries, never from a hand-written list. Args: { section?: " + INVENTORY_SECTIONS.join("|") + " }. Read-only.",
    parameters: { type: "object", properties: { section: { type: "string" } }, additionalProperties: false },
    summarize: (a) => (a.section ? `查看界面清单 · ${String(a.section)}` : "查看界面清单"),
    async execute(args, ctx) {
      const data = await collectInventory(typeof args.section === "string" ? args.section : undefined);
      if ((data as { error?: string }).error) return bad(ctx.callId, "invalid_args", data);
      return read(ctx.callId, data);
    },
  }),
  defineTool({
    name: "ui_inspect",
    labelZh: "查看界面结构",
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      `Inspect real DOM under a CSS selector: which class names actually exist (with global hit counts), a node tree (tag/classes/box/short text/sampled computed styles) and a ready-to-paste selector per node. Use this BEFORE style_patch so your selectors hit something. Args: { root: string (e.g. ".p3d-host", "#root", ".titlebar"), depth?: number (1..6, default ${SURFACE_DEFAULTS.depth}), maxNodes?: number (<=400) }. Read-only.`,
    parameters: {
      type: "object",
      properties: { root: { type: "string" }, depth: { type: "number" }, maxNodes: { type: "number" } },
      required: ["root"],
      additionalProperties: false,
    },
    summarize: (a) => `查看 ${String(a.root ?? "?")} 的界面结构`,
    execute(args, ctx) {
      const callId = ctx.callId;
      const root = typeof args.root === "string" ? args.root.trim() : "";
      if (!root) return bad(callId, "invalid_args", { hint: "root 必须是 CSS 选择器，例如 \".titlebar\" 或 \"#root\"" });
      const census = censusSurface(root, {
        ...(typeof args.depth === "number" ? { depth: args.depth } : {}),
        ...(typeof args.maxNodes === "number" ? { maxNodes: args.maxNodes } : {}),
      });
      return read(callId, census);
    },
  }),
  defineTool({
    name: "style_patch",
    labelZh: "改组件样式",
    effect: "config_write",
    domain: "ui",
    provenance: HOST,
    description:
      `Apply per-component CSS as **structured rules** (not free text) into a session-scoped scratch layer: rules: [{ selector, decls: {prop:value}, keyframes?: {name:"fx-…", body} }]. Each rule is validated (global selectors html/body/*/#root, position:fixed, url()/@import, z-index>900, caps ${STYLE_CAPS.maxRules} rules / ${STYLE_CAPS.maxBytes} bytes) and reported back with hit counts and before→after values; a selector that hits 0 elements comes back in zeroHit with the real class names to use instead. Nothing is persisted: call save_theme_extension({name, css}) afterwards if the user wants to keep it; revert with style_revert. For glow/sheen/ripple/particles/border animations use the built-in recipes — call ui_inventory { section: "fx" } first (classes + --fx-* knobs) instead of writing @keyframes from scratch. Needs the ${DOMAIN_ZH.ui} authorization.`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        rules: { type: "array", items: { type: "object" } },
      },
      required: ["rules"],
      additionalProperties: false,
    },
    summarize: (a) => {
      const n = Array.isArray(a.rules) ? a.rules.length : 0;
      return n ? `改 ${n} 条组件样式${a.name ? `（层 ${String(a.name)}）` : ""}` : "改组件样式";
    },
    undoRoute: (token) => revertByToken(token),
    execute(args, ctx) {
      const callId = ctx.callId;
      const sanitized = sanitizeStyleRules(args.rules);
      if (!sanitized.rules.length) {
        return bad(callId, "no_valid_rules", {
          rejected: sanitized.rejected,
          caps: sanitized.caps,
          hint: "按 rejected 里的 reason 逐条改；先用 ui_inspect 拿到真实类名再写选择器",
        });
      }
      const name = typeof args.name === "string" && args.name.trim()
        ? args.name.trim().slice(0, 40)
        : `patch-${++patchSeq}`;
      // 先量 before（应用前的计算值），再一次性注入，最后量 after —— 单次样式重算，不逐条写
      const before = sanitized.rules.map((r) => readComputed(r.selector, Object.keys(r.decls)));
      const css = buildStyleText(sanitized.rules, name);
      const { count: layerCount, undoToken } = applyLayer(name, css);
      const applied = sanitized.rules.map((r, i) => {
        const hits = document.querySelectorAll(r.selector).length;
        const after = readComputed(r.selector, Object.keys(r.decls));
        const changed = Object.entries(after)
          .filter(([p, v]) => before[i]?.[p] !== undefined && before[i][p] !== v)
          .map(([p, v]) => `${p}: ${before[i][p]} → ${v}`);
        return { selector: r.selector, hits, changed };
      });
      // 打偏的选择器不只说"没命中"，直接把真实类名递过去——这是"改不动界面"的根治那一步
      const zeroHit = applied.filter((a) => a.hits === 0).map((a) => ({ selector: a.selector, near: nearClasses(a.selector) }));
      return {
        callId,
        ok: true,
        status: "applied",
        data: {
          layer: name,
          layers: listLayers(),
          applied,
          zeroHit,
          rejected: sanitized.rejected,
          bytes: sanitized.bytes,
          undoable: true,
          note: zeroHit.length
            ? `有 ${zeroHit.length} 条选择器命中 0 个元素（见 zeroHit.near 的真实类名），它们已注入但不会产生效果——改正后再发一次。下一步：把实际改动讲给用户听`
            : `临时层「${name}」已生效（共 ${layerCount} 层），重启不保留；要持久化请调 save_theme_extension 并带上同一批规则。下一步：把 changed 里的旧→新讲给用户听，再问是否保存为插件`,
        },
        // P98-M0：从前只写 undoable:true 却不带令牌，卡片撤销按钮拿不到 token 就永久失效
        undoToken,
      };
    },
  }),
  defineTool({
    name: "style_revert",
    labelZh: "撤回临时样式",
    effect: "config_write",
    domain: "ui",
    provenance: HOST,
    description:
      `Remove session scratch style layers: { name: string } drops one, { all: true } drops every layer this run added. Original styles are untouched (we only ever append a layer), so reverting restores exactly what was there before. Needs the ${DOMAIN_ZH.ui} authorization.`,
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, all: { type: "boolean" } },
      additionalProperties: false,
    },
    summarize: (a) => (a.all === true ? "撤回全部临时样式层" : a.name ? `撤回临时样式层 ${String(a.name)}` : "撤回临时样式"),
    execute(args, ctx) {
      const callId = ctx.callId;
      if (args.all === true) {
        const n = revertAll();
        return { callId, ok: true, status: "applied", data: { revertedAll: n, layers: listLayers() } };
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return bad(callId, "invalid_args", { hint: "给 name，或 all:true 清掉本次全部临时层", layers: listLayers() });
      const had = revertLayer(name);
      return {
        callId,
        ok: had,
        status: had ? "applied" : "not_executed",
        ...(!had ? { code: "no_such_layer" } : {}),
        data: { name, removed: had, layers: listLayers(), note: had ? "已撤回该层，原样式自动回落" : "没有这一层；现存层见 layers" },
      };
    },
  }),
];

