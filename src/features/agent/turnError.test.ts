/**
 * P91 A2/A3：单轮错误解析与重试策略（纯函数）。
 * 钉住三件事：结构化错误解得开、解不开时不甩内部码给用户、降预算阶梯不越界。
 */
import { expect, it } from "vitest";
import { parseTurnError, nextMaxTokens, sleepAbortable, MAX_TOKENS_LADDER } from "./turnError";

const hostErr = (code: string, msg: string, retryable: boolean, shrink: boolean) =>
  new Error(JSON.stringify({ agentError: 1, code, msg, retryable, shrink }));

it("解宿主结构化错误：码/文案/重试策略原样带出", () => {
  const e = parseTurnError(hostErr("provider_error", "模型服务在回复中途返回错误", true, false));
  expect(e).toEqual({ agentError: 1, code: "provider_error", msg: "模型服务在回复中途返回错误", retryable: true, shrink: false, shrinkInput: false });
});

it("P95-H1：输入侧超限单独标志，绝不误走「降输出预算」阶梯", () => {
  const e = parseTurnError(new Error(JSON.stringify({ agentError: 1, code: "context_overflow", msg: "放不下", retryable: false, shrink: false })));
  expect(e.shrinkInput).toBe(true); // 宿主就算漏发该字段，只凭 code 也认得
  expect(e.retryable).toBe(false);
  // shrink=false ⇒ 不该去动 max_tokens（对包体过大毫无作用）
  expect(nextMaxTokens(16384, e.shrink)).toBeNull();
});

it("缺字段按最保守解释：不可重试、不降预算", () => {
  const e = parseTurnError(new Error(JSON.stringify({ agentError: 1, code: "bad_request" })));
  expect(e.code).toBe("bad_request");
  expect(e.retryable).toBe(false);
  expect(e.shrink).toBe(false);
  expect(e.msg).toContain("bad_request"); // 没文案时至少说清是哪类
});

it("非本通道的普通错误：整串当文案，超时/断连类仍判可重试", () => {
  const plain = parseTurnError(new Error("模型连接失败；请检查本机 AI 服务设置"));
  expect(plain.code).toBe("legacy");
  expect(plain.retryable).toBe(true);
  expect(plain.msg).toContain("连接失败");
  // Key 无效这种重试无意义的，绝不判可重试
  expect(parseTurnError(new Error("API Key 无效或无权限（401）")).retryable).toBe(false);
  // 半截 JSON / 非 JSON 前缀都走整串文案分支，不抛异常
  expect(parseTurnError(new Error("{not json")).msg).toBe("{not json");
  expect(parseTurnError("字符串错误").msg).toBe("字符串错误");
});

it("降预算阶梯：16384→8192→4096 后不再降；非截断类不降", () => {
  expect(nextMaxTokens(16384, true)).toBe(8192);
  expect(nextMaxTokens(8192, true)).toBe(4096);
  expect(nextMaxTokens(4096, true)).toBeNull();
  expect(nextMaxTokens(16384, false)).toBeNull();
  // 阶梯末位就是最低档（防止未来加档时把 0 或负数发出去）
  expect(MAX_TOKENS_LADDER[MAX_TOKENS_LADDER.length - 1]).toBe(4096);
});

it("退避等待可被 abort 提前叫醒", async () => {
  const c = new AbortController();
  setTimeout(() => c.abort(), 5);
  expect(await sleepAbortable(5000, c.signal)).toBe(true);
  expect(await sleepAbortable(1, new AbortController().signal)).toBe(false);
  const done = new AbortController();
  done.abort();
  expect(await sleepAbortable(5000, done.signal)).toBe(true);
});
