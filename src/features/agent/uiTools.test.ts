/**
 * P97-I1/I2：界面自省与组件级样式的纵向测试（自带迷你假 DOM）。
 * 重点是 I2 的**命中回执**：选择器打偏时必须回 zeroHit + 真实类名，
 * 否则模型又会回到"改背景色试试运气"的老路（真机反馈 5 的根因）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../panels/panels", () => ({ panelTitleOf: (id: string) => `标题:${id}` }));

// 控件/设置 store 在模块初始化时就摸 localStorage，测试环境得先给它一个（与 agentRun.test.ts 同法）
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

/* ---------------- 迷你假 DOM（只实现本批用到的那几样） ---------------- */

interface FakeEl {
  tagName: string;
  id: string;
  classList: Set<string> & { contains: (c: string) => boolean };
  children: FakeEl[];
  childNodes: { nodeType: number; textContent: string }[];
  clientWidth: number;
  clientHeight: number;
  textContent: string;
  styles: Record<string, string>;
  parentEl?: FakeEl;
  querySelectorAll: (sel: string) => FakeEl[];
  querySelector: (sel: string) => FakeEl | null;
}

function el(tag: string, opts: { id?: string; cls?: string[]; text?: string; size?: [number, number]; styles?: Record<string, string>; kids?: FakeEl[] } = {}): FakeEl {
  const set = new Set(opts.cls ?? []);
  const cls = Object.assign(set, { contains: (c: string) => set.has(c) }) as FakeEl["classList"];
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    id: opts.id ?? "",
    classList: cls,
    children: opts.kids ?? [],
    childNodes: opts.text ? [{ nodeType: 3, textContent: opts.text }] : [],
    clientWidth: opts.size?.[0] ?? 100,
    clientHeight: opts.size?.[1] ?? 24,
    textContent: opts.text ?? "",
    styles: opts.styles ?? {},
    querySelectorAll: (sel: string) => walkAll(opts.kids ?? []).filter((n) => match(n, sel)),
    querySelector: (sel: string) => walkAll(opts.kids ?? []).find((n) => match(n, sel)) ?? null,
  };
  for (const k of node.children) k.parentEl = node;
  return node;
}

function walkAll(roots: FakeEl[]): FakeEl[] {
  const out: FakeEl[] = [];
  const rec = (n: FakeEl) => { out.push(n); n.children.forEach(rec); };
  roots.forEach(rec);
  return out;
}

function match(root: FakeEl, sel: string): boolean {
  const parts = sel.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const hit = last === "*"
    ? true
    : last.startsWith("#")
      ? root.id === last.slice(1)
      : last.startsWith(".")
        ? last.slice(1).split(".").every((c) => root.classList.has(c))
        : root.tagName === last.toUpperCase();
  if (!hit) return false;
  // 后代链（只校验"祖先里有没有"，够测了）
  let cur: FakeEl | undefined = root.parentEl;
  for (const anc of parts.slice(0, -1).reverse()) {
    while (cur && !match(cur, anc)) cur = cur.parentEl;
    if (!cur) return false;
    cur = cur.parentEl;
  }
  return true;
}

const tree: FakeEl[] = [
  el("div", { cls: ["app-shell"], kids: [
    el("div", { cls: ["titlebar"], text: "Uartix+", kids: [
      el("span", { cls: ["tb-brand"], text: "Uartix+" }),
      el("button", { cls: ["tb-btn"], text: "设置" }),
    ] }),
    el("div", { cls: ["p3d-host"], kids: [
      el("button", { cls: ["p3d-cbtn"], text: "选通道", styles: { "border-radius": "4px" } }),
    ] }),
  ] }),
];

const styleTags: { textContent: string; dataset: Record<string, string> }[] = [];
let all = walkAll(tree);

function installDom() {
  all = walkAll(tree);
  vi.stubGlobal("document", {
    head: { appendChild: (n: { textContent: string; dataset: Record<string, string> }) => { styleTags.push(n); } },
    documentElement: el("html"),
    createElement: () => { const s = { textContent: "", dataset: {} as Record<string, string> }; return s; },
    querySelector: (sel: string) => all.find((n) => match(n, sel)) ?? null,
    querySelectorAll: (sel: string) => (sel.trim() === "*" ? all : all.filter((n) => match(n, sel))),
  });
  vi.stubGlobal("getComputedStyle", (node: FakeEl) => ({
    getPropertyValue: (p: string) => node.styles?.[p] ?? "",
  }));
}

