/**
 * 测试序列器 CLI（T5）。
 *
 * 与桌面端共用同一执行引擎（src/features/sequencer/runner.ts，依赖注入）与
 * 报告生成器（report.ts）；本文件只提供 Node 侧的实现：TCP/UDP 传输、
 * 参数解析、顺序执行、HTML 报告落盘、退出码。
 *
 * 注意：本目录不在 tsconfig include 内（项目未装 @types/node，不为此引入），
 * 类型正确性由 esbuild 打包 + 端到端冒烟保证；引擎/报告本身有完整 tsc+vitest 覆盖。
 *
 * 用法:
 *   uartix-seq <套件.json> [更多.json…] --conn tcp://主机:端口 | udp://主机:端口
 *              [--var 名=值 …] [--report 报告.html] [--junit 报告.xml]
 *              [--max-run-ms 毫秒] [--quiet]
 *   uartix-seq <套件.json> [更多.json…] --loopback [--lb-delay 毫秒] [--lb-corrupt N] […同上]
 *
 * 说明:
 *   · 传输为 TCP 客户端 / UDP（Node 原生，零依赖）；串口设备请经 TCP 透传桥接入
 *   · --loopback：内置回环"设备"（收到什么回什么，进程内实现零网络依赖），
 *     无硬件也能跑通断言链路——CI 接入用。--lb-delay 模拟链路延迟（默认 10ms），
 *     --lb-corrupt N 每 N 次回显翻转末字节（模拟坏帧，验证套件真的能抓到失败）
 *   · --junit 输出 JUnit XML（GitHub Actions 等 CI 直接吃测试报告）；退出码不变
 *   · 帧匹配仅支持「原始字节」(by:"raw")；模板/字段匹配需要解码引擎，属桌面端能力
 *   · send 仅支持 HEX 字面载荷；命令库 / 指令工厂载荷为桌面端能力（执行时记 fail）
 *   · TCP 按到达分段作为帧（设备按帧发送或加帧间隔），UDP 每个报文一帧
 *   · --max-run-ms 默认 0（不限制）；CI 建议设置，防 waitForFrame(0) 挂死
 *   · 退出码: 0=全部完成 · 1=存在失败/中止 · 2=用法或环境错误
 */

import * as net from "node:net";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as path from "node:path";
import * as runner from "../src/features/sequencer/runner";
import { renderReportHtml } from "../src/features/sequencer/report";
import { normalizeSuite } from "../src/features/sequencer/sequencerStore";
import type { FrameRow } from "../src/ipc/types";
import type { RunProgress, RunResult, StepResult, Suite } from "../src/features/sequencer/types";

/* ================= 参数解析 ================= */

interface Args {
  files: string[];
  conn: string | null;
  /** 回环模式延迟 ms；null = 未启用回环（用 --conn） */
  loopback: number | null;
  /** 每 N 次回显翻转末字节（0=关闭） */
  lbCorrupt: number;
  vars: Map<string, number | string>;
  report: string | null;
  junit: string | null;
  maxRunMs: number;
  quiet: boolean;
}

const USAGE = `用法: uartix-seq <套件.json> [更多.json…] --conn tcp://主机:端口 | udp://主机:端口
                [--var 名=值 …] [--report 报告.html] [--junit 报告.xml] [--max-run-ms 毫秒] [--quiet]
  或: uartix-seq <套件.json> [更多.json…] --loopback [--lb-delay 毫秒] [--lb-corrupt N] […同上]`;

