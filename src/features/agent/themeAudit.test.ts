/**
 * P131-B1：`theme_audit` 的工具侧单测。
 *
 * 判定核（`styles/renderAudit.test.ts`）已经把算法逐条钉过了，这里只测**接线**：
 * 采样读的是不是真值、回执有没有把话说完、上限切了还报不报总数、采不到时出不出声。
 *
 * 自带一份迷你假 DOM（不复用 uiTools.test 那份）：审计要的是几何与层叠
 * （rect / parentElement / 注入层节点 / --zoom），那份假 DOM 是给选择器 census 用的。
 * 硬把两套判据挤进同一份公共夹具，结果只会是两边都不敢改。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 控件/设置 store 在模块初始化期就摸 localStorage，测试环境得先给一个（与 uiTools.test 同法）
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

interface Fake {
  tag: string;
  id: string;
  classList: Set<string>;
  role?: string;
  attrs: Record<string, string>;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  kids: Fake[];
  parent?: Fake;
}

function mk(
  tag: string,
  o: {
    id?: string;
    cls?: string[];
    text?: string;
    rect?: [number, number, number, number];
    styles?: Record<string, string>;
    kids?: Fake[];
    role?: string;
    attrs?: Record<string, string>;
  } = {},
): Fake {
  const node: Fake = {
    tag,
    id: o.id ?? "",
    classList: new Set(o.cls ?? []),
    role: o.role,
    attrs: o.attrs ?? {},
    text: o.text ?? "",
    rect: { x: o.rect?.[0] ?? 0, y: o.rect?.[1] ?? 0, width: o.rect?.[2] ?? 120, height: o.rect?.[3] ?? 24 },
    styles: o.styles ?? {},
    kids: o.kids ?? [],
  };
  for (const k of node.kids) k.parent = node;
  return node;
}

const descendants = (n: Fake): Fake[] => n.kids.flatMap((k) => [k, ...descendants(k)]);

/** 只实现审计用到的那几种选择器形态：`*`、标签、`style[data-x]`、交互件清单 */
function matchesSel(n: Pick<Fake, "tag" | "attrs" | "role">, sel: string): boolean {
  const s = sel.trim();
  if (s === "*") return true;
  for (const part of s.split(",").map((p) => p.trim())) {
    const attr = /^(\w*)\[data-([\w-]+)\]$/.exec(part);
    if (attr) {
      const [, t, key] = attr;
      const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      if ((!t || t.toLowerCase() === n.tag.toLowerCase()) && n.attrs[camel] != null) return true;
      continue;
    }
    const role = /^\[role=(\w+)\]$/.exec(part);
    if (role) {
      if (n.role === role[1]) return true;
      continue;
    }
    const tagHref = /^(\w+)\[href\]$/.exec(part);
    if (tagHref) {
      if (n.tag === tagHref[1] && n.attrs.href != null) return true;
      continue;
    }
    if (/^\w+$/.test(part) && n.tag.toLowerCase() === part.toLowerCase()) return true;
  }
  return false;
}

/**
 * 包成真 DOM 的形状。两处必要的手法：
 *  - **缓存**：同一个 Fake 节点每次都要拿到同一个 Element（采样侧按节点身份去重）；
 *  - **children / parentElement 走 getter**：直接写值会 parent→child→parent 无限递归。
 */
const elCache = new WeakMap<Fake, Element>();
function asEl(n: Fake): Element {
  const cached = elCache.get(n);
  if (cached) return cached;
  const node = {
    __styles: n.styles,
    tagName: n.tag,
    id: n.id,
    classList: n.classList,
    textContent: n.text,
    get children() {
      return n.kids.map(asEl);
    },
    get childNodes() {
      return n.text ? [{ nodeType: 3, textContent: n.text }] : [];
    },
    get parentElement() {
      return n.parent ? asEl(n.parent) : null;
    },
    getBoundingClientRect: () => ({
      ...n.rect,
      right: n.rect.x + n.rect.width,
      bottom: n.rect.y + n.rect.height,
      top: n.rect.y,
      left: n.rect.x,
    }),
    querySelectorAll: (sel: string) => descendants(n).filter((d) => matchesSel(d, sel)).map(asEl),
    matches: (sel: string) => matchesSel(n, sel),
  };
  const el = node as unknown as Element;
  elCache.set(n, el);
  return el;
}

const styleOf = (node: Element) => ((node as unknown as { __styles?: Record<string, string> }).__styles ?? {});

let body: Fake;
let styleNodes: { textContent: string; attrs: Record<string, string> }[] = [];
let zoom = "1";

