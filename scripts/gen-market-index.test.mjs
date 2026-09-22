/**
 * P99b-N2.5：市场生成器的**源包规则**测试（`npm test` 会带上这个文件）。
 *
 * 这批解决的是"作者手感"：一支真 widget 是几十行 HTML，塞进 JSON 的一个字符串里就得手敲
 * `\"` 与 `\n`。所以源包允许**旁挂真实文件**（`htmlFile: "rig.html"`），由生成器编译成
 * 单个 `.uartix.json`，**哈希算在编译产物上**。
 *
 * 但"能编译"必然带两个新坑，它们比便利更重要，所以各有反向断言：
 *  1. `..` 越界 ⇒ 投稿人写一个 `htmlFile: "../../../src-tauri/..."` 就能把仓库里任意文件
 *     灌进货架上的包（与 §8 那条 `..` 越界同族）；
 *  2. `publicUrl` 与实际写出的产物名不一致 ⇒ **索引不会红，用户点安装才 404**（N1 的洞）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { resolveFileRefs, buildEntry, pkgFileNameOf } = await import("./gen-market-index.mjs");

/** 造一个只读得到 dir 内文件的读入口（测试里不碰仓库） */
function fakeFs(files) {
  return (rel) => {
    if (!Object.hasOwn(files, rel)) throw new Error(`ENOENT ${rel}`);
    return files[rel];
  };
}

describe("resolveFileRefs：源包里的 `<键>File` 内联", () => {
  it("htmlFile 换成 html，键消失，内容原样进包", () => {
    const read = fakeFs({ "rig.html": "<div class=\"a\">\n  x\n</div>" });
    const out = resolveFileRefs({ kind: "widget", format: "html", htmlFile: "rig.html" }, read);
    expect(out).toEqual({ kind: "widget", format: "html", html: "<div class=\"a\">\n  x\n</div>" });
    expect("htmlFile" in out).toBe(false);
  });

  it("嵌套数组与对象里的 File 键也处理（产物表是 {entry: {...}} 形状）", () => {
    const read = fakeFs({ "a.css": "p{color:red}", "b.css": "p{color:blue}" });
    const out = resolveFileRefs(
      { kind: "panel", parts: [{ cssFile: "a.css" }, { nested: { cssFile: "b.css" } }] },
      read,
    );
    expect(out).toEqual({ kind: "panel", parts: [{ css: "p{color:red}" }, { nested: { css: "p{color:blue}" } }] });
  });

  it("同一个键既写值又写 File ⇒ 拒绝（不许两份说法都留着）", () => {
    const read = fakeFs({ "rig.html": "x" });
    expect(() => resolveFileRefs({ html: "旧的", htmlFile: "rig.html" }, read)).toThrow(/既写了/);
  });

  it("`..` 越界与绝对路径都拒绝，且各自报对（这就是那条 `..` 同族红线）", () => {
    const read = fakeFs({ "../leak.json": "不该读到", "/etc/passwd": "不该读到" });
    expect(() => resolveFileRefs({ htmlFile: "../leak.json" }, read)).toThrow(/越界/);
    expect(() => resolveFileRefs({ htmlFile: "/etc/passwd" }, read)).toThrow(/绝对路径/);
    expect(() => resolveFileRefs({ htmlFile: "C:\\secrets\\x.html" }, read)).toThrow(/绝对路径/);
    expect(() => resolveFileRefs({ htmlFile: "a/../../b.html" }, read)).toThrow(/越界/);
    expect(read("../leak.json")).toBe("不该读到"); // 反证：文件"在"，被拒是因为路径不合法，不是因为读不到
  });

  it("引用的文件不存在 ⇒ 构建失败，不静默产出空串", () => {
    const read = fakeFs({});
    expect(() => resolveFileRefs({ htmlFile: "gone.html" }, read)).toThrow(/不存在/);
  });

  it("File 的值必须是字符串路径（写成对象/数字就拒，不猜）", () => {
    const read = fakeFs({});
    expect(() => resolveFileRefs({ htmlFile: 3 }, read)).toThrow(/路径/);
  });
});

