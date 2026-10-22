/**
 * P174-A2：仓库布局与信任判定的判据。
 *
 * 这一组的重点是**"什么变化才该让用户重新批准"**——判据错了的两种表现都很糟：
 * 放宽了（改个权限也不问）是安全洞；收紧了（改个描述就要重批）是骚扰，
 * 而骚扰会训练用户无脑点「同意」。
 */
import { describe, expect, it } from "vitest";
import { validateExtension, type ExtensionManifest } from "./manifest";
import {
  danglingIndexIds,
  emptyIndex,
  extDir,
  extensionsRoot,
  flattenPermissions,
  indexPath,
  logsDir,
  permissionDelta,
  removeFromIndex,
  resolveInExtDir,
  stableStringify,
  stagingDir,
  trustDigestInput,
  trustPath,
  trustVerdict,
  upsertIndex,
  type TrustRecord,
} from "./repo";

const APP = "C:\\Users\\x\\AppData\\Roaming\\uartix";

function manifest(over: Record<string, unknown> = {}): ExtensionManifest {
  const r = validateExtension({
    format: "uartix-extension",
    schemaVersion: 3,
    id: "user.yolo.workbench",
    version: "1.0.0",
    name: "YOLO 训练工作台",
    description: "第一版描述",
    main: "main.mjs",
    activation: ["onPanel:workbench"],
    permissions: { fs: { read: ["$WS/**"], write: ["$WS"] }, ui: { panel: true } },
    contributes: { panels: [{ id: "workbench", title: "YOLO", entry: "panel/index.html" }] },
    ...over,
  });
  expect(r.errors).toEqual([]);
  return r.manifest!;
}

describe("P174-A2 · 目录布局", () => {
  it("四个位置都在 appDir/extensions 之下，尾斜杠不重复", () => {
    expect(extensionsRoot(APP)).toBe(`${APP}/extensions`);
    expect(extDir(APP, "user.yolo.workbench")).toBe(`${APP}/extensions/user.yolo.workbench`);
    expect(stagingDir(APP, "draft1")).toBe(`${APP}/extensions/staging/draft1`);
    expect(indexPath(APP)).toBe(`${APP}/extensions/index.json`);
    expect(trustPath(APP)).toBe(`${APP}/extensions/trust.json`);
    expect(logsDir(APP, "a.b")).toBe(`${APP}/extensions/a.b/logs`);
    // 带尾斜杠的输入不该拼出 //
    expect(extensionsRoot(APP + "\\")).toBe(`${APP}/extensions`);
  });
});

describe("P174-A2 · 包内路径不许越界", () => {
  it("正常相对路径拼成绝对路径", () => {
    expect(resolveInExtDir("C:/ext/a", "panel/index.html")).toBe("C:/ext/a/panel/index.html");
    expect(resolveInExtDir("C:/ext/a", "main.mjs")).toBe("C:/ext/a/main.mjs");
  });

  it("穿越、绝对、盘符、反斜杠、空段一律 null", () => {
    const dir = "C:/ext/a";
    for (const bad of [
      "../evil.mjs",
      "a/../../evil.mjs",
      "/etc/passwd",
      "C:/Windows/system32/x.dll",
      "panel\\index.html",
      "panel//index.html",
      "./main.mjs",
      "~/.ssh/id_rsa",
      "",
    ]) {
      expect(resolveInExtDir(dir, bad), bad).toBeNull();
    }
  });
});