const ctxFor = (scope: "preview" | "create" | "custom", allowed: string[] = []) => ({
  source: "local_agent" as const,
  runId: "t",
  signal: new AbortController().signal,
  scope,
  ...(allowed.length ? { allowed } : {}),
});
const call = (name: string, args: unknown) => ({ callId: `c-${name}-${Math.random().toString(36).slice(2, 7)}`, name, arguments: JSON.stringify(args) });

beforeEach(() => {
  // 每个用例都要全新的 styleScratch（模块级缓存着 <style> 节点）
  vi.resetModules();
  styleTags.length = 0;
  installDom();
});

/**
 * P99a-A7：`executeUiTool` 已不存在（派发在管线上），这里挂一个同名同签名的壳，
 * 让测试跑的仍是生产那条 `runToolCall`。
 */
const load = async () => {
  const mod = await import("./uiTools");
  const { toolHarness } = await import("./toolTestKit");
  const h = toolHarness(mod.uiToolEntries);
  return {
    ...mod,
    executeUiTool: (
      c: { callId: string; name: string; arguments: string },
      tc: { scope: "preview" | "create" | "custom"; allowed?: string[]; signal: AbortSignal; runId: string },
    ) => h.exec(c, { scope: tc.scope, allowed: tc.allowed ?? [], runId: tc.runId, signal: tc.signal }),
  };
};

