import { describe, expect, it } from "vitest";
import {
  TOOL_DEFS,
  compactFrame,
  countStatuses,
  flattenResults,
  mcpServerConfig,
  pageFrames,
  summarizeRun,
} from "./mcpTools";

describe("mcpServerConfig", () => {
  it("node 命令 + CLI 路径；空路径给占位符", () => {
    const s = mcpServerConfig("D:\\x\\uartix-mcp.cjs");
    expect(s).toContain('"uartix"');
    expect(s).toContain("D:\\\\x\\\\uartix-mcp.cjs");
    expect(mcpServerConfig(" ")).toContain("<uartix-mcp.cjs");
  });
});

describe("TOOL_DEFS", () => {
  it("8 个工具且名字唯一、schema 皆为 object", () => {
    expect(TOOL_DEFS.length).toBe(8);
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(8);
    for (const t of TOOL_DEFS) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(8);
    }
  });
  it("send 必填 text；run_sequence 必填 json", () => {
    expect(TOOL_DEFS.find((t) => t.name === "send")?.inputSchema.required).toEqual(["text"]);
    expect(TOOL_DEFS.find((t) => t.name === "run_sequence")?.inputSchema.required).toEqual([
      "json",
    ]);
  });
});

describe("pageFrames（get_frames 分页，P66-1）", () => {
  const ring = Array.from({ length: 10 }, (_, i) => ({ seq: i, v: i })); // seq 0..9 升序，9 最新
  it("首页：取最新 count 条，新→旧，nextBeforeSeq=页内最旧 seq", () => {
    const r = pageFrames(ring, 4, null);
    expect(r.page.map((f) => f.seq)).toEqual([9, 8, 7, 6]);
    expect(r.nextBeforeSeq).toBe(6);
    expect(r.hasMore).toBe(true);
  });
  it("游标翻页：只含 seq < beforeSeq，翻到头 hasMore=false", () => {
    const p1 = pageFrames(ring, 4, null);
    const p2 = pageFrames(ring, 4, p1.nextBeforeSeq);
    expect(p2.page.map((f) => f.seq)).toEqual([5, 4, 3, 2]);
    expect(p2.hasMore).toBe(true);
    const p3 = pageFrames(ring, 4, p2.nextBeforeSeq);
    expect(p3.page.map((f) => f.seq)).toEqual([1, 0]);
    expect(p3.nextBeforeSeq).toBe(0);
    expect(p3.hasMore).toBe(false);
  });
  it("游标低于环形最旧帧：返回剩余尾部；游标=0：空页", () => {
    const tail = pageFrames(ring, 4, 3);
    expect(tail.page.map((f) => f.seq)).toEqual([2, 1, 0]);
    expect(tail.hasMore).toBe(false);
    const empty = pageFrames(ring, 4, 0);
    expect(empty.page).toEqual([]);
    expect(empty.nextBeforeSeq).toBeNull();
    expect(empty.hasMore).toBe(false);
  });
  it("count 钳制：0/负数回退默认 32，>256 封顶", () => {
    expect(pageFrames(ring, 0, null).page).toHaveLength(10); // 默认 32 > 环形 10
    expect(pageFrames(ring, 9999, null).page).toHaveLength(10);
    const big = Array.from({ length: 300 }, (_, i) => ({ seq: i }));
    expect(pageFrames(big, 9999, null).page).toHaveLength(256);
  });
});

describe("compactFrame", () => {
  it("字段名→值/文本，hex 截断", () => {
    const out = compactFrame({
      tplName: "惯导",
      tsMs: 123,
      seq: 7,
      valid: true,
      error: null,
      fields: [
        { name: "roll", value: 1.5, text: null },
        { name: "txt", value: 0, text: "OK" },
      ],
      bytes: new Uint8Array(70).fill(0xab),
    });
    expect(out).toMatchObject({ tpl: "惯导", valid: true, fields: { roll: 1.5, txt: "OK" } });
    const hex = out.hex as string;
    expect(hex).toContain("…(共70B)");
    expect(hex.split(" ").filter((s) => s !== "…(共70B)")).toHaveLength(64);
  });
  it("无字节/无错误不出键", () => {
    const out = compactFrame({
      tplName: "t",
      tsMs: 1,
      seq: 0,
      valid: false,
      error: "校验和不匹配",
      fields: [],
    });
    expect("hex" in out).toBe(false);
    expect(out.err).toBe("校验和不匹配");
  });
});

describe("flattenResults / countStatuses / summarizeRun", () => {
  const tree = [
    {
      kind: "send",
      label: "s1",
      status: "pass",
      durationMs: 3,
      detail: "ok",
      children: [
        { kind: "wait", label: "w1", status: "timeout", durationMs: 100, detail: "超时" },
        { kind: "assertVar", label: "a1", status: "pass", durationMs: 1, detail: "" },
      ],
    },
    { kind: "note", label: "n1", status: "skipped", durationMs: 0, detail: "" },
  ];
  it("拍平保留深度与顺序", () => {
    const flat = flattenResults(tree);
    expect(flat).toHaveLength(4);
    expect(flat.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
    expect(flat[1].kind).toBe("wait");
  });
  it("cap 截断", () => {
    expect(flattenResults(tree, 0, 2)).toHaveLength(2);
  });
  it("计数：pass=2 fail=1 other=1", () => {
    expect(countStatuses(tree)).toEqual({ pass: 2, fail: 1, other: 1 });
  });
  it("summarizeRun 汇总", () => {
    const s = summarizeRun({
      suiteName: "冒烟",
      status: "failed",
      startedAt: 1000,
      finishedAt: 1500,
      steps: tree,
    });
    expect(s).toMatchObject({
      suite: "冒烟",
      status: "failed",
      durationMs: 500,
      pass: 2,
      fail: 1,
      other: 1,
    });
    expect((s.steps as unknown[]).length).toBe(4);
  });
});
