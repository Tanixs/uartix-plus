/**
 * P113-A 取证：把"内容画到自己格子外面"的元素描红。
 *
 * 存在的理由：用户报"拖窄面板后行与行叠在一起"，而这类现场**只在某个宽度上出现**。
 * 光读 CSS 只能列候选（是溢出还是换行？谁没长高？），定不了案 —— 所以需要一个能
 * 在真浏览器里把嫌疑人圈出来的开关，配 `.tools/shot.mjs` 就能拿图说话。
 *
 * 三条纪律：
 *  1. **只在 dev 且 URL 显式要它时才跑**（判定在 `bootOverrides.devForensics`）；
 *     它不改任何用户数据，只往 DOM 上加类与一个角标；
 *  2. 判据是"孩子的右缘越过自己的右缘"，而不是 `scrollWidth > clientWidth` ——
 *     后者会漏掉 `overflow: visible` 的容器（内容照样画出去，容器不记账）；
 *  3. 它**不修任何东西**。修法是产品 CSS 的事，这里只负责让讨论有图可看。
 *
 * 颜色是刻意写死的字面量（红/琥珀/深灰底白字）：取证层要在**任意主题**下都刺眼，
 * 跟着 `--danger` 走反而会在暗主题里糊成一片。它不进产品样式表，所以也不受
 * "语义色不许抄字面量"那条门的约束（那条门扫的是 CSS 文件）。
 */

/** 描红用的类名。写在这里而不是散在 CSS 字符串里，是为了让测试能核对拼写一致 */
const FLAG = "ovf-host";
const VICTIM = "ovf-over";
const STYLE_ID = "vs-probe-overflow";
const BADGE_ID = `${STYLE_ID}-badge`;

/** 越过父格多少像素才算"画出去了"（1px 是子像素舍入，2px 起才是肉眼看得见的叠字） */
const TOLERANCE_PX = 2;

const CSS = `
.${FLAG} { outline: 2px solid #e5534b; outline-offset: -1px; }
.${VICTIM} { outline: 2px solid #d29922; outline-offset: -1px; }
#${BADGE_ID} {
  position: fixed; right: 12px; bottom: 40px; z-index: 9999;
  max-width: 420px; padding: 8px 10px; border-radius: 8px;
  background: #1b1f26; color: #fff; font: 11px/1.5 ui-monospace, monospace;
  white-space: pre-wrap; box-shadow: 0 8px 24px rgba(0, 0, 0, .35);
}`;

function describe(el: HTMLElement): string {
  const cls = typeof el.className === "string" && el.className.trim()
    ? `.${el.className.trim().split(/\s+/).join(".")}`
    : "";
  const label = el.querySelector("label, .lk-label")?.textContent?.trim().slice(0, 12) ?? "";
  return `${el.tagName.toLowerCase()}${cls}${label ? ` ⟨${label}⟩` : ""}`;
}

/**
 * 扫一遍：谁的哪一块内容越过了自己的右缘。
 * 返回 `[宿主描述, 越界像素]`，按越界量从大到小；同时把红框画上去。
 */
export function probeOverflowNow(root: ParentNode = document): [string, number][] {
  const doc = root === document ? document : null;
  const found: [HTMLElement, HTMLElement, number][] = [];
  for (const host of Array.from((root.querySelector("body") ?? root).querySelectorAll<HTMLElement>("*"))) {
    const hr = host.getBoundingClientRect();
    if (hr.width < 8 || hr.height < 4) continue;
    const cs = getComputedStyle(host);
    // 自己就会裁/滚/省略的容器不算案发现场：内容进不去是它的设计（滚动区、代码块、截断标题）
    if (cs.overflowX !== "visible" || cs.textOverflow === "ellipsis") continue;
    for (const kid of Array.from(host.children) as HTMLElement[]) {
      // 绝对/固定定位的孩子**天生在流外**：导轨那条拖拽条 `.rail-sash { right: -4px }` 就是
      // 故意骑在分界线上的（可见 8px、命中区 16px）。第一版没排除它，探针把"设计"报成了"事故"。
      const kpos = getComputedStyle(kid).position;
      if (kpos === "absolute" || kpos === "fixed") continue;
      const kr = kid.getBoundingClientRect();
      const over = Math.round(kr.right - hr.right);
      if (kr.width > 0 && over > TOLERANCE_PX) {
        found.push([host, kid, over]);
        break;
      }
    }
  }
  if (doc) {
    for (const [host, kid] of found) {
      host.classList.add(FLAG);
      kid.classList.add(VICTIM);
    }
    paint(doc, found.map(([, , over], i) => [describe(found[i][0]), over] as [string, number]));
  }
  return found
    .map(([host, , over]) => [describe(host), over] as [string, number])
    .sort((a, b) => b[1] - a[1]);
}

/** 装样式 + 写角标：截图里要能看见"到底几处、分别在哪" */
function paint(doc: Document, top: [string, number][]): void {
  if (!doc.getElementById(STYLE_ID)) {
    const s = doc.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    doc.head.appendChild(s);
  }
  let badge = doc.getElementById(BADGE_ID);
  if (!badge) {
    badge = doc.createElement("div");
    badge.id = BADGE_ID;
    doc.body.appendChild(badge);
  }
  badge.textContent = top.length
    ? `溢出 ${top.length} 处：\n${top.slice(0, 8).map(([d, n]) => `+${n}px ${d}`).join("\n")}`
    : "溢出 0 处";
}
