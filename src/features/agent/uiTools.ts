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
import { slotCatalogText } from "../../styles/layerSlots";
import { censusSurface, collectInventory, collectAuditInput, AUDIT_DEFAULTS, INVENTORY_SECTIONS, SURFACE_DEFAULTS } from "./uiSurface";
import {
  auditContrast,
  auditHitTargets,
  auditLayerClash,
  auditMotionOverride,
  auditOverflow,
  HIT_TARGET_MIN_PX,
  summarizeAudit,
} from "../../styles/renderAudit";
import { buildStyleText, sanitizeStyleRules, STYLE_CAPS } from "../styles/styleSanitize";
import { applyLayer, listLayers, revertAll, revertByToken, revertLayer } from "./styleScratch";
import { defineTool, notExecuted as bad, type AgentToolEntry } from "./toolRegistry";
import type { ToolReceipt } from "./types";
// P103 批2：版式与工具栏两支新工具的落点——全部走现成管道（appBus / layoutsStore / chromeStore），
// dockview api 不出 App.tsx，这里只发请求与改 store，不直接摸布局。
import { requestApplyLayout, requestApplyPreset } from "../ai/appBus";
import { CHROME_SEGS, getChrome, patchChrome, resetChrome, type ChromeSegId } from "../settings/chromeStore";
import { getLayout, getSnapshot as getLayouts } from "../settings/layoutsStore";
import { WORKSPACE_PRESETS } from "../settings/settingsStore";

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

/**
 * 当前**真的贴在屏幕上**的注入层文本（AI 临时层 + 主题扩展层）。
 *
 * 为什么从 DOM 节点读而不是从 store 读：节点里的字节就是浏览器实际吃进去的那份，
 * 从 store 再拼一次等于造第二真相——净化、截断、启停顺序任何一处不同，审计就审了个不存在的东西。
 */
