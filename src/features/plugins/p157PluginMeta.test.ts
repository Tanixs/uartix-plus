/**
 * P157-E2 · 插件封面与展示信息的牙。
 *
 * 三件事各有各的坏法：
 *  ① `fitSize` 把长图/超大图缩歪 → 封面糊或比例错；
 *  ② manifest 收下坏作者/坏主页/超预算封面 → 导出能过、导入被拒，或者包被封面顶爆；
 *  ③ `updateMeta` 不走校验直接改 pkg → 手工改坏版本号也能落盘（下次导入才炸）。
 * 这里分别钉住；canvas 真压缩路径归活体截图（node 没有 canvas）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fitSize, approxDataUrlBytes } from "./coverImage";
import { COVER_MAX_BYTES, coverBytes, validateManifest } from "./pluginManifest";

const tinyCover = "data:image/png;base64,iVBORw0KGgo=";

describe("P157-E2 · fitSize / 字节预算", () => {
  it("长边缩到上限，比例不变；已达标的不放大", () => {
    expect(fitSize(2048, 1024, 1024)).toEqual({ w: 1024, h: 512 });
    expect(fitSize(100, 3000, 1024)).toEqual({ w: 34, h: 1024 });
    expect(fitSize(800, 600, 1024)).toEqual({ w: 800, h: 600 });
    expect(fitSize(1, 1, 1024)).toEqual({ w: 1, h: 1 });
  });

  it("非法尺寸回落 1×1（不让 NaN 流进 canvas）", () => {
    expect(fitSize(0, 100)).toEqual({ w: 1, h: 1 });
    expect(fitSize(Number.NaN, 100)).toEqual({ w: 1, h: 1 });
  });

  it("字节估算与校验器同源：小图 8 字节、padding 正确；上传与导入不会两套账", () => {
    expect(approxDataUrlBytes(tinyCover)).toBe(8);
    expect(coverBytes(tinyCover)).toBe(8);
    expect(approxDataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
  });
});

function rawManifest(extra: Record<string, unknown> = {}) {
  return {
    format: "uartix-plugin",
    schemaVersion: 2,
    id: "user.theme.p157",
    version: "1.0.0",
    name: "P157 测试包",
    hostApi: "^1.0",
    capabilities: ["theme.tokens"],
    contributions: { themes: [{ id: "main", entry: "main.json" }] },
    artifacts: { "main.json": { kind: "theme", vars: { "--bg": "#101014" } } },
    provenance: { createdBy: "user", reviewed: false },
    ...extra,
  };
}

describe("P157-E2 · manifest 可选展示信息", () => {
  it("author / homepage / cover 通过并规范化", () => {
    const v = validateManifest(rawManifest({ author: "  Tanix  ", homepage: "https://github.com/Tanixs", cover: tinyCover }));
    expect(v.ok).toBe(true);
    expect(v.manifest?.author).toBe("Tanix");
    expect(v.manifest?.homepage).toBe("https://github.com/Tanixs");
    expect(v.manifest?.cover).toBe(tinyCover);
  });

  it("主页只收 https；作者不超 40 字；封面只收 png/jpeg/webp", () => {
    expect(validateManifest(rawManifest({ homepage: "http://example.com" })).ok).toBe(false);
    expect(validateManifest(rawManifest({ author: "x".repeat(41) })).ok).toBe(false);
    expect(validateManifest(rawManifest({ cover: "data:image/gif;base64,R0lGOD" })).ok).toBe(false);
  });

  it("封面超预算当场拒（不等到导入/落盘）", () => {
    const big = "data:image/png;base64," + "A".repeat(Math.ceil((COVER_MAX_BYTES * 4) / 3) + 64);
    const v = validateManifest(rawManifest({ cover: big }));
    expect(v.ok).toBe(false);
    expect(v.errors.join("")).toContain("cover");
  });

  it("老包不带三字段照常过（向后兼容）", () => {
    const v = validateManifest(rawManifest());
    expect(v.ok).toBe(true);
    expect(v.manifest?.author).toBeUndefined();
    expect(v.manifest?.cover).toBeUndefined();
  });
});

/* ---------------- updateMeta：就地编辑必须走同一把校验 ---------------- */

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});
vi.mock("./artifact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifact")>()),
  disposeProjections: vi.fn(),
  rebuildProjections: vi.fn(),
}));

const KEY = "vs.pluginLib.v1";

beforeEach(() => {
  storage.clear();
  storage.set(
    KEY,
    JSON.stringify({
      plugins: [
        {
          pkg: rawManifest(),
          state: "enabled",
          nonce: "n-a",
          config: {},
          versions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  );
  vi.resetModules();
});

async function freshStore() {
  return import("./pluginStore");
}

describe("P157-E2 · updateMeta", () => {
  it("改名/版本/作者/主页/封面就地落盘；id 不变", async () => {
    const store = await freshStore();
    const res = store.updateMeta("user.theme.p157", {
      name: "新名字",
      version: "1.1.0",
      author: "Tanix",
      homepage: "https://example.com/p157",
      cover: tinyCover,
    });
    expect(res.ok).toBe(true);
    const p = store.getPlugin("user.theme.p157");
    expect(p?.pkg.id).toBe("user.theme.p157");
    expect(p?.pkg.name).toBe("新名字");
    expect(p?.pkg.version).toBe("1.1.0");
    expect(p?.pkg.cover).toBe(tinyCover);
    expect(storage.get(KEY)).toContain("新名字");
  });

  it("坏版本/坏主页当场拒，原值不动", async () => {
    const store = await freshStore();
    expect(store.updateMeta("user.theme.p157", { version: "1.2" }).ok).toBe(false);
    expect(store.updateMeta("user.theme.p157", { homepage: "ftp://x" }).ok).toBe(false);
    expect(store.getPlugin("user.theme.p157")?.pkg.version).toBe("1.0.0");
  });

  it("清空可选字段传 undefined：键从包里消失（导出/校验都按未填）", async () => {
    const store = await freshStore();
    expect(store.updateMeta("user.theme.p157", { author: "Tanix", cover: tinyCover }).ok).toBe(true);
    expect(store.updateMeta("user.theme.p157", { author: undefined, cover: undefined }).ok).toBe(true);
    const p = store.getPlugin("user.theme.p157");
    expect(p?.pkg.author).toBeUndefined();
    expect(p?.pkg.cover).toBeUndefined();
    expect(storage.get(KEY)).not.toContain("Tanix");
  });
});
