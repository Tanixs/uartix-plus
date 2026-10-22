/**
 * P174-A3：引导脚本源码的**结构判据**（字符串层）。
 *
 * 真正的语法校验在 `scripts/bootstrapSyntax.test.mjs`——那条要用 `node --check` 起子进程，
 * 而 `src/` 是浏览器环境、没有 `@types/node`。把两类判据分开，是为了让这条文件
 * 在 tsc 下干净，而不是靠 `@ts-ignore` 糊过去。
 */
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_FILE, BOOTSTRAP_SOURCE } from "./bootstrap";

describe("P174-A3 · bootstrap 源码结构", () => {
  it("文件名是 .mjs（否则 `node` 会按 CJS 解析，`import` 直接报错）", () => {
    expect(BOOTSTRAP_FILE.endsWith(".mjs")).toBe(true);
  });

  it("协议里那几种消息名一个不少（少一种就有一条通路静默失效）", () => {
    for (const t of ["hello", "activate", "call", "dispose", "ready", "result", "emit", "log", "tools", "disposed"]) {
      expect(BOOTSTRAP_SOURCE, t).toContain(`"${t}"`);
    }
  });

  it("token 不匹配时直接丢消息（空闲挂起重启后，旧实例的残留消息真会到）", () => {
    expect(BOOTSTRAP_SOURCE).toContain("if (m.token !== token) return;");
  });

  it("disposer 逆序跑，且单条抛错不阻断后续", () => {
    expect(BOOTSTRAP_SOURCE).toContain("for (let i = disposers.length - 1; i >= 0; i--)");
    expect(BOOTSTRAP_SOURCE).toContain("disposer 抛错");
  });

  it("退出前会杀掉插件起的子进程（否则训练进程会变成孤儿）", () => {
    expect(BOOTSTRAP_SOURCE).toContain("killAll()");
  });

  it("插件目录由 argv 传入，不从 cwd 猜（cwd 可能是工作区）", () => {
    expect(BOOTSTRAP_SOURCE).toContain("process.argv[2]");
  });
});