function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  const vars = new Map<string, number | string>();
  let conn: string | null = null;
  let loopback: number | null = null;
  let lbCorrupt = 0;
  let report: string | null = null;
  let junit: string | null = null;
  let maxRunMs = 0;
  let quiet = false;

  const need = (i: number, flag: string): string => {
    if (i >= argv.length) throw `参数 ${flag} 缺少值`;
    return argv[i];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") throw USAGE;
    else if (a === "--conn") conn = need(++i, a);
    else if (a === "--loopback") loopback = 10; // 默认 10ms 模拟真实链路
    else if (a === "--lb-delay") {
      const v = Number(need(++i, a));
      if (!Number.isFinite(v) || v < 0) throw `--lb-delay 需要非负数字`;
      if (loopback === null) throw `--lb-delay 需与 --loopback 同用`;
      loopback = Math.round(v);
    } else if (a === "--lb-corrupt") {
      const v = Number(need(++i, a));
      if (!Number.isFinite(v) || v < 0) throw `--lb-corrupt 需要非负数字`;
      if (loopback === null) throw `--lb-corrupt 需与 --loopback 同用`;
      lbCorrupt = Math.round(v);
    } else if (a === "--report") report = need(++i, a);
    else if (a === "--junit") junit = need(++i, a);
    else if (a === "--var") {
      const kv = need(++i, a);
      const eq = kv.indexOf("=");
      if (eq <= 0) throw `--var 需要 名=值 形式，收到「${kv}」`;
      const name = kv.slice(0, eq);
      const raw = kv.slice(eq + 1);
      const n = Number(raw);
      vars.set(name, raw !== "" && Number.isFinite(n) ? n : raw);
    } else if (a === "--max-run-ms") {
      const v = Number(need(++i, a));
      if (!Number.isFinite(v) || v < 0) throw `--max-run-ms 需要非负数字`;
      maxRunMs = Math.round(v);
    } else if (a === "--quiet") quiet = true;
    else if (a.startsWith("--")) throw `未知参数 ${a}`;
    else files.push(a);
  }
  if (!files.length) throw "缺少套件 JSON 文件";
  if (conn && loopback !== null) throw "--conn 与 --loopback 互斥，选一个";
  if (!conn && loopback === null) throw "缺少 --conn（tcp://主机:端口 或 udp://主机:端口）或 --loopback";
  return { files, conn, loopback, lbCorrupt, vars, report, junit, maxRunMs, quiet };
}

/* ================= 传输 ================= */

interface Transport {
  send(bytes: Uint8Array): Promise<void>;
  onData(cb: (bytes: Uint8Array) => void): void;
  close(): void;
}

function connectTcp(host: string, port: number): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`TCP 连接超时 ${host}:${port}`));
    }, 5000);
    // 连接前的 error → reject；连接后的 error → 已 resolve 的 promise 上 no-op（防未处理崩溃）
    sock.on("error", (e) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    });
    sock.on("connect", () => {
      clearTimeout(timer);
      resolve({
        send: (bytes) =>
          new Promise<void>((res, rej) => {
            if (sock.destroyed) return rej(new Error("连接已关闭，发送失败"));
            sock.write(Buffer.from(bytes), (err) => {
              if (err) rej(err);
              else if (sock.destroyed) rej(new Error("连接在发送后关闭"));
              else res();
            });
          }),
        onData: (cb) => sock.on("data", (b) => cb(new Uint8Array(b))),
        close: () => sock.destroy(),
      });
    });
  });
}

function connectUdp(host: string, port: number): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    // 绑定前出错 → reject；resolve 后再出错 → 已结算 promise 上 no-op
    sock.on("error", (e) => {
      try {
        sock.close();
      } catch {
        /* 已关 */
      }
      reject(e);
    });
    sock.bind(() => {
      resolve({
        send: (bytes) =>
          new Promise<void>((res, rej) => {
            sock.send(Buffer.from(bytes), port, host, (err) => (err ? rej(err) : res()));
          }),
        onData: (cb) => sock.on("message", (b) => cb(new Uint8Array(b))),
        close: () => {
          try {
            sock.close();
          } catch {
            /* 已关 */
          }
        },
      });
    });
  });
}

async function connect(conn: string): Promise<{ t: Transport; desc: string }> {
  const m = /^(tcp|udp):\/\/([^:/\s]+):(\d+)$/.exec(conn);
  if (!m) throw `--conn 格式错误：${conn}（应为 tcp://主机:端口 或 udp://主机:端口）`;
  const port = Number(m[3]);
  if (!(port >= 1 && port <= 65535)) throw `--conn 端口非法：${m[3]}`;
  if (m[1] === "tcp") return { t: await connectTcp(m[2], port), desc: `tcp://${m[2]}:${port}` };
  return { t: await connectUdp(m[2], port), desc: `udp://${m[2]}:${port}` };
}

/** 内置回环"设备"：进程内 echo（收到什么回什么），零网络依赖——CI 无硬件跑套件。
 *  corruptEvery>0 时每 N 次回显翻转末字节（模拟坏帧，验证套件能抓到失败）。 */
