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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      let done = false;
      let kick = null;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (kick) clearTimeout(kick);
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
      /* 2.6 秒的"收手"计时**从激活那一刻起算**，不是从 spawn 起算。
         从 spawn 起算的版本在满负载下会红：全套测试并行时，起进程 + activate 可能超过 2.6s，
         于是 dispose 赶在激活之前发出去，看起来像"心跳没跑"（实际是插件还没跑）。
         判据必须只对"插件的行为"敏感，不能对"机器有多忙"敏感。 */
      const armKick = () => {
        if (kick) return;
        kick = setTimeout(() => {
          try {
            child.stdin.write(encodeMessage({ t: "dispose", token: TOKEN, reason: "test" }) + "\n");
          } catch {
            /* 进程可能已经没了 */
          }
        }, 2_600);
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
          got.push(m);
          if (m.t === "ready") {
            child.stdin.write(encodeMessage({ t: "activate", token: TOKEN }) + "\n");
            return;
          }
          if (m.t === "log" && String(m.msg || "").includes("示例扩展已启动")) armKick();
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

/**
 * P174-A7：**面板的那条 RPC 线**，在真进程上跑一遍。
 *
 * 面板里的按钮 → `uartix.call("ping")` → 宿主拼成 `panel.<panelId>.ping` → 发 `call` →
 * 引导脚本路由到 `ctx.panels.register(panelId, { ping })` → 回 `result`。
 *
 * 这条线断在哪一环都不会抛错，只会让按钮一直转圈：方法名前缀拼错是 `not_found`、
 * token 没带是**静默丢弃**（设计如此）、`id` 不复用结果是等不到回音。所以只能真跑。
 */
describe("P174-A7 · 面板 RPC 在真进程上走通", () => {
  it("panel.<id>.<method> 拿得到结果；未知方法得 not_found；emit 带 panelId 回来", async () => {
    const manifestRaw = readFileSync(path.join(EXAMPLE_DIR, "extension.json"), "utf8");
    const v = validateExtension(JSON.parse(manifestRaw));
    expect(v.ok, `示例包清单不合法：${v.errors.join("；")}`).toBe(true);
    expect(v.manifest.contributes.panels?.[0]?.id).toBe("hello");

    const pluginDir = path.join(dir, "p7", v.manifest.id);
    const bootPath = path.join(dir, "bootstrap-p7.mjs");
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
      let done = false;
      let step = 0;
      let kick = null;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (kick) clearTimeout(kick);
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
        reject(new Error(`超时；已收到 ${JSON.stringify(got).slice(0, 700)}`));
      }, 15_000);
      /* 心跳是 2s 一次：**必须等过一个周期再收手**，否则"emit 通路根本没接上"也能过。
         （第一版是 r2 一到就 dispose，于是这条断言永远看不到 emit —— 它红得对。）
         计时同样从激活那一刻起算，不跟机器忙不忙挂钩。 */
      const armKick = () => {
        if (kick) return;
        kick = setTimeout(() => {
          try {
            child.stdin.write(encodeMessage({ t: "dispose", token: TOKEN, reason: "test" }) + "\n");
          } catch {
            /* 进程可能已经没了 */
          }
        }, 2_600);
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
          got.push(m);
          if (m.t === "ready") {
            child.stdin.write(encodeMessage({ t: "activate", token: TOKEN }) + "\n");
            return;
          }
          // activate 的输出到齐了才开始调：过早调用会得到 not_found（处理器还没注册）
          if (m.t === "log" && String(m.msg || "").includes("示例扩展已启动") && step === 0) {
            step = 1;
            child.stdin.write(
              encodeMessage({ t: "call", token: TOKEN, id: "r1", method: "panel.hello.ping", args: { from: "probe" } }) + "\n",
            );
            return;
          }
          if (m.t === "result" && m.id === "r1") {
            step = 2;
            child.stdin.write(
              encodeMessage({ t: "call", token: TOKEN, id: "r2", method: "panel.hello.nope" }) + "\n",
            );
            return;
          }
          // r2 之后还要等一个心跳才收手（armKick 由它来管）
          if (m.t === "result" && m.id === "r2") armKick();
        }
      });
      child.stderr.on("data", (d) => got.push({ t: "__stderr", line: d.toString("utf8") }));
      child.on("error", reject);
      child.on("exit", (code) => finish(code));

      child.stdin.write(
        encodeMessage({ t: "hello", v: 1, token: TOKEN, workspace: pluginDir, appDir: dir, dev: true }) + "\n",
      );
    });

    const dump = JSON.stringify(messages).slice(0, 900);
    const r1 = messages.find((m) => m.t === "result" && m.id === "r1");
    const r2 = messages.find((m) => m.t === "result" && m.id === "r2");
    expect(r1, `第一条 call 没有结果：${dump}`).toBeTruthy();
    expect(r1.ok, `ping 失败：${dump}`).toBe(true);
    expect(r1.data.pong).toBe(true);
    // 参数真的到了扩展里（拼错前缀也会"成功"，所以要看回传的内容）
    expect(r1.data.echo).toEqual({ from: "probe" });
    expect(r2, `未知方法没有结果：${dump}`).toBeTruthy();
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe("not_found");
    // 面板事件的另一端：host 靠 panelId 分发给对应的 iframe
    expect(
      messages.some((m) => m.t === "emit" && m.panelId === "hello" && m.event === "heartbeat"),
      `没收到面板事件：${dump}`,
    ).toBe(true);
    // token 必须回带（A2 的规矩，这条是顺手复核）
    expect(r1.token).toBe(TOKEN);
  }, 25_000);
});

