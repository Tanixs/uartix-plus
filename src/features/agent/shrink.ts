/**
 * P95-H3：按内容形态的确定性压缩（对照 dsh 的 `toolshrink`/`dsh-tool-squeeze`）。
 *
 * 为什么不是"按字节切一刀"：`preview(2000)` 对时序数组等于"前 2000 个字符都是数字串开头"，
 * 模型既看不到分布也看不到尾部；对 `shell_exec` 更糟——失败原因在**结尾**，前 2000 字往往是回声。
 * 这里按形态留"人真正要看的东西"，且**必须**如实标 `count/returned/truncated`（红线 A7 同源）。
 *
 * 刻意保持零运行时依赖（只 import type）：`agentAdapter → 本模块 → generalTools → agentAdapter`
 * 会构成新的静态环，而求值期成环 = dev 白屏（P92-F / HANDOFF §8-33）。
 * 也因此**不做 HTML 正文抽取**——那需要复用 generalTools 里的 stripTags，代价是重新闭环；
 * 网页类交给 P94-G3 的 `read_artifact` 分页，那才是它的正确出口。
 */
import type { ToolReceipt } from "./types";

/** 数组类：保留首尾各 N 个采样点 + 分位数 */
export const KEEP_EDGES = 8;
/** 列表类：每段保留前 N 条 */
export const KEEP_ITEMS = 12;
/** 树/目录类：每层保留前 N 个子项 */
export const KEEP_TREE = 30;
/** 长文本类：超过这个长度就换头/尾摘录（单位字符） */
export const TEXT_CLAMP = 4000;
export const TEXT_HEAD = 1600;
export const TEXT_TAIL = 1600;

export interface ShapedResult {
  data: unknown;
  /** 命中的形态名（进事件与回执，便于复盘"当时按什么规则压的"） */
  shape: string;
  /** 被换掉的条目/字符数量级（0 = 原样通过） */
  dropped: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

/** 时序数组 → 形态无关的统计摘要（复用 adapter 里 channelStats 的思路，但作用于回副本） */
function shapeSeries(v: unknown[]): { summary: unknown[]; dropped: number } {
  let dropped = 0;
  const summary = v.map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const t = Array.isArray(row.t) ? (row.t as unknown[]).filter(isNum) : [];
    const val = Array.isArray(row.v) ? (row.v as unknown[]).filter(isNum) : [];
    if (!t.length && !val.length) return row;
    const sorted = [...val].sort((a, b) => a - b);
    dropped += Math.max(0, t.length - KEEP_EDGES * 2);
    return {
      id: row.id,
      name: row.name,
      points: val.length,
      min: sorted[0] ?? null,
      max: sorted[sorted.length - 1] ?? null,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      firstT: t[0] ?? null,
      lastT: t[t.length - 1] ?? null,
      head: val.slice(0, KEEP_EDGES),
      tail: val.slice(-KEEP_EDGES),
      note: `时序已按形态压缩：只留分位数与首尾各 ${KEEP_EDGES} 点（原始 ${val.length} 点）；需要逐点请用 plot_window 缩小 maxPoints 或 read_artifact 取原文`,
    };
  });
  return { summary, dropped };
}

/** 递归把"对象里的数组段"收成前 K 条 + 计数（app_state 分段 / fs_list 目录树同型） */
function clampLists(node: unknown, depth = 0): { value: unknown; dropped: number } {
  if (depth > 4 || node === null || typeof node !== "object") return { value: node, dropped: 0 };
  if (Array.isArray(node)) {
    const dropped = node.length > KEEP_TREE ? node.length - KEEP_TREE : 0;
    const kept = node.slice(0, KEEP_TREE);
    const kids = kept.map((x) => clampLists(x, depth + 1));
    return { value: kids.map((k) => k.value), dropped: dropped + kids.reduce((n, k) => n + k.dropped, 0) };
  }
  let dropped = 0;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(node as Record<string, unknown>);
  // 工具自己已经报过 count/returned/truncated 的段 = 已自管，不再二次截（否则 LIST_CAP 会被这里的 KEEP_TREE 覆盖）
  const selfDescribed = entries.some(([k]) => /Count$|^count$|^returned$|^truncated$|^trimmedTo$/.test(k))
    || (node as { truncated?: unknown; count?: unknown }).truncated !== undefined
    || (node as { count?: unknown }).count !== undefined;
  for (const [k, v] of entries) {
    if (selfDescribed && Array.isArray(v)) {
      // 本层不截长度，只往里收（数组本身交给下一层会被 KEEP_TREE 二次截，等于覆盖工具的 LIST_CAP）
      const kids = v.map((x) => clampLists(x, depth + 1));
      out[k] = kids.map((k) => k.value);
      dropped += kids.reduce((n, k) => n + k.dropped, 0);
      continue;
    }
    const r = clampLists(v, depth + 1);
    out[k] = r.value;
    dropped += r.dropped;
    if (Array.isArray(v) && r.dropped > 0) {
      out[`${k}Count`] = v.length;
      out[`${k}Returned`] = Array.isArray(r.value) ? r.value.length : v.length;
      out[`${k}Truncated`] = true;
    }
  }
  return { value: out, dropped };
}