function makeLoopback(delayMs: number, corruptEvery: number): { t: Transport; desc: string } {
  let onDataCb: ((b: Uint8Array) => void) | null = null;
  let count = 0;
  const t: Transport = {
    send: (bytes) =>
      new Promise<void>((res) => {
        // echo 必须发生在 send resolve 之后的宏任务里：引擎只认「waitForFrame
        // 步骤开始之后」到达的帧（runner.arrivedAt 语义），echo 抢在 send 内
        // 投递会被判早到而永不匹配。
        setTimeout(() => {
          if (!onDataCb) return;
          let out = bytes;
          if (corruptEvery > 0 && bytes.length > 0) {
            count++;
            if (count % corruptEvery === 0) {
              out = bytes.slice();
              out[out.length - 1] ^= 0xff;
            }
          }
          onDataCb(out);
        }, Math.max(0, delayMs));
        res();
      }),
    onData: (cb) => {
      onDataCb = cb;
    },
    close: () => {
      onDataCb = null;
    },
  };
  return {
    t,
    desc: `loopback（延迟 ${delayMs}ms${corruptEvery > 0 ? `，每 ${corruptEvery} 次坏帧` : ""}）`,
  };
}

/* ================= 帧流与 deps ================= */

const listeners = new Set<(rows: FrameRow[]) => void>();
let seqNo = 0;

function feedBytes(bytes: Uint8Array): void {
  const row: FrameRow = {
    tplId: "",
    tplName: "RAW",
    color: "#888888",
    tsMs: Date.now(),
    seq: seqNo++,
    len: bytes.length,
    valid: true,
    error: null,
    fields: [],
    bytes,
  };
  for (const l of listeners) l([row]);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0) throw new Error(`HEX 非法：「${hex}」`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error(`HEX 非法：「${hex}」`);
    out[i] = b;
  }
  return out;
}

function makeDeps(t: Transport, vars: Map<string, number | string>): runner.SequencerDeps {
  return {
    send: async (mode, text) => {
      const bytes =
        mode === "hex" ? hexToBytes(text) : new Uint8Array(Buffer.from(text, "utf8"));
      await t.send(bytes);
    },
    resolveSend: (p) => (p.type === "hex" ? { mode: "hex", text: p.text } : null),
    onFrames: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getVar: (name) => vars.get(name),
    now: () => Date.now(),
  };
}

/* ================= 输出 ================= */

const TAG: Record<string, string> = {
  pass: "PASS   ",
  fail: "FAIL   ",
  timeout: "TIMEOUT",
  skipped: "SKIP   ",
  aborted: "ABORT  ",
};

function printNode(r: StepResult, depth: number): void {
  const pad = "  ".repeat(depth);
  const ms = r.durationMs > 0 ? ` (${r.durationMs}ms)` : "";
  console.log(`${pad}[${TAG[r.status] ?? r.status}] ${r.label}${r.detail ? ` — ${r.detail}` : ""}${ms}`);
  if (r.children) for (const c of r.children) printNode(c, depth + 1);
}

function makePrinter(quiet: boolean): (p: RunProgress) => void {
  let seen = 0;
  return (p) => {
    if (quiet) return;
    for (; seen < p.results.length; seen++) printNode(p.results[seen], 0);
  };
}

function summarize(result: RunResult): { pass: number; bad: number; skip: number } {
  const c = { pass: 0, bad: 0, skip: 0 };
  const walk = (rs: StepResult[]): void => {
    for (const r of rs) {
      if (r.status === "pass") c.pass++;
      else if (r.status === "fail" || r.status === "timeout") c.bad++;
      else c.skip++;
      if (r.children) walk(r.children);
    }
  };
  walk(result.steps);
  return c;
}

/* ================= 主流程 ================= */

function loadSuites(files: string[]): Suite[] {
  const suites: Suite[] = [];
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      throw `读取/解析失败 ${f}：${String(e)}`;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    let n = 0;
    for (const x of list) {
      const s = normalizeSuite(x);
      if (s) {
        suites.push(s);
        n++;
      }
    }
    if (n === 0) throw `${f} 中没有有效序列（缺 name 字段或结构损坏）`;
    console.error(`已加载 ${f}：${n} 个序列`);
  }
  return suites;
}

