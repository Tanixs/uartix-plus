/**
 * P131-C 资产通道的运行期守卫：`--fx-asset-*` 这一族变量**只能由资产层写**，
 * 而且必须跟着"在画那一枚 / 草稿层"的启停一起出现与消失。
 *
 * 用真 `rootVars`（不 mock）：断言读的是 `effectiveRootVars()`，也就是界面实际拿到的东西。
 * `Blob` / `URL.createObjectURL` 在 node 里不存在，所以自己 stub——
 * 顺便钉住"环境没有 blob 能力时不许画半张图"：那时 `live` 必须小于 `declared`，而不是假装成功。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});

const { effectiveRootVars, rootVarLayers } = await import("../../styles/rootVars");
const { ASSET_LAYER_ID, assetLayerCount, syncThemeAssets } = await import("./assetRuntime");
const { dropScratchAsset, listScratchAssets, putScratchAsset, revertScratchAssets, scratchAssetCount, SCRATCH_ASSET_LAYER_ID } = await import("../agent/scratchAssets");

/** 一枚真 1×1 PNG 的 base64（魔数核对要过） */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** 同一长度、换中间一个字节：头尾与长度都没变，只有整串哈希会变 */
const PNG_ALT = PNG.slice(0, 40) + (PNG[40] === "A" ? "B" : "A") + PNG.slice(41);
let made = 0;
const revoked: string[] = [];

beforeEach(() => {
  made = 0;
  revoked.length = 0;
  vi.stubGlobal("Blob", class {
    constructor(public parts: unknown[], public type: unknown) {}
  });
  vi.stubGlobal("URL", Object.assign(globalThis.URL ?? function () {}, {
    createObjectURL: () => `blob:fake-${++made}`,
    revokeObjectURL: (u: string) => void revoked.push(u),
  }));
});

/** 真身先记下来（在任何 stub 之前求值），afterEach 只收回这两枚 */
const prevBlob = globalThis.Blob;
const prevUrl = globalThis.URL;

afterEach(() => {
  revertScratchAssets();
  syncThemeAssets([]);
  // 不用 unstubAllGlobals：它会把文件顶上的 localStorage 桩一起拔掉（同 themeApply 那条注释）
  vi.stubGlobal("Blob", prevBlob);
  vi.stubGlobal("URL", prevUrl);
});

describe("P131-C · 主题资产层（在画那一枚带的贴图）", () => {
  it("启用即写入内联样式，且键名是 --fx-asset-<id>", () => {
    expect(syncThemeAssets([{ id: "acrylic-noise", mime: "image/png", data: PNG }])).toBe(1);
    expect(effectiveRootVars()["--fx-asset-acrylic-noise"]).toBe('url("blob:fake-1")');
    expect(rootVarLayers().map((l) => l.id)).toContain(ASSET_LAYER_ID);
  });

  it("清空即撤层：变量不见了，层也不留在表里，且旧 URL 被回收", () => {
    syncThemeAssets([{ id: "n1", mime: "image/png", data: PNG }]);
    syncThemeAssets([]);
    expect(effectiveRootVars()["--fx-asset-n1"]).toBeUndefined();
    expect(rootVarLayers().map((l) => l.id)).not.toContain(ASSET_LAYER_ID);
    expect(revoked).toEqual(["blob:fake-1"]);
    expect(assetLayerCount(ASSET_LAYER_ID)).toBe(0);
  });

  it("内容没变就复用同一个 URL；变了才换（每枚主题重合成都要跑，不能每次都造新对象）", () => {
    syncThemeAssets([{ id: "n1", mime: "image/png", data: PNG }]);
    syncThemeAssets([{ id: "n1", mime: "image/png", data: PNG }]);
    expect(made).toBe(1);
    syncThemeAssets([{ id: "n1", mime: "image/png", data: PNG_ALT }]);
    expect(made).toBe(2);
    expect(revoked).toEqual(["blob:fake-1"]);
  });

  it("环境没有 blob 能力 ⇒ live=0 且不写变量（宁可没贴图，不画半张）", () => {
    vi.stubGlobal("Blob", undefined);
    expect(syncThemeAssets([{ id: "n1", mime: "image/png", data: PNG }])).toBe(0);
    expect(effectiveRootVars()["--fx-asset-n1"]).toBeUndefined();
  });
});

describe("P131-C · AI 草稿资产层（asset_put）", () => {
  it("放一贴给出 varName，CSS 里就按这个名字引用", () => {
    const r = putScratchAsset({ id: "grain", mime: "image/png", data: PNG });
    expect(r.ok).toBe(true);
    expect(r.varName).toBe("--fx-asset-grain");
    expect(effectiveRootVars()["--fx-asset-grain"]).toBe('url("blob:fake-1")');
    expect(listScratchAssets()).toEqual([{ id: "grain", mime: "image/png", bytes: 70, varName: "--fx-asset-grain" }]);
  });

  it("撒谎的资产进不来，而且给出的理由是校验器原话", () => {
    const r = putScratchAsset({ id: "grain", mime: "image/png", data: "PHN2Zz48L3N2Zz4=" });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("asset_bytes_do_not_match_mime");
    expect(scratchAssetCount()).toBe(0);
    expect(effectiveRootVars()["--fx-asset-grain"]).toBeUndefined();
  });

  it("草稿层压在主题层之上：同一枚 id，模型正在调的那版赢", () => {
    syncThemeAssets([{ id: "grain", mime: "image/png", data: PNG }]);
    const themeUrl = effectiveRootVars()["--fx-asset-grain"];
    putScratchAsset({ id: "grain", mime: "image/png", data: PNG_ALT });
    const scratchUrl = effectiveRootVars()["--fx-asset-grain"];
    expect(themeUrl).toBeTruthy();
    expect(scratchUrl).not.toBe(themeUrl);
    revertScratchAssets();
    expect(effectiveRootVars()["--fx-asset-grain"], "撤草稿不该把主题那版一起撤掉").toBe(themeUrl);
  });

  it("drop 一枚就少一枚，全撤则整层消失", () => {
    putScratchAsset({ id: "a1", mime: "image/png", data: PNG });
    putScratchAsset({ id: "a2", mime: "image/png", data: PNG });
    expect(dropScratchAsset("a1")).toBe(true);
    expect(effectiveRootVars()["--fx-asset-a1"]).toBeUndefined();
    expect(effectiveRootVars()["--fx-asset-a2"]).toBeTruthy();
    expect(revertScratchAssets()).toBe(1);
    expect(rootVarLayers().map((l) => l.id)).not.toContain(SCRATCH_ASSET_LAYER_ID);
  });
});