describe("buildEntry：源包两种形态与产物名对账", () => {
  const cats = { theme: "外观与主题", widget: "桌面小部件" };
  const root = mkdtempSync(path.join(tmpdir(), "uartix-market-"));
  const pkgDir = path.join(root, "market", "pkg");
  const outDir = path.join(root, "public", "market", "pkg");
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const flatPkg = {
    format: "uartix-plugin", schemaVersion: 2, id: "uartix.theme.flat", version: "1.0.0",
    name: "平铺", hostApi: "^1.0", capabilities: ["theme.tokens"],
    contributions: { themes: [{ id: "main", entry: "main.json" }] },
    artifacts: { "main.json": { kind: "theme", vars: { "--bg": "#000" } } },
    provenance: { createdBy: "user", reviewed: false },
  };
  writeFileSync(path.join(pkgDir, "flat.uartix.json"), JSON.stringify(flatPkg, null, 2) + "\n", "utf8");

  // 目录源：manifest 里 HTML 走旁挂文件
  const dirPkg = path.join(pkgDir, "rig");
  mkdirSync(dirPkg, { recursive: true });
  writeFileSync(
    path.join(dirPkg, "manifest.json"),
    JSON.stringify(
      { ...flatPkg, id: "uartix.widget.rig", name: "台架", capabilities: ["ui.widget"],
        contributions: { widgets: [{ id: "rig", entry: "rig.json", name: "台架", w: 2, h: 2 }] },
        artifacts: { "rig.json": { kind: "widget", format: "html", htmlFile: "rig.html" } } },
      null, 2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(path.join(dirPkg, "rig.html"), "<div>\n  <span>yaw</span>\n</div>\n", "utf8");

  it("目录源编译出 `<目录名>.uartix.json`，产物里是内联好的 html", () => {
    const entry = buildEntry(
      {
        id: "uartix.widget.rig", name: "台架", author: "t", category: "widget",
        description: { zh: "x" }, version: "1.0.0", minAppVersion: "0.4.1", updated: "2026-09-22",
        packageFile: "rig/", publicUrl: "/market/pkg/rig.uartix.json", capabilities: ["ui.widget"],
      },
      cats,
      { root },
    );
    expect(entry.id).toBe("uartix.widget.rig");
    const emitted = JSON.parse(readFileSync(path.join(outDir, "rig.uartix.json"), "utf8"));
    expect(emitted.artifacts["rig.json"].html).toContain("<span>yaw</span>");
    expect("htmlFile" in emitted.artifacts["rig.json"]).toBe(false);
    expect(entry.bytes).toBe(readFileSync(path.join(outDir, "rig.uartix.json")).length);
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("`publicUrl` 的末段与实际产物名不一致 ⇒ 当场构建失败（N1 是静默 404）", () => {
    expect(
      () =>
        buildEntry(
          {
            id: "uartix.theme.flat", name: "平铺", author: "t", category: "theme",
            description: { zh: "x" }, version: "1.0.0", minAppVersion: "0.4.1", updated: "2026-09-22",
            packageFile: "flat.uartix.json", publicUrl: "/market/pkg/typo.uartix.json", capabilities: ["theme.tokens"],
          },
          cats,
          { root },
        ),
    ).toThrow(/typo\.uartix\.json/);
  });

  it("目录源与同名平铺包并存 ⇒ 拒绝（两份都在时，上架的是哪一份没人说得清）", () => {
    writeFileSync(path.join(pkgDir, "rig.uartix.json"), "{}", "utf8");
    try {
      expect(
        () =>
          buildEntry(
            {
              id: "uartix.widget.rig", name: "台架", author: "t", category: "widget",
              description: { zh: "x" }, version: "1.0.0", minAppVersion: "0.4.1", updated: "2026-09-22",
              packageFile: "rig/", publicUrl: "/market/pkg/rig.uartix.json", capabilities: ["ui.widget"],
            },
            cats,
            { root },
          ),
      ).toThrow(/重名/);
    } finally {
      unlinkSync(path.join(pkgDir, "rig.uartix.json"));
    }
  });

  it("产物名规则单点：平铺源用文件名，目录源用 `<目录名>.uartix.json`", () => {
    expect(pkgFileNameOf("flat.uartix.json")).toBe("flat.uartix.json");
    expect(pkgFileNameOf("rig/")).toBe("rig.uartix.json");
    expect(pkgFileNameOf("rig")).toBe("rig.uartix.json");
  });

  it("写到 public 下的产物是**编译后**的字节，源目录里的 manifest 保持带 File 的样子", () => {
    buildEntry(
      {
        id: "uartix.widget.rig", name: "台架", author: "t", category: "widget",
        description: { zh: "x" }, version: "1.0.0", minAppVersion: "0.4.1", updated: "2026-09-22",
        packageFile: "rig", publicUrl: "/market/pkg/rig.uartix.json", capabilities: ["ui.widget"],
      },
      cats,
      { root },
    );
    const src = JSON.parse(readFileSync(path.join(dirPkg, "manifest.json"), "utf8"));
    expect(src.artifacts["rig.json"].htmlFile).toBe("rig.html");
    expect(existsSync(path.join(pkgDir, "rig.uartix.json"))).toBe(false);
  });
});
