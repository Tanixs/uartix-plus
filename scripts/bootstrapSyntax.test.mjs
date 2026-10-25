/**
 * P174-A3：引导脚本的**真语法校验**。
 *
 * 为什么单独一个 .mjs 而不是并进 `src/features/plugins/engine/bootstrap.test.ts`：
 * 这条要用 `node --check` 起子进程，而 `src/` 是浏览器环境、tsconfig 里没有 node 类型，
 * 引 `node:child_process` 会让 `tsc --noEmit` 直接红。**判据该搬家，不该靠 @ts-ignore 糊。**
 *
 * 为什么必须是"跑一遍 node --check"而不是"断言字符串里有某个词"：
 * bootstrap 是拼出来的 200 行字符串，少一个括号、写错一个关键字，TS 编译器完全看不见，
 * 而它只在用户装插件的那一刻炸。那种断言 copy 一份坏代码也照样绿——是本仓 §4-3
 * 记过的"永真判据"。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_FILE, BOOTSTRAP_SOURCE } from "../src/features/plugins/engine/bootstrap.ts";

const dir = mkdtempSync(path.join(tmpdir(), "uartix-boot-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
});

describe("P174-A3 · bootstrap 语法", () => {
  it("能被 node --check 解析为合法 ESM", () => {
    const file = path.join(dir, BOOTSTRAP_FILE);
    writeFileSync(file, BOOTSTRAP_SOURCE, "utf8");
    expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).not.toThrow();
  });

  it("坏掉的源码会被这条判据抓住（门自己不是瞎的）", () => {
    const file = path.join(dir, "broken.mjs");
    // 故意少一个右括号：如果 node --check 抓不到，上面那条用例就是永真的
    writeFileSync(file, "function f() {\n  return 1;\n", "utf8");
    expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).toThrow();
  });
});
