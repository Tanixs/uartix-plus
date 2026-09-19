/**
 * P88b-4 A2：外观工具五件套（theme_read / theme_patch / theme_preset / image_swatch / save_theme_extension）。
 * - 修改语义与 settings_apply 完全对齐：仅「常规创造」档自动执行（可撤销外观），preview/custom 拒绝；
 *   覆盖层撤销走 appearanceStore 内建 undoToken（本次运行内有效，详见 §5.4）；
 * - theme_read 只读不开门（对齐 settings_read）；image_swatch 读取图片 → 前端 canvas 量化取色，
 *   需自定义档位勾选 files 域 + 路径落在白名单（复用 generalTools 同款域门），产出建议色后由模型
 *   调 theme_patch 应用——取色确定性计算，不依赖模型视觉能力；
 * - save_theme_extension 把覆盖层转成 theme 扩展存入插件库并启用，随后清空覆盖层（保存即持久化边界）。
 */
import { invoke } from "@tauri-apps/api/core";
import { upsertProjection } from "../ai/extensionStore";
import {
  APPEARANCE_TOKENS,
  getOverrides,
  overlayActive,
  patchTokens,
  readAllTokens,
} from "./appearanceStore";
import { inWhitelist, GENERAL_DOMAIN } from "./generalTools";
import type { ToolCall, ToolDefinition, ToolReceipt, TaskContext } from "./types";

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

/* ================= 工具定义与执行 ================= */

