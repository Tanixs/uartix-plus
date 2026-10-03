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
const { inWhitelist, parseFsRoots, parseDdgResults, generalToolEntries, expandRepoCheck, resolveRepoCheck, validRepoTestPath, REPO_CHECKS } = await import("./generalTools");
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
  patch({ agentFsRoots: "", agentShellEnabled: false, agentRepoCheck: false });
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

/**
 * P109-D：fs_grep / fs_glob / fs_edit。这三支配角的是"它到底能不能自己翻代码"，
 * 所以判据集中在两件事：**门在触盘之前**（invoke 一次都不该被调），以及
 * Rust 回的 not_found / ambiguous 是**决策信息**，不能被糊成一条 error。
 */
describe("P109-D · fs_grep / fs_glob / fs_edit", () => {
  it("白名单为空 ⇒ 三支都在触盘之前被拒，且回的是可操作的话", async () => {
    patch({ agentFsRoots: "" });
    invokeMock.mockClear();
    for (const [name, args] of [
      ["fs_grep", { root: "D:\\w", needle: "x" }],
      ["fs_glob", { root: "D:\\w", needle: ".rs" }],
      ["fs_edit", { path: "D:\\w\\a.ts", old_text: "a", new_text: "b" }],
    ] as [string, Record<string, unknown>][]) {
      const r = await executeGeneralTool(call(name, args), ctx("custom", ["files", "write"]), "r1", noGate);
      expect(r.ok, `${name} 不该在白名单为空时放行`).toBe(false);
      expect(r.code).toBe("path_outside_whitelist");
      expect(JSON.stringify(r)).toContain("白名单");
    }
    expect(invokeMock, "白名单判定必须在 invoke 之前，否则门只存在于渲染层").not.toHaveBeenCalled();
  });

  it("fs_grep 把 truncated / skipped 如实带回去（「没找到」与「跳过了二进制」是两件事）", async () => {
    patch({ agentFsRoots: "D:\\w" });
    invokeMock.mockResolvedValue({
      mode: "content", needle: "x", scanned: 4000, matches: [{ path: "D:\\w\\a.ts", line: 3, text: "const x = 1" }],
      truncated: true, skipped: { binary: 37, oversized: 2 },
    });
    const r = await executeGeneralTool(call("fs_grep", { root: "D:\\w", needle: "x" }), ctx("custom", ["files"]), "r1", noGate);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ count: 1, truncated: true, skipped: { binary: 37, oversized: 2 } });
    expect(JSON.stringify(r.data)).toContain("收窄");
  });

  it("editFailure：not_found / ambiguous 落成 not_executed，其它才算 error", async () => {
    const { editFailure } = await import("./generalTools");
    for (const [msg, code] of [
      ["Error: not_found: 文件里没有这段原文", "not_found"],
      ["Error: ambiguous: 这段原文命中 3 处", "ambiguous"],
      ["path_outside_whitelist", "path_outside_whitelist"],
    ] as [string, string][]) {
      const r = editFailure("c1", msg);
      expect(r.status, msg).toBe("not_executed");
      expect(r.code).toBe(code);
      expect(r.ok).toBe(false);
    }
    const other = editFailure("c1", "Error: 写入失败：disk full");
    expect(other.status).toBe("error");
    expect(JSON.stringify(other)).toContain("disk full");
  });

  it("fs_edit 走的是逐条批准（覆盖已有内容是 §8-44 四类之一），且门在批准卡之前", () => {
    const e = generalToolEntries.find((x) => x.name === "fs_edit");
    expect(e?.effect).toBe("irreversible");
    expect(e?.domain).toBe("write");
    // assess 存在＝白名单/参数在"弹批准卡"之前就能拒掉；缺它就会出现
    // "用户点了允许，才发现路径越界"那种骗人签的卡
    expect(typeof e?.assess, "fs_edit 必须有 assess，否则拒绝发生在批准之后").toBe("function");
  });
});

/**
 * P133-A · `repo_check`：命令表是宿主常量。
 *
 * 这批的全部理由就是"能跑校验 ≠ 能跑任何东西"，所以钉的是**参数面拿不到命令**这件事。
 * 没有钉"跑起来能过"——那取决于机器上装没装 node/cargo，不该由单测去赌（真跑通在验收里做一次）。
 */
