/**
 * P88e B1：通用工具单测——白名单解析/归一化边界、DuckDuckGo 结果解析、域门裁决。
 * 不触网、不触盘：invoke 路径在白名单校验处即被拦截。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

const { patch } = await import("../settings/settingsStore");
const invokeMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => undefined as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const { inWhitelist, parseFsRoots, parseDdgResults, generalToolEntries } = await import("./generalTools");
const { toolHarness } = await import("./toolTestKit");
import type { ApprovalGate } from "./toolRegistry";
import type { TaskContext, ToolCall } from "./types";

/**
 * P99a-A7：旧的 `executeGeneralTool` 已经不存在（工具组不再自带派发），这里保留同名同签名
 * 的薄壳，把调用转进**生产用的那条管线** `runToolCall`。旧版本要 mock 六个模块，是因为
 * generalTools 反过来 import 了 agentAdapter；那条边断掉之后，夹具只需要注册表。
 */
function executeGeneralTool(call: ToolCall, ctx: TaskContext, _runId: string, gate: ApprovalGate) {
  return toolHarness(generalToolEntries, { gate })
    .exec(call, { scope: ctx.scope, allowed: ctx.allowed ?? [], runId: ctx.runId, signal: ctx.signal });
}

function ctx(scope: TaskContext["scope"], allowed?: string[]): TaskContext {
  return { source: "local_agent", runId: "r1", signal: new AbortController().signal, scope, ...(allowed ? { allowed } : {}) };
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  callId: "c1",
  name,
  arguments: JSON.stringify(args),
});

/** 不应被触达的门（shell 开关关闭时在 gate 之前就返回） */
const noGate: ApprovalGate & { requests: unknown[] } = {
  requests: [],
  request: () => {
    throw new Error("gate.request 不应被触达");
  },
  takeToken: () => {
    throw new Error("gate.takeToken 不应被触达");
  },
  reject: () => {
    throw new Error("gate.reject 不应被触达");
  },
};

beforeEach(() => {
  patch({ agentFsRoots: "", agentShellEnabled: false });
  // 每个用例重置：跨用例残留的 mockResolvedValue 会让"新建 vs 覆盖"的判定读到上一个文件的状态
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => undefined as unknown);
});

describe("parseFsRoots", () => {
  it("按分号/逗号/换行拆分并去空", () => {
    expect(parseFsRoots("D:\\Projects; D:\\data\nC:\\docs, E:\\")).toEqual([
      "D:\\Projects",
      "D:\\data",
      "C:\\docs",
      "E:\\",
    ]);
    expect(parseFsRoots("  ")).toEqual([]);
  });
});

describe("inWhitelist", () => {
  it("白名单为空一律拒绝", () => {
    expect(inWhitelist("D:\\Projects\\a.txt")).toBe(false);
  });

  it("分隔符边界匹配：前缀目录误配被拒", () => {
    patch({ agentFsRoots: "D:\\Projects" });
    expect(inWhitelist("D:\\Projects\\a.txt")).toBe(true);
    expect(inWhitelist("D:\\ProjectsX\\a.txt")).toBe(false);
    expect(inWhitelist("D:\\Projects")).toBe(true);
  });

  it("正斜杠/盘符大小写/重复分隔符归一化", () => {
    patch({ agentFsRoots: "d:\\projects;d:/data" });
    expect(inWhitelist("d:/projects/sub/b.md")).toBe(true);
    expect(inWhitelist("D:\\DATA\\\\x.json")).toBe(true);
    expect(inWhitelist("C:\\Windows\\system32\\x.dll")).toBe(false);
  });

  it("P99a-A6：`..` 段一律拒（归一化不折叠，前缀匹配会放它过去）", () => {
    patch({ agentFsRoots: "D:\\Projects" });
    expect(inWhitelist("D:\\Projects\\..\\..\\Windows\\a.dll")).toBe(false);
    expect(inWhitelist("D:/Projects/sub/../../outside.txt")).toBe(false);
    expect(inWhitelist("D:\\Projects\\.\\a.txt")).toBe(false);
    expect(inWhitelist("D:\\Projects\\sub\\a.txt")).toBe(true);
  });
});

