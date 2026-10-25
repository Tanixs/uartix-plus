import { describe, expect, it } from "vitest";
import { draftDirName, draftPathOf, draftRelPath, draftRoot, toDraftEntry } from "./draft";

/**
 * P174-B1：草稿态的**路径与归一**判据。
 *
 * 草稿目录是"别人写的东西 + 我们拼的路径"，所以这里守的是三件事：
 * 名字不能把目录带出去、草稿内文件路径不能越界、坏清单不能把草稿从列表里弄没，
 * 而**合法清单**要能在转正之前就把权限面列出来。
 */

/** 一份最小但合法的 v3 清单（与 manifest 校验器同一套字段）。 */
const valid = (over: Record<string, unknown> = {}) => ({
  format: "uartix-plugin",
  schemaVersion: 3,
  id: "a.b",
  version: "1.0.0",
  name: "示例",
  main: "main.mjs",
  ...over,
});

describe("草稿路径", () => {
  it("根目录归一：反斜杠与尾斜杠都收干净", () => {
    expect(draftRoot("C:\\Users\\x\\AppData\\Roaming\\uartix\\")).toBe("C:/Users/x/AppData/Roaming/uartix/.drafts");
    expect(draftRoot("C:/a")).toBe("C:/a/.drafts");
  });

  it("目录名：id 原样保留，tag 只留小写字母数字；空 tag 退化成 draft", () => {
    expect(draftDirName("uartix.yolo", "v2")).toBe("uartix.yolo-v2");
    expect(draftDirName("a.b", "My Try!")).toBe("a.b-mytry");
    expect(draftDirName("a.b", "  ")).toBe("a.b-draft");
    expect(draftDirName("a.b", "x".repeat(40)).length).toBe("a.b-".length + 12);
  });

  it("越界的名字一律拒（`..`、带分隔符、绝对路径、点开头）", () => {
    for (const bad of ["../x", "a/b", "a\\b", "..", ".hidden", ""]) {
      expect(draftPathOf("C:/app", bad), `${bad} 应当被拒`).toBeNull();
    }
    expect(draftPathOf("C:/app", "a.b-v1")).toBe("C:/app/.drafts/a.b-v1");
  });
});

describe("草稿内文件路径", () => {
  it("反斜杠归一成正斜杠，但逐段仍要检查", () => {
    expect(draftRelPath("main.mjs")).toBe("main.mjs");
    expect(draftRelPath("lib\\util.mjs")).toBe("lib/util.mjs");
    expect(draftRelPath("  ui/index.html  ")).toBe("ui/index.html");
  });

  it("绝对路径、盘符、`..`、空段、NUL 一律拒（一次写入就能落到草稿根之外）", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "C:/Windows/system32",
      "c:evil.mjs",
      "~/secret",
      "../outside.mjs",
      "a/../../outside.mjs",
      "a//b.mjs",
      "a/./b.mjs",
      "a/\0b",
      "x".repeat(301),
    ]) {
      expect(draftRelPath(bad), `${JSON.stringify(bad)} 应当被拒`).toBeNull();
    }
  });
});

describe("草稿条目归一", () => {
  it("合法清单：id / 名称 / 版本 / 权限面都取到，issue 为空", () => {
    const e = toDraftEntry(
      "a.b-v1",
      "/d/a.b-v1",
      valid({ permissions: { fs: { write: ["$WS/runs"] } } }),
    );
    expect(e).toMatchObject({ id: "a.b", title: "示例", version: "1.0.0", issue: "" });
    expect(e.manifest?.id).toBe("a.b");
    expect(e.permissions).toContain("写 $WS/runs");
  });

  it("合法但该说一句的（没有 activation）进 warnings，不算转正失败", () => {
    const e = toDraftEntry("a.b-v1", "/d/a.b-v1", valid());
    expect(e.issue).toBe("");
    expect(e.warnings.some((w) => w.includes("activation"))).toBe(true);
  });

  it("旧格式给出「格式已废弃」这句人话，而不是一句校验失败", () => {
    const e = toDraftEntry("old-1", "/d/old-1", { format: "uartix-plugin", schemaVersion: 2, id: "a.b" });
    expect(e.issue).toContain("旧版插件格式");
    expect(e.manifest).toBeUndefined();
  });

  it("清单不合法：issue 给出第一条原因，不提供可转正的 manifest", () => {
    const e = toDraftEntry("a.b-v1", "/d/a.b-v1", valid({ version: "not-semver" }));
    expect(e.issue.length).toBeGreaterThan(1);
    expect(e.manifest).toBeUndefined();
  });

  it("清单形状不对也照样列出（坏草稿更该被看见）", () => {
    expect(toDraftEntry("x-1", "/d/x-1", null).issue).toContain("不是对象");
    const noName = toDraftEntry("x-1", "/d/x-1", { id: "x.y" });
    expect(noName.title).toBe("x.y"); // 没 name 就用 id，别渲染空标题
    expect(toDraftEntry("x-1", "/d/x-1", {}).title).toBe("x-1"); // 连 id 都没有才退回目录名
  });
});