/** 长文本：留头留尾（失败原因与结尾摘要通常在尾部），中间显式承认被省略 */
function clampText(s: string): { value: unknown; dropped: number } {
  if (s.length <= TEXT_CLAMP) return { value: s, dropped: 0 };
  return {
    value: `${s.slice(0, TEXT_HEAD)}\n…（中间省略 ${s.length - TEXT_HEAD - TEXT_TAIL} 字符，全量可用 read_artifact 分页取回）…\n${s.slice(-TEXT_TAIL)}`,
    dropped: s.length - TEXT_HEAD - TEXT_TAIL,
  };
}

/** 尾部优先的字段（命令输出：报错在结尾） */
const TAIL_FIRST_FIELDS = new Set(["stdout", "stderr", "output", "log", "logs", "content", "body", "text", "snippet"]);

function clampLongStrings(node: unknown, depth = 0): { value: unknown; dropped: number } {
  if (depth > 4 || node === null || typeof node !== "object") return { value: node, dropped: 0 };
  if (Array.isArray(node)) {
    const kids = node.map((x) => clampLongStrings(x, depth + 1));
    return { value: kids.map((k) => k.value), dropped: kids.reduce((n, k) => n + k.dropped, 0) };
  }
  let dropped = 0;
  const out: Record<string, unknown> = {};
  const src = node as Record<string, unknown>;
  // 源头（Rust / 工具自己）已声明的 `{字段}Bytes` 不覆盖：它知道真正的原始体积，这里只看见被源头
  // 截过的那一段。用"源对象键集合"判定而不是"是否已写入"，否则换个键顺序就退化成"把窗口长度当原始长度"。
  const declared = new Set(Object.keys(src));
  const clipped: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "string" && v.length > TEXT_CLAMP) {
      const c = clampText(v);
      out[k] = c.value;
      if (!declared.has(`${k}Bytes`)) out[`${k}Bytes`] = v.length;
      if (TAIL_FIRST_FIELDS.has(k)) out[`${k}Note`] = "尾部优先摘录（报错与结论通常在结尾）";
      dropped += c.dropped;
      clipped.push(k);
      continue;
    }
    const r = clampLongStrings(v, depth + 1);
    out[k] = r.value;
    dropped += r.dropped;
  }
  // 截断标记在循环后统一写：源头那份 `false` 会作为普通键被拷进 out 并覆盖循环内的赋值，
  // 但这一轮我们确实又截了一次 ⇒ 真话是 true（红线 A7）。
  for (const k of clipped) out[`${k}Truncated`] = true;
  return { value: out, dropped };
}

/** theme_read 的 token 表：只留被覆盖的项，其余给计数（39 条全量对模型没用） */
function shapeTokens(tokens: unknown[]): { value: unknown[]; dropped: number } {
  const kept = tokens.filter((raw) => (raw as { overridden?: boolean })?.overridden === true);
  return { value: kept.length ? kept : tokens.slice(0, KEEP_ITEMS), dropped: tokens.length - kept.length };
}

/**
 * 入口：按形态压一份回执。返回的 `data` 仍可能是大对象（例如全量都是短字符串），
 * 那由调用方（`rememberArtifact`）继续走"存原文 + artifactRef"的老路——两者是接力不是替代。
 */
export function shrinkByShape(receipt: ToolReceipt): ShapedResult {
  const data = receipt.data;
  if (data === null || typeof data !== "object") return { data, shape: "scalar", dropped: 0 };
  const obj = data as Record<string, unknown>;
  let dropped = 0;
  let shape = "object";
  const out: Record<string, unknown> = { ...obj };

  if (Array.isArray(obj.series)) {
    const s = shapeSeries(obj.series as unknown[]);
    out.series = s.summary;
    out.shrunk = { shape: "series", originalPoints: (obj.series as unknown[]).length };
    dropped += s.dropped;
    shape = "series";
  }
  if (Array.isArray(obj.tokens)) {
    const s = shapeTokens(obj.tokens as unknown[]);
    out.tokens = s.value;
    out.tokensTotal = (obj.tokens as unknown[]).length;
    dropped += Math.max(0, s.dropped);
    shape = "tokens";
  }
  const lists = clampLists(out);
  if (lists.dropped) {
    shape = shape === "object" ? "lists" : shape;
    dropped += lists.dropped;
    out.listsTruncated = true;
  }
  const texts = clampLongStrings(lists.value);
  if (texts.dropped) {
    if (shape === "object") shape = "text";
    dropped += texts.dropped;
  }
  return { data: texts.value, shape, dropped };
}
