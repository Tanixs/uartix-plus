/**
 * P88b-4 A4：外观工具与覆盖层单测（node 环境，stub document/getComputedStyle）。
 * 覆盖：值解析、取色纯函数、覆盖层 patch/undo 原子性、工具档位门、配方（含玻璃派生）、保存清层。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]) => undefined as unknown),
  upsert: vi.fn(),
  inWl: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../ai/extensionStore", () => ({ upsertProjection: mocks.upsert }));
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn(), previewCss: vi.fn(() => "") }));
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
    createElement: () => ({
      width: 0,
      height: 0,
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
  return { store, tools };
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
    expect(prev.code).toBe("general_tool_requires_custom");
    const noDom = await tools.executeAppearanceTool(call("image_swatch", { path: "D:\\w\\a.png" }), ctx("custom", ["network"]));
    expect(noDom.code).toBe("general_tool_requires_custom");
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
  it("save_theme_extension persists overlay via projection and clears the layer", async () => {
    const inline = stubDom();
    const { tools } = await load();
    const empty = await tools.executeAppearanceTool(call("save_theme_extension", { name: "我的主题" }), ctx("create"));
    expect(empty.code).toBe("empty_overlay");
    await tools.executeAppearanceTool(call("theme_patch", { tokens: { "--accent": "#336699", "--fs-body": "13px" } }), ctx("create"));
    const ok = await tools.executeAppearanceTool(call("save_theme_extension", { name: "我的主题", css: ":root{--x:1}" }), ctx("create"));
    expect(ok.ok).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const ext = mocks.upsert.mock.calls[0][0] as { type: string; enabled: boolean; vars: Record<string, string>; css?: string };
    expect(ext.type).toBe("theme");
    expect(ext.enabled).toBe(true);
    expect(ext.vars["--accent"]).toBe("#336699");
    expect(ext.css).toBe(":root{--x:1}");
    expect(inline.size).toBe(0); // 覆盖层已清空，由扩展层接管
  });
});