describe("uiTools", () => {
  it("ui_inventory：清单从 registry 派生，未知段要报错不静默", async () => {
    const { executeUiTool } = await load();
    const r = await executeUiTool(call("ui_inventory", { section: "controls" }), ctxFor("preview"));
    expect(r.ok).toBe(true);
    expect((r.data as { controls: string[] }).controls).toContain("slider");
    expect((r.data as { controls: string[] }).controls).toHaveLength(11);
    const bad = await executeUiTool(call("ui_inventory", { section: "nope" }), ctxFor("preview"));
    expect(bad.ok).toBe(false);
    expect((bad.data as { error: string }).error).toBe("unknown_section");
    /**
     * 真机实录：模型把"不指定段"写成 `section:"None"` ⇒ 被判 unknown_section，白烧一轮。
     * 只读清单没有安全含义，这类**语义等价于没填**的写法一律归一成全量；
     * 但拼错的段名（上面那条 `nope`）仍然要红——纠错信息不能一起宽掉。
     */
    for (const alias of ["None", "all", "", "  ", "*", "全部"]) {
      const aliased = await executeUiTool(call("ui_inventory", { section: alias }), ctxFor("preview"));
      expect(aliased.ok, `section=${JSON.stringify(alias)}`).toBe(true);
      expect(Object.keys(aliased.data as object)).toHaveLength(7);
    }
    const all2 = await executeUiTool(call("ui_inventory", {}), ctxFor("create"));
    const d = all2.data as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(["actions", "blocks", "controls", "domains", "fx", "panels", "tokens"]);
    expect((d.fx as { className: string }[]).map((f) => f.className)).toContain(".fx-glow");
    expect((d.panels as { panels: { title: string }[] }[])[0].panels[0].title).toBe("标题:hexview");
  });

  it("ui_inspect 给出真实类名与可粘选择器（模型不再靠猜）", async () => {
    const { executeUiTool } = await load();
    const r = await executeUiTool(call("ui_inspect", { root: ".titlebar" }), ctxFor("preview"));
    const d = r.data as { matched: number; classes: { name: string; hits: number }[]; nodes: { selector: string; children?: unknown[] }[] };
    expect(d.matched).toBe(1);
    expect(d.classes.map((c) => c.name)).toContain("tb-btn");
    expect(d.nodes[0].selector).toBe(".titlebar");
    expect(d.nodes[0].children).toBeTruthy();
    const miss = await executeUiTool(call("ui_inspect", { root: ".no-such-class" }), ctxFor("preview"));
    expect((miss.data as { matched: number; note: string }).matched).toBe(0);
    expect((miss.data as { note: string }).note).toContain("没有元素命中");
  });

  it("style_patch：命中数 + 旧→新都回，越权条目单独退回而不是整批失败", async () => {
    const { executeUiTool } = await load();
    const r = await executeUiTool(call("style_patch", {
      name: "圆角按钮",
      rules: [
        { selector: ".p3d-cbtn", decls: { "border-radius": "10px" } },
        { selector: ".tb-butn", decls: { color: "red" } },
        { selector: "body", decls: { display: "none" } },
      ],
    }), ctxFor("custom", ["ui"]));
    expect(r.ok).toBe(true);
    const d = r.data as {
      layer: string; applied: { selector: string; hits: number; changed: string[] }[];
      zeroHit: { selector: string; near: string[] }[]; rejected: { reason: string }[];
    };
    expect(d.layer).toBe("圆角按钮");
    expect(d.applied.find((a) => a.selector === ".p3d-cbtn")?.hits).toBe(1);
    // 旧→新要真算得动得有真正的 CSS 引擎，假 DOM 里只钉形状（内容留给真机验收看）
    expect(Array.isArray(d.applied.find((a) => a.selector === ".p3d-cbtn")?.changed)).toBe(true);
    expect(d.zeroHit.map((z) => z.selector)).toEqual([".tb-butn"]);
    expect(d.zeroHit[0].near.join(" "), "打偏时必须递真实类名").toContain("tb-btn");
    expect(d.rejected[0]?.reason).toContain("global_selector");
    // 真的注入了追加层，且没去动原始样式
    expect(styleTags[styleTags.length - 1]?.textContent).toContain(".p3d-cbtn{border-radius:10px}");
    expect(styleTags[styleTags.length - 1]?.textContent).not.toContain("body{display:none}");
  });

  it("style_revert：撤层即回落原值；没有这层要说不存在", async () => {
    const { executeUiTool } = await load();
    await executeUiTool(call("style_patch", { name: "A", rules: [{ selector: ".tb-btn", decls: { color: "red" } }] }), ctxFor("custom", ["ui"]));
    expect(styleTags[styleTags.length - 1]?.textContent).toContain(".tb-btn{color:red}");
    const back = await executeUiTool(call("style_revert", { name: "A" }), ctxFor("custom", ["ui"]));
    expect(back.ok).toBe(true);
    expect(styleTags[styleTags.length - 1]?.textContent).toBe("");
    const miss = await executeUiTool(call("style_revert", { name: "B" }), ctxFor("custom", ["ui"]));
    expect(miss.ok).toBe(false);
    expect(miss.code).toBe("no_such_layer");
  });

  it("授权门：只读两支常发，写两支没 ui 域就拒（仅预览档说 preview_only，手工档说未勾域）", async () => {
    const { executeUiTool } = await load();
    const rules = [{ selector: ".tb-btn", decls: { color: "red" } }];
    const denied = await executeUiTool(call("style_patch", { rules }), ctxFor("create"));
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("unauthorized_scope");
    expect(String((denied.data as { hint: string }).hint)).toContain("界面深改");
    const prev = await executeUiTool(call("style_patch", { rules }), ctxFor("preview"));
    expect(prev.code).toBe("preview_only");
    const readInPreview = await executeUiTool(call("ui_inventory", {}), ctxFor("preview"));
    expect(readInPreview.ok).toBe(true);
    const allowed = await executeUiTool(call("style_patch", { rules }), ctxFor("custom", ["ui"]));
    expect(allowed.ok).toBe(true);
  });

  it("全部条目都非法时整批不发（no_valid_rules），并把原因与上限回出来", async () => {
    const { executeUiTool } = await load();
    const r = await executeUiTool(call("style_patch", { rules: [{ selector: "html", decls: { color: "red" } }] }), ctxFor("custom", ["ui"]));
    expect(r.code).toBe("no_valid_rules");
    const d = r.data as { rejected: { reason: string }[]; caps: { maxRules: number } };
    expect(d.rejected[0]?.reason).toContain("global_selector");
    expect(d.caps.maxRules).toBeGreaterThan(0);
  });
});

/* ================= P103 批2：layout_apply / chrome_set =================
 * 两支新写工具的验收口径：回执要把「发生了什么/为什么没有」说清；授权门沿用 ui 域；
 * dockview 行为不在这里演（App 侧管道已有 applyLayout.test.ts 钉住），这里钉参数校验与总线出口。 */