function injectedCssText(): string {
  if (typeof document === "undefined") return "";
  return [...document.querySelectorAll("style[data-ai-scratch], style[data-ai-ext]")]
    .map((s) => s.textContent ?? "")
    .filter(Boolean)
    .join("\n");
}

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
      `Apply per-component CSS as **structured rules** (not free text) into a session-scoped scratch layer: rules: [{ selector, decls: {prop:value}, keyframes?: {name:"fx-…", body} }]. Each rule is validated (global selectors html/body/*/#root, url()/@import, and the layer rule: position:fixed must pair with a registered slot such as z-index: var(--z-menu) — slots are ${slotCatalogText()}; protected tiers and unknown slots are rejected; caps ${STYLE_CAPS.maxRules} rules / ${STYLE_CAPS.maxBytes} bytes) and reported back with hit counts and before→after values; a selector that hits 0 elements comes back in zeroHit with the real class names to use instead. Nothing is persisted: call save_theme_extension({name, css}) afterwards if the user wants to keep it; revert with style_revert. For glow/sheen/ripple/particles/border animations use the built-in recipes — call ui_inventory { section: "fx" } first (classes + --fx-* knobs) instead of writing @keyframes from scratch. Needs the ${DOMAIN_ZH.ui} authorization.`,
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
  defineTool({
    /* —— P131-B1（详设 A9）：把"渲染层到底读不读得出来"做成每次都能跑的证据 —— */
    name: "theme_audit",
    labelZh: "审计渲染层",
    effect: "read",
    // 与 ui_inspect 同档：只读、不开权限门。审计要是得先申请授权，模型就不会顺手跑了
    domain: null,
    provenance: HOST,
    description:
      `Measure what is ACTUALLY on screen instead of what the CSS says: contrast of every visible text node against its real composited backdrop (WCAG 4.5:1, 3:1 for large text), text painted outside its own box, interactive targets under ${HIT_TARGET_MIN_PX} CSS px (folded back through --zoom, so a narrow control at 125% is not falsely accused), rules that would override the user's reduced-motion setting (specificity vs the host's html.no-motion baseline), and layer clashes (a position:fixed overlay high enough to bury the settings dialog, or a reference to a protected/unknown z slot). Read-only — it changes nothing. Args: { root?: string (default "body"), maxSamples?: number (20..800, default ${AUDIT_DEFAULTS.maxSamples}) }. blocking:true means SPEAK: list the findings for the user and fix the selectors/colors, then run it again — it is not an install gate and never will be (evidence open, permissions closed). The 12 static gates cannot see injected theme CSS, so this is the only check that covers what you just painted.`,
    parameters: {
      type: "object",
      properties: { root: { type: "string" }, maxSamples: { type: "number" } },
      additionalProperties: false,
    },
    summarize: () => "审计渲染层（对比度/溢出/命中区/动效降级）",
    execute(args, ctx) {
      const callId = ctx.callId;
      if (typeof document === "undefined") {
        return bad(callId, "no_dom", { hint: "审计要读活界面，当前环境没有 DOM；界面上跑一次即可" });
      }
      const root = typeof args.root === "string" ? args.root.trim() : "";
      const input = collectAuditInput({
        ...(root ? { root } : {}),
        ...(typeof args.maxSamples === "number" ? { maxSamples: args.maxSamples } : {}),
      });
      if (!input.visited && !input.textSamples.length) {
        return bad(callId, "no_visible_nodes", {
          hint: `选择器 ${root || "body"} 下没有可见元素：先 ui_inspect 看清真实结构，或去掉 root 参数审全局`,
        });
      }
      const { issues, unmeasurable } = auditContrast(input.textSamples);
      const injected = injectedCssText();
      const result = summarizeAudit({
        sampled: input.textSamples.length,
        contrast: issues.slice(0, 12),
        unmeasurable: unmeasurable.slice(0, 6),
        overflow: auditOverflow(input.overflow).slice(0, 12),
        hitTargets: auditHitTargets(input.hits).slice(0, 12),
        motionOverride: auditMotionOverride(injected).slice(0, 12),
        layerClash: auditLayerClash(injected).slice(0, 12),
        perf: { styleBytes: input.perf.styleBytes, rules: input.perf.rules },
      });
      return {
        callId,
        ok: true,
        status: "read",
        data: {
          ...result,
          contrastTotal: issues.length,
          unmeasurableTotal: unmeasurable.length,
          visited: input.visited,
          truncated: input.truncated,
          zoom: input.zoom,
          sheetsSkipped: input.perf.sheetsSkipped,
          injectedBytes: injected.length,
          hint: result.blocking
            ? "有要说的：逐条把 selector/ratio/need 讲给用户，改完再跑一次确认归零；不要因为有发现就放弃这条设计，也不要替他决定「可以忽略」"
            : `界面在 ${root || "body"} 范围内读得出来、没画出格子、命中区够、减弱动效也还压得住（采了 ${input.textSamples.length} 处文字）`,
        },
      };
    },
  }),
  defineTool({
    name: "layout_apply",
    labelZh: "切换工作区版式",
    effect: "config_write",
    domain: "ui",
    provenance: HOST,
    description:
      `Switch the workbench panel layout (the docked areas). Three forms: { preset: "${WORKSPACE_PRESETS.join("|")}" } applies a built-in preset; { slot: "name-or-id" } applies one of the user's saved layout slots; { rollback: true } restores the automatic snapshot taken before the last switch. Every apply snapshots the current layout first, so rollback always undoes the most recent switch. Needs the ${DOMAIN_ZH.ui} authorization.`,
    parameters: {
      type: "object",
      properties: {
        preset: { type: "string" },
        slot: { type: "string" },
        rollback: { type: "boolean" },
      },
      additionalProperties: false,
    },
    summarize: (a) =>
      a.rollback === true
        ? "回滚到切换前的版式"
        : typeof a.preset === "string" && a.preset
          ? `切换内置版式 ${a.preset}`
          : typeof a.slot === "string" && a.slot
            ? `应用布局槽 ${a.slot}`
            : "切换工作区版式",
    async execute(args, ctx) {
      const callId = ctx.callId;
      // dockview api 只在 App.tsx 里：布局 JSON 经 appBus 单向总线送过去，done 是它的回执通道（同步判定，不会石沉大海）
      const applyJson = (layout: unknown) =>
        new Promise<string | null>((resolve) => requestApplyLayout(layout, resolve));
      if (args.rollback === true) {
        const backup = getLayout("auto-backup");
        if (!backup) {
          return bad(callId, "no_backup", {
            hint: "还没有可回滚的快照——每次切换版式前都会自动快照，切换过一次之后再回滚",
          });
        }
        const err = await applyJson(backup.layout);
        if (err) return bad(callId, "apply_failed", { error: err });
        return {
          callId,
          ok: true,
          status: "applied",
          data: { rolledBack: true, note: "已回滚到上一次切换前的版式（本次回滚前也自动快照了一次，想反悔就再 rollback 一次）" },
        };
      }
      const preset = typeof args.preset === "string" ? args.preset.trim() : "";
      if (preset) {
        if (!(WORKSPACE_PRESETS as readonly string[]).includes(preset)) {
          return bad(callId, "invalid_args", { hint: `未知预设：${preset}（可选：${WORKSPACE_PRESETS.join("/")}）` });
        }
        requestApplyPreset(preset);
        return {
          callId,
          ok: true,
          status: "applied",
          data: { preset, note: `已切换内置版式「${preset}」；切换前的布局已自动快照，rollback:true 可回滚` },
        };
      }
      const slot = typeof args.slot === "string" ? args.slot.trim() : "";
      if (slot) {
        const slots = getLayouts().slots;
        const hit = slots.find((s) => s.id === slot || s.name === slot);
        if (!hit) {
          return bad(callId, "no_such_slot", {
            hint: slots.length
              ? `没有名为「${slot}」的布局槽；现有：${slots.map((s) => s.name).join("、")}`
              : "还没有保存过布局槽（用户可在 设置 → 工作区 里另存；也可以先切内置预设）",
          });
        }
        const err = await applyJson(hit.layout);
        if (err) return bad(callId, "apply_failed", { error: err });
        return {
          callId,
          ok: true,
          status: "applied",
          data: { slot: hit.name, note: `已应用布局槽「${hit.name}」；之前的布局已自动快照，rollback:true 可回滚` },
        };
      }
      return bad(callId, "invalid_args", { hint: "三选一：preset（内置预设）/ slot（用户布局槽名或 id）/ rollback:true（回滚到上一版式）" });
    },
  }),
  defineTool({
    name: "chrome_set",
    labelZh: "调整工具栏分区",
    effect: "config_write",
    domain: "ui",
    provenance: HOST,
    description:
      `Reorder or hide the three toolbar segments: "connect" (interface params + connect button), "session" (record/replay), "layout" (+Panel picker / edit-layout button). Args: { order?: string[] — subset allowed, missing segments keep default order appended at the end (segments can never be lost); hide?: string[]; show?: string[]; reset?: true }. Refuses to hide every segment (an empty toolbar has no way back). Persisted across restarts. Needs the ${DOMAIN_ZH.ui} authorization.`,
    parameters: {
      type: "object",
      properties: {
        order: { type: "array", items: { type: "string" } },
        hide: { type: "array", items: { type: "string" } },
        show: { type: "array", items: { type: "string" } },
        reset: { type: "boolean" },
      },
      additionalProperties: false,
    },
    summarize: (a) => (a.reset === true ? "恢复工具栏默认分区" : "调整工具栏分区（排序/显隐）"),
    execute(args, ctx) {
      const callId = ctx.callId;
      if (args.reset === true) {
        resetChrome();
        return {
          callId,
          ok: true,
          status: "applied",
          data: { state: getChrome(), note: "已恢复默认三段：接口参数 ｜ 会话 ｜ 面板与布局" },
        };
      }
      const order = Array.isArray(args.order) ? args.order.map(String) : undefined;
      const hide = Array.isArray(args.hide) ? args.hide.map(String) : undefined;
      const show = Array.isArray(args.show) ? args.show.map(String) : undefined;
      if (!order && !hide && !show) {
        return bad(callId, "invalid_args", {
          hint: "至少给一个参数：order / hide / show / reset:true",
          state: getChrome(),
        });
      }
      const invalid = [...(order ?? []), ...(hide ?? []), ...(show ?? [])].filter(
        (v) => !(CHROME_SEGS as readonly string[]).includes(v),
      );
      if (invalid.length) {
        return bad(callId, "invalid_args", { hint: `合法段名只有：${CHROME_SEGS.join("/")}`, invalid });
      }
      const cur = getChrome();
      const hidden = cur.hidden
        .filter((s) => !(show ?? []).includes(s))
        .concat(((hide ?? []) as ChromeSegId[]).filter((s) => !cur.hidden.includes(s)));
      patchChrome({ order: order as ChromeSegId[] | undefined, hidden });
      const state = getChrome();
      const visible = state.order.filter((s) => !state.hidden.includes(s));
      return {
        callId,
        ok: true,
        status: "applied",
        data: {
          state,
          visible,
          note: `工具栏现为：${visible.join(" ｜ ")}${state.hidden.length ? `（已隐藏：${state.hidden.join("、")}）` : ""}；reset:true 恢复默认`,
        },
      };
    },
  }),
];

