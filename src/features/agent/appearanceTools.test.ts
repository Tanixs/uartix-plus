/**
 * P88b-4 A4：外观工具与覆盖层单测（node 环境，stub document/getComputedStyle）。
 * 覆盖：值解析、取色纯函数、覆盖层 patch/undo 原子性、工具档位门、配方（含玻璃派生）、保存清层。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentPluginId } from "../plugins/pluginId";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  upsert: vi.fn(),
  inWl: vi.fn(() => true),
  stage: vi.fn((_m: unknown): { ok: boolean; errors: string[]; warnings: string[]; stagingId?: string } => ({ ok: true, errors: [], warnings: [], stagingId: "st-1" })),
  install: vi.fn(() => ({ ok: true, msg: "", id: "user.agent.theme-glass" })),
  enable: vi.fn(() => ({ ok: true, msg: "已启用" })),
  // P91 D3：同名再存 = 原地升版（真实更新链），默认库里不存在同名插件
  getPlugin: vi.fn((_id: string): unknown => undefined),
  propose: vi.fn((_id: string, _m: unknown): { ok: boolean; msg: string } => ({ ok: true, msg: "候选已就绪" })),
  approve: vi.fn(() => ({ ok: true, msg: "已更新到 v0.1.1" })),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../ai/extensionStore", () => ({ upsertProjection: mocks.upsert }));
vi.mock("../ai/extRuntime", () => ({
  applyStyleExts: vi.fn(),
  /**
   * P98-M0：`collectThemeVars(keys)` 的真实契约是"读 documentElement 的**计算值**"，
   * 所以这里按同一契约用 stub 的 getComputedStyle 现算，而不是返回一份写死的两键底。
   * 旧 mock 把底钉成 `{--bg,--text}`，overlay 靠调用方 `{...base, ...overlay}` 才补上 `--accent`；
   * 改成读有效值后，"patch 过的 accent 到底有没有进保存下来的主题"这件事才真的被测到
   * （以前它只测到那行合并代码，测不到值从哪来）。
   */
  collectThemeVars: (keys?: readonly string[]) => {
    const cs = (globalThis as unknown as {
      getComputedStyle: (el: unknown) => { getPropertyValue(k: string): string };
    }).getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const k of keys ?? ["--bg", "--text", "--accent"]) {
      const v = cs.getPropertyValue(k).trim();
      if (v) vars[k] = v.slice(0, 200);
    }
    return { vars, theme: "dark" };
  },
}));
/* P90 E2：保存改走真实插件安装链（appearanceTools 内是动态 import，这里同样按 mock 解析） */
vi.mock("../plugins/pluginStore", () => ({
  stagePackage: mocks.stage,
  installStaged: mocks.install,
  setEnabled: mocks.enable,
  // P91 D3：同名再存走真实更新链（proposeUpdate → approveUpdate），getPlugin 判存在
  getPlugin: mocks.getPlugin,
  proposeUpdate: mocks.propose,
  approveUpdate: mocks.approve,
}));
vi.mock("./generalTools", () => ({
  inWhitelist: mocks.inWl,
  GENERAL_DOMAIN: { files: "文件", network: "网络", shell: "命令行" },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  pxPayload = null;
  mocks.invoke.mockReset();
  mocks.upsert.mockReset();
  mocks.inWl.mockReset();
  mocks.inWl.mockReturnValue(true);
  mocks.stage.mockReset();
  mocks.stage.mockReturnValue({ ok: true, errors: [], warnings: [], stagingId: "st-1" });
  mocks.install.mockReset();
  mocks.install.mockReturnValue({ ok: true, msg: "", id: "user.agent.theme-glass" });
  mocks.enable.mockReset();
  mocks.enable.mockReturnValue({ ok: true, msg: "已启用" });
  mocks.getPlugin.mockReset();
  mocks.getPlugin.mockReturnValue(undefined);
  mocks.propose.mockReset();
  mocks.propose.mockReturnValue({ ok: true, msg: "候选已就绪" });
  mocks.approve.mockReset();
  mocks.approve.mockReturnValue({ ok: true, msg: "已更新到 v0.1.1" });
});

let idSeq = 0;
/** image_swatch 成功路径预置的像素数据（getImageData 直接返回，跳过真实 canvas 解码） */
let pxPayload: Uint8ClampedArray | null = null;

/** DOM stub：inline 样式用 Map 承载；builtin 模拟当前主题文件的 token 值（计算值=inline 覆盖 builtin）。 */
function stubDom(builtin: Record<string, string> = {}) {
  const inline = new Map<string, string>();
  vi.stubGlobal("document", {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => inline.set(k, v),
        removeProperty: (k: string) => inline.delete(k),
        getPropertyValue: (k: string) => inline.get(k) ?? "",
      },
      dataset: { theme: "dark" } as Record<string, string>,
    },
    // styleScratch 会建一个 <style data-ai-scratch>；node 里只要不抛就行（层文本的真值在 Map 里）
    head: { appendChild: () => undefined },
    createElement: () => ({
      width: 0,
      height: 0,
      // styleScratch 的 <style> 节点：dataset + textContent（层文本真值仍在模块的 Map 里，这里只求不抛）
      dataset: {} as Record<string, string>,
      textContent: "",
      getContext: () => ({ drawImage: () => undefined, getImageData: () => ({ data: pxPayload ?? new Uint8ClampedArray(4) }) }),
    }),
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (k: string) => inline.get(k) ?? builtin[k] ?? "",
  }));
  vi.stubGlobal("crypto", { randomUUID: () => `t-${++idSeq}` });
  return inline;
}

