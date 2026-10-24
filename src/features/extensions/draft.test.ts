import { describe, expect, it } from "vitest";
import { draftDirName, draftPathOf, draftRoot, toDraftEntry } from "./draft";

/**
 * P174-B1：草稿态的**路径与归一**判据。
 *
 * 草稿目录是"别人写的东西 + 我们拼的路径"，所以这里守的是两件事：
 * 名字不能把目录带出去，坏清单不能把草稿从列表里弄没。
 */
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

describe("草稿条目归一", () => {
  it("正常清单：id / 名称 / 版本都取到", () => {
    const e = toDraftEntry("a.b-v1", "/d/a.b-v1", { id: "a.b", name: "示例", version: "1.0.0" });
    expect(e).toMatchObject({ id: "a.b", title: "示例", version: "1.0.0", issue: "" });
  });

  it("清单形状不对也照样列出（坏草稿更该被看见）", () => {
    expect(toDraftEntry("x-1", "/d/x-1", null).issue).toContain("不是对象");
    const noName = toDraftEntry("x-1", "/d/x-1", { id: "x.y" });
    expect(noName.title).toBe("x.y"); // 没 name 就用 id，别渲染空标题
    expect(toDraftEntry("x-1", "/d/x-1", {}).title).toBe("x-1"); // 连 id 都没有才退回目录名
  });
});