function reportPathFor(base: string, idx: number, total: number): string {
  if (total <= 1) return base;
  return base.replace(/\.x?html?$/i, "").replace(/\.xml$/i, "") + `.${idx + 1}.html`;
}

function junitPathFor(base: string, idx: number, total: number): string {
  if (total <= 1) return base;
  return base.replace(/\.xml$/i, "") + `.${idx + 1}.xml`;
}

const xmlEsc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** RunResult → JUnit XML（一个 testsuite；顶层步骤= testcase，group 折叠为单条）。
 *  fail/timeout → <failure>；skipped/aborted → <skipped>；suite 非 done → testsuite error 属性提示。 */
function junitXml(result: RunResult): string {
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  const cases: string[] = [];
  const walk = (rs: StepResult[], depth: number): void => {
    for (const r of rs) {
      if (depth > 0 && r.kind === "group") {
        walk(r.children ?? [], depth + 1); // 嵌套组：只收叶子，避免同名重复计数
        continue;
      }
      tests++;
      const time = (r.durationMs / 1000).toFixed(3);
      const name = xmlEsc(`${r.label} (${r.kind})`);
      if (r.status === "fail" || r.status === "timeout") {
        failures++;
        cases.push(
          `    <testcase name="${name}" time="${time}">\n` +
            `      <failure message="${xmlEsc(r.detail.slice(0, 300))}" type="${r.status}"/>\n` +
            `    </testcase>`,
        );
      } else if (r.status !== "pass") {
        skipped++;
        cases.push(
          `    <testcase name="${name}" time="${time}">\n` +
            `      <skipped message="${xmlEsc(r.detail.slice(0, 300))}"/>\n` +
            `    </testcase>`,
        );
      } else {
        cases.push(`    <testcase name="${name}" time="${time}"/>`);
      }
    }
  };
  walk(result.steps, 0);
  const time = ((result.finishedAt - result.startedAt) / 1000).toFixed(3);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuite name="${xmlEsc(result.suiteName)}" tests="${tests}" failures="${failures}" ` +
    `errors="0" skipped="${skipped}" time="${time}">\n` +
    cases.join("\n") +
    `\n  </testsuite>\n`
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const suites = loadSuites(args.files);
  const { t, desc } =
    args.loopback !== null
      ? makeLoopback(args.loopback, args.lbCorrupt)
      : await connect(args.conn);
  console.error(`已连接 ${desc}`);

  let exit = 0;
  try {
    const deps = makeDeps(t, args.vars);
    t.onData(feedBytes);
    for (let i = 0; i < suites.length; i++) {
      const suite = suites[i];
      console.log(`\n[${i + 1}/${suites.length}] ${suite.name}`);
      const started = runner.startRun(suite, deps, { onProgress: makePrinter(args.quiet) });
      if (!started.ok) {
        console.error(`启动失败：${started.error}`);
        exit = 1;
        break;
      }
      const killer =
        args.maxRunMs > 0
          ? setTimeout(() => {
              console.error(`超出 --max-run-ms=${args.maxRunMs}，强制停止`);
              started.handle.stop();
            }, args.maxRunMs)
          : null;
      const result = await started.handle.done;
      if (killer) clearTimeout(killer);

      const c = summarize(result);
      const dur = ((result.finishedAt - result.startedAt) / 1000).toFixed(2);
      console.log(
        `---- ${result.status === "done" ? "完成" : result.status === "aborted" ? "已中止" : "失败"} · 通过 ${c.pass} · 失败/超时 ${c.bad} · 跳过/中止 ${c.skip} · ${dur}s ----`,
      );
      if (result.status !== "done") exit = 1;

      if (args.report) {
        const p = reportPathFor(args.report, i, suites.length);
        fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
        fs.writeFileSync(p, renderReportHtml(result), "utf8");
        console.error(`报告已写入 ${p}`);
      }
      if (args.junit) {
        const p = junitPathFor(args.junit, i, suites.length);
        fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
        fs.writeFileSync(p, junitXml(result), "utf8");
        console.error(`JUnit 已写入 ${p}`);
      }
    }
  } finally {
    t.close();
  }
  return exit;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  });