/**
 * P174-A8：**工作区根真的通到插件里了吗**——这一条要在内核层验，不是在字符串上验。
 *
 * 判据分两半，缺一半就什么都没证明：
 * 1. 给了 `--allow-fs-write=<ws>` 且 `hello.workspace = <ws>` ⇒ 插件真能把文件写进那个目录；
 * 2. **不给**那个参数 ⇒ 同一个插件写同一个目录必须失败（`ERR_ACCESS_DENIED`）。
 *
 * 只有 1 的话，"参数没生效但目标目录恰好可写"也能过；只有 2 的话，
 * "插件根本没跑"也能过。两条一起才说明"牢笼是真的、绑定是真的"。
 */
describe("P174-A8 · 工作区根与写权限（内核级）", () => {
  const MAIN = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    "export async function activate(ctx) {",
    "  const dir = ctx.workspace || '';",
    // 先用 SDK 写一次：`ctx.fs.writeText(\"$WS/...\")` 是插件作者最自然的写法，
    // 它必须和 node:fs 走同一条内核路径（否则"SDK 能用、真跑不能用"这种错很难查）
    "  try {",
    "    await ctx.fs.writeText('$WS/sdk-out.txt', 'sdk');",
    "    ctx.log.info('SDK_OK');",
    "  } catch (e) {",
    "    ctx.log.info('SDK_FAIL ' + (e && e.message));",
    "  }",
    "  try {",
    "    const p = path.join(dir, 'probe-out.txt');",
    "    fs.writeFileSync(p, 'ok');",
    "    ctx.log.info('WRITE_OK ' + p);",
    "  } catch (e) {",
    "    ctx.log.info('WRITE_FAIL ' + (e && e.code));",
    "  }",
    "}",
  ].join("\n");

  function runOnce(tag, ws, allowWriteDir, pluginDir, bootPath) {
    return new Promise((resolve, reject) => {
      const args = [PERM, "--allow-fs-read=*"];
      if (allowWriteDir) args.push(`--allow-fs-write=${allowWriteDir}`);
      args.push("--allow-child-process", bootPath, pluginDir);

      const child = spawn(process.execPath, args, { cwd: pluginDir, windowsHide: true });
      const got = [];
      let buf = "";
      let done = false;
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
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
        reject(new Error(`${tag} 超时；已收到 ${JSON.stringify(got).slice(0, 600)}`));
      }, 12_000);

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
          if (m.t === "ready") {
            child.stdin.write(encodeMessage({ t: "activate", token: TOKEN }) + "\n");
            return;
          }
          if (m.t === "log" && /^WRITE_(OK|FAIL)/.test(String(m.msg || ""))) {
            child.stdin.write(encodeMessage({ t: "dispose", token: TOKEN, reason: "test" }) + "\n");
          }
        }
      });
      child.stderr.on("data", (d) => got.push({ t: "__stderr", line: d.toString("utf8") }));
      child.on("error", reject);
      child.on("exit", (code) => finish(code));

      child.stdin.write(
        encodeMessage({ t: "hello", v: 1, token: TOKEN, workspace: ws, appDir: dir, dev: true }) + "\n",
      );
    });
  }

  function setupPkg(tag) {
    const pluginDir = path.join(dir, `ws-${tag}`);
    const bootPath = path.join(dir, `bootstrap-${tag}.mjs`);
    const ws = path.join(dir, `wsroot-${tag}`);
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(bootPath, BOOTSTRAP_SOURCE, "utf8");
    writeFileSync(path.join(pluginDir, "main.mjs"), MAIN, "utf8");
    return { pluginDir, bootPath, ws };
  }

  it("给了写目录 + hello.workspace ⇒ 文件真的落到工作区里", async () => {
    const { pluginDir, bootPath, ws } = setupPkg("allow");
    const { messages } = await runOnce("allow", ws, ws, pluginDir, bootPath);
    const dump = JSON.stringify(messages).slice(0, 700);
    expect(messages.some((m) => m.t === "log" && /^WRITE_OK/.test(String(m.msg))), dump).toBe(true);
    // SDK 那条路：`$WS` 前缀在引导脚本里展开，写的是同一个内核允许的目录
    expect(messages.some((m) => m.t === "log" && String(m.msg) === "SDK_OK"), `ctx.fs 走 $WS 失败：${dump}`).toBe(true);
    expect(readFileSync(path.join(ws, "sdk-out.txt"), "utf8")).toBe("sdk");
    // 光看日志不够：日志也可能是插件自己编的
    const out = path.join(ws, "probe-out.txt");
    expect(existsSync(out), `文件没真落盘：${dump}`).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("ok");
  });

  it("不给写目录 ⇒ 同一个插件写同一个目录必须被内核拒（ERR_ACCESS_DENIED）", async () => {
    const { pluginDir, bootPath, ws } = setupPkg("deny");
    const { messages } = await runOnce("deny", ws, null, pluginDir, bootPath);
    const dump = JSON.stringify(messages).slice(0, 700);
    const fail = messages.find((m) => m.t === "log" && /^WRITE_FAIL/.test(String(m.msg)));
    expect(fail, `没看到失败日志（可能根本没写）：${dump}`).toBeTruthy();
    expect(String(fail.msg)).toContain("ERR_ACCESS_DENIED");
    expect(existsSync(path.join(ws, "probe-out.txt"))).toBe(false);
  });
});
