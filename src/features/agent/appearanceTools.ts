/**
 * P88b-4 A2：外观工具五件套（theme_read / theme_patch / theme_preset / image_swatch / save_theme_extension）。
 * - 修改语义与 settings_apply 完全对齐：按**授权域**裁决（外观覆盖＝config，存为插件＝plugins），
 *   preview 档一律只预览；覆盖层撤销走 appearanceStore 内建 undoToken（本次运行内有效，详见 §5.4）；
 * - theme_read 只读不开门（对齐 settings_read）；image_swatch 读取图片 → 前端 canvas 量化取色，
 *   需自定义档位勾选 files 域 + 路径落在白名单（复用 generalTools 同款域门），产出建议色后由模型
 *   调 theme_patch 应用——取色确定性计算，不依赖模型视觉能力；
 * - save_theme_extension 把覆盖层装成一个**真实插件**（stagePackage→installStaged→setEnabled）
 *   并启用，随后清空覆盖层（保存即持久化边界）；P90 E：默认收尾步骤，用户在插件库可一键停用。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  APPEARANCE_TOKENS,
  getOverrides,
  overlayActive,
  patchTokens,
  readAllTokens,
  undoOverlayDetailed,
} from "./appearanceStore";
import { inWhitelist } from "./generalTools";
import { guardStyleText } from "../styles/styleSanitize";
import { scratchCssMerged } from "./styleScratch";
import { THEME_CSS_MAX_BYTES } from "../plugins/artifact";
import { DOMAIN_ZH } from "./scopeTiers";
import { defineTool, notExecuted, type AgentToolEntry, type ToolCtx, type ToolResultBody } from "./toolRegistry";

export const APPEARANCE_TOOLS = [
  "theme_read",
  "theme_patch",
  "theme_preset",
  "image_swatch",
  "save_theme_extension",
] as const;

/* ================= 内置配方（借鉴 Harness 第三方主题=一组 alias 覆盖；全部纯 token，无 CSS 注入） ================= */

export interface AppearancePreset {
  id: string;
  name: string;
  desc: string;
  /** 静态覆盖值 */
  vars?: Record<string, string>;
  /** 应用时按当前主题计算（如玻璃=读取面板色加透明度，深浅主题自适应） */
  derive?: () => Record<string, string>;
}

