/**
 * P138-B：落盘侧的两把尺与那个占位形状。
 * 逻辑全住在 `context.ts`（纯函数），这里钉得住；渲染层只画结果（§8-48）。
 */
import { describe, expect, it } from "vitest";
import {
  droppedPlaceholder,
  excerptForStorage,
  readDroppedPlaceholder,
  storageChars,
} from "./context";

/** 分配器与调用点的额度无关，给它一个自己的上限来验形状 */
const CAP = 96_000;
const longBody = (tag: string, n = 200_000) => `${tag}HEAD`.repeat(20) + "x".repeat(n) + `${tag}TAIL`.repeat(20);

describe("excerptForStorage：三档要各归各", () => {
  it("没超限 ⇒ 原样通过，且返回的是**同一个引用**（不许悄悄复制一份新的骗人说内容没变）", () => {
    const data = { note: "短", rows: [1, 2, 3] };
    const r = excerptForStorage(data, CAP);
    expect(r.mode).toBe("kept");
    expect(r.omitted).toBe(0);
    expect(r.data).toBe(data);
  });

  it("只削超长字符串叶子：结构、短字段与计数都留着，削完有界", () => {
    const data = { a: longBody("A"), b: longBody("B"), c: longBody("C"), count: 7, note: "末行统计在这" };
    const r = excerptForStorage(data, CAP);
    expect(r.mode).toBe("excerpt");
    expect(r.omitted).toBeGreaterThan(0);
    expect(storageChars(r.data)).toBeLessThanOrEqual(CAP);
    const out = r.data as typeof data;
    // 摘录必须是原文的逐字头尾——一句"重写的摘要"读起来像事实，实际谁都反驳不了（§8-41）
    expect((out.a as string).startsWith("AHEAD")).toBe(true);
    expect((out.a as string).endsWith("ATAIL")).toBe(true);
    expect(out.a).toContain("摘录：中间省略");
    expect(out.note).toBe("末行统计在这");
    expect(out.count).toBe(7);
  });

  it("顶层是长字符串（没有字段可挑）⇒ 整条摘录，仍是字符串", () => {
    const r = excerptForStorage(longBody("S"), 8_000);
    expect(r.mode).toBe("excerpt");
    expect(typeof r.data).toBe("string");
    expect((r.data as string).length).toBeLessThanOrEqual(8_000 + 60);
  });

  it("削不动的结构 ⇒ 明确退回 dropped，并交出原文多大", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ i }));
    const data = { rows };
    const r = excerptForStorage(data, CAP);
    expect(r.mode).toBe("dropped");
    expect(r.data).toBeNull();
    expect(r.omitted).toBe(storageChars(data));
  });

  it("原始 data 不可序列化时不抛（storageChars 兜住，落盘不能因为一条怪回执就整本写不进去）", () => {
    const weird = { big: 10n }; // BigInt：JSON.stringify 直接抛
    expect(storageChars(weird)).toBe(0);
    expect(() => excerptForStorage(weird, 10)).not.toThrow();
  });
});

describe("落盘整份省略的那个占位", () => {
  it("写读往返一致", () => {
    expect(readDroppedPlaceholder(droppedPlaceholder(9_000))).toBe(9_000);
  });

  it("不把工具的正常返回误判成占位（这条是本批最容易写错的地方）", () => {
    // `fs_read` 的返回就同时带 truncated 与 bytes：那是一次**完整存在**的分页读取，
    // 若判别键撞名，卡片与导出会对着一份好数据说"正文已被落盘抹掉"——假话还伪装成格式问题。
    const fsRead = { content: "abc", from: 0, bytes: 65536, returned: 3, truncated: true, nextFrom: 65536 };
    expect(readDroppedPlaceholder(fsRead)).toBeNull();
    expect(readDroppedPlaceholder(null)).toBeNull();
    expect(readDroppedPlaceholder([1, 2])).toBeNull();
    expect(readDroppedPlaceholder({ atRestOmitted: true })).toBeNull();
  });
});