function installDom() {
  const all = [body, ...descendants(body)];
  const root = mk("html", { styles: { "--zoom": zoom } });
  const doc = {
    documentElement: asEl(root),
    querySelector: (sel: string) => {
      if (sel.trim() === "body") return asEl(body);
      const hits = all.filter((n) => matchesSel(n, sel));
      return hits.length ? asEl(hits[0]) : null;
    },
    querySelectorAll: (sel: string) => {
      if (sel.trim().startsWith("style[")) {
        return styleNodes
          .filter((st) => matchesSel({ tag: "style", attrs: st.attrs, role: undefined }, sel))
          .map((st) => ({ textContent: st.textContent })) as unknown as NodeListOf<Element>;
      }
      return all.filter((n) => matchesSel(n, sel)).map(asEl) as unknown as NodeListOf<Element>;
    },
    styleSheets: [] as { cssRules: { cssText: string }[] }[],
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("getComputedStyle", (node: Element) => {
    const styles = styleOf(node);
    // 真 CSSStyleDeclaration 同时给 `cs.overflowX` 与 `cs.getPropertyValue("overflow-x")`，
    // 假的那份只实现一条路，产品代码走哪条都"过测"——那就测不到东西了。两条都给。
    const camel: Record<string, string> = {};
    for (const [k, v] of Object.entries(styles)) {
      camel[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
    }
    return {
      ...camel,
      getPropertyValue: (p: string) => styles[p] ?? camel[p] ?? "",
    };
  });
}

const run = async (args: Record<string, unknown>) => {
  const ui = await import("./uiTools");
  const { toolHarness } = await import("./toolTestKit");
  const h = toolHarness(ui.uiToolEntries);
  return h.exec(
    { callId: `c-${Math.random().toString(36).slice(2, 7)}`, name: "theme_audit", arguments: JSON.stringify(args) },
    { scope: "custom", allowed: ["ui", "config", "plugins"] },
  );
};

const VIS = { visibility: "visible", display: "block", opacity: "1" };

/** 一条工具栏 + 一枚按钮：够测对比度 / 命中区 / 溢出三条判据 */
function shellTree(o: { text?: string; bg: string; fg: string; btnH?: number; fontSize?: string }) {
  body = mk("body", {
    cls: ["app"],
    styles: { "background-color": "#ffffff", ...VIS },
    rect: [0, 0, 320, 40],
    kids: [
      mk("div", {
        cls: ["cmdbar"],
        styles: { "background-color": o.bg, "overflow-x": "visible", ...VIS, display: "flex" },
        rect: [0, 0, 300, 34],
        kids: o.text
          ? [
              mk("button", {
                cls: ["tb-btn"],
                text: o.text,
                styles: {
                  color: o.fg,
                  "background-color": "rgba(0,0,0,0)",
                  "font-size": o.fontSize ?? "12px",
                  "font-weight": "400",
                  ...VIS,
                  display: "inline-block",
                },
                rect: [8, 5, 60, o.btnH ?? 24],
              }),
            ]
          : [],
      }),
    ],
  });
}

beforeEach(() => {
  vi.resetModules();
  styleNodes = [];
  zoom = "1";
});

describe("theme_audit：接的是真值，说的是人话", () => {
  it("accent 当文字压在浅壳上 → 判红，ratio / need / selector 都进回执", async () => {
    shellTree({ text: "设置", bg: "#edebe9", fg: "#0078d4" });
    installDom();
    const r = await run({});
    const data = r.data as { sampled: number; contrast: { selector: string; ratio: number; need: number }[]; blocking: boolean };
    expect(data.sampled).toBe(1);
    expect(data.contrast).toHaveLength(1);
    expect(data.contrast[0].selector).toBe(".tb-btn");
    expect(data.contrast[0].ratio).toBeLessThan(4.5);
    expect(data.contrast[0].need).toBe(4.5);
    expect(data.blocking).toBe(true);
  });

  it("换成 P130 最终取的那枚蓝 → 干净，blocking:false", async () => {
    shellTree({ text: "设置", bg: "#edebe9", fg: "#005a9e" });
    installDom();
    const r = await run({});
    const data = r.data as { contrast: unknown[]; overflow: unknown[]; hitTargets: unknown[]; blocking: boolean };
    expect(data.contrast).toHaveLength(0);
    expect(data.overflow).toHaveLength(0);
    expect(data.hitTargets).toHaveLength(0);
    expect(data.blocking).toBe(false);
  });

  it("命中区按 --zoom 折回设备像素：16px 在 100% 报、在 150% 不报", async () => {
    shellTree({ text: "OK", bg: "#edebe9", fg: "#005a9e", btnH: 16 });
    installDom();
    const d1 = (await run({})).data as { hitTargets: { selector: string; minSide: number; need: number }[] };
    expect(d1.hitTargets[0].selector).toBe(".tb-btn");
    expect(d1.hitTargets[0].minSide).toBe(16);
    expect(d1.hitTargets[0].need).toBe(24);

    zoom = "1.5";
    shellTree({ text: "OK", bg: "#edebe9", fg: "#005a9e", btnH: 16 });
    installDom();
    const d2 = (await run({})).data as { hitTargets: unknown[] };
    expect(d2.hitTargets).toHaveLength(0);
  });

  it("溢出只报「孩子越过父格」，自己会裁的不算案发现场", async () => {
    shellTree({ bg: "#edebe9", fg: "#005a9e" });
    const bar = body.kids[0];
    bar.kids.push(
      mk("div", {
        cls: ["sb-menu"],
        styles: { "background-color": "#ffffff", "overflow-x": "visible", ...VIS },
        rect: [10, 40, 80, 20],
        kids: [mk("span", { cls: ["sb-item"], text: "溢出项", styles: { color: "#201f1e", "font-size": "12px", "background-color": "rgba(0,0,0,0)", ...VIS }, rect: [10, 40, 120, 20] })],
      }),
      mk("div", {
        cls: ["clip-host"],
        styles: { "background-color": "#ffffff", "overflow-x": "hidden", ...VIS },
        rect: [10, 70, 80, 20],
        kids: [mk("span", { cls: ["clip-kid"], text: "被裁项", styles: { color: "#201f1e", "font-size": "12px", "background-color": "rgba(0,0,0,0)", ...VIS }, rect: [10, 70, 160, 20] })],
      }),
    );
    installDom();
    const data = (await run({})).data as { overflow: { selector: string; overPx: number }[] };
    expect(data.overflow.map((o) => o.selector)).toEqual([".sb-menu"]);
    expect(data.overflow[0].overPx).toBe(40);
  });

  it("动效降级读的是**贴在屏幕上的注入层**，不是 store 里的副本", async () => {
    shellTree({ text: "设置", bg: "#edebe9", fg: "#005a9e" });
    styleNodes = [
      { textContent: ".btn{transition:all .2s ease}", attrs: { aiScratch: "1" } },
      { textContent: ".dlg .btn{transition:transform .2s ease}", attrs: { aiExt: "1" } },
    ];
    installDom();
    const data = (await run({})).data as { motionOverride: { selector: string }[]; injectedBytes: number; blocking: boolean };
    expect(data.motionOverride.map((m) => m.selector)).toEqual([".dlg .btn"]);
    expect(data.injectedBytes).toBeGreaterThan(0);
    expect(data.blocking).toBe(true);
  });

  it("层冲突：注入层里有铺满视口的 fixed 浮层 → 报出来（它盖得住设置对话框）", async () => {
    shellTree({ text: "设置", bg: "#edebe9", fg: "#005a9e" });
    styleNodes = [{ textContent: ".veil{position:fixed;inset:0;z-index:var(--z-float)}", attrs: { aiExt: "1" } }];
    installDom();
    const data = (await run({})).data as { layerClash: { selector: string; reason: string }[]; blocking: boolean };
    expect(data.layerClash.map((l) => l.selector)).toEqual([".veil"]);
    expect(data.layerClash[0].reason).toBe("covers_host_dialog");
    expect(data.blocking).toBe(true);
  });

  it("清单有上限，但总数照实报（切了不许装作没有）", async () => {
    body = mk("body", {
      styles: { "background-color": "#ffffff", ...VIS },
      rect: [0, 0, 300, 300],
      kids: Array.from({ length: 14 }, (_, i) =>
        mk("span", {
          cls: [`row-${i}`],
          text: `第 ${i} 行`,
          styles: { color: "#0078d4", "background-color": "#edebe9", "font-size": "12px", "font-weight": "400", ...VIS },
          rect: [0, i * 16, 100, 14],
        }),
      ),
    });
    installDom();
    const data = (await run({})).data as { sampled: number; contrast: unknown[]; contrastTotal: number };
    expect(data.sampled).toBe(14);
    expect(data.contrast).toHaveLength(12);
    expect(data.contrastTotal).toBe(14);
  });

  it("root 下没有可见元素：出声并给出下一步，不交一张空表当「审计通过」", async () => {
    shellTree({ bg: "#edebe9", fg: "#005a9e" });
    installDom();
    const r = await run({ root: ".not-here" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no_visible_nodes");
    expect(String((r.data as { hint: string }).hint)).toContain("ui_inspect");
  });

  it("背景一路透明到根：不硬编白底，unmeasurable 里说清几条采不出来", async () => {
    body = mk("body", {
      styles: { "background-color": "rgba(0,0,0,0)", ...VIS },
      rect: [0, 0, 300, 60],
      kids: [mk("span", { cls: ["ghost"], text: "飘着的字", styles: { color: "#333333", "background-color": "rgba(0,0,0,0)", "font-size": "12px", "font-weight": "400", ...VIS }, rect: [0, 0, 80, 16] })],
    });
    installDom();
    const data = (await run({})).data as { contrast: unknown[]; unmeasurable: { reason: string }[]; unmeasurableTotal: number };
    expect(data.contrast).toHaveLength(0);
    expect(data.unmeasurable[0].reason).toBe("no_opaque_backdrop");
    expect(data.unmeasurableTotal).toBe(1);
  });
});
