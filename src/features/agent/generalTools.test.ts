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
const { inWhitelist, parseFsRoots, parseDdgResults, executeGeneralTool } = await import("./generalTools");
import type { ApprovalGate } from "./agentAdapter";
import type { ToolCall, TaskContext } from "./types";

/* generalTools → agentAdapter 拖入的运行时副作用 store：一律 mock，避免真实总线/定时器 */
vi.mock("../ai/appActions", () => ({ runAppAction: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn(), previewCss: vi.fn(() => "") }));
vi.mock("../serial/serialStore", () => ({
  getSnapshot: () => ({ status: "disconnected" }),
  subscribe: () => () => {},
}));
vi.mock("../operator/operatorStore", () => ({ getSnapshot: () => ({ pkg: null }) }));
vi.mock("../plot/plotStore", () => ({
  getSnapshot: () => ({ channels: [] }),
  getChanData: () => ({ t: [], v: [] }),
  timeOrigin: () => 1000,
  sampleRate: () => 50,
}));
vi.mock("../plot/dataLease", () => ({ acquireDataLease: vi.fn(async () => true), hasDataLease: () => false }));

function ctx(scope: TaskContext["scope"], allowed?: string[]): TaskContext {
  return { source: "local_agent", runId: "r1", signal: new AbortController().signal, scope, ...(allowed ? { allowed } : {}) };
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  callId: "c1",
  name,
  arguments: JSON.stringify(args),
});

/** 不应被触达的门（shell 开关关闭时在 gate 之前就返回） */
const noGate: ApprovalGate = {
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
    expect(r1.code).toBe("general_tool_requires_custom");
    expect(r2.code).toBe("general_tool_requires_custom");
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
    expect(r.code).toBe("general_tool_requires_custom");
  });
});