describe("P103 批2 · 版式与工具栏", () => {
  beforeEach(installDom);

  it("chrome_set：非法段名拒发并递合法清单；排序/显隐落进 chromeStore；reset 回默认", async () => {
    const { executeUiTool } = await load();
    const badR = await executeUiTool(call("chrome_set", { order: ["nope"] }), ctxFor("custom", ["ui"]));
    expect(badR.ok).toBe(false);
    expect(badR.code).toBe("invalid_args");
    expect(String((badR.data as { hint: string }).hint)).toContain("connect");

    const ok = await executeUiTool(
      call("chrome_set", { order: ["layout", "connect"], hide: ["session"] }),
      ctxFor("custom", ["ui"]),
    );
    expect(ok.ok).toBe(true);
    const chrome = (await import("../settings/chromeStore")).getChrome();
    expect(chrome.order, "缺的段按默认序补尾，不许丢段").toEqual(["layout", "connect", "session"]);
    expect(chrome.hidden).toEqual(["session"]);
    expect(String((ok.data as { note: string }).note)).toContain("layout ｜ connect");

    const back = await executeUiTool(call("chrome_set", { reset: true }), ctxFor("custom", ["ui"]));
    expect(back.ok).toBe(true);
    expect((await import("../settings/chromeStore")).getChrome()).toEqual({
      order: ["connect", "session", "layout"],
      hidden: [],
    });
  });

  it("chrome_set 授权门：没 ui 域就拒（create 档也不行），仅预览档说 preview_only", async () => {
    const { executeUiTool } = await load();
    const denied = await executeUiTool(call("chrome_set", { hide: ["session"] }), ctxFor("create"));
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("unauthorized_scope");
    const prev = await executeUiTool(call("chrome_set", { hide: ["session"] }), ctxFor("preview", ["ui"]));
    expect(prev.code).toBe("preview_only");
  });

  it("layout_apply：未知预设 / 无此槽 / 无备份各说各话；合法预设经 appBus 发出", async () => {
    const { executeUiTool } = await load();
    const badPreset = await executeUiTool(call("layout_apply", { preset: "nope" }), ctxFor("custom", ["ui"]));
    expect(badPreset.code).toBe("invalid_args");
    expect(String((badPreset.data as { hint: string }).hint)).toContain("analyze");

    const noSlot = await executeUiTool(call("layout_apply", { slot: "不存在" }), ctxFor("custom", ["ui"]));
    expect(noSlot.code).toBe("no_such_slot");

    const noBack = await executeUiTool(call("layout_apply", { rollback: true }), ctxFor("custom", ["ui"]));
    expect(noBack.code).toBe("no_backup");

    const { subscribeAppBus } = await import("../ai/appBus");
    const seen: string[] = [];
    const un = subscribeAppBus((m) => {
      if (m.kind === "applyPreset") seen.push(m.preset);
    });
    const okPreset = await executeUiTool(call("layout_apply", { preset: "analyze" }), ctxFor("custom", ["ui"]));
    un();
    expect(okPreset.ok).toBe(true);
    expect(seen, "合法预设必须真的从 appBus 发出去（App 侧消费）").toEqual(["analyze"]);
    expect(String((okPreset.data as { note: string }).note)).toContain("rollback");
  });

  it("layout_apply 走布局槽：applyLayout 回执成功才算 applied，失败要带回错误", async () => {
    const { executeUiTool } = await load();
    const { saveLayout } = await import("../settings/layoutsStore");
    const { subscribeAppBus } = await import("../ai/appBus");
    saveLayout("我的布局", { panels: ["a"] });

    const unOk = subscribeAppBus((m) => {
      if (m.kind === "applyLayout") m.done(null);
    });
    const okR = await executeUiTool(call("layout_apply", { slot: "我的布局" }), ctxFor("custom", ["ui"]));
    unOk();
    expect(okR.ok).toBe(true);
    expect(String((okR.data as { note: string }).note)).toContain("我的布局");

    const unFail = subscribeAppBus((m) => {
      if (m.kind === "applyLayout") m.done("应用布局失败：模拟");
    });
    const failR = await executeUiTool(call("layout_apply", { slot: "我的布局" }), ctxFor("custom", ["ui"]));
    unFail();
    expect(failR.ok).toBe(false);
    expect(failR.code).toBe("apply_failed");
    expect(String((failR.data as { error: string }).error)).toContain("模拟");
  });
});
