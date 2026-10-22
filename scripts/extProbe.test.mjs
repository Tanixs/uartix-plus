/**
 * P174-A4：**第一次端到端**——真起一个 Node 进程，握手、激活、收日志、优雅退出。
 *
 * 为什么这条必须存在：A3 交付时只能证明「代码路径齐了、语法合法」，证明不了
 * 「引导脚本真的能跟插件对上话」。而这条链上任何一环错（字段名不一致、token 没回带、
 * 事件循环被 readline 占死）都会让"装完插件没反应"，且没有任何报错可看。
 *
 * 这里用真 `spawn`，不是 mock：判据是**子进程的 stdout 上真的出现了那句话**。
 * 参数集与 `buildHostNodeArgs` 保持一致（`--permission` / `--allow-fs-read=*` /
 * `--allow-child-process`），因为权限模型下**连 import node:child_process 都需要那个开关**。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_SOURCE } from "../src/features/extensions/bootstrap.ts";
import { encodeMessage } from "../src/features/extensions/protocol.ts";


/**
 * 探测本机 node 认哪个权限开关：Node 20 只有 `--experimental-permission`，
 * 22 起才把 `--permission` 转正。CI 跑的是 node 20，本机可能是 22 —— 不探测就是"本机绿、CI 红"。
 */
function permFlag() {
  for (const f of ["--permission", "--experimental-permission"]) {
    try {
      execFileSync(process.execPath, [f, "-e", ""], { stdio: "pipe" });
      return f;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const TOKEN = "probe-token-1";
const PERM = permFlag() || "--permission";
const dir = mkdtempSync(path.join(tmpdir(), "uartix-ext-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
});

/** 造一个最小插件：activate 里打一行日志，dispose 里再打一行。 */
function writePlugin(pluginDir) {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(pluginDir, "main.mjs"),
    [
      "export async function activate(ctx) {",
      '  ctx.log.info("hello from probe");',
      '  ctx.onDispose(() => ctx.log.info("bye from probe"));',
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(pluginDir, "extension.json"),
    JSON.stringify({ format: "uartix-extension", schemaVersion: 3, id: "probe.hello", version: "1.0.0", name: "probe", main: "main.mjs" }),
    "utf8",
  );
}

/**
 * 起宿主并跑完一轮：hello → activate → 收日志 → dispose → 等退出。
 * 返回收到的所有消息与退出码，供断言。
 */
function runProbe(pluginDir, bootPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [PERM, "--allow-fs-read=*", "--allow-child-process", bootPath, pluginDir],
      { cwd: pluginDir, windowsHide: true },
    );
    const messages = [];
    let buf = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        reject(new Error(`超时；已收到 ${JSON.stringify(messages).slice(0, 500)}`));
      }
    }, 12_000);

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ messages, code });
    };

    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        messages.push(m);

        if (m.t === "ready") {
          // 握手成功 → 让它激活
          child.stdin.write(encodeMessage({ t: "activate", token: TOKEN }) + "\n");
        } else if (m.t === "log" && m.msg === "hello from probe") {
          // 插件跑起来了 → 走优雅退出，验证 disposer
          child.stdin.write(encodeMessage({ t: "dispose", token: TOKEN, reason: "reload" }) + "\n");
        } else if (m.t === "disposed") {
          // 引导脚本会自己退；给它一点时间
        }
      }
    });
    child.stderr.on("data", (d) => messages.push({ t: "__stderr", line: d.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", (code) => finish(code));

    child.stdin.write(
      encodeMessage({
        t: "hello",
        v: 1,
        token: TOKEN,
        workspace: pluginDir,
        appDir: pluginDir,
        dev: true,
      }) + "\n",
    );
  });
}

describe("P174-A4 · 端到端（真进程）", () => {
  it("握手 → 激活 → 收日志 → 优雅退出，全链路走通", async () => {
    const pluginDir = path.join(dir, "plug");
    const bootPath = path.join(dir, "bootstrap.mjs");
    writeFileSync(bootPath, BOOTSTRAP_SOURCE, "utf8");
    writePlugin(pluginDir);
    // 插件目录要先存在（writePlugin 之前 mkdtemp 只建了父目录）
    expect(pluginDir.length).toBeGreaterThan(0);

    const { messages } = await runProbe(pluginDir, bootPath);

    const ready = messages.find((m) => m.t === "ready");
    expect(ready, `没收到 ready：${JSON.stringify(messages).slice(0, 600)}`).toBeTruthy();
    expect(ready.token).toBe(TOKEN); // token 必须回带（空闲挂起重启后靠它挡旧消息）
    expect(ready.v).toBe(1);

    const hello = messages.find((m) => m.t === "log" && m.msg === "hello from probe");
    expect(hello, "插件 activate 里的日志没回来").toBeTruthy();
    expect(hello.level).toBe("info");

    const bye = messages.find((m) => m.t === "log" && m.msg === "bye from probe");
    expect(bye, "disposer 没跑（逆序清理这条链断了）").toBeTruthy();

    expect(messages.some((m) => m.t === "disposed")).toBe(true);
  }, 20_000);

  it("token 不对的指令被丢弃（不执行、不回报）", async () => {
    const pluginDir = path.join(dir, "plug2");
    const bootPath = path.join(dir, "bootstrap2.mjs");
    writeFileSync(bootPath, BOOTSTRAP_SOURCE, "utf8");
    writePlugin(pluginDir);

    const { messages } = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [PERM, "--allow-fs-read=*", bootPath, pluginDir], {
        cwd: pluginDir,
        windowsHide: true,
      });
      const got = [];
      let buf = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        resolve({ messages: got });
      }, 2500);
      child.stdout.on("data", (d) => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            got.push(JSON.parse(line));
          } catch {
            /* 忽略非 JSON 行 */
          }
        }
      });
      child.on("error", reject);
      child.stdin.write(encodeMessage({ t: "hello", v: 1, token: TOKEN, workspace: pluginDir, appDir: pluginDir, dev: true }) + "\n");
      // 故意用错的 token 让它激活
      setTimeout(() => {
        child.stdin.write(encodeMessage({ t: "activate", token: "wrong" }) + "\n");
      }, 300);
      setTimeout(() => {
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        resolve({ messages: got });
      }, 2000);
    });

    expect(messages.some((m) => m.t === "ready")).toBe(true);
    // 错 token 的 activate 不许生效
    expect(messages.some((m) => m.t === "log" && m.msg === "hello from probe")).toBe(false);
  }, 20_000);
});