export const appearanceToolDefs: ToolDefinition[] = [
  {
    name: "theme_read",
    description:
      "Read current appearance tokens: theme id, full token values (colors/font sizes/radius/motion), and the active overlay. Read-only, no approval needed.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "theme_patch",
    description: `Apply appearance token overrides (session-level preview; undoable). Only in create scope. Args: { tokens: Record<string,string> } over whitelist: ${APPEARANCE_TOKENS.join(" ")}. Unit tokens accept <n>px/<n>ms; --ease accepts cubic-bezier(...) or named curves; unknown/invalid tokens reject the whole patch atomically.`,
    parameters: { type: "object", properties: { tokens: { type: "object" } }, required: ["tokens"], additionalProperties: false },
  },
  {
    name: "theme_preset",
    description:
      "Apply a built-in appearance preset (stacked onto current overlay, undoable). Only in create scope. Args: { name: string } one of: " +
      APPEARANCE_PRESETS.map((p) => p.id).join(" / ") +
      ".",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
  {
    name: "image_swatch",
    description:
      "Extract a color palette from an image inside the file whitelist (custom scope with files domain): returns dominant colors, dark/light judgement, and a suggested accent. Then use theme_patch to apply colors. Args: { path: string }.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "save_theme_extension",
    description:
      "Persist the current appearance overlay as an enabled theme extension in the plugin library (overlay is cleared afterwards; undo tokens expire). Only in create scope. Args: { name: string, css?: string (optional extra scoped CSS, no global selectors except :root variables) }.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, css: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

function notExecuted(callId: string, code: string, data?: unknown): ToolReceipt {
  return { callId, ok: false, status: "not_executed", code, ...(data !== undefined ? { data } : {}) };
}

/** 修改类工具的档位门：与 settings_apply 一致，仅 create 档自动执行（可撤销外观）。 */
function createScopeDenied(callId: string, ctx: TaskContext): ToolReceipt | null {
  if (ctx.signal.aborted) return notExecuted(callId, "cancelled");
  if (ctx.scope !== "create") {
    return notExecuted(callId, "preview_only", {
      hint: `外观修改仅在「常规创造」档自动执行（当前档位 ${ctx.scope}）；覆盖可随时撤销`,
    });
  }
  return null;
}

export async function executeAppearanceTool(call: ToolCall, ctx: TaskContext): Promise<ToolReceipt> {
  const callId = call.callId;
  let parsed: Record<string, unknown> = {};
  if (call.arguments && call.arguments.trim()) {
    try {
      parsed = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      return notExecuted(callId, "invalid_json");
    }
  }
  switch (call.name) {
    case "theme_read": {
      const theme = typeof document !== "undefined" ? document.documentElement.dataset.theme || "dark" : "unknown";
      return {
        callId,
        ok: true,
        status: "read",
        data: { theme, overlayActive: overlayActive(), overlay: getOverrides(), tokens: readAllTokens() },
      };
    }
    case "theme_patch": {
      const denied = createScopeDenied(callId, ctx);
      if (denied) return denied;
      const tokens = parsed.tokens;
      if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
        return notExecuted(callId, "invalid_args", { hint: "tokens 必须是 { token: value } 对象" });
      }
      const r = patchTokens(tokens as Record<string, string>);
      if (!r.ok) return notExecuted(callId, r.err ?? "patch_failed");
      return { callId, ok: true, status: "applied", data: { applied: r.applied, overlay: getOverrides() }, undoToken: r.undoToken };
    }
    case "theme_preset": {
      const denied = createScopeDenied(callId, ctx);
      if (denied) return denied;
      const name = String(parsed.name ?? "").trim();
      const preset = APPEARANCE_PRESETS.find((p) => p.id === name || p.name === name);
      if (!preset) {
        return notExecuted(callId, "unknown_preset", {
          hint: `可选配方：${APPEARANCE_PRESETS.map((p) => p.id).join(" / ")}`,
        });
      }
      const vars = { ...(preset.vars ?? {}), ...(preset.derive ? preset.derive() : {}) };
      const r = patchTokens(vars);
      if (!r.ok) return notExecuted(callId, r.err ?? "patch_failed");
      return {
        callId,
        ok: true,
        status: "applied",
        data: { preset: preset.id, desc: preset.desc, applied: r.applied, overlay: getOverrides() },
        undoToken: r.undoToken,
      };
    }
    case "image_swatch": {
      if (ctx.signal.aborted) return notExecuted(callId, "cancelled");
      const path = String(parsed.path ?? "").trim();
      if (!path) return notExecuted(callId, "invalid_args", { hint: "path 必须是非空字符串" });
      if (ctx.scope !== "custom" || !(ctx.allowed ?? []).includes("files")) {
        return notExecuted(callId, "general_tool_requires_custom", {
          hint: `取色读取文件需要「Agent · 自定义」档位勾选「${GENERAL_DOMAIN.files}」授权域`,
        });
      }
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
            hint: "可用 theme_patch 将建议色写入 --accent/--on-accent，或将主色写入 --bg-panel/--bg（会话级预览、可撤销）",
          },
        };
      } catch (e) {
        return { callId, ok: false, status: "error", code: "tool_failed", data: { err: String(e).slice(0, 300) } };
      }
    }
    case "save_theme_extension": {
      const denied = createScopeDenied(callId, ctx);
      if (denied) return denied;
      const name = String(parsed.name ?? "").trim();
      if (!name) return notExecuted(callId, "invalid_args", { hint: "name 必须是非空字符串" });
      const css = typeof parsed.css === "string" ? parsed.css : undefined;
      if (css && css.length > 8000) return notExecuted(callId, "invalid_args", { hint: "css 超长（上限 8000 字符）" });
      const overlay = getOverrides();
      if (!Object.keys(overlay).length && !css) {
        return notExecuted(callId, "empty_overlay", { hint: "当前没有可保存的外观修改；先用 theme_patch/theme_preset 生成覆盖" });
      }
      const id = crypto.randomUUID();
      upsertProjection({
        id,
        type: "theme",
        name,
        desc: "由 Agent 外观任务生成",
        version: "1.0.0",
        perms: ["css"],
        enabled: true,
        createdAt: Date.now(),
        vars: overlay,
        ...(css ? { css } : {}),
      });
      // 动态 import：extRuntime 引 chatStore，静态引入会与本模块（被 agentRun 链静态持有）成环
      const { applyStyleExts } = await import("../ai/extRuntime");
      applyStyleExts(); // 立即接管渲染（随后清覆盖层，避免双重来源）
      const { clearOverlay } = await import("./appearanceStore");
      clearOverlay();
      return { callId, ok: true, status: "applied", data: { id, name, enabled: true, tokens: Object.keys(overlay).length } };
    }
    default:
      return notExecuted(callId, "unknown_tool");
  }
}