describe("parseDdgResults", () => {
  it("提取标题/链接/摘要，还原 uddg 重定向与实体", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">Ex&lt;ample&gt; &amp; Co</a>
        <a class="result__snippet" href="#">first &nbsp;snippet</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.org/b">Second</a>
      </div>`;
    const r = parseDdgResults(html);
    expect(r).toEqual([
      { title: "Ex<ample> & Co", url: "https://example.com/a", snippet: "first snippet" },
      { title: "Second", url: "https://example.org/b", snippet: "" },
    ]);
  });
});

describe("executeGeneralTool 域门", () => {
  it("preview 档位拒绝全部通用工具", async () => {
    const r1 = await executeGeneralTool(call("fs_read", { path: "D:\\x" }), ctx("preview"), "r1", noGate);
    const r2 = await executeGeneralTool(call("web_search", { query: "x" }), ctx("preview"), "r1", noGate);
    // P99a-A4：域门在仅预览档回 preview_only（旧实现回 general_tool_requires_custom，
    // 与策略判定的 preview_only 并存成两个码）；历史账本里的旧码仍由 receiptStatusText 认得
    expect(r1.code).toBe("preview_only");
    expect(r2.code).toBe("preview_only");
  });

  it("自定义档位未勾域拒绝", async () => {
    const r1 = await executeGeneralTool(call("fs_list", { path: "D:\\x" }), ctx("custom", ["config"]), "r1", noGate);
    const r2 = await executeGeneralTool(call("web_fetch", { url: "https://example.com" }), ctx("custom", []), "r1", noGate);
    expect(r1.code).toBe("unauthorized_scope");
    expect(r2.code).toBe("unauthorized_scope");
  });

  it("勾了 files 域但白名单为空 → 拒绝且不触盘", async () => {
    const r = await executeGeneralTool(call("fs_read", { path: "D:\\Projects\\a.txt" }), ctx("custom", ["files"]), "r1", noGate);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("path_outside_whitelist");
  });

  it("shell：勾域但总开关关闭 → shell_disabled，且不进审批门", async () => {
    const r = await executeGeneralTool(call("shell_exec", { command: "echo hi" }), ctx("custom", ["shell"]), "r1", noGate);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("shell_disabled");
  });

  it("shell：preview 档位直接拒绝（即使开关开着）", async () => {
    patch({ agentShellEnabled: true });
    const r = await executeGeneralTool(call("shell_exec", { command: "echo hi" }), ctx("preview"), "r1", noGate);
    expect(r.code).toBe("preview_only");
  });
});

/** P94-G4：fs_read 不再把整份文件塞进上下文，而是按字节窗口分页并如实标注 */
describe("fs_read 分页", () => {
  it("走 agent_fs_read_text，回 from/returned/truncated/nextFrom 并给出续读提示", async () => {
    patch({ agentFsRoots: "D:\\w" });
    invokeMock.mockResolvedValueOnce({
      text: "0123456789", from: 0, totalBytes: 4096, hasMore: true, nextFrom: 10,
    });
    const r = await executeGeneralTool(call("fs_read", { path: "D:\\w\\a.txt", from: 0 }), ctx("custom", ["files"]), "r1", noGate);
    expect(r.ok).toBe(true);
    expect(invokeMock.mock.calls[0][0]).toBe("agent_fs_read_text");
    const d = r.data as { content: string; bytes: number; returned: number; truncated: boolean; nextFrom: number; hint: string };
    expect(d.content).toBe("0123456789");
    expect(d.bytes).toBe(4096);
    expect(d.returned).toBe(10);
    expect(d.truncated).toBe(true);
    expect(d.nextFrom).toBe(10);
    expect(d.hint).toContain("from: 10");
  });

  it("读完了 truncated=false 且不给续读提示；maxBytes 超上限被夹到 64KB", async () => {
    patch({ agentFsRoots: "D:\\w" });
    invokeMock.mockResolvedValueOnce({ text: "all", from: 0, totalBytes: 3, hasMore: false, nextFrom: 3 });
    const r = await executeGeneralTool(call("fs_read", { path: "D:\\w\\a.txt", maxBytes: 99_000_000 }), ctx("custom", ["files"]), "r1", noGate);
    const calls = invokeMock.mock.calls;
    expect(calls[calls.length - 1][1]).toMatchObject({ maxBytes: 64 * 1024 });
    expect((r.data as { truncated: boolean; hint?: string }).truncated).toBe(false);
    expect((r.data as { hint?: string }).hint).toBeUndefined();
  });
});

/**
 * P97-I4 `fs_write`：用户要的"软件目录内最大放行"落地成——**新建直接写、覆盖必须逐条批准**，
 * 两者都仍受文件白名单约束（白名单就是"软件目录"的形式）。
 */
describe("fs_write（write 域）", () => {
  /** 记录批准请求；takeToken 由测试决定是否已放行 */
  function fakeGate(hasToken: boolean) {
    const requested: unknown[] = [];
    const gate: ApprovalGate = {
      request: (req) => { requested.push(req); },
      takeToken: () => (hasToken ? { id: "t1" } as never : null),
      reject: () => undefined,
    };
    return { gate, requested };
  }

  it("没勾 write 域就拒（files 域不给写）；preview 一律拒", async () => {
    patch({ agentFsRoots: "D:\\w" });
    const a = await executeGeneralTool(call("fs_write", { path: "D:\\w\\a.txt", content: "hi" }), ctx("custom", ["files"]), "r1", noGate);
    expect(a.code).toBe("unauthorized_scope");
    expect(String((a.data as { hint: string }).hint)).toContain("文件写入");
    const b = await executeGeneralTool(call("fs_write", { path: "D:\\w\\a.txt", content: "hi" }), ctx("preview"), "r1", noGate);
    expect(b.code).toBe("preview_only");
    // 门没过就不该碰盘
    expect(invokeMock.mock.calls.some((c) => c[0] === "agent_fs_write")).toBe(false);
  });

  it("白名单外 / 空内容 / 目录目标都拒，且拒在触盘之前", async () => {
    patch({ agentFsRoots: "D:\\w" });
    const out = await executeGeneralTool(call("fs_write", { path: "D:\\Other\\a.txt", content: "hi" }), ctx("custom", ["write"]), "r1", noGate);
    expect(out.code).toBe("path_outside_whitelist");
    const empty = await executeGeneralTool(call("fs_write", { path: "D:\\w\\a.txt", content: "   " }), ctx("custom", ["write"]), "r1", noGate);
    expect(empty.code).toBe("invalid_args");
    invokeMock.mockResolvedValueOnce({ exists: true, isDir: true, bytes: 0 });
    const dir = await executeGeneralTool(call("fs_write", { path: "D:\\w\\sub", content: "hi" }), ctx("custom", ["write"]), "r1", noGate);
    expect(dir.code).toBe("is_dir");
  });

  it("新建文件直接写成功，不进审批门", async () => {
    patch({ agentFsRoots: "D:\\w" });
    // fs_write 会 stat 两次（assess 判风险 + 写回执说清覆盖了多少），所以用常驻值而不是 Once
    invokeMock.mockResolvedValue({ exists: false, isDir: false, bytes: 0 });
    const gate = fakeGate(false);
    const r = await executeGeneralTool(call("fs_write", { path: "D:\\w\\new.txt", content: "第一行" }), ctx("custom", ["write"]), "r1", gate.gate);
    expect(r.ok).toBe(true);
    expect((r.data as { created?: boolean; chars: number }).created).toBe(true);
    expect(gate.requested).toHaveLength(0);
    const last = invokeMock.mock.calls[invokeMock.mock.calls.length - 1];
    expect(last[0]).toBe("agent_fs_write");
    expect(last[1]).toMatchObject({ path: "D:\\w\\new.txt", content: "第一行" });
    // P99a-A6：白名单根必须**随调用传给 Rust**，由 Rust 侧再判一次（渲染层的门不是唯一的门）
    expect((last[1] as { roots: string[] }).roots).toEqual(["D:\\w"]);
  });

  it("覆盖已有文件先要批准；拿到令牌后才真写，且回执说清覆盖了几个字节", async () => {
    patch({ agentFsRoots: "D:\\w" });
    invokeMock.mockResolvedValue({ exists: true, isDir: false, bytes: 512 });
    const denied = fakeGate(false);
    const r1 = await executeGeneralTool(call("fs_write", { path: "D:\\w\\old.txt", content: "新内容" }), ctx("custom", ["write"]), "r1", denied.gate);
    expect(r1.code).toBe("needs_local_approval");
    expect(denied.requested).toHaveLength(1);
    expect((denied.requested[0] as { effect: string; plan: string }).effect).toBe("irreversible");
    expect(String((denied.requested[0] as { plan: string }).plan)).toContain("512");
    expect(invokeMock.mock.calls.some((c) => c[0] === "agent_fs_write")).toBe(false);

    const okGate = fakeGate(true);
    const r2 = await executeGeneralTool(call("fs_write", { path: "D:\\w\\old.txt", content: "新内容" }), ctx("custom", ["write"]), "r1", okGate.gate);
    expect(r2.ok).toBe(true);
    const d = r2.data as { overwroteBytes?: number; created?: boolean; hint: string };
    expect(d.overwroteBytes).toBe(512);
    expect(d.created).toBeUndefined();
    expect(d.hint).toContain("不可撤销");
  });
});