/** 颜色字符串 → [r,g,b]；支持 #rgb / #rrggbb / rgb() / rgba()（computed 值常见形式）。 */
export function parseColorToRgb(s: string): [number, number, number] | null {
  const v = s.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) {
    const [r, g, b] = m[1];
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

const rgbToHex = (r: number, g: number, b: number): string =>
  "#" + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");

/** 语义化版本补丁位 +1（同名主题原地升版用）；解析失败退回时间戳版，绝不产出非法版本串 */
function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return `0.1.${Date.now() % 100000}`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** 玻璃配方：读取当前面板/嵌底色 → 同色半透明（深浅主题自适应）。解析失败则跳过该项（部分覆盖合法）。 */
function glassVars(): Record<string, string> {
  const out: Record<string, string> = {};
  const cs = getComputedStyleSafe();
  for (const [name, alpha] of [
    ["--bg-panel", 0.72],
    ["--bg-inset", 0.6],
    ["--bg-titlebar", 0.66],
  ] as const) {
    const rgb = parseColorToRgb(cs.getPropertyValue(name));
    if (rgb) out[name] = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }
  return out;
}

function getComputedStyleSafe(): CSSStyleDeclaration {
  return getComputedStyle(document.documentElement);
}

/**
 * P92 E1：改动**前**抓一份当前值，回执给出「旧 → 新」清单。
 * 缺这个反馈环时，模型无从判断自己改得够不够（用户截图里那份"看不出什么变化"的主题
 * 就是这么交付的），用户也看不到到底动了哪几项。
 */
function diffAgainstCurrent(tokens: Record<string, string>): string[] {
  const cs = getComputedStyleSafe();
  const out: string[] = [];
  for (const [k, v] of Object.entries(tokens)) {
    let old: string;
    try {
      old = cs.getPropertyValue(k).trim();
    } catch {
      old = "";
    }
    out.push(`${k}: ${old || "（未覆盖）"} → ${String(v).slice(0, 60)}`);
  }
  return out;
}

/** 改动面过小时让模型自己补一轮，而不是交付弱结果后结束任务 */
function thinPatchHint(count: number): string | undefined {
  return count < 6
    ? `本次只改了 ${count} 项，用户几乎看不出差别：套 theme_preset 配方，或把 面(--bg/--bg-panel/--bg-inset)、边框(--border/--border-soft)、文字(--text/--text-dim)、主色(--accent) 一起调`
    : undefined;
}

export const APPEARANCE_PRESETS: AppearancePreset[] = [
  {
    id: "motion-calm",
    name: "动效·舒缓",
    desc: "过渡时长放慢约一倍，曲线更柔",
    vars: {
      "--dur-snap": "120ms",
      "--dur-fast": "220ms",
      "--dur-base": "320ms",
      "--ease": "cubic-bezier(0.25, 0.6, 0.3, 1)",
    },
  },
  {
    id: "motion-snappy",
    name: "动效·干脆",
    desc: "过渡时长缩短，操作更跟手",
    vars: {
      "--dur-snap": "40ms",
      "--dur-fast": "80ms",
      "--dur-base": "100ms",
      "--ease": "cubic-bezier(0.1, 0.9, 0.2, 1)",
    },
  },
  {
    id: "font-large",
    name: "大字号",
    desc: "五档字号整体上调（配合界面缩放可再放大）",
    vars: { "--fs-xs": "12px", "--fs-body": "13px", "--fs-sm": "14px", "--fs-md": "16px", "--fs-lg": "18px" },
  },
  {
    id: "font-compact",
    name: "紧凑字号",
    desc: "恢复默认五档字号",
    vars: { "--fs-xs": "10px", "--fs-body": "11px", "--fs-sm": "12px", "--fs-md": "14px", "--fs-lg": "16px" },
  },
  { id: "glass", name: "玻璃面板", desc: "面板与嵌底变半透明（跟随当前主题色）", derive: glassVars },
  {
    id: "minimal",
    name: "极简直角",
    desc: "去阴影、圆角收小，界面更硬朗",
    vars: {
      "--shadow": "none",
      "--radius-s": "2px",
      "--radius-m": "3px",
      "--radius-l": "4px",
      "--radius-xl": "5px",
    },
  },
];

/* ================= 取色（纯函数，便于测试） ================= */

export interface SwatchColor {
  hex: string;
  /** 占比 0~1 */
  ratio: number;
}

export interface SwatchResult {
  /** 整体偏暗（适合配深色主题） */
  isDark: boolean;
  /** 主色簇（按占比降序，最多 5 个） */
  palette: SwatchColor[];
  /** 建议强调色（饱和度优先）与其上的文字色 */
  suggest: { accent: string; accentText: string };
}

const luma = (r: number, g: number, b: number): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** 图片像素 → 调色板：每通道 5bit 量化聚桶，按占比取主簇；accent 选饱和度×占比最高的簇。 */
export function extractSwatch(px: Uint8ClampedArray): SwatchResult {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  let darkPixels = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (a < 128) continue; // 透明像素跳过
    total++;
    if (luma(r, g, b) < 0.5) darkPixels++;
    // 滤掉近白/近黑（占多数背景的极端色不进调色板，但计入明暗统计）
    const L = luma(r, g, b);
    if (L > 0.96 || L < 0.04) continue;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    cur.n++;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }
  if (total === 0) return { isDark: true, palette: [], suggest: { accent: "#2f6fce", accentText: "#ffffff" } };
  const list = [...buckets.values()]
    .map((c) => {
      const r = Math.round(c.r / c.n);
      const g = Math.round(c.g / c.n);
      const b = Math.round(c.b / c.n);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      return { hex: rgbToHex(r, g, b), ratio: c.n / total, sat };
    })
    .filter((c) => c.ratio >= 0.004)
    .sort((a, b) => b.ratio - a.ratio);
  // accent：饱和度×占比加权最高者；全低饱和（灰图）退回占比最高者
  const byWeight = [...list].sort((a, b) => b.sat * b.ratio - a.sat * a.ratio);
  const accent = (byWeight[0]?.sat > 0.12 ? byWeight[0] : list[0]) ?? { hex: "#2f6fce", ratio: 1, sat: 0 };
  const accentL = hexLuma(accent.hex);
  return {
    isDark: darkPixels / total > 0.5,
    palette: list.slice(0, 5).map(({ hex, ratio }) => ({ hex, ratio: Math.round(ratio * 1000) / 1000 })),
    suggest: { accent: accent.hex, accentText: accentL > 0.55 ? "#1c2128" : "#ffffff" },
  };
}

function hexLuma(hex: string): number {
  const rgb = parseColorToRgb(hex);
  return rgb ? luma(rgb[0], rgb[1], rgb[2]) : 0.5;
}

