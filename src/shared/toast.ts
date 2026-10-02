/**
 * 一条浮在界面上的短话（P131-A）。
 *
 * 为什么单独一个叶子模块：这段代码原来有**两份**——`ai/extRuntime.toast()` 与
 * `operator/lock.ts` 里各自 `document.createElement("div")` 建一个 `.ai-toast-host`。
 * 两份各自记自己的 host 变量，于是同一屏可以同时挂两个提示列，各说各的话；
 * 而更要紧的是：**两份实现共用的那对类名，在全部 CSS 里一条规则都没有**
 * （对 src 下所有 .css 搜 `ai-toast` = 0 命中）——「Operator 模式：配置只读」这句
 * 必须让用户看见的话，一直是无定位、无底色地贴在 body 末尾。
 *
 * 所以这里只做一件事：一处实现 + 一对有样式的类名。零业务依赖（`lock.ts` 的
 * "独立零依赖"红线靠这个前提才守得住：它不能 import extRuntime，那会把 chatStore
 * 一路拉进 operator 链路）。
 */

/** 同时最多挂几条：再多就把界面挡死了（这一条是"提示"变"遮挡"的分界） */
const MAX_VISIBLE = 4;
const SHOW_MS = 2600;

let host: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement | null {
  if (typeof document === "undefined") return null; // 非 DOM 环境（单测）静默
  if (!host || !host.isConnected) {
    host = document.createElement("div");
    host.className = "ai-toast-host"; // 整列不吃点击（见 theme.css 的 pointer-events），底下那颗键照常点
    document.body.appendChild(host);
  }
  return host;
}

/** 弹一条提示（2.6s 自动消失，最多同时 4 条，超出的最旧一条立即让位） */
export function toast(msg: string): void {
  const h = ensureHost();
  if (!h) return;
  const el = document.createElement("div");
  el.className = "ai-toast";
  // 上限 200 字：原来两处都是这么裁的，保持一致（超长通常是异常串，截断比撑爆界面好）
  el.textContent = String(msg).slice(0, 200);
  h.appendChild(el);
  while (h.children.length > MAX_VISIBLE) h.firstElementChild?.remove();
  window.setTimeout(() => el.remove(), SHOW_MS);
}
