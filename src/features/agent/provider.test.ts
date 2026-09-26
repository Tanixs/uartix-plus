import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });

const { toWireMessages, fromRustTurn, invokeAgentProvider, cleanApiKey, cleanBaseUrl } =
  await import("./provider");

// 注意：必须用块体。箭头函数隐式返回 mockReset() 的 mock 本身，
// vitest 会把 beforeEach 返回的函数当 teardown 在测试后调用，触发 unhandled rejection。
// P110-B1：provider 现在要求"档案表里有一对可用的"才发得出请求（旧行为是把空串发给宿主，
// 换一个含义不明的 401 —— 正是 P108 那轮排查花掉一小时的地方）。
// 每个用例都重配一次而不是在文件顶层配：下面的用例里有 `await import("./provider")`，
// 模块重置后它会拿到**新的** aiProfileStore 实例（seed、密钥空），顶层配一次会时灵时不灵。
// 出站形状的断言一条没动，这里只是把"没配好"这个前置条件满足掉。
beforeEach(async () => {
  invoke.mockReset();
  const { patchEditingProvider } = await import("../ai/aiProfileStore");
  patchEditingProvider({ baseUrl: "https://api.deepseek.com", apiKey: "test-key-not-real" });
});

it("wire format: camelCase, optional fields omitted when empty", () => {
  const wire = toWireMessages([
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    { role: "assistant", content: "a", calls: [{ callId: "c1", name: "n", arguments: "{}" }] },
    { role: "tool", content: "r", callId: "c1" },
  ]);
  expect(wire[0]).toEqual({ role: "system", content: "s" });
  expect(wire[0]).not.toHaveProperty("calls");
  expect(wire[2].calls).toHaveLength(1);
  expect(wire[3].callId).toBe("c1");
  expect(wire[3]).not.toHaveProperty("calls");
});

it("rust turn: missing fields normalize to empty strings", () => {
  const turn = fromRustTurn({ content: "hi", calls: [{ name: "t" }, { callId: "c", id: "i", name: "n", arguments: "{\"a\":1}" }] });
  expect(turn.content).toBe("hi");
  expect(turn.calls[0]).toEqual({ callId: "", name: "t", arguments: "" });
  expect(turn.calls[1].callId).toBe("c"); // callId 优先于 id
});

it("P90 B1/B6：reasoning 透传且空值不落字段；images 仅在该条带图时下发", () => {
  expect(fromRustTurn({ content: "c", calls: [], reasoning: "先看现状" }).reasoning).toBe("先看现状");
  expect(fromRustTurn({ content: "c", calls: [] })).not.toHaveProperty("reasoning");
  expect(fromRustTurn({ content: "c", calls: [], reasoning: "" })).not.toHaveProperty("reasoning");
  const wire = toWireMessages([
    { role: "user", content: "u", images: ["data:image/png;base64,AA"] },
    { role: "user", content: "v" },
  ]);
  expect(wire[0].images).toEqual(["data:image/png;base64,AA"]);
  expect(wire[1]).not.toHaveProperty("images");
});

it("provider sends settings and structured tools to ai_agent_turn", async () => {
  invoke.mockResolvedValue({ content: "ok", calls: [] });
  const turn = await invokeAgentProvider([{ role: "user", content: "go" }], [{ name: "x", description: "d", parameters: { type: "object" } }], new AbortController().signal);
  expect(turn.content).toBe("ok");
  expect(invoke).toHaveBeenCalledTimes(1);
  const [cmd, args] = invoke.mock.calls[0];
  expect(cmd).toBe("ai_agent_turn");
  expect(args.messages).toEqual([{ role: "user", content: "go" }]);
  expect(args.tools[0].name).toBe("x");
  expect(typeof args.reqId).toBe("string");
  expect(typeof args.thinking).toBe("boolean"); // P90 B1：思维链开关沿用设置项下发
});