/** base64 图片 → 64×64 下采样像素（DOM 侧薄封装，不做单测；纯计算在 extractSwatch） */
async function readImagePixels(b64: string, mime: string): Promise<Uint8ClampedArray> {
  const img = new Image();
  img.src = `data:${mime};base64,${b64}`;
  await img.decode();
  const side = 64;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D 上下文不可用");
  ctx.drawImage(img, 0, 0, side, side);
  return ctx.getImageData(0, 0, side, side).data;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  avif: "image/avif",
};

/* ================= 工具定义与执行（P99a-A2：一条 entry 说清全部事实） ================= */

const HOST = { kind: "host" } as const;

/** 外观五支的授权域（此前散在 domainGate 调用点里，现在 entry.domain 单点声明、管线执行） */
async function themeRead(_args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResultBody> {
  const callId = ctx.callId;
  const theme = typeof document !== "undefined" ? document.documentElement.dataset.theme || "dark" : "unknown";
  return {
    callId,
    ok: true,
    status: "read",
    data: { theme, overlayActive: overlayActive(), overlay: getOverrides(), tokens: readAllTokens() },
  };
}

async function themePatch(parsed: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResultBody> {
  const callId = ctx.callId;
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    return notExecuted(callId, "invalid_args", { hint: "tokens 必须是 { token: value } 对象" });
  }
  const beforeDiff = diffAgainstCurrent(tokens as Record<string, string>);
  const r = patchTokens(tokens as Record<string, string>);
  if (!r.ok) return notExecuted(callId, r.err ?? "patch_failed");
  const count = r.applied?.length ?? 0;
  return {
    callId,
    ok: true,
    status: "applied",
    data: {
      applied: r.applied,
      changedCount: count,
      diff: beforeDiff.slice(0, 24),
      ...(thinPatchHint(count) ? { warn: thinPatchHint(count) } : {}),
      overlay: getOverrides(),
      // P90 E1：覆盖层只是预览，默认收尾=落成已启用插件（用户可一键停用）
      next: "把改动清单讲给用户听；满意后调用 save_theme_extension 保存为已启用插件（除非用户要求只看临时效果）",
    },
    undoToken: r.undoToken,
  };
}

async function themePreset(parsed: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResultBody> {
  const callId = ctx.callId;
  const name = String(parsed.name ?? "").trim();
  const preset = APPEARANCE_PRESETS.find((p) => p.id === name || p.name === name);
  if (!preset) {
    return notExecuted(callId, "unknown_preset", {
      hint: `可选配方：${APPEARANCE_PRESETS.map((p) => p.id).join(" / ")}`,
    });
  }
  const vars = { ...(preset.vars ?? {}), ...(preset.derive ? preset.derive() : {}) };
  const beforeDiff = diffAgainstCurrent(vars);
  const r = patchTokens(vars);
  if (!r.ok) return notExecuted(callId, r.err ?? "patch_failed");
  return {
    callId,
    ok: true,
    status: "applied",
    data: {
      preset: preset.id,
      desc: preset.desc,
      applied: r.applied,
      changedCount: r.applied?.length ?? 0,
      diff: beforeDiff.slice(0, 24),
      overlay: getOverrides(),
      next: "把改动清单讲给用户听；满意后调用 save_theme_extension 保存为已启用插件",
    },
    undoToken: r.undoToken,
  };
}

async function imageSwatch(parsed: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResultBody> {
  const callId = ctx.callId;
  const path = String(parsed.path ?? "").trim();
  if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
  // 授权域（files）由管线的 entry.domain 裁决，这里不再自判——两处判同一个门就是第二真相
  if (!inWhitelist(path)) {
    return notExecuted(callId, "path_outside_whitelist", { hint: "路径不在「Agent 文件白名单」内" });
  }
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return notExecuted(callId, "unsupported_image", {
      hint: `支持的图片格式：${Object.keys(MIME_BY_EXT).join(" / ")}`,
    });
  }
  try {
    const r = await invoke<{ bytes: number; data: string }>("agent_fs_read_b64", { path });
    const px = await readImagePixels(r.data, mime);
    const sw = extractSwatch(px);
    return {
      callId,
      ok: true,
      status: "read",
      data: {
        path,
        ...sw,
        hint: "可用 theme_patch 将建议色写入 --accent/--on-accent，或将主色写入 --bg-panel/--bg；预览满意后用 save_theme_extension 存为已启用插件",
      },
    };
  } catch (e) {
    return { callId, ok: false, status: "error", code: "tool_failed", data: { err: String(e).slice(0, 300) } };
  }
}

/**
 * 保存成主题插件的**唯一**安装链。`cssMaxBytes` 是两个调用方唯一的差别，且它是宿主侧参数
 * （模型碰不到）：`save_theme_extension` 收的是模型手写的 CSS，按 8 KiB 计；
 * `style_commit` 收的是宿主自己净化过的临时层，按产物上限计（详设 §13.3 第 3 条：
 * "写入时合法、固化时被拒"不能发生）。结构规则两条完全相同。
 */
const SAVE_CSS_MAX_BYTES = 8000;

async function persistTheme(
  parsed: Record<string, unknown>,
  ctx: ToolCtx,
  cssMaxBytes: number,
): Promise<ToolResultBody> {
  const callId = ctx.callId;
    const name = String(parsed.name ?? "").trim();
    if (!name) return notExecuted(callId, "invalid_args", { hint: "name 必须是非空字符串" });
    const css = typeof parsed.css === "string" ? parsed.css : undefined;
    if (css) {
      // P97-J0：这条通路以前**只校验长度**（旧 8000 字上限），"no global selectors except :root"
      // 只是写在工具描述里的话术 ⇒ 一条 `body{display:none}` 就能把整个界面关掉。
      // 现在过同一个净化器；组件级样式请走结构化的 style_patch（可逐条回执与撤销）。
      const g = guardStyleText(css, cssMaxBytes, [...APPEARANCE_TOKENS]);
      if (!g.ok) {
        return notExecuted(callId, "unsafe_css", {
          problems: g.problems.slice(0, 12),
          ruleCount: g.ruleCount,
          bytes: g.bytes,
          hint: "按 problems 逐条修正后重发；改单个组件请改用 style_patch（结构化规则、带命中数回执、可撤销）",
        });
      }
    }
    const overlay = getOverrides();
    if (!Object.keys(overlay).length && !css) {
      return notExecuted(callId, "empty_overlay", { hint: "当前没有可保存的外观修改；先用 theme_patch/theme_preset 生成覆盖" });
    }
    // P90 E2：改为走**真实插件安装链**（stagePackage → installStaged → setEnabled），
    // 旧实现只 upsertProjection，成果不进插件库、用户在「插件管理」里根本看不到，
    // 也就没有"一键停用"。动态 import：pluginStore→extRuntime→chatStore→agentRun
    // 会与本模块所在的 agent 链成环（§16 P89 红线 R1）。
    const { stagePackage, installStaged, setEnabled, proposeUpdate, approveUpdate, getPlugin } =
      await import("../plugins/pluginStore");
    // P91 D3：保存的是**完整主题**而不是补丁。旧实现只存 overlay 里那两三个 token，用户在插件库里
    // 打开看到的是"几乎没内容"的主题（正是"生成的几乎没生成"的直接来源）。
    // P98-M0 修正取法：直接读**全量 token 的有效计算值**，而不是"16 个色板键 + 覆盖层"。
    // 旧写法下 radius/fs/dur/ease 只有"覆盖层恰好还留着"才进得了插件——AI 先 undo 再保存就会丢，
    // 而丢了之后停用插件也"看起来没撤干净"（因为从来没生效过）。
    const { collectThemeVars } = await import("../ai/extRuntime");
    const vars = collectThemeVars(APPEARANCE_TOKENS).vars;
    // P92 D2：id = 名称的稳定哈希。旧 slug 会把中文整个吃掉（「AI 助手现代玻璃风」→
    // `user.agent.theme-ai`），两份不同主题因此撞成同一 id，再叠加"同 id 即原地升版"
    // 就会让后一份**静默覆盖**前一份。现在只有 id 与 name 同时相同才认作同一份主题，
    // 否则加后缀新建；人类可读的中文名继续留在 pkg.name。
    const { agentPluginId, freeAgentId } = await import("../plugins/pluginId");
    const THEME_PREFIX = "user.agent.theme";
    const baseId = agentPluginId(THEME_PREFIX, name);
    const exact = getPlugin(baseId);
    const same = exact && exact.pkg.name.trim() === name.trim() ? exact : null;
    const pluginId = same ? baseId : freeAgentId(baseId, (cand) => !!getPlugin(cand));
    const version = same ? bumpPatch(same.pkg.version) : "0.1.0";
    const manifest = {
      format: "uartix-plugin",
      schemaVersion: 2,
      id: pluginId,
      version,
      name,
      desc: "由 Agent 外观任务生成",
      hostApi: "^1.0",
      capabilities: ["theme.tokens"],
      contributions: { themes: [{ id: "main", entry: "main.json", name }] },
      artifacts: { "main.json": { kind: "theme", vars, ...(css ? { css } : {}) } },
      provenance: { createdBy: "agent", reviewed: false },
    };
    let updated = false;
    if (same) {
      const prop = proposeUpdate(pluginId, manifest);
      if (!prop.ok) return notExecuted(callId, "invalid_package", { msg: prop.msg });
      const prevCaps: string[] = same.pkg.capabilities;
      const addedCaps = manifest.capabilities.filter((c) => !prevCaps.includes(c));
      if (addedCaps.length) {
        // 新增能力必须用户在库里批准，Agent 不自签
        return {
          callId,
          ok: true,
          status: "applied",
          data: {
            pluginId,
            name,
            pendingApproval: true,
            hint: `同一份主题已存在，候选已就绪但含新增能力（${addedCaps.join("、")}）；请到 设置 → 插件管理 批准后生效`,
          },
        };
      }
      const ap = approveUpdate(pluginId);
      if (!ap.ok) return notExecuted(callId, "install_failed", { msg: ap.msg });
      updated = true;
    } else {
      const staged = stagePackage(manifest);
      if (!staged.ok || !staged.stagingId) {
        return notExecuted(callId, "invalid_package", {
          errors: staged.errors.slice(0, 8),
          // P92 D2：把"id 不合规"翻译成模型能照做的下一步，而不是只丢一串校验错误
          ...(staged.errors.some((e) => e.toLowerCase().includes("id"))
            ? { hint: `id 必须是小写点分 ASCII 标识；本次已自动生成 ${pluginId}，如需自定义请显式传 id 参数` }
            : {}),
        });
      }
      const installed = installStaged(staged.stagingId);
      if (!installed.ok || !installed.id) {
        return notExecuted(callId, "install_failed", { msg: installed.msg });
      }
    }
    const en = setEnabled(pluginId, true);
    const { clearOverlay } = await import("./appearanceStore");
    clearOverlay(); // 保存即持久化边界：插件层接管渲染，覆盖层清空
    return {
      callId,
      ok: true,
      status: "applied",
      data: {
        pluginId,
        id: pluginId,
        name,
        version,
        updated,
        enabled: en.ok,
        tokens: Object.keys(vars).length,
        // P90 E3：回执自带可行动文案，用户不必去猜"改完怎么恢复"
        hint: en.ok
          ? `已保存为插件「${name}」并启用；关闭：本卡『停用』或 设置 → 插件管理`
          : `插件已保存但启用失败：${en.msg}`,
      },
    };
}

export const appearanceToolEntries: AgentToolEntry[] = [
  defineTool({
    name: "theme_read",
    labelZh: "读取外观",
    effect: "read",
    domain: null,
    provenance: HOST,
    description:
      "Read current appearance tokens: theme id, full token values (colors/font sizes/radius/motion), and the active overlay. Read-only, no approval needed.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    summarize: () => "读取外观 token",
    execute: themeRead,
  }),
  defineTool({
    name: "theme_patch",
    labelZh: "修改外观",
    effect: "config_write",
    domain: "config",
    provenance: HOST,
    description: `Apply appearance token overrides (session-level preview; undoable). Needs the ${DOMAIN_ZH.config} authorization. A style request is NOT satisfied by 1-2 tokens: cover surface (--bg/--bg-panel/--bg-inset), border (--border/--border-soft), text (--text/--text-dim) and accent together, or prefer theme_preset which derives a coherent set from the live theme. After the user can see the result, call save_theme_extension to persist it as an enabled plugin unless they asked for a temporary preview. Args: { tokens: Record<string,string> } over whitelist: ${APPEARANCE_TOKENS.join(" ")}. Unit tokens accept <n>px/<n>ms; --ease accepts cubic-bezier(...) or named curves; unknown/invalid tokens reject the whole patch atomically.`,
    parameters: { type: "object", properties: { tokens: { type: "object" } }, required: ["tokens"], additionalProperties: false },
    summarize: (a) => {
      const tokens = a.tokens;
      const keys = tokens && typeof tokens === "object" ? Object.keys(tokens as object) : [];
      return keys.length ? `调整 ${keys.slice(0, 4).join("、")}${keys.length > 4 ? ` 等 ${keys.length} 项` : ""}` : "调整外观";
    },
    undoRoute: (token) => undoOverlayDetailed(token),
    execute: themePatch,
  }),
  defineTool({
    name: "theme_preset",
    labelZh: "应用配方",
    effect: "config_write",
    domain: "config",
    provenance: HOST,
    description:
      "Preferred first move for a named style (glass / dark / high-contrast ...): applies a built-in preset that DERIVES a coherent token set from the currently active theme (stacked onto the overlay, undoable), instead of you hand-writing 2 colors. Needs the " +
      DOMAIN_ZH.config +
      " authorization. Persist afterwards with save_theme_extension so the user can switch it off later. Args: { name: string } one of: " +
      APPEARANCE_PRESETS.map((p) => p.id).join(" / ") +
      ".",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    summarize: (a) => `配方「${String(a.name ?? "") || "?"}」`,
    undoRoute: (token) => undoOverlayDetailed(token),
    execute: themePreset,
  }),
  defineTool({
    name: "image_swatch",
    labelZh: "图片取色",
    effect: "read",
    domain: "files",
    provenance: HOST,
    description:
      "Extract a color palette from an image inside the file whitelist (custom scope with files domain): returns dominant colors, dark/light judgement, and a suggested accent. Then use theme_patch to apply colors. Args: { path: string }.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    summarize: (a) => {
      const p = String(a.path ?? "");
      return `取色 ${p.split(/[\\/]/).pop() || p.slice(0, 40)}`;
    },
    execute: imageSwatch,
  }),
  defineTool({
    name: "save_theme_extension",
    labelZh: "保存主题",
    // 存为主题＝装插件并启用，撤销走插件库停用（覆盖层 undoToken 在保存后失效，见函数内注释）
    effect: "draft_write",
    domain: "plugins",
    provenance: HOST,
    description:
      "Persist the appearance work as an ENABLED theme plugin (default final step of any appearance edit; overlay is cleared afterwards, undo tokens expire). It saves a COMPLETE theme — the currently active theme's full token set with your overlay applied on top — not just the patched tokens, and saving the same name again bumps the version in place instead of creating a duplicate. The user can switch it off from this card's 停用 button or 设置 → 插件管理. Needs the plugin-library (插件库) authorization. Args: { name: string, css?: string (optional scoped CSS; **validated** — html/body/*/#root selectors, position:fixed, url()/@import and z-index>900 are rejected per rule with the reason; a :root rule may only declare NEW --custom-properties, whitelisted tokens go through theme_patch; prefer style_patch for per-component rules) }.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, css: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    summarize: (a) => `保存主题「${String(a.name ?? "") || "?"}」`,
    undoRoute: (token) => undoOverlayDetailed(token),
    execute: (a, ctx) => persistTheme(a, ctx, SAVE_CSS_MAX_BYTES),
  }),
  defineTool({
    /* —— P99a-B4（详设 §13.3）：就地固化临时层。读宿主真值，不让模型复述自己发过的参数 —— */
    name: "style_commit",
    labelZh: "固化临时样式",
    // 与保存主题同权同域：写的是插件库条目，不是会话层
    effect: "draft_write",
    domain: "plugins",
    provenance: HOST,
    description:
      "Turn the CURRENT session scratch style layers (what `style_patch` actually applied) into an ENABLED theme plugin — the host reads the merged layer CSS itself, so the persisted look equals the look on screen. Do NOT retype the rules: after several patches and reverts a hand-written copy is not faithful. Args: { name: string } (same name again = version bump, not a duplicate plugin). Token overrides are captured from the live theme as well; afterwards the overlay is cleared and the scratch undo tokens expire — recovery path becomes 停用 in 设置 → 插件管理 or rollback_plugin. Fails with no_scratch_layers when nothing is pending. Needs the 插件库 authorization.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    summarize: (a) => `固化临时样式为主题「${String(a.name ?? "") || "?"}」`,
    execute: async (a, ctx) => {
      const callId = ctx.callId;
      const { css, layers } = scratchCssMerged();
      if (!css.trim()) {
        return notExecuted(callId, "no_scratch_layers", {
          hint: "当前会话没有待固化的临时样式层；先用 style_patch 改，或直接用 save_theme_extension 存主题",
        });
      }
      const r = await persistTheme({ name: String(a.name ?? ""), css }, ctx, THEME_CSS_MAX_BYTES);
      return { ...r, data: { ...(r.data as Record<string, unknown>), layers, layerCount: layers.length } };
    },
  }),
];