const ctx = (scope: "preview" | "create" | "custom", allowed: string[] = []) => ({
  source: "local_agent" as const,
  runId: "t",
  signal: new AbortController().signal,
  scope,
  allowed,
});

const call = (name: string, args?: unknown) => ({
  callId: "c1",
  name,
  arguments: args === undefined ? "" : JSON.stringify(args),
});

async function load() {
  vi.resetModules();
  const store = await import("./appearanceStore");
  const tools = await import("./appearanceTools");
  // P99a-A7：五支工具不再有自带的 executeAppearanceTool（派发在管线上），
  // 这里把同名同签名的壳挂回 tools 上——测试跑的仍是生产那条 runToolCall。
  const { toolHarness } = await import("./toolTestKit");
  const h = toolHarness(tools.appearanceToolEntries);
  const executeAppearanceTool = (
    c: { callId: string; name: string; arguments: string },
    tc: { scope: "preview" | "create" | "custom"; allowed: string[] },
  ) => h.exec(c, { scope: tc.scope, allowed: tc.allowed });
  return { store, tools: { ...tools, executeAppearanceTool } };
}

describe("parseColorToRgb", () => {
  it("supports hex3/hex6/rgb/rgba and rejects garbage", async () => {
    const { tools } = await load();
    expect(tools.parseColorToRgb("#2f6fce")).toEqual([47, 111, 206]);
    expect(tools.parseColorToRgb("#abc")).toEqual([170, 187, 204]);
    expect(tools.parseColorToRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(tools.parseColorToRgb("rgba(1,2,3,0.5)")).toEqual([1, 2, 3]);
    expect(tools.parseColorToRgb("color-mix(in srgb, red, blue)")).toBeNull();
  });
});

describe("extractSwatch", () => {
  it("finds dominant colored cluster, judges light image, picks white text on accent", async () => {
    const { tools } = await load();
    // 60% 近白背景 + 30% 饱和蓝 + 10% 黑
    const px = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < px.length; i += 4) {
      const k = (i / 4) % 10;
      const [r, g, b] = k < 6 ? [245, 246, 248] : k < 9 ? [30, 90, 220] : [10, 10, 10];
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
    const sw = tools.extractSwatch(px);
    expect(sw.isDark).toBe(false);
    expect(sw.palette[0].hex).toBe("#1e5adc");
    expect(sw.suggest.accent).toBe("#1e5adc");
    expect(sw.suggest.accentText).toBe("#ffffff");
  });
  it("marks dark images and ignores fully transparent pixels", async () => {
    const { tools } = await load();
    const px = new Uint8ClampedArray(16 * 4); // 4 像素全透明
    const sw = tools.extractSwatch(px);
    expect(sw.isDark).toBe(true);
    expect(sw.palette).toHaveLength(0);
  });
});

describe("appearanceStore patch/undo", () => {
  it("applies whitelisted tokens to inline style and records undo", async () => {
    const inline = stubDom({ "--accent": "#2f6fce" });
    const { store } = await load();
    const r = store.patchTokens({ "--accent": "#ff0000", "--dur-fast": "200ms" });
    expect(r.ok).toBe(true);
    expect(inline.get("--accent")).toBe("#ff0000");
    expect(inline.get("--dur-fast")).toBe("200ms");
    expect(store.undoOverlayDetailed(r.undoToken!)).toBe("undone");
    expect(inline.has("--accent")).toBe(false); // 原本无覆盖 → 移除
    expect(inline.has("--dur-fast")).toBe(false);
    expect(store.undoOverlayDetailed(r.undoToken!)).toBe("token_expired");
  });
  it("restores previous overlay value on undo", async () => {
    const inline = stubDom();
    const { store } = await load();
    const r1 = store.patchTokens({ "--accent": "#111111" });
    const r2 = store.patchTokens({ "--accent": "#222222" });
    store.undoOverlayDetailed(r2.undoToken!);
    expect(inline.get("--accent")).toBe("#111111");
    store.undoOverlayDetailed(r1.undoToken!);
    expect(inline.has("--accent")).toBe(false);
  });
  it("rejects whole patch on any unknown/invalid token (atomic)", async () => {
    const inline = stubDom();
    const { store } = await load();
    expect(store.patchTokens({ "--accent": "#ff0000", "--nope": "1" }).err).toBe("unknown_token:--nope");
    expect(store.patchTokens({ "--fs-md": "big" }).err).toBe("invalid_value:--fs-md");
    expect(store.patchTokens({ "--accent": "red; background:url(x)" }).err).toBe("invalid_value:--accent");
    expect(inline.size).toBe(0);
  });
});

describe("appearance tools", () => {
  it("theme_patch applies in create scope and is rejected in preview", async () => {
    stubDom();
    const { tools } = await load();
    const bad = await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#123456" } }), ctx("preview"));
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("preview_only");
    const ok = await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#123456" } }), ctx("create"));
    expect(ok.ok).toBe(true);
    expect(ok.undoToken).toBeTruthy();
  });
  it("theme_preset applies static vars and rejects unknown preset", async () => {
    stubDom();
    const { tools } = await load();
    const bad = await tools.executeAppearanceTool(call("theme_preset", { name: "nope" }), ctx("create"));
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("unknown_preset");
    const ok = await tools.executeAppearanceTool(call("theme_preset", { name: "font-large" }), ctx("create"));
    expect(ok.ok).toBe(true);
    expect((ok.data as { applied: string[] }).applied).toContain("--fs-md");
  });
  it("glass preset derives semi-transparent panel from current theme", async () => {
    stubDom({ "--bg-panel": "#1a1f28", "--bg-inset": "rgb(20,24,32)" });
    const { tools } = await load();
    const ok = await tools.executeAppearanceTool(call("theme_preset", { name: "glass" }), ctx("create"));
    expect(ok.ok).toBe(true);
    const applied = (ok.data as { applied: string[] }).applied;
    expect(applied).toContain("--bg-panel");
    expect(applied).toContain("--bg-inset");
  });
  it("image_swatch enforces domain gate and whitelist, then extracts palette", async () => {
    stubDom();
    // 预置 2x1 像素：一蓝一白（getImageData 直接返回该数据，跳过真实 canvas 解码）
    pxPayload = new Uint8ClampedArray([30, 90, 220, 255, 245, 246, 248, 255]);
    vi.stubGlobal("Image", class { src = ""; decode = async () => undefined; });
    const { tools } = await load();
    const prev = await tools.executeAppearanceTool(call("image_swatch", { path: "D:\\w\\a.png" }), ctx("create"));
    // P99a-A4：域门统一 unauthorized_scope（旧码 general_tool_requires_custom 已并进来）
    expect(prev.code).toBe("unauthorized_scope");
    const noDom = await tools.executeAppearanceTool(call("image_swatch", { path: "D:\\w\\a.png" }), ctx("custom", ["network"]));
    expect(noDom.code).toBe("unauthorized_scope");
    mocks.inWl.mockReturnValueOnce(false);
    const outWl = await tools.executeAppearanceTool(call("image_swatch", { path: "D:\\elsewhere\\a.png" }), ctx("custom", ["files"]));
    expect(outWl.code).toBe("path_outside_whitelist");
    mocks.invoke.mockResolvedValueOnce({ bytes: 8, data: "AAAA" });
    const ok = await tools.executeAppearanceTool(call("image_swatch", { path: "D:\\w\\a.png" }), ctx("custom", ["files"]));
    expect(ok.ok).toBe(true);
    expect((ok.data as { suggest: { accent: string } }).suggest.accent).toBe("#1e5adc");
  });
  it("notifies the theme-bridge callback on every overlay change (P88b-4 C2)", async () => {
    const inline = stubDom();
    const { store } = await load();
    const seen: (string | undefined)[] = [];
    store.setOverlayChangeCb(() => seen.push(inline.get("--accent")));
    const r = store.patchTokens({ "--accent": "#112233" });
    expect(seen).toEqual(["#112233"]);
    store.undoOverlayDetailed(r.undoToken!);
    expect(seen).toEqual(["#112233", undefined]); // 撤销同样广播（iframe 同步回退）
    store.setOverlayChangeCb(null);
  });
  it("P90 E2 save_theme_extension 装成真实插件并启用，随后清空覆盖层", async () => {
    // 底主题要真的存在于 stub 的计算值里：P98-M0 之后 save 读的是「全量 token 的有效计算值」，
    // 不再是"写死的两键底 + overlay 合并"，所以 builtin 没给键就等于当前主题没有这个键。
    const inline = stubDom({ "--bg": "#101010", "--text": "#eee" });
    const { tools } = await load();
    const empty = await tools.executeAppearanceTool(call("save_theme_extension", { name: "我的主题" }), ctx("create"));
    expect(empty.code).toBe("empty_overlay");
    await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699", "--fs-body": "13px" } }), ctx("create"));
    const ok = await tools.executeAppearanceTool(call("save_theme_extension", { name: "Glass", css: ":root{--x:1}" }), ctx("create"));
    expect(ok.ok).toBe(true);
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    const manifest = mocks.stage.mock.calls[0][0] as {
      id: string; capabilities: string[]; contributions: Record<string, unknown[]>;
      artifacts: Record<string, { kind: string; vars: Record<string, string>; css?: string }>;
    };
    expect(manifest.id).toBe(agentPluginId("user.agent.theme", "Glass")); // P92 D2：哈希 id，不再是 slug
    expect(manifest.capabilities).toEqual(["theme.tokens"]);
    expect(manifest.contributions.themes).toHaveLength(1);
    expect(manifest.artifacts["main.json"].kind).toBe("theme");
    expect(manifest.artifacts["main.json"].vars["--accent"]).toBe("#336699");
    // P91 D3：保存的是完整主题——本次 patch 之外还要带上当前主题的底 token
    expect(manifest.artifacts["main.json"].vars["--bg"]).toBe("#101010");
    expect(manifest.artifacts["main.json"].css).toBe(":root{--x:1}");
    expect(mocks.install).toHaveBeenCalledWith("st-1");
    expect(mocks.enable).toHaveBeenCalledWith(agentPluginId("user.agent.theme", "Glass"), true);
    const data = ok.data as { pluginId: string; enabled: boolean; hint: string; tokens: number; updated: boolean };
    expect(data.pluginId).toBe(agentPluginId("user.agent.theme", "Glass")); // 停用入口靠它
    expect(data.enabled).toBe(true);
    expect(data.updated).toBe(false);
    expect(data.tokens).toBeGreaterThanOrEqual(4); // patch 2 + 底 2，不再是"只存了两个 token"
    expect(data.hint).toContain("并启用");
    expect(inline.size).toBe(0); // 覆盖层已清空，由插件层接管
  });

  it("P92 D2 中文名不再退化成单字母 id，且不同中文名不互相覆盖", async () => {
    stubDom();
    const { tools } = await load();
    const idOf = async (name: string) => {
      mocks.stage.mockClear();
      await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699" } }), ctx("create"));
      const r = await tools.executeAppearanceTool(call("save_theme_extension", { name }), ctx("create"));
      return (r.data as { pluginId: string }).pluginId;
    };
    const a = await idOf("AI 助手现代玻璃风");
    const b = await idOf("深海蓝玻璃");
    expect(a).toMatch(/^user\.agent\.theme-[0-9a-z]{1,7}$/);
    expect(a).not.toBe("user.agent.theme-ai"); // 旧 slug 把中文全吃掉后剩下的残骸
    expect(a).not.toBe(b); // 两份不同主题必须各自独立，不再静默覆盖
    expect(a).toBe(await idOf("AI 助手现代玻璃风")); // 同名稳定（幂等判据成立的前提）
  });

  /**
   * P99a-B4（详设 §13.3）：`style_commit` 的价值不是"少一步"，是**忠实**——
   * 它读宿主临时层的真值，而不是让模型复述自己历史上发过的参数。
   * 这三条一起构成"写入时合法 ⇒ 固化时也被接受"的等价承诺。
   */
  it("P99a-B4 style_commit 读的是临时层真值（含多层顺序），不是模型重抄", async () => {
    stubDom({ "--bg": "#101010" });
    const { tools } = await load();
    const scratch = await import("./styleScratch");
    expect(
      (await tools.executeAppearanceTool(call("style_commit", { name: "空的" }), ctx("create"))).code,
    ).toBe("no_scratch_layers");
    scratch.applyLayer("圆角", ".tb-btn{border-radius:12px}");
    scratch.applyLayer("发光", ".tb-btn{box-shadow:0 0 8px #0f0}");
    const ok = await tools.executeAppearanceTool(call("style_commit", { name: "圆角发光" }), ctx("create"));
    expect(ok.ok).toBe(true);
    const manifest = mocks.stage.mock.calls[0][0] as {
      artifacts: Record<string, { css?: string }>;
    };
    const css = manifest.artifacts["main.json"].css ?? "";
    expect(css).toContain("border-radius:12px");
    expect(css).toContain("box-shadow");
    // 层顺序＝追加顺序（后者覆盖前者），固化不能把它洗成字母序
    expect(css.indexOf("border-radius")).toBeLessThan(css.indexOf("box-shadow"));
    const data = ok.data as { layers: string[]; layerCount: number; pluginId: string };
    expect(data.layers).toEqual(["圆角", "发光"]);
    expect(data.layerCount).toBe(2);
    expect(data.pluginId).toBe(agentPluginId("user.agent.theme", "圆角发光"));
  });

  it("P99a-B4 等价承诺：超过手写 8KiB 上限的层文本仍能固化（同一段走 save_theme_extension 会被拒）", async () => {
    stubDom({ "--bg": "#101010" });
    const { tools } = await load();
    const scratch = await import("./styleScratch");
    const big = `.big{padding:${"1".repeat(9000)}px}`;
    scratch.applyLayer("大层", big);
    const committed = await tools.executeAppearanceTool(call("style_commit", { name: "大层主题" }), ctx("create"));
    expect(committed.ok).toBe(true);
    const retyped = await tools.executeAppearanceTool(call("save_theme_extension", { name: "手写版", css: big }), ctx("create"));
    expect(retyped.code).toBe("unsafe_css");
    expect(String((retyped.data as { problems: string[] }).problems.join())).toContain("css_too_long");
  });

  it("P99a-B4 固化后覆盖层清空（与保存主题同一持久化边界），且带恢复路径文案", async () => {
    stubDom({ "--bg": "#101010" });
    const { tools } = await load();
    const scratch = await import("./styleScratch");
    await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699" } }), ctx("create"));
    scratch.applyLayer("层一", ".a{color:#fff}");
    const r = await tools.executeAppearanceTool(call("style_commit", { name: "带 token" }), ctx("create"));
    const data = r.data as { hint: string; tokens: number; enabled: boolean };
    expect(mocks.enable).toHaveBeenCalled();
    expect(data.tokens).toBeGreaterThan(0); // token 也从真值里取，不只是层文本
    expect(data.hint).toContain("停用");
    expect(data.hint).toContain("插件管理");
  });

  it("P91 D3 同名再存走原地升版：不重复安装、版本自增、回执标 updated", async () => {
    stubDom();
    const { tools } = await load();
    await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699" } }), ctx("create"));
    const baseId = agentPluginId("user.agent.theme", "Glass");
    mocks.getPlugin.mockImplementation((id: string) =>
      id === baseId ? { pkg: { id: baseId, version: "0.1.3", name: "Glass", capabilities: ["theme.tokens"] }, state: "enabled" } : undefined,
    );
    const r = await tools.executeAppearanceTool(call("save_theme_extension", { name: "Glass" }), ctx("create"));
    expect(r.ok).toBe(true);
    expect(mocks.stage).not.toHaveBeenCalled(); // 不再产生第二条插件记录
    expect(mocks.install).not.toHaveBeenCalled();
    // proposeUpdate(id, manifest) —— 第二参才是候选包
    const manifest = mocks.propose.mock.calls[0][1] as { id: string; version: string };
    expect(manifest.id).toBe(baseId);
    expect(manifest.version).toBe("0.1.4"); // 补丁位自增
    expect(mocks.approve).toHaveBeenCalledWith(baseId);
    const data = r.data as { updated: boolean; version: string };
    expect(data.updated).toBe(true);
    expect(data.version).toBe("0.1.4");
  });

  it("P92 D2 id 撞上但名字不同 → 另立门户新建，不覆盖别人的主题", async () => {
    stubDom();
    const { tools } = await load();
    await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699" } }), ctx("create"));
    const baseId = agentPluginId("user.agent.theme", "Glass");
    // 库里同 id 却是另一份主题（改名/哈希撞车的现实情形）
    mocks.getPlugin.mockImplementation((id: string) =>
      id === baseId
        ? { pkg: { id: baseId, version: "0.1.0", name: "别的主题", capabilities: ["theme.tokens"] }, state: "enabled" }
        : id === `${baseId}-2`
          ? undefined
          : undefined,
    );
    const r = await tools.executeAppearanceTool(call("save_theme_extension", { name: "Glass" }), ctx("create"));
    expect(mocks.propose).not.toHaveBeenCalled(); // 绝不原地升版覆盖别人
    expect(mocks.stage).toHaveBeenCalledTimes(1);
    const manifest = mocks.stage.mock.calls[0][0] as { id: string; name: string };
    expect(manifest.id).toBe(`${baseId}-2`);
    expect((r.data as { updated: boolean }).updated).toBe(false);
  });

  it("P91 D3 更新含新增能力时不自动批准，回话让用户去库里批", async () => {
    stubDom();
    const { tools } = await load();
    await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699" } }), ctx("create"));
    const baseId = agentPluginId("user.agent.theme", "Glass");
    mocks.getPlugin.mockImplementation((id: string) =>
      id === baseId
        ? { pkg: { id: baseId, version: "0.1.0", name: "Glass", capabilities: [] }, state: "enabled" }
        : undefined,
    );
    const r = await tools.executeAppearanceTool(call("save_theme_extension", { name: "Glass" }), ctx("create"));
    const data = r.data as { pendingApproval?: boolean; hint?: string };
    expect(data.pendingApproval).toBe(true);
    expect(data.hint).toContain("插件管理");
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("P90 E2 安装/启用失败如实回执，不假装保存成功", async () => {
    stubDom();
    const { tools } = await load();
    await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699" } }), ctx("create"));
    mocks.stage.mockReturnValue({ ok: false, errors: ["能力非法"], warnings: [] });
    const bad = await tools.executeAppearanceTool(call("save_theme_extension", { name: "X" }), ctx("create"));
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("invalid_package");
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("P92 E1：theme_patch 回执给出「旧 → 新」清单与改动数，改得太少时给出警告", async () => {
    stubDom({ "--accent": "#ff0000" });
    const { tools } = await load();
    const r = await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699" } }), ctx("create"));
    const d = r.data as { changedCount: number; diff: string[]; warn?: string; next: string };
    expect(d.changedCount).toBe(1);
    expect(d.diff[0]).toContain("--accent");
    expect(d.diff[0]).toContain("#ff0000"); // 旧值取自改动之前
    expect(d.diff[0]).toContain("#336699");
    expect(d.warn).toContain("看不出差别");
    expect(d.next).toContain("讲给用户");
    // 够大的改动不再给警告
    const many = await tools.executeAppearanceTool(
      call("theme_patch", {
        tokens: {
          "--bg": "#0a0a0a", "--bg-panel": "#121212", "--bg-inset": "#0d0d0d",
          "--border": "#2a2a2a", "--text": "#eeeeee", "--accent": "#336699",
        },
      }),
      ctx("create"),
    );
    expect((many.data as { changedCount: number; warn?: string }).changedCount).toBe(6);
    expect((many.data as { warn?: string }).warn).toBeUndefined();
  });

  it("P92 E1：theme_preset 回执同样带 changedCount 与差异清单", async () => {
    stubDom({ "--bg-panel": "#111111", "--bg-inset": "#0d0d0d", "--bg-titlebar": "#1a1a1a" });
    const { tools } = await load();
    const r = await tools.executeAppearanceTool(call("theme_preset", { name: "glass" }), ctx("create"));
    const d = r.data as { changedCount: number; diff: string[] };
    expect(d.changedCount).toBe(3); // 三处面全在当前主题里定义 ⇒ 玻璃配方三项都派生出值
    expect(d.diff.length).toBe(d.changedCount);
    expect(d.diff.some((l) => l.includes("--bg-panel"))).toBe(true);
    expect(d.diff.some((l) => l.includes("#111111"))).toBe(true); // 旧值先于改动抓取
    // 当前主题缺 token 时只派生能解析的那几项，不编造颜色
    stubDom({ "--bg-panel": "#111111" });
    const thin = await tools.executeAppearanceTool(call("theme_preset", { name: "glass" }), ctx("create"));
    expect((thin.data as { changedCount: number }).changedCount).toBe(1);
  });

  it("P92 C：档位门按授权域裁决——扩展档不比「界面创造」低", async () => {
    stubDom();
    const { tools } = await load();
    // 扩展档（scope=custom + 勾选 config）改得动外观：旧实现写死 scope!=="create" 直接拒
    const ext = await tools.executeAppearanceTool(
      call("theme_patch", { tokens: { "--accent": "#123456" } }),
      ctx("custom", ["config", "plugins", "files"]),
    );
    expect(ext.ok).toBe(true);
    // 没勾 config 的档位仍然拒，且给的是"超出授权范围"而不是"仅预览"
    const noDom = await tools.executeAppearanceTool(
      call("theme_patch", { tokens: { "--accent": "#654321" } }),
      ctx("custom", ["files"]),
    );
    expect(noDom.code).toBe("unauthorized_scope");
    expect((noDom.data as { hint: string }).hint).toContain("配置写入");
    // 保存=装插件：要 plugins 域，config 单独不够
    const saveNoPlg = await tools.executeAppearanceTool(
      call("save_theme_extension", { name: "T" }),
      ctx("custom", ["config"]),
    );
    expect(saveNoPlg.code).toBe("unauthorized_scope");
    const saveOk = await tools.executeAppearanceTool(
      call("save_theme_extension", { name: "T" }),
      ctx("custom", ["config", "plugins"]),
    );
    expect(saveOk.ok).toBe(true);
    // preview 档一切照旧：只预览
    const prev = await tools.executeAppearanceTool(
      call("theme_patch", { tokens: { "--accent": "#abcdef" } }),
      ctx("preview", ["config", "plugins"]),
    );
    expect(prev.code).toBe("preview_only");
  });
});
