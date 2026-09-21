/**
 * P97-I2：会话内样式临时层（一次性、可逐条撤回、**不落盘**）。
 *
 * 为什么单独一层：Agent 需要**多份具名改动并存 + 单独撤一条**（dsh 的 activation/retract 语义），
 * 而不是"整块预览"那种一屏一个槽的模型。落盘仍走 `save_theme_extension`（装成真插件，
 * 用户在插件库里能一键停用）。
 *
 * 关键性质：**我们从不去改原始 CSS**——只追加一个 `<style data-ai-scratch>`，
 * 撤掉某一层就自动回落到原值。所以撤销不需要任何"备份再覆盖"（那会把别人的改动一起回滚）。
 *
 * P98-M0 补真：回执从前就写 `undoable: true`，但**不带 undoToken**，
 * `agentRun.undoReceipt` 拿不到 token 直接 return null ⇒ 聊天卡上的撤销按钮永久失效。
 * 那是"回执声称做不到的事"。现在每次 applyLayer 发一个一次性令牌，内部记该层前值。
 */

const layers = new Map<string, string>();
/** undoToken → 受影响层的前值（css=null 表示"原本没有这一层"，撤销即删）。仅本次运行内有效 */
const undoHistory = new Map<string, Record<string, string | null>>();
const listeners = new Set<() => void>();
let el: HTMLStyleElement | null = null;

/** 订阅层集合变更（外观来源面板用），返回退订 */
export function subscribeScratch(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function ensure(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  if (!el) {
    el = document.createElement("style");
    el.dataset.aiScratch = "1";
    document.head.appendChild(el);
  }
  return el;
}

/** 一次性重建整块文本：单次样式重算，比逐条 insertRule 便宜得多 */
function render(): void {
  const node = ensure();
  // 文本形态只有 `scratchCssMerged` 一处说法：界面上看到的层与固化下来的字节必须是同一份
  if (node) node.textContent = scratchCssMerged().css;
  listeners.forEach((f) => f());
}

/**
 * 应用/替换一个具名层。
 * 返回 `{ count, undoToken }`：count 给回执说"现在挂着几层"，token 给撤销按钮用。
 */
export function applyLayer(name: string, css: string): { count: number; undoToken: string } {
  const before: Record<string, string | null> = { [name]: layers.get(name) ?? null };
  layers.set(name, css);
  render();
  const undoToken = crypto.randomUUID();
  undoHistory.set(undoToken, before);
  return { count: layers.size, undoToken };
}

/** 按令牌撤销一次 applyLayer（恢复到该层前值；原本没有这层就删掉）。 */
export function revertByToken(token: string): "undone" | "token_expired" {
  const before = undoHistory.get(token);
  if (!before) return "token_expired";
  for (const [name, prev] of Object.entries(before)) {
    if (prev === null) layers.delete(name);
    else layers.set(name, prev);
  }
  undoHistory.delete(token);
  render();
  return "undone";
}

/** 撤回一层（逆操作）。返回是否真的撤掉了东西 */
export function revertLayer(name: string): boolean {
  const had = layers.delete(name);
  if (had) {
    render();
    // 层被显式撤掉后，指向它的一次性令牌就该作废，否则事后撤销会"复活"刚被撤的改动
    for (const [tok, snap] of [...undoHistory]) {
      if (name in snap) undoHistory.delete(tok);
    }
  }
  return had;
}

/** 全撤（用户点"清掉本次所有临时样式"） */
export function revertAll(): number {
  const n = layers.size;
  layers.clear();
  undoHistory.clear();
  render();
  return n;
}

export function listLayers(): { name: string; bytes: number }[] {
  return [...layers.entries()].map(([name, css]) => ({ name, bytes: css.length }));
}

/**
 * 当前临时层的**全文**（按追加顺序拼）。`style_commit` 就地固化时读的就是这个真值——
 * 以前没有任何出口能把层文本交给模型，"保存为主题"只能靠模型复述自己历史上发过的参数，
 * 多轮叠加或中途撤过层就一定不忠实（详设 §13.3）。
 */
export function scratchCssMerged(): { css: string; layers: string[] } {
  const entries = [...layers.entries()];
  return {
    css: entries.map(([name, css]) => `/* scratch:${name} */\n${css}`).join("\n\n"),
    layers: entries.map(([name]) => name),
  };
}

export function layerCount(): number {
  return layers.size;
}
