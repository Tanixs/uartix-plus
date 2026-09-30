/**
 * P121-C 的教训（#93 真输入验证挖出来的）：字节带一直接不到拖拽，原因是
 * 区域声明写成 `"sendspec,sendfield"`，而匹配是按空白切分的 —— 整串被当成一个 token，
 * kind 永远对不上。后果不是报错，是**静默没有落点**：界面看起来"拖了没反应"。
 *
 * 这种坑纯函数测试全绿（dropIndexAt / moveTargetIndex 都只管算落点，不管区域认不认），
 * 只在真 DOM 上暴露。所以把解析抽成 `parseKinds` 单独钉住：两种分隔符都认，
 * 以后谁再写错一种，区域照样收得到拖拽。
 */
import { describe, expect, it } from "vitest";
import { parseKinds } from "./pointerDrag";

describe("parseKinds（拖拽区域的 kind 列表）", () => {
  it("逗号与空格是同一回事 —— 钉住那个把拖拽整条功能弄哑的坑", () => {
    expect(parseKinds("sendspec,sendfield")).toEqual(["sendspec", "sendfield"]);
    expect(parseKinds("sendspec sendfield")).toEqual(["sendspec", "sendfield"]);
    expect(parseKinds("sendspec ,sendfield")).toEqual(parseKinds("sendspec sendfield"));
  });

  it("多余分隔符不留空 token（空 token 会匹配到不该匹配的东西）", () => {
    expect(parseKinds("  a ,, b  ")).toEqual(["a", "b"]);
    expect(parseKinds("")).toEqual([]);
    expect(parseKinds(",,,")).toEqual([]);
  });

  it("单个 kind 与全应用现有写法不变", () => {
    expect(parseKinds("vs-field")).toEqual(["vs-field"]);
    expect(parseKinds("vs-widget vs-cmd vs-field")).toEqual(["vs-widget", "vs-cmd", "vs-field"]);
  });
});