it("abort before invoke: no request sent", async () => {
  const ac = new AbortController();
  ac.abort();
  await expect(invokeAgentProvider([], [], ac.signal)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});

it("abort while in flight: host ai_abort fires immediately with same reqId", async () => {
  const ac = new AbortController();
  let sentReqId = "";
  invoke.mockImplementation((cmd: string, args: { reqId: string }) => {
    if (cmd === "ai_agent_turn") { sentReqId = args.reqId; return new Promise(() => {}); } // 永不 resolve，模拟挂起
    return Promise.resolve(undefined);
  });
  const p = invokeAgentProvider([], [], ac.signal);
  p.catch(() => undefined); // 在途请求被放弃，调用方 loop 依 signal 收敛
  await Promise.resolve();
  ac.abort();
  await vi.waitFor(() => {
    const abortCall = invoke.mock.calls.find((c) => c[0] === "ai_abort");
    expect(abortCall?.[1]).toEqual({ reqId: sentReqId });
  });
});

it("host error propagates without fabricating tool calls", async () => {
  invoke.mockRejectedValue("模型服务 HTTP 401；未执行工具");
  let err: unknown = null;
  await invokeAgentProvider([], [], new AbortController().signal).catch((e) => { err = e; });
  expect(err).toBe("模型服务 HTTP 401；未执行工具");
});

/* ================= P108：密钥的边界清洗 + OpenRouter 预置 =================
 * 起因：用户填 OpenRouter 一直报"API Key 无效或无权限（401）"。查下来 base URL 一直是洗过的，
 * key 却**原样发出**（粘贴带进来的换行/引号直接进 Authorization 头），界面只回一句"Key 无效"——
 * 用户分不清是自己的锅还是软件的锅。下面钉的就是"洗没洗"与"有没有第二份名单"。 */

it("cleanApiKey：剥掉粘贴带进来的空白、换行、引号、反引号", () => {
  expect(cleanApiKey("  sk-or-v1-abc\n")).toBe("sk-or-v1-abc");
  expect(cleanApiKey("`sk-abc`")).toBe("sk-abc");
  expect(cleanApiKey("'sk-abc'")).toBe("sk-abc");
  expect(cleanApiKey("sk-a b\tc")).toBe("sk-abc");
});

it("cleanApiKey：不校验形状——合法 key 里的 - _ . : 一律原样保留", () => {
  // 猜一套白名单（必须 sk-or- 开头、必须 64 位十六进制）会把别家网关的合法 key 直接拒掉，
  // 那是比 401 更难查的失败。所以只剥"复制粘贴必然带进来的那一族字符"。
  const k = "sk-or-v1_0b6b.9ca:245";
  expect(cleanApiKey(k)).toBe(k);
});

it("cleanApiKey：全空白洗成空串（仍是「没填」，不是半个 key）", () => {
  expect(cleanApiKey(" \n\t ")).toBe("");
});

it("两个清洗函数同源：共用同一个字符集，零宽字符也在这族里", () => {
  // 这条不是在测功能，是在测"两处是不是同一个答案"。cleanBaseUrl 只多剥尾斜杠，
  // 这里故意不放斜杠，于是两者必须逐字相等 —— 哪天有人给其中一个加规则，这条就红。
  const dirty = " 'sk-or-v1-abc` \n";
  expect(cleanApiKey(dirty)).toBe(cleanBaseUrl(dirty));
  // JS 的 \s 不含 U+200B，而它恰恰是网页/PDF 粘贴最常带的字符：两者都必须剥掉
  const zwsp = "sk-or\u200b-v1-abc";
  expect(cleanApiKey(zwsp)).toBe("sk-or-v1-abc");
  expect(cleanBaseUrl(zwsp)).toBe("sk-or-v1-abc");
});

it("发送点真的洗了：供应商档案里带换行的 key 不会原样进 Authorization", async () => {
  invoke.mockResolvedValue({ content: "ok", calls: [] });
  // P110-B1：密钥的住处从 Settings 搬进了供应商表 —— 这里换的只是**喂值的入口**，
  // 两条断言一字未松：脏 key 不许原样出境、尾斜杠必须洗掉。
  const profiles = await import("../ai/aiProfileStore");
  profiles.patchEditingProvider({ apiKey: " sk-or-v1-abc\n", baseUrl: "https://openrouter.ai/api/v1/" });
  await invokeAgentProvider([{ role: "user", content: "go" }], [], new AbortController().signal);
  const [, args] = invoke.mock.calls[0];
  expect(args.apiKey).toBe("sk-or-v1-abc");
  expect(args.baseUrl, "尾斜杠也要洗掉：Rust 侧还要再拼 /chat/completions").toBe("https://openrouter.ai/api/v1");
});

it("预置表：base URL 一律不带端点路径、不带尾斜杠（拼重了是 404）", async () => {
  const { AI_PRESETS } = await import("../settings/settingsStore");
  for (const [k, v] of Object.entries(AI_PRESETS)) {
    expect(v.baseUrl, k).not.toMatch(/\/+$/);
    expect(v.baseUrl, `${k} 的 base 里不该写端点路径`).not.toMatch(/\/(chat\/completions|messages|responses)$/);
  }
});

it("P108 OpenRouter 档：base 到 /api/v1、默认模型走 :free、前缀提示给到 sk-or-v1-", async () => {
  const { AI_PRESETS } = await import("../settings/settingsStore");
  expect(AI_PRESETS.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
  expect(AI_PRESETS.openrouter.model.endsWith(":free"), "默认档不该替用户花钱").toBe(true);
  // 输入框原来写死 "sk-…"，而真实前缀是 sk-or-v1- —— 这次"缺前缀"的嫌疑恰恰是这句没帮上忙
  expect(AI_PRESETS.openrouter.keyHint).toBe("sk-or-v1-…");
});

/**
 * 守卫：`src/` 里每一处 `apiKey:` 赋值都必须过 `cleanApiKey(`。
 * 为什么扫源码而不是又写一遍逻辑：这是"把设置里的串发给宿主"那一族动作的边界，
 * 第四个发送点（新的调用方、MCP 代理……）忘了包上就会**静默发坏头**，而走正常路径的测试看不见它。
 * 大小写在这里帮了忙：字段名是 `aiApiKey`（大写 A），不会被 `/apiKey:/` 误伤；
 * 测试夹具里的假 key 属于脱敏测试，随 `.test.ts` 一起排除。
 */
it("守卫：所有 apiKey 发送点都过了 cleanApiKey", async () => {
  // 变量说明符：src 的 tsconfig 不挂 @types/node，写字面量会被 tsc 判"找不到模块"
  const fsSpec = "node:fs";
  const urlSpec = "node:url";
  const { readdirSync, readFileSync } = (await import(fsSpec)) as unknown as {
    readdirSync: (p: string, o?: { withFileTypes?: boolean }) => unknown[];
    readFileSync: (p: string, enc?: string) => string;
  };
  const { fileURLToPath } = (await import(urlSpec)) as unknown as {
    fileURLToPath: (u: string | URL) => string;
  };
  const root = fileURLToPath(new URL("../../", import.meta.url)); // = src/
  const bad: string[] = [];
  /**
   * P110-B1 判据精化（原话"每一处 `apiKey:` 赋值都必须过 `cleanApiKey(`"在档案表成型后
   * 会把**类型声明**也判成发送点 —— `AiProvider.apiKey: string;` 不发任何东西）。
   * 豁免只有两种形状，且都由下面的反向用例钉住边界：接口里的类型标注、空串初始化。
   * 取值发送（`apiKey: p.apiKey`）必须仍然判红，否则这道守卫就白写了。
   */
  const bareApiKeySend = (code: string): boolean => {
    if (!/apiKey:/.test(code) || /cleanApiKey\(/.test(code)) return false;
    if (/^apiKey\??\s*:\s*(string|number|boolean|unknown)\s*;?$/.test(code)) return false;
    if (/^apiKey\s*:\s*""\s*,?$/.test(code)) return false;
    return true;
  };
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }) as {
      name: string;
      isDirectory: () => boolean;
    }[];
    for (const e of entries) {
      const abs = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(abs);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      const rel = abs.slice(root.length);
      readFileSync(abs, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          // 注释里写 `apiKey: st.aiApiKey` 是在讲历史，不是在发送 —— 与 i18n 门"注释里的中文不算"
          // 同一口径（那是写给读代码的人看的）。会被漏掉的只有"整行注释掉的发送点"，那种本来也不发送。
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          if (!bareApiKeySend(code)) return;
          // 两处**角色**豁免，都不是发送点：
          //  - `aiProfileStore.ts`：那张表存的就是用户贴进去的原样（清洗点唯一，在 `aiWireArgs`）；
          //  - `patchEditingProvider({ apiKey: … })`：设置页往表里写值，写的是配置不是 HTTP 头。
          // 判红的能力靠上面的 `bareApiKeySend` 与文件末尾那组反向用例保住，不在这两条豁免里。
          if (/aiProfileStore\.ts$/.test(rel) || /patchEditingProvider\(\s*\{/.test(code)) return;
          bad.push(`${rel}:${i + 1}  ${code}`);
        });
    }
  };
  walk(root);
  expect(bad, `新增发送点请写 apiKey: cleanApiKey(...)：\n${bad.join("\n")}`).toEqual([]);
});

/** 守卫：恢复白名单必须从 AI_PRESETS 派生。手抄一份的后果不是编译错，是**静默丢档位**：
 *  选了新预设、重启软件，预设被退回 deepseek 且 baseUrl 跟着被覆盖。 */
it("守卫：档案表的模板名单从 AI_PRESETS 派生，不手抄", async () => {
  // P110-B1 改钉的位置，**不是删掉的守卫**：这条原来盯的是 `settingsStore.load()` 里那份
  // `aiPreset` 回落白名单（P108 的教训：手抄一份的后果是"选了新档、重启后静默退回 deepseek"）。
  // 那个字段已随档案表成型而删除，同一件事的新住址是 aiProfileStore —— 模板列表与
  // baseUrl→模板的反查都必须派生自 AI_PRESETS，抄一份就会在新加预置时静默丢档。
  const fsSpec = "node:fs";
  const urlSpec = "node:url";
  const { readFileSync } = (await import(fsSpec)) as unknown as {
    readFileSync: (p: string, enc?: string) => string;
  };
  const { fileURLToPath } = (await import(urlSpec)) as unknown as {
    fileURLToPath: (u: string | URL) => string;
  };
  const src = readFileSync(
    fileURLToPath(new URL("../ai/aiProfileStore.ts", import.meta.url)),
    "utf8",
  );
  expect(src, "模板列表要读 AI_PRESETS 的键").toContain("Object.keys(AI_PRESETS)");
  expect(src, "baseUrl 反查模板也要派生，别再抄一份 Record").not.toMatch(/const TPL_[A-Z_]+: Record/);
  expect(src, "不许再手抄一份预置名单").not.toMatch(/\[\s*"openai",\s*"deepseek",/);
});
