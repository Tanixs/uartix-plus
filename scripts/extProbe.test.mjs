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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_SOURCE } from "../src/features/extensions/bootstrap.ts";
import { encodeMessage } from "../src/features/extensions/protocol.ts";
import { validateExtension } from "../src/features/extensions/manifest.ts";


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

  it("token 不对的指令被丢弃（不执行、不回报）", async () => {    const pluginDir = path.join(dir, "plug2");
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

/**
 * P174-A6：**仓库里那个示例包**，用它自己跑一遍。
 *
 * 前两条钉的是"引导脚本与一个最小插件对得上"，这一条钉的是"`examples/extensions/uartix.hello`
 * 这个真的会被用户拿去装的包，能被引导脚本跑起来"。两者不是同一件事：
 * 示例包是磁盘上的真文件，它的清单可能过期、入口可能写错，而那种错误在面板上表现为
 * "进程起来了但一直没日志、8 秒后超时"——用户完全看不出是示例包坏了。
 *
 * 另外它还钉住一件只有真跑才知道的事：**定时器真的在推日志**。心跳停止（比如
 * `setInterval` 被权限模式挡掉、或 stdout 被别的东西占住）时，握手照样成功、日志照样
 * 一行不报，面板看起来"活着"，其实插件已经不动了。
 */
// 用 dirname + join 而不是 `new URL(..., import.meta.url)`：eslint 的 scripts 环境里没有 URL 全局
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = path.join(HERE, "..", "examples", "extensions", "uartix.hello");

describe("P174-A6 · 仓库示例包在真引导脚本里跑通", () => {
  it("清单合法 → activate 输出工作区 → 心跳到达 → dispose 报总数", async () => {
    const manifestRaw = readFileSync(path.join(EXAMPLE_DIR, "extension.json"), "utf8");
    const v = validateExtension(JSON.parse(manifestRaw));
    // 示例包自己都不合法，就没有说服力——而且这里红的时候信息很清楚："示例坏了"，
    // 不是"某个用户的包装不上"。
    expect(v.ok, `示例包清单不合法：${v.errors.join("；")}`).toBe(true);
    expect(v.manifest.main).toBe("main.mjs");

    const pluginDir = path.join(dir, v.manifest.id);
    const bootPath = path.join(dir, "bootstrap-demo.mjs");
    writeFileSync(bootPath, BOOTSTRAP_SOURCE, "utf8");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "main.mjs"), readFileSync(path.join(EXAMPLE_DIR, v.manifest.main), "utf8"), "utf8");

    const { messages } = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [PERM, "--allow-fs-read=*", "--allow-child-process", bootPath, pluginDir],
        { cwd: pluginDir, windowsHide: true },
      );
      const got = [];
      let buf = "";
      let disposed = false;
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(kick);
        resolve({ messages: got, code });
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        reject(new Error(`超时；已收到 ${JSON.stringify(got).slice(0, 600)}`));
      }, 15_000);
      // 心跳是 2s 一次：等到超过一个周期再收手，否则"定时器根本没跑"也能过
      const kick = setTimeout(() => {
        if (disposed) return;
        disposed = true;
        child.stdin.write(encodeMessage({ t: "dispose", token: TOKEN, reason: "test" }) + "\n");
      }, 2_600);

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
          got.push(m);
          if (m.t === "ready") child.stdin.write(encodeMessage({ t: "activate", token: TOKEN }) + "\n");
        }
      });
      child.stderr.on("data", (d) => got.push({ t: "__stderr", line: d.toString("utf8") }));
      child.on("error", reject);
      child.on("exit", (code) => finish(code));

      child.stdin.write(
        encodeMessage({ t: "hello", v: 1, token: TOKEN, workspace: pluginDir, appDir: dir, dev: true }) + "\n",
      );
    });

    const dump = JSON.stringify(messages).slice(0, 800);
    const logs = messages.filter((m) => m.t === "log").map((m) => m.msg);

    expect(messages.some((m) => m.t === "ready"), `没握手：${dump}`).toBe(true);
    // 语法错了 / import 失败，都是在这里现形（activate 根本没跑）
    expect(logs.some((m) => m.includes("示例扩展已启动")), `activate 没跑：${dump}`).toBe(true);
    // 工作区真的传进去了：面板显示"未配置"和不显示，是两种不同的故障
    expect(logs.some((m) => m.includes(pluginDir)), `工作区没传到插件里：${dump}`).toBe(true);
    // 心跳至少一次 —— 这是唯一能证明"定时器活着、stdout 还在流动"的判据
    expect(logs.some((m) => /心跳 \d+/.test(m)), `心跳没到（定时器没跑）：${dump}`).toBe(true);
    // disposer 报的是它自己数到的次数，不是写死的话
    expect(messages.some((m) => m.t === "log" && /已停止：共 \d+ 次心跳/.test(m.msg)), `disposer 没跑：${dump}`).toBe(true);
    expect(messages.some((m) => m.t === "disposed")).toBe(true);
  }, 25_000);
});