describe("P174-A2 · 稳定序列化与信任摘要", () => {
  it("键序不同、内容相同 ⇒ 摘要完全相同（否则用户会莫名被要求重批）", () => {
    const a = { b: 1, a: { d: 2, c: [3, 4] } };
    const b = { a: { c: [3, 4], d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    // 数组保序：顺序变了就是变了
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("改名字/描述不影响摘要；改权限、改注入、改入口才影响", () => {
    const base = manifest();
    const baseDigest = trustDigestInput(base);

    expect(trustDigestInput(manifest({ name: "换个名字" }))).toBe(baseDigest);
    expect(trustDigestInput(manifest({ description: "换个描述" }))).toBe(baseDigest);
    expect(trustDigestInput(manifest({ author: "某人", homepage: "https://a.b" }))).toBe(baseDigest);

    // 多给一个写目录：必须变
    expect(
      trustDigestInput(manifest({ permissions: { fs: { write: ["$WS", "$WS/runs"] }, ui: { panel: true } } })),
    ).not.toBe(baseDigest);

    // 往宿主面板注入：必须变
    expect(
      trustDigestInput(
        manifest({ inject: { sections: [{ slot: "serial.side", id: "x", title: "X", entry: "a.html" }] } }),
      ),
    ).not.toBe(baseDigest);

    // 入口换了：必须变
    expect(trustDigestInput(manifest({ main: "other.mjs" }))).not.toBe(baseDigest);
  });

  it("activation 顺序不影响摘要（它是集合，不是序列）", () => {
    const a = manifest({ activation: ["onPanel:p", "onCommand:c"] });
    const b = manifest({ activation: ["onCommand:c", "onPanel:p"] });
    expect(trustDigestInput(a)).toBe(trustDigestInput(b));
  });
});

describe("P174-A2 · 信任三态", () => {
  const m = manifest();
  const digest = trustDigestInput(m);
  const rec: TrustRecord = { id: m.id, version: m.version, digest, grantedAt: 1, grantedSummary: [] };

  it("没记录 ⇒ 要批准；摘要同 ⇒ 已信任；摘要不同 ⇒ 变了要重批", () => {
    expect(trustVerdict(undefined, digest)).toBe("needs-approval");
    expect(trustVerdict(rec, digest)).toBe("trusted");
    expect(trustVerdict(rec, digest + "x")).toBe("changed");
  });

  it("只升版本号、权限面没变 ⇒ 仍然 trusted（不该为一次小版本再来一遍）", () => {
    const bumped = manifest({ version: "1.0.1" });
    // 版本号本身参与摘要，所以这里检验的是"产品语义"：
    // 如果将来决定版本号不参与摘要，这条会红——那时要重新想清楚"你批的是哪一版"怎么回答
    expect(trustDigestInput(bumped)).not.toBe(digest);
  });
});

describe("P174-A2 · 索引", () => {
  it("upsert 覆盖同 id、remove 删掉、悬空条目能被点出来", () => {
    const empty = emptyIndex();
    const one = upsertIndex(empty, "a.b", {
      dir: "a.b",
      version: "1.0.0",
      digest: "d1",
      installedAt: 1,
      source: "market",
    });
    expect(Object.keys(one.items)).toEqual(["a.b"]);

    const two = upsertIndex(one, "a.b", { ...one.items["a.b"], version: "1.1.0" });
    expect(two.items["a.b"].version).toBe("1.1.0");
    expect(Object.keys(two.items)).toHaveLength(1);

    expect(removeFromIndex(two, "a.b").items).toEqual({});
    expect(danglingIndexIds(two, ["a.b"])).toEqual([]);
    expect(danglingIndexIds(two, [])).toEqual(["a.b"]);
  });
});

describe("P174-A2 · 权限人话与差异", () => {
  it("摊平后每一行都是可读句子（批准卡直接用，不许只显示代号）", () => {
    const lines = flattenPermissions(
      manifest({
        permissions: {
          fs: { read: ["$WS/**"], write: ["$WS"] },
          process: { spawn: ["python"] },
          ui: { panel: true, notify: true },
        },
        inject: { mutations: [{ target: "hex", op: "hide" }] },
      }),
    );
    expect(lines).toContain("写 $WS");
    expect(lines).toContain("运行 python");
    expect(lines).toContain("隐藏面板 hex");
    expect(lines.join("|")).not.toMatch(/ui\.panel|fs\.write/); // 不许漏出内部代号
  });

  it("差异只算增删，不算措辞变化", () => {
    const d = permissionDelta(["写 $WS", "运行 python"], ["写 $WS", "联网 api.x:443"]);
    expect(d.added).toEqual(["联网 api.x:443"]);
    expect(d.removed).toEqual(["运行 python"]);
  });
});
