import { beforeEach, describe, expect, it, vi } from "vitest";
import { COVER_MAX_BYTES, SHOTS_MAX, validateManifest } from "./pluginManifest";
import { appendShots, removeShot } from "./pluginShots";

const tiny = "data:image/png;base64,iVBORw0KGgo=";
const tiny2 = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

function rawManifest(extra: Record<string, unknown> = {}) {
  return {
    format: "uartix-plugin",
    schemaVersion: 2,
    id: "user.theme.p161",
    version: "1.0.0",
    name: "P161 测试包",
    hostApi: "^1.0",
    capabilities: ["theme.tokens"],
    contributions: { themes: [{ id: "main", entry: "main.json" }] },
    artifacts: { "main.json": { kind: "theme", vars: { "--bg": "#101014" } } },
    provenance: { createdBy: "user", reviewed: false },
    ...extra,
  };
}

describe("P161 · manifest screenshots", () => {
  it("可选；合法截图按顺序保留", () => {
    const empty = validateManifest(rawManifest());
    expect(empty.ok).toBe(true);
    expect(empty.manifest?.screenshots).toBeUndefined();

    const v = validateManifest(rawManifest({ screenshots: [tiny, tiny2] }));
    expect(v.ok).toBe(true);
    expect(v.manifest?.screenshots).toEqual([tiny, tiny2]);
  });

  it("超过 4 张拒绝", () => {
    const v = validateManifest(rawManifest({ screenshots: Array.from({ length: SHOTS_MAX + 1 }, () => tiny) }));
    expect(v.ok).toBe(false);
    expect(v.errors.join("")).toContain(`最多 ${SHOTS_MAX} 张`);
  });

  it("非数组、非图片 data URL 拒绝", () => {
    expect(validateManifest(rawManifest({ screenshots: "x" })).ok).toBe(false);
    const v = validateManifest(rawManifest({ screenshots: ["data:image/gif;base64,R0lGOD"] }));
    expect(v.ok).toBe(false);
    expect(v.errors.join("")).toContain("screenshots[0]");
  });

  it("单张超过 200KB 拒绝并指出序号", () => {
    const big = "data:image/png;base64," + "A".repeat(Math.ceil((COVER_MAX_BYTES * 4) / 3) + 64);
    const v = validateManifest(rawManifest({ screenshots: [tiny, big] }));
    expect(v.ok).toBe(false);
    expect(v.errors.join("")).toContain("screenshots[1]");
    expect(v.errors.join("")).toContain("200KB");
  });
});

describe("P161 · 增删与上限", () => {
  it("appendShots 截到上限并报告丢弃数", () => {
    const current = [tiny, tiny, tiny];
    const r = appendShots(current, [tiny2, tiny2, tiny2]);
    expect(r.next).toHaveLength(SHOTS_MAX);
    expect(r.dropped).toBe(2);
  });

  it("removeShot 只删指定项，越界不变", () => {
    expect(removeShot([tiny, tiny2, tiny], 1)).toEqual([tiny, tiny]);
    expect(removeShot([tiny], 9)).toEqual([tiny]);
  });
});

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

describe("P161 · updateMeta screenshots", () => {
  it("写入、读取、清空；无效数组不覆盖原值", async () => {
    const store = await import("./pluginStore");
    expect(store.updateMeta("user.theme.p161", { screenshots: [tiny, tiny2] }).ok).toBe(true);
    expect(store.getPlugin("user.theme.p161")?.pkg.screenshots).toEqual([tiny, tiny2]);
    expect(storage.get(KEY)).toContain("screenshots");

    expect(store.updateMeta("user.theme.p161", { screenshots: Array.from({ length: SHOTS_MAX + 1 }, () => tiny) }).ok).toBe(false);
    expect(store.getPlugin("user.theme.p161")?.pkg.screenshots).toEqual([tiny, tiny2]);

    expect(store.updateMeta("user.theme.p161", { screenshots: undefined }).ok).toBe(true);
    expect(store.getPlugin("user.theme.p161")?.pkg.screenshots).toBeUndefined();
  });
});

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

describe("P161 · 详情画廊接线", () => {
  it("详情渲染画廊，隐藏 input 支持多选并写回 manifest", () => {
    const src = read("features/plugins/PluginLibraryDialog.tsx");
    expect(src).toContain("PluginShotGallery");
    expect(src).toContain("screenshots: next.length ? next : undefined");
    expect(src).toContain("multiple");
    expect(src).toContain("readPicture");
  });

  it("灯箱有 dialog 语义、键盘导航与焦点", () => {
    const src = read("features/plugins/PluginShotGallery.tsx");
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('"Escape"');
    expect(src).toContain('"ArrowLeft"');
    expect(src).toContain('"ArrowRight"');
    expect(src).toContain("autoFocus");
    expect(src).toContain("aria-label");
  });

  it("样式有网格、删除按钮焦点态与灯箱", () => {
    const css = read("styles/theme.css");
    expect(css).toContain(".plg-shot-grid {");
    expect(css).toContain(".plg-shot-del:focus-visible");
    expect(css).toContain(".plg-big-img {");
  });
});
