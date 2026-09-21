/**
 * P95-H3：按内容形态的确定性压缩（纯函数）。
 * 钉住四件事：①压缩是**确定性**的（同输入同输出，模型可复盘）②压完必须说得出"压了什么、多少"
 * ③尾部优先的字段不能从头截（报错在结尾）④认不出的形态原样通过（不乱改数据）。
 */
import { describe, expect, it } from "vitest";
import {
  KEEP_EDGES, KEEP_ITEMS, KEEP_TREE, TEXT_CLAMP, shrinkByShape,
} from "./shrink";
import type { ToolReceipt } from "./types";

const rec = (data: unknown): ToolReceipt => ({ callId: "c1", ok: true, status: "read", data });

describe("shrinkByShape", () => {
  it("时序：留分位数与首尾，点数与丢弃量如实报告，且确定性", () => {
    const t = Array.from({ length: 4000 }, (_, i) => i);
    const v = t.map((i) => (i % 97) - 48);
    const first = shrinkByShape(rec({ series: [{ id: "c1", name: "ax", t, v }], relativeSeconds: true }));
    const row = (first.data as { series: Record<string, unknown>[] }).series[0];
    expect(first.shape).toBe("series");
    expect(row.points).toBe(4000);
    expect((row.head as number[]).length).toBe(KEEP_EDGES);
    expect((row.tail as number[]).length).toBe(KEEP_EDGES);
    expect((row.tail as number[])[KEEP_EDGES - 1]).toBe(v[v.length - 1]); // 尾真的是结尾（旧 preview 只给开头）
    expect(typeof row.p50).toBe("number");
    expect(typeof row.p95).toBe("number");
    expect(first.dropped).toBe(4000 - KEEP_EDGES * 2);
    // 确定性：同一输入两次压缩结果逐字节一致（不能随机采样）
    const again = shrinkByShape(rec({ series: [{ id: "c1", name: "ax", t, v }], relativeSeconds: true }));
    expect(JSON.stringify(again.data)).toBe(JSON.stringify(first.data));
    // 体积必须真的下来了
    expect(JSON.stringify(first.data).length).toBeLessThan(JSON.stringify(v).length);
  });

  it("token 表：只留被覆盖的项并报总数", () => {
    const tokens = Array.from({ length: 39 }, (_, i) => ({
      name: `--t${i}`, value: `#00${i}`, overridden: i < 2,
    }));
    const r = shrinkByShape(rec({ theme: "dark", overlayActive: true, overlay: {}, tokens }));
    const d = r.data as { tokens: { name: string }[]; tokensTotal: number };
    expect(r.shape).toBe("tokens");
    expect(d.tokens.map((x) => x.name)).toEqual(["--t0", "--t1"]);
    expect(d.tokensTotal).toBe(39);
  });

  it("长文本：头尾都留、中间显式承认省略；命令输出这类标注尾部优先", () => {
    const long = "x".repeat(TEXT_CLAMP * 2);
    const r = shrinkByShape(rec({
      command: "build",
      exitCode: 1,
      stdout: "out-" + long,
      stderr: long + "ERR at line 999: boom", // 报错在结尾——从头截就永远看不见它
    }));
    const d = r.data as Record<string, unknown>;
    expect(d.stderrBytes).toBe(long.length + "ERR at line 999: boom".length);
    expect(d.stderrTruncated).toBe(true);
    expect(String(d.stderrNote)).toContain("尾部优先");
    expect(String(d.stderr)).toContain("ERR at line 999: boom");
    expect(String(d.stderr)).toContain("中间省略");
    expect(String(d.stdout)).toContain("out-xxx"); // 头部同样留着
    expect(r.shape).toBe("text");
    // 源头（Rust）已声明的原始体积不被改写，且**与键顺序无关**（红线 A7：一处真相）
    const bigOut = "y".repeat(TEXT_CLAMP * 2);
    const declaredFirst = shrinkByShape(rec({ stdoutBytes: 999999, stdoutTruncated: false, stdout: bigOut }));
    expect((declaredFirst.data as Record<string, unknown>).stdoutBytes).toBe(999999);
    // 源头那份 false 也要翻成 true：这一轮确实又被我们截了一次，说 false 就是把截断藏起来
    expect((declaredFirst.data as Record<string, unknown>).stdoutTruncated).toBe(true);
    const declaredLast = shrinkByShape(rec({ stdout: bigOut, stdoutBytes: 999999, stdoutTruncated: false }));
    expect((declaredLast.data as Record<string, unknown>).stdoutBytes).toBe(999999);
    expect((declaredLast.data as Record<string, unknown>).stdoutTruncated).toBe(true);
    // 源头没声明时我们自己补上（如实是被这里截的）
    const bare = shrinkByShape(rec({ stdout: bigOut }));
    expect((bare.data as Record<string, unknown>).stdoutBytes).toBe(bigOut.length);
    expect((bare.data as Record<string, unknown>).stdoutTruncated).toBe(true);
  });

  it("列表段：超过 KEEP_TREE 就截并回 count/returned/truncated", () => {
    const r = shrinkByShape(rec({ plugins: { items: Array.from({ length: 500 }, (_, i) => `p${i}`) } }));
    const d = r.data as { plugins: { items: string[]; itemsCount: number; itemsReturned: number; itemsTruncated: boolean } };
    expect(d.plugins.items.length).toBe(KEEP_TREE);
    expect(d.plugins.itemsCount).toBe(500);
    expect(d.plugins.itemsReturned).toBe(KEEP_TREE);
    expect(d.plugins.itemsTruncated).toBe(true);
    expect(r.dropped).toBe(500 - KEEP_TREE);
  });

  it("工具自己已报 count/returned 的段不再二次截（KEEP_TREE 不能盖掉工具侧 LIST_CAP）", () => {
    // 40 > KEEP_TREE(30)：若按通用规则收，LIST_CAP.channels=40 会被悄悄降到 30，回执上的 returned 就变成假话
    const channels = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: `ch${i}` }));
    const r = shrinkByShape(rec({ channels, count: 52, returned: 40, truncated: true }));
    const d = r.data as { channels: unknown[] };
    expect(d.channels.length).toBe(40);
    expect(r.dropped).toBe(0);
  });

  it("认不出的形态原样通过（压缩不能偷偷改数据）", () => {
    const data = { path: "D:/a", bytes: 12, ok: true };
    const r = shrinkByShape(rec(data));
    expect(r.dropped).toBe(0);
    expect(r.shape).toBe("object");
    expect(r.data).toEqual(data);
  });

  it("标量与缺省 data 不炸", () => {
    expect(shrinkByShape(rec("short string")).shape).toBe("scalar");
    expect(shrinkByShape({ callId: "c", ok: true, status: "read" }).data).toBeUndefined();
  });

  it("KEEP_ITEMS 用于未知结构的兜底上限（与 KEEP_TREE 同族，登记以免漂移）", () => {
    expect(KEEP_ITEMS).toBeGreaterThan(0);
    expect(KEEP_TREE).toBeGreaterThanOrEqual(KEEP_ITEMS);
  });
});