describe("repo_check 命令表闭合", () => {
  const ROOT = "D:\\Projects\\repo";

  function fakeGate(hasToken: boolean) {
    const requested: unknown[] = [];
    const gate: ApprovalGate = {
      request: (req) => { requested.push(req); },
      takeToken: () => (hasToken ? { id: "t1" } as never : null),
      reject: () => undefined,
    };
    return { gate, requested };
  }

  it("参数面只有 check/root/testPath——能扩这张表的只有源码", () => {
    const e = generalToolEntries.find((x) => x.name === "repo_check")!;
    expect(Object.keys(e.parameters!.properties as Record<string, unknown>).sort()).toEqual([
      "check", "root", "testPath",
    ]);
    expect(JSON.stringify(e.parameters)).not.toContain('"command"');
    // 表就是那五档，多一档都得改这里（写死而不是 Object.keys，是为了让"有人偷偷加一档"必须过断言）
    expect(Object.keys(REPO_CHECKS)).toEqual(["gates", "types", "tests", "one_test", "rust"]);
  });

  it("表外的一律 unknown_check，并把允许的那几档回给模型", () => {
    // 两个变体的判别键是 `err`，所以这里按"两边都可能有的形状"读，不做单侧窄化
    const p = expandRepoCheck("rm_rf", ROOT) as { err?: string; extra?: { allowed: string[] } };
    expect(p.err).toBe("unknown_check");
    expect(p.extra!.allowed).toEqual(["gates", "types", "tests", "one_test", "rust"]);
  });

  it("argv 由表拼装：程序名裸着、脚本绝对化到根之下、cargo 那档换子目录", () => {
    const p = expandRepoCheck("gates", ROOT) as { argv: string[]; cwd: string; timeoutSecs: number };
    expect(p.argv).toEqual(["node", "D:\\Projects\\repo\\.tools\\run-gates.mjs"]);
    expect(p.cwd).toBe(ROOT);
    expect(p.timeoutSecs).toBeGreaterThan(10); // 10s 是 shell 那一档的预算，门禁必然被掐死在里面
    const c = expandRepoCheck("rust", ROOT) as { argv: string[]; cwd: string };
    expect(c.argv).toEqual(["cargo", "test", "--lib"]);
    // cwd 走子目录而不是 --manifest-path：少一格"可以被拼"的东西
    expect(c.cwd).toBe("D:\\Projects\\repo\\src-tauri");
  });

  it("testPath 只给 one_test 用，越界与形状不符都拒", () => {
    expect("err" in expandRepoCheck("gates", ROOT, "src/a.test.ts")).toBe(true);
    for (const bad of ["../src/a.test.ts", "src/../src/a.test.ts", "src/a.test.txt", "C:\\repo\\a.test.ts", "src\\a.test.ts", ""]) {
      expect(validRepoTestPath(bad), bad).toBe(false);
    }
    expect(validRepoTestPath("src/features/agent/loop.test.ts")).toBe(true);
    expect(validRepoTestPath("scripts/gateWiring.test.mjs")).toBe(true);
    const p = expandRepoCheck("one_test", ROOT, "src/x.test.ts") as { argv: string[] };
    expect(p.argv[p.argv.length - 1]).toBe("src/x.test.ts");
    expect("err" in expandRepoCheck("one_test", ROOT)).toBe(true); // 缺 testPath 也拒，不猜一个
  });

  it("白名单为空 ⇒ 校验也关：它借的是同一条文件门", () => {
    expect(resolveRepoCheck({ check: "gates" }, [])).toMatchObject({ err: "files_whitelist_empty" });
  });

  it("多根必须点名 root，点名也只能点白名单里那一个", () => {
    expect(resolveRepoCheck({ check: "gates" }, ["D:\\a", "D:\\b"])).toMatchObject({ err: "root_required" });
    expect(resolveRepoCheck({ check: "gates", root: "D:\\c" }, ["D:\\a"])).toMatchObject({
      err: "path_outside_whitelist",
    });
    expect("argv" in resolveRepoCheck({ check: "gates", root: "D:\\a" }, ["D:\\a"])).toBe(true);
  });

  it("总开关关着 → repo_check_disabled，且不进审批门（与 shell_disabled 同一条理由）", async () => {
    patch({ agentFsRoots: ROOT, agentRepoCheck: false });
    const r = await executeGeneralTool(call("repo_check", { check: "gates" }), ctx("custom", ["files"]), "r1", noGate);
    expect(r.code).toBe("repo_check_disabled");
  });

  it("没勾 files 域进不去；preview 一律 preview_only", async () => {
    patch({ agentFsRoots: ROOT, agentRepoCheck: true });
    const a = await executeGeneralTool(call("repo_check", { check: "gates" }), ctx("custom", ["config"]), "r1", noGate);
    expect(a.code).toBe("unauthorized_scope");
    const b = await executeGeneralTool(call("repo_check", { check: "gates" }), ctx("preview"), "r1", noGate);
    expect(b.code).toBe("preview_only");
  });

  it("开开关后先弹批准卡，卡上写的是展开后的 argv，一次 invoke 都没发生", async () => {
    patch({ agentFsRoots: ROOT, agentRepoCheck: true });
    const g = fakeGate(false);
    const r = await executeGeneralTool(call("repo_check", { check: "types" }), ctx("custom", ["files"]), "r1", g.gate);
    expect(r.code).toBe("needs_local_approval");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(g.requested).toHaveLength(1);
    const plan = JSON.stringify(g.requested[0]);
    expect(plan).toContain("node_modules"); // 用户批的是这条命令，不是"我要跑个检查"这句话
    expect(plan).toContain("--noEmit");
  });

  it("批准后无 shell 直启：argv 原样下发、roots 随调用交给 Rust 再判一次", async () => {
    patch({ agentFsRoots: ROOT, agentRepoCheck: true });
    const g = fakeGate(true);
    invokeMock.mockResolvedValueOnce({
      exitCode: 1, timedOut: false, stdout: "FAIL gate 7", stderr: "",
      stdoutBytes: 10, stdoutTruncated: false, stderrBytes: 0, stderrTruncated: false,
    });
    const r = await executeGeneralTool(call("repo_check", { check: "gates" }), ctx("custom", ["files"]), "r1", g.gate);
    const last = invokeMock.mock.calls[invokeMock.mock.calls.length - 1];
    expect(last[0]).toBe("agent_repo_check");
    expect(last[1]).toMatchObject({
      argv: ["node", "D:\\Projects\\repo\\.tools\\run-gates.mjs"],
      cwd: ROOT,
      roots: [ROOT],
    });
    // 门禁红了是一次**观察**，不是工具故障：ok:true + passed:false，回执里带着真退出码
    expect(r.ok).toBe(true);
    const d = r.data as { passed: boolean; exitCode: number; covers: string };
    expect(d.passed).toBe(false);
    expect(d.exitCode).toBe(1);
    expect(d.covers).toContain("14");
  });

  it("表里没有 git/网络/包管理器：那句「AI 不 push」是有机制的，不是空头承诺", () => {
    for (const [id, c] of Object.entries(REPO_CHECKS)) {
      expect(["node", "cargo"], `${id} 的程序名越界了`).toContain(c.program);
      const flat = [c.script ?? "", ...(c.args ?? [])].join(" ").toLowerCase();
      for (const banned of ["git", "curl", "npm", "npx", "pnpm", "http", "ssh"]) {
        expect(flat, `${id} 的 argv 里出现了 ${banned}`).not.toContain(banned);
      }
    }
  });

  it("exitCode 0 且没超时才算 passed", async () => {
    patch({ agentFsRoots: ROOT, agentRepoCheck: true });
    const g = fakeGate(true);
    invokeMock.mockResolvedValueOnce({
      exitCode: 0, timedOut: true, stdout: "", stderr: "killed",
      stdoutBytes: 0, stdoutTruncated: false, stderrBytes: 6, stderrTruncated: false,
    });
    const r = await executeGeneralTool(call("repo_check", { check: "tests" }), ctx("custom", ["files"]), "r1", g.gate);
    expect((r.data as { passed: boolean }).passed).toBe(false);
  });
});

