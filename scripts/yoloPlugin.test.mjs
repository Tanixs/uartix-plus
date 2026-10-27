/**
 * P174-A9：YOLO 训练工作台插件的判据。
 *
 * 这一批的东西分两种，两种都必须能自动验：
 *
 * 1. **纯函数**（`dumpConfig` / `parseSimpleYaml` / `buildParamSpec`）：生成的 config.yaml 必须能被自己读回来，
 *    而且要一模一样——因为真正读它的是 Python 的 `yaml.safe_load`，格式写错的后果是
 *    "训练参数没生效"（不报错，只是跑出来的东西不对）。
 *
 * 2. **整条链**（真起插件进程）：`state()` 能把工作区读成面板要的形状、`saveConfig()` 写下的
 *    覆盖会被 `startTrain()` 用上、`python` 子进程的输出会被解析成进度、日志会落到 `$WS/logs/`。
 *    这一条用 **node 冒充 python**（工作区 `_env.bat` 指向 `process.execPath`，假脚本用 JS 写）：
 *    判据是"插件怎么拼命令、怎么解析输出"，而不是"这台机器有没有 torch"。
 *
 * P175-W1 加了四条**不许回退**的判据（详设 §10）：
 * - 用户的手动流水线（`config.yaml` / `scripts/*` / `*.bat`）一个字节都不能动 → 哈希 + mtime 对比；
 * - 参数表不许写死 → 探测结果少一个键，UI 就得少一项；
 * - 探测失败要**降级并说明**，不是弹一个空表单；
 * - 每次实验的快照落在**新的** `train_runs/`，且新参数真的进到快照里被 runner 读到。
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_SOURCE } from "../src/features/plugins/engine/bootstrap.ts";
import { encodeMessage } from "../src/features/plugins/engine/protocol.ts";
import { validateExtension } from "../src/features/plugins/engine/manifest.ts";

const TOKEN = "yolo-probe-1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, "..", "plugins", "uartix.yolo");

function permFlag() {
  for (const f of ["--permission", "--experimental-permission"]) {
    try {
      execFileSync(process.execPath, [f, "-e", ""], { stdio: "pipe" });
      return f;
    } catch {
      /* 试下一个 */
    }
  }
  return "--permission";
}
const PERM = permFlag();

const dir = mkdtempSync(path.join(tmpdir(), "uartix-yolo-"));
/** Windows 路径统一成正斜杠再比：插件内部到处是这种归一。 */
const fwd = (p) => String(p).replace(/\\/g, "/");
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

/* ============================ 纯函数：配置往返 ============================ */

describe("P174-A9 · config.yaml 生成与回读", () => {
  it("dumpConfig 的输出能被 parseSimpleYaml 原样读回（含中文路径、引号、布尔、列表）", async () => {
    const mod = await import("../../plugins/uartix.yolo/main.mjs");
    const cfg = {
      env: { proxy_enable: true, proxy: "http://127.0.0.1:7897" },
      dataset: {
        sources: ["D:/OneDrive/Desktop/X-AnyLabeling/images/123lmages", "E:/带空格的 目录/标注 \"引号\""],
        output_dir: "D:/YOLO-Workspace/datasets/123lmages_seg",
        val_ratio: 0.15,
        seed: 42,
        classes: ["1", "2", "3"],
        label_map: {},
      },
      train: {
        weights: "D:/YOLO-Workspace/models/yolo11n-seg.pt",
        epochs: 300,
        imgsz: 640,
        batch: 16,
        workers: 0,
        patience: 100,
        device: "0",
        name: "yolo11n_seg_640",
        project: "D:/YOLO-Workspace/runs",
        optimizer: "auto",
        cos_lr: true,
        close_mosaic: 20,
        degrees: 10,
        fliplr: 0,
        flipud: 0,
        copy_paste: 0.2,
        mixup: 0,
        cache: "disk",
        seed: 42,
        save_period: 25,
      },
    };
    const text = mod.dumpConfig(cfg);
    // 反斜杠必须被转义或改写成正斜杠：YAML 双引号标量里 `\Y` 是非法转义，
    // 报错会出现在 python 那一侧（"invalid escape sequence"），看起来像插件坏了
    expect(text).not.toMatch(/[^\\]\\[A-Za-z]/);
    const back = mod.parseSimpleYaml(text);
    expect(back).toEqual(cfg);
  });

  it("空列表写成 []（yaml 里空值会变成 null，脚本那边遍历就炸）", async () => {
    const mod = await import("../../plugins/uartix.yolo/main.mjs");
    const text = mod.dumpConfig({
      env: { proxy_enable: false, proxy: "" },
      dataset: { sources: [], output_dir: "D:/x", val_ratio: 0.1, seed: 1, classes: [], label_map: {} },
      train: {
        weights: "w.pt",
        epochs: 1,
        imgsz: 64,
        batch: 1,
        workers: 0,
        patience: 1,
        device: "cpu",
        name: "n",
        project: "D:/r",
        optimizer: "auto",
        cos_lr: false,
        close_mosaic: 0,
        degrees: 0,
        fliplr: 0,
        flipud: 0,
        copy_paste: 0,
        mixup: 0,
        cache: "disk",
        seed: 1,
        save_period: 1,
      },
    });
    expect(text).toContain("sources: []");
    expect(text).toContain("classes: []");
    expect(mod.parseSimpleYaml(text).dataset.sources).toEqual([]);
  });
});

describe("P174-A9 · 训练时长格式", () => {
  it("秒 → 人能读的写法；缺失/0 返回空串（界面显示成「—」）", async () => {
    const mod = await import("../../plugins/uartix.yolo/main.mjs");
    expect(mod.fmtDuration(25)).toBe("25s");
    expect(mod.fmtDuration(95)).toBe("1m 35s");
    expect(mod.fmtDuration(3725)).toBe("1h 02m");
    expect(mod.fmtDuration(0)).toBe("");
    expect(mod.fmtDuration(undefined)).toBe("");
  });
});

/* ============================ 整条链：真起插件进程 ============================ */

/**
 * 造一个"像 YOLO-Workspace"的假工作区：
 * - `_env.bat` 指向 **node**（于是 `python` 探测拿到的是 node，`--version` 也能答）
 * - `scripts/*.py` 里放 JS（node 不看扩展名，直接执行）——打印真实脚本会打印的那几行
 * - `datasets/x/data.yaml` 与 `runs/<name>/results.csv` 各一份，供 `state()` 扫描
 */
function makeWorkspace(tag) {
  const ws = path.join(dir, `ws-${tag}`);
  mkdirSync(path.join(ws, "scripts"), { recursive: true });
  mkdirSync(path.join(ws, "datasets", "x", "images", "train"), { recursive: true });
  mkdirSync(path.join(ws, "datasets", "x", "images", "val"), { recursive: true });
  mkdirSync(path.join(ws, "runs", "exp1"), { recursive: true });
  mkdirSync(path.join(ws, "models"), { recursive: true });

  // 路径要用**这个临时工作区**的真实位置：写死 D:/fake 的话，后面 scanDataset 会去
  // 一个不存在的盘上找 data.yaml，而那条断言会红在一个与插件无关的地方
  const fwd = ws.replace(/\\/g, "/");
  writeFileSync(path.join(ws, "config.yaml"), [
    "# 假工作区的配置（形状照抄真实那份：注释、两层嵌套、字符串列表、内联 {}）",
    "env:",
    "  proxy_enable: true",
    "  proxy: http://127.0.0.1:7897",
    "",
    "dataset:",
    "  sources:",
    "    - D:/fake/anno/one",
    "    - D:/fake/anno/two",
    `  output_dir: ${fwd}/datasets/x`,
    "  val_ratio: 0.2",
    "  seed: 7",
    "  classes: ['1', '2', '3']",
    "  label_map: {}",
    "",
    "train:",
    "  weights: D:/fake/models/base.pt",
    "  epochs: 50",
    "  imgsz: 512",
    "  batch: 8",
    "  workers: 0",
    "  patience: 30",
    "  device: 0",
    "  name: from_base",
    `  project: ${fwd}/runs`,
    "  fliplr: 0.0",
    "",
  ].join("\n"), "utf8");

  // node 冒充 python：--version 有输出，别的一律走"脚本"
  writeFileSync(path.join(ws, "_env.bat"), `@echo off\r\nset "PYTHON_EXE=${process.execPath}"\r\n`, "utf8");

  writeFileSync(path.join(ws, "scripts", "train.py"), [
    "// 用 node 执行的假 train.py：打印 ultralytics 会打印的那几行",
    "const fs = require('node:fs');",
    "const cfg = process.argv[process.argv.indexOf('--config') + 1];",
    "const text = fs.readFileSync(cfg, 'utf8');",
    "console.log('[信息] ========== 开始训练 ==========');",
    "console.log('[工作台自检] config 里有 epochs 7: ' + /^  epochs: 7$/m.test(text));",
    "for (const e of [1, 2, 3]) {",
    "  console.log('      ' + e + '/3      3.21G     0.9     1.2     0.5     1.1         16        640: 100%');",
    "}",
    "console.log('[信息] ========== 训练完成 ==========');",
    "process.exit(0);",
  ].join("\n"), "utf8");

  writeFileSync(path.join(ws, "scripts", "build_dataset.py"), [
    "const fs = require('node:fs');",
    "const cfg = process.argv[process.argv.indexOf('--config') + 1];",
    "console.log('[信息] 素材文件夹 D:/fake/anno/one : 10 个样本');",
    "console.log('[信息] 合计 10 个样本（重名自动改名 0 个）');",
    "console.log('[信息] 划分完成: 训练集 8 张 / 验证集 2 张 (val_ratio=0.20, seed=7)');",
    "console.log('[信息] 清理旧文件/缓存 0 个');",
    "console.log('[信息] ========== 数据集构建完成 ==========');",
    "fs.writeFileSync(cfg + '.built', 'ok');",
    "process.exit(0);",
  ].join("\n"), "utf8");

  writeFileSync(path.join(ws, "datasets", "x", "data.yaml"), "path: D:/fake/datasets/x\ntrain: images/train\nval: images/val\nnames:\n  0: '1'\n  1: '2'\n", "utf8");
  for (let i = 0; i < 3; i++) writeFileSync(path.join(ws, "datasets", "x", "images", "train", `a${i}.jpg`), "x");
  writeFileSync(path.join(ws, "datasets", "x", "images", "val", "b0.jpg"), "x");

  writeFileSync(path.join(ws, "runs", "exp1", "results.csv"),
    "epoch,time,metrics/mAP50(B),metrics/mAP50(M),metrics/mAP50-95(M)\n1,12.5,0.5,0.6,0.4\n2,25,0.7,0.75,0.6\n", "utf8");

  // 手动流水线里那两样"面板绝不能碰"的东西，形状照抄真工作区（红线 A 的判据要有的放矢）
  writeFileSync(path.join(ws, "03_train.bat"), '@echo off\r\ncall "%~dp0_env.bat"\r\n"%PYTHON_EXE%" "%~dp0scripts\\train.py" --config "%~dp0config.yaml" %*\r\n', "utf8");
  writeFileSync(path.join(ws, "README_使用说明.txt"), "唯一需要修改的文件是 config.yaml\n", "utf8");

  // 投料口：用户自己标注、自己往里放，面板只数不写
  mkdirSync(path.join(ws, "annotations", "第二批数字", "images"), { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(path.join(ws, "annotations", "第二批数字", "images", `c${i}.jpg`), "x");
  writeFileSync(path.join(ws, "annotations", "第二批数字", "c0.json"), "{}", "utf8");

  return ws;
}

/** 起宿主（真 bootstrap + 真插件进程），返回一个能 call 的客户端。 */
/**
 * 把仓库里的插件复制到临时目录（**整包**，含 `runner/`）：运行期它只往 $WS 写，
 * 但别让它有机会碰源码。
 */
function copyInto(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".versions" || e.name === "logs") continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyInto(s, d);
    else copyFileSync(s, d);
  }
  return to;
}

function copyPlugin(tag = "plug") {
  return copyInto(PLUGIN_SRC, path.join(dir, tag, "uartix.yolo"));
}

/**
 * 把插件自带的 python runner 换成 node 能跑的假 runner。
 *
 * 为什么换而不是跳过：W1 换的就是**训练走哪条路**（不再是用户的 `scripts/train.py`）。
 * 那条路必须整条跑一遍才算数——快照写到哪、命令怎么拼、进度怎么解析、
 * 新参数有没有进到 runner 读到的那份文件里。真 runner 由 `yoloRunner.test.mjs` 用真 python 验。
 */
function fakeRunner(pluginDir) {
  const p = path.join(pluginDir, "runner", "train_job.py");
  expect(existsSync(p), "插件包里必须有自带的 runner/train_job.py（P175-W1）").toBe(true);
  writeFileSync(
    p,
    [
      "// 用 node 执行的假 runner：打印 ultralytics 会打印的那几行，并把读到的配置原样留档",
      "const fs = require('node:fs');",
      "const a = process.argv;",
      "const cfg = a[a.indexOf('--config') + 1];",
      "const text = fs.readFileSync(cfg, 'utf8');",
      "if (a.includes('--dry-run')) {",
      "  const grab = (k) => { const m = new RegExp('^  ' + k + ': (.*)$', 'm').exec(text); return m ? m[1] : null; };",
      "  console.log(JSON.stringify({ ok: true, dry_run: true, config: cfg, ultralytics: 'fake-8.4', data: grab('data') || 'D:/fake/data.yaml', data_exists: true, model: grab('weights') || '', overrides: { epochs: Number(grab('epochs')), lr0: Number(grab('lr0')), batch: Number(grab('batch')) }, dropped: [] }));",
      "  process.exit(0);",
      "}",
      "fs.writeFileSync(cfg + '.ran', text);",
      "console.log('[信息] ========== 开始训练 ==========');",
      "console.log('[工作台自检] config 里有 epochs 7: ' + /^  epochs: 7$/m.test(text));",
      "console.log('[工作台自检] 快照里有 lr0: ' + /^  lr0: 0\\.005$/m.test(text));",
      "for (const e of [1, 2, 3]) {",
      "  console.log('      ' + e + '/3      3.21G     0.9     1.2     0.5     1.1         16        640: 100%');",
      "}",
      "console.log('[信息] ========== 训练完成 ==========');",
      "process.exit(0);",
    ].join("\n"),
    "utf8",
  );
  return p;
}

/**
 * 用户手动流水线上那些文件的指纹（P175 红线 A 的判据）。
 * `config.yaml` / 所有 `.bat` / 所有 `scripts/*.py` / `README_使用说明.txt`——
 * 面板跑完一整轮之后，这些必须**mtime 与内容都不变**。
 */
function userFilesFingerprint(ws) {
  const files = [];
  for (const e of readdirSync(ws, { withFileTypes: true })) {
    if (e.isFile() && (/\.bat$/i.test(e.name) || e.name === "config.yaml" || /README_.*\.txt$/i.test(e.name))) {
      files.push(path.join(ws, e.name));
    }
  }
  const sd = path.join(ws, "scripts");
  if (existsSync(sd)) for (const e of readdirSync(sd)) if (e.endsWith(".py")) files.push(path.join(sd, e));
  const out = {};
  for (const f of files) {
    const st = statSync(f);
    out[f.replace(/\\/g, "/")] = { mtime: st.mtimeMs, size: st.size, text: readFileSync(f, "utf8") };
  }
  return out;
}

function assertUntouched(before, ws, what) {
  const after = userFilesFingerprint(ws);
  const keys = Object.keys(before);
  expect(keys.length, `${what}：指纹里连一个文件都没有，这条判据等于没写`).toBeGreaterThanOrEqual(4);
  expect(Object.keys(after).sort(), `${what}：文件列表变了（面板新增/删了用户的文件？）`).toEqual(keys.slice().sort());
  for (const k of keys) {
    expect(after[k].mtime, `${what}：${k} 的 mtime 被改过`).toBe(before[k].mtime);
    expect(after[k].text, `${what}：${k} 的内容被改过`).toBe(before[k].text);
  }
}

function startPlugin(pluginDir, ws, roots) {
  const bootPath = path.join(dir, `boot-${path.basename(ws)}.mjs`);
  writeFileSync(bootPath, BOOTSTRAP_SOURCE, "utf8");
  const args = [PERM, "--allow-fs-read=*"];
  // 没工作区时**不给**这个参数：`--allow-fs-write=`（空值）会让 node 直接起不来，
  // 而那条用例要验的是"没有工作区时插件怎么答"，不是"参数拼错时 node 怎么崩"
  if (ws) args.push(`--allow-fs-write=${ws}`);
  args.push("--allow-child-process", bootPath, pluginDir);
  const child = spawn(process.execPath, args, { cwd: pluginDir, windowsHide: true });

  const events = [];
  const results = new Map();
  let buf = "";
  let exited = false;
  let seq = 0;

  const done = new Promise((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      resolve(code);
    });
  });

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
      if (m.t === "ready") {
        child.stdin.write(encodeMessage({ t: "activate", token: TOKEN }) + "\n");
        continue;
      }
      if (m.t === "result") {
        const r = results.get(m.id);
        if (r) {
          results.delete(m.id);
          r(m);
        }
        continue;
      }
      if (m.t === "emit") events.push(m);
    }
  });

  function call(method, args) {
    const id = `c${++seq}`;
    return new Promise((resolve, reject) => {
      results.set(id, (m) => (m.ok ? resolve(m.data) : reject(Object.assign(new Error(m.err), { code: m.code }))));
      child.stdin.write(encodeMessage({ t: "call", token: TOKEN, id, method, args: args ?? null }) + "\n");
      setTimeout(() => {
        if (results.has(id)) {
          results.delete(id);
          reject(new Error(`调用超时：${method}`));
        }
      }, 30_000);
    });
  }

  /** 等到某个条件成立（看事件流），超时就带着已有事件报错。 */
  function waitFor(pred, ms, what) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = pred();
        if (hit) return resolve(hit);
        if (exited) return reject(new Error(`进程已退出；没等到 ${what}；事件 ${JSON.stringify(events).slice(0, 600)}`));
        if (Date.now() - t0 > ms) {
          return reject(new Error(`等 ${what} 超时；事件 ${JSON.stringify(events).slice(0, 800)}`));
        }
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  const ready = new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (exited) {
        clearInterval(t);
        reject(new Error("插件进程在握手前退出"));
      }
    }, 50);
    child.stdout.once("data", () => {
      clearInterval(t);
      resolve();
    });
  });

  child.stdin.write(
    encodeMessage({ t: "hello", v: 1, token: TOKEN, workspace: ws, appDir: dir, roots: roots || {}, dev: true }) + "\n",
  );

  return { child, call, events, waitFor, done, ready };
}

describe("P174-A9 · 插件在真宿主里跑（node 冒充 python）", () => {
  it("清单合法，且声明了它真的要用的权限", () => {
    const raw = JSON.parse(readFileSync(path.join(PLUGIN_SRC, "plugin.json"), "utf8"));
    const v = validateExtension(raw);
    expect(v.ok, `插件清单不合法：${v.errors.join("；")}`).toBe(true);
    const m = v.manifest;
    expect(m.id).toBe("uartix.yolo");
    expect(m.contributes.panels?.[0]).toEqual({ id: "train", title: "YOLO 训练", entry: "panel.html" });
    // 要写工作区里的位置，一个都不能少（少了就是运行时才炸的 EACCES）。
    // P175-W1 多两个：`train_runs/`（第三层快照）与 `annotations/`（投料口，只在用户点「建目录」时写一次）
    expect(m.permissions.fs.write).toEqual([
      "$WS/.uartix",
      "$WS/annotations",
      "$WS/datasets",
      "$WS/logs",
      "$WS/models",
      "$WS/runs",
      "$WS/train_runs",
    ]);
    expect(existsSync(path.join(PLUGIN_SRC, m.main))).toBe(true);
    expect(existsSync(path.join(PLUGIN_SRC, m.contributes.panels[0].entry))).toBe(true);
    // 自带 runner 是"新参数能生效"的那条腿；它不在了，面板新增的参数就只是面板上的装饰
    expect(existsSync(path.join(PLUGIN_SRC, "runner", "train_job.py"))).toBe(true);
  }, 20_000);

  it("state() 读工作区 → saveConfig 覆盖 → startTrain 起真进程并解析进度", async () => {
    const ws = makeWorkspace("main");
    // 插件从仓库里复制一份到临时目录：运行期它只往 $WS 写，但别让它有机会碰源码
    const pluginDir = copyPlugin("plug");
    fakeRunner(pluginDir);
    // 红线 A：整轮跑完，用户手动流水线上的文件必须一个字节都没变
    const guard = userFilesFingerprint(ws);

    const c = startPlugin(pluginDir, ws);
    try {
      await c.ready;

      /* ---- 1. state：工作区 / python / 基准配置 / 数据集 / 训练记录 ---- */
      const st = await c.call("panel.train.state", {});
      const fwd = (p) => String(p).replace(/\\/g, "/");
      expect(fwd(st.workspace)).toBe(fwd(ws));
      expect(st.needWorkspace).toBe(false);

      // python 是 _env.bat 里那条（node），版本能读出来
      expect(st.python.ok, JSON.stringify(st.python)).toBe(true);
      expect(st.python.source).toBe("_env.bat");

      // config.yaml 被读成基准：这台 python 没有 pyyaml ⇒ 走内置兜底解析
      expect(st.config.baseFound, JSON.stringify(st.config.baseError)).toBe(true);
      expect(st.config.baseSource).toBe("fallback");
      expect(st.config.effective.dataset.sources).toEqual(["D:/fake/anno/one", "D:/fake/anno/two"]);
      expect(st.config.effective.dataset.val_ratio).toBe(0.2);
      expect(st.config.effective.train.epochs).toBe(50);
      expect(st.config.effective.train.name).toBe("from_base");

      // 参数面：探测要 6 秒，所以 `state()` 里**不该**已经探好（否则每次刷新都卡一下）
      expect(st.params.ready, "state() 顺手把参数表探完了").toBe(false);
      expect(st.params.groups).toEqual([]);
      // node 冒充的 python 跑不了 `-c` ⇒ 探测必然失败。这时要**降级 + 说清楚**，而不是给一张空表单
      const ps = await c.call("panel.train.params", false);
      expect(ps.degraded, JSON.stringify(ps)).toBe(true);
      expect(String(ps.error || "")).toBeTruthy();
      const shown = ps.groups.flatMap((g) => g.items.map((i) => i.key));
      expect(shown).toContain("epochs");
      expect(shown, "weights 是工作区词汇，探测失败也必须在").toContain("weights");
      expect(shown, "降级时不该把探测没成功的键吹成有").not.toContain("lr0");

      // 投料口：只数不写（标注是用户自己的事）
      expect(fwd(st.intake.dir)).toBe(fwd(path.join(ws, "annotations")));
      expect(st.intake.exists).toBe(true);
      expect(st.intake.subdirs[0].images).toBe(3);
      expect(st.intake.subdirs[0].json).toBe(1);

      // 数据集与训练记录：真的从盘上扫出来的
      expect(st.dataset.exists).toBe(true);
      expect(st.dataset.trainCount).toBe(3);
      expect(st.dataset.valCount).toBe(1);
      expect(st.dataset.classes).toEqual(["1", "2"]);
      expect(st.runs[0].name).toBe("exp1");
      expect(st.runs[0].epochs).toBe(2);
      expect(st.runs[0].metrics.mAP50M).toBe("0.75");
      // 训练时长取 results.csv 的累计 time（最后一行的秒数），并给出可显示的写法
      expect(st.runs[0].durationSec).toBe(25);
      expect(st.runs[0].durationText).toBe("25s");
      expect(st.runs[0].finishedAt).toBeGreaterThan(0);
      expect(st.runs[0].startedAt).toBeLessThan(st.runs[0].finishedAt);

      /* ---- 2. saveConfig：只落"与基准不同的那些" ---- */
      const st2 = await c.call("panel.train.saveConfig", { train: { epochs: 7, lr0: 0.005 } });
      expect(st2.config.effective.train.epochs).toBe(7);
      // 基准里的其它值不能被覆盖掉（合并而不是替换）
      expect(st2.config.effective.train.name).toBe("from_base");
      const overFile = path.join(ws, ".uartix", "yolo", "config.json");
      expect(existsSync(overFile)).toBe(true);
      expect(JSON.parse(readFileSync(overFile, "utf8"))).toEqual({ train: { epochs: 7, lr0: 0.005 } });

      /* ---- 3. startTrain：真起子进程，日志与进度都回来 ---- */
      const job = await c.call("panel.train.startTrain", {});
      expect(job.state).toBe("running");

      const finished = await c.waitFor(() => {
        const jobs = c.events.filter((e) => e.event === "job").map((e) => e.payload);
        return jobs.find((j) => j.state === "succeeded" || j.state === "failed");
      }, 20_000, "任务结束");

      expect(finished.state, `任务失败：${JSON.stringify(finished)}`).toBe("succeeded");
      expect(finished.code).toBe(0);
      expect(finished.progress.epoch).toBe(3);
      expect(finished.progress.epochs).toBe(3);
      expect(finished.progress.percent).toBe(100);

      // 第三层快照：`train_runs/<实验名>-<时间>.yaml`（不再往 `.uartix/yolo/runs/<job>/` 里塞）
      const snapDir = path.join(ws, "train_runs");
      const snaps = readdirSync(snapDir).filter((f) => f.endsWith(".yaml"));
      expect(snaps, JSON.stringify(snaps)).toHaveLength(1);
      expect(snaps[0], "快照文件名要带实验名与时间，两个实验撞不到一起").toMatch(/^from_base-\d{8}-\d{6}\.yaml$/);
      const cfgPath = path.join(snapDir, snaps[0]);
      expect(fwd(job.configPath)).toBe(fwd(cfgPath));
      const yamlText = readFileSync(cfgPath, "utf8");
      expect(yamlText).toMatch(/^ {2}epochs: 7$/m);
      expect(yamlText).toMatch(/^ {2}lr0: 0\.005$/m); // 新增参数进了快照
      expect(yamlText).toContain(`  output_dir: "${ws.replace(/\\/g, "/")}/datasets/x"`);
      expect(yamlText).toContain("- \"D:/fake/anno/one\"");
      // 旧位置不该再有第二份真相（同一个配置两个地方各写一份，迟早漂移）
      expect(existsSync(path.join(ws, ".uartix", "yolo", "runs")), "还在写 .uartix/yolo/runs/<job>/config.yaml：两份真相").toBe(false);

      // 假 runner 读到的 config 里 epochs 真的是 7（证明写盘 → 传参 → runner 读 这条链是通的）
      const logs = c.events.filter((e) => e.event === "log").flatMap((e) => e.payload.lines);
      expect(logs.some((l) => l.text.includes("config 里有 epochs 7: true")), JSON.stringify(logs.slice(0, 12))).toBe(true);
      expect(logs.some((l) => l.text.includes("快照里有 lr0: true")), "新增参数没被 runner 读到，面板上的输入框就是装饰").toBe(true);
      // 命令与快照路径都打进日志：用户复制就能在命令行跑同一次（详设 §4.3）
      expect(logs.some((l) => l.text.includes("手动等价")), "日志里没给手动等价命令").toBe(true);
      expect(logs.some((l) => /runner[\\/]train_job\.py/.test(l.text)), "训练没走插件自带的 runner").toBe(true);
      // 日志同时落到 $WS/logs/
      expect(finished.logPath.replace(/\\/g, "/")).toContain("/logs/yolo-");
      expect(existsSync(finished.logPath)).toBe(true);
      expect(readFileSync(finished.logPath, "utf8")).toContain("开始训练");

      /* ---- 4. 任务列表：面板重新打开时靠它恢复视图 ---- */
      const st3 = await c.call("panel.train.state", {});
      expect(st3.jobs.some((j) => j.id === job.id && j.state === "succeeded")).toBe(true);
      expect(st3.active).toBeNull();
      expect(st3.trainRuns.some((r) => fwd(r.file) === fwd(cfgPath)), "state() 要能列出已有快照").toBe(true);

      /* ---- 5. 改回基准值 ⇒ 这条 diff 自己消失 ----
         参数面从 8 项涨到 40 多项以后，这条从"整洁"变成正确性：不剪的话用户以后改
         工作区的 config.yaml 会被这些无意义的覆盖永远压住，表现为"改了没生效"。 */
      const st4 = await c.call("panel.train.saveConfig", { train: { epochs: 50 } });
      expect(st4.config.effective.train.epochs).toBe(50);
      expect(JSON.parse(readFileSync(overFile, "utf8"))).toEqual({ train: { lr0: 0.005 } });
      // null = 撤销这一项（面板上把输入框清空时送回来的就是它）
      const st5 = await c.call("panel.train.saveConfig", { train: { lr0: null } });
      expect(st5.config.effective.train.lr0, "撤销后该回落基准，而不是把 null 留在配置里").toBeUndefined();
      expect(JSON.parse(readFileSync(overFile, "utf8"))).toEqual({});

      /* ---- 6. 红线 A：这一整轮什么都没动用户的手动流水线 ---- */
      assertUntouched(guard, ws, "state / params / saveConfig / startTrain 全跑一遍之后");
    } finally {
      try {
        c.child.kill();
      } catch {
        /* 已经退出 */
      }
    }
  }, 90_000);

  it("没有工作区时 state() 说人话，而不是抛异常（面板要能把「去选目录」显示出来）", async () => {
    const pluginDir = copyPlugin("plug2");
    const ws = makeWorkspace("empty"); // 只是借它的目录当 roots，hello 里给空工作区
    const c = startPlugin(pluginDir, "");
    try {
      await c.ready;
      const st = await c.call("panel.train.state", {});
      expect(st.needWorkspace).toBe(true);
      expect(st.workspace).toBe("");
      expect(st.dataset.exists).toBe(false);
      // 读路径不抛错：投料口/快照列表在没工作区时给空值，而不是崩
      expect(st.intake.exists).toBe(false);
      expect(st.intake.dir).toBe("");
      expect(st.trainRuns).toEqual([]);
      // 默认值仍然给出来（面板要能画出表单）
      expect(st.config.effective.dataset.classes).toEqual(["1", "2", "3"]);
      void ws;
    } finally {
      try {
        c.child.kill();
      } catch {
        /* 已经退出 */
      }
    }
  }, 60_000);
});

/**
 * P174-A11：**真插件**吃到了外部目录。
 *
 * 与契约层那条（`pluginProbe`）不同，这条走的是 `plugins/uartix.yolo` 本体：
 * 它 `state()` 里的 `deploy` 块必须随 `hello.roots` 变化——没绑是 `bound:false`（不是崩），
 * 绑了就得报出 `run.bat` 与配置文件名。这条断了的表现是"面板上部署那块永远是'还没配置'",
 * 而用户明明绑了目录。
 */
/**
 * P174-A15：部署页的服务端（插件侧）。
 *
 * 不在这里真跑工具（那要 Docker + pulsar2 镜像，且会动用户的 work/out 目录）。
 * 钉的是三件**能在没有环境时验的事**：
 * 1. 配置读得出来（`$Model` / `$ModelName` / 尺寸 / Docker 镜像）；
 * 2. 没有交付产物时 `deployDeliver` 说人话，而不是抛一个空路径；
 * 3. 没绑工具时 `deployStart` 明确拒（不猜路径——猜错的形态是"部署到别人的目录里"）。
 */
describe("P174-A15 · 部署页的插件侧", () => {
  function toolDir(tag) {
    const d = path.join(dir, `deploy-${tag}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "run.bat"), "@echo off\r\n", "utf8");
    writeFileSync(
      path.join(d, "deploy_config.digits.ps1"),
      [
        '# 注释里的 $Model = "D:/should/not/be/read"',
        '$Model = "D:/YOLO-Workspace/models/delivered/yolo11n-seg-digits-best.pt"',
        '$ModelName = "yolo11n-seg-digits"',
        "$ImgszW = 640",
        "$ImgszH = 480",
        '$DockerImage = "pulsar2:4.0"',
      ].join("\n"),
      "utf8",
    );
    return d;
  }

  it("deployState 读得出配置：取真正那一行，不取注释里那句", async () => {
    const ws = makeWorkspace("deploy-state");
    const pluginDir = copyPlugin("deploy-state");
    const p = startPlugin(pluginDir, ws, { deploy: toolDir("state") });
    await p.ready;
    const st = await p.call("panel.train.deployState", {});
    expect(st.tool.ready, JSON.stringify(st.tool)).toBe(true);
    expect(st.configs).toHaveLength(1);
    expect(st.configs[0].model).toBe("D:/YOLO-Workspace/models/delivered/yolo11n-seg-digits-best.pt");
    expect(st.configs[0].modelName).toBe("yolo11n-seg-digits");
    expect(st.configs[0].imgsz).toBe("640×480");
    expect(st.configs[0].docker).toBe("pulsar2:4.0");
    // 没有训练产物 ⇒ latest 为 null（界面据此把"交付"按钮置灰，而不是点了才报错）
    expect(st.latest).toBeNull();
    expect(st.delivered).toEqual([]);
    p.child.stdin.end();
    await p.done;
  }, 30_000);

  it("没有训练产物时交付 → 一句人话；没绑工具时部署 → 明确拒", async () => {
    const ws = makeWorkspace("deploy-neg");
    const pluginDir = copyPlugin("deploy-neg");
    const p = startPlugin(pluginDir, ws, {});
    await p.ready;

    const miss = await p.call("panel.train.deployState", {});
    expect(miss.tool.bound).toBe(false);

    // 没绑工具：deployStart 要拒，而不是拿空路径去起进程
    const err = await p.call("panel.train.deployStart", "x.ps1", "validate", {}).then(
      () => null,
      (e) => String(e.message || e),
    );
    expect(err, "没绑外部目录时 deployshould 被拒").toBeTruthy();
    expect(err).toContain("deploy");

    p.child.stdin.end();
    await p.done;
  }, 30_000);
});

describe("P174-A11 · 外部目录递进真插件", () => {
  it("没绑 ⇒ deploy.bound = false（插件照常启动，训练不受影响）", async () => {
    const ws = makeWorkspace("deploy-none");
    const pluginDir = copyPlugin("deploy-none");
    const p = startPlugin(pluginDir, ws);
    await p.ready;
    const st = await p.call("panel.train.state", {});
    expect(st.deploy, "state 里没有 deploy 块").toBeTruthy();
    expect(st.deploy.bound).toBe(false);
    expect(st.deploy.dir).toBe("");
    p.child.stdin.end();
    await p.done;
  }, 30_000);

  it("绑上 ⇒ 报出目录、run.bat 与 deploy_config，并给出可否部署", async () => {
    const ws = makeWorkspace("deploy-bound");
    const pluginDir = copyPlugin("deploy-bound");
    // 造一个"长得像部署工具"的目录：run.bat + 一个 deploy_config*.ps1
    const toolDir = path.join(dir, "maixcam2_deploy");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(path.join(toolDir, "run.bat"), "@echo off\r\n", "utf8");
    writeFileSync(path.join(toolDir, "deploy_config.digits.ps1"), "# fake\n", "utf8");

    const p = startPlugin(pluginDir, ws, { deploy: toolDir });
    await p.ready;
    const st = await p.call("panel.train.state", {});
    expect(st.deploy.bound, `绑了却报没绑：${JSON.stringify(st.deploy)}`).toBe(true);
    expect(st.deploy.dir.replace(/\\/g, "/")).toBe(toolDir.replace(/\\/g, "/"));
    expect(st.deploy.runBat).toBe(true);
    expect(st.deploy.configs).toEqual(["deploy_config.digits.ps1"]);
    expect(st.deploy.ready).toBe(true);
    p.child.stdin.end();
    await p.done;
  }, 30_000);
});

/* ============================================================================
   P175-W1 · 参数面不许写死 / 值的整形 / 投料口 / 开跑前摘要
   ============================================================================ */

describe("P175-W1 · 参数表由包自己驱动（详设 §4.2、§10 判据 2）", () => {
  it("探测结果少一个键，UI 就少一项——而不是报错，也不是照抄一份内置表", async () => {
    const { buildParamSpec } = await import("../../plugins/uartix.yolo/main.mjs");
    const full = buildParamSpec({
      keys: { epochs: ["int", 100], lr0: ["frac", 0.01], mosaic: ["frac", 1], optimizer: ["str", "auto"], cache: ["", false] },
      ultralytics: "8.4.102",
      degraded: false,
    });
    expect(full.groups.map((g) => g.id)).toEqual(["base", "optimizer", "augment", "perf"]);
    expect(full.count).toBe(6); // 5 个探测到的 + weights（工作区词汇，always）

    // 包升级后某个键没了 ⇒ 那一项必须从面板上消失（"面板有、引擎不认"是最坏的那种错）
    const less = buildParamSpec({ keys: { epochs: ["int", 100], optimizer: ["str", "auto"] }, ultralytics: "9.0.0", degraded: false });
    expect(less.groups.map((g) => g.id)).toEqual(["base", "optimizer"]);
    expect(less.groups[0].items.map((i) => i.key)).toEqual(["weights", "epochs"]);
    expect(less.count).toBe(3);
  });

  it("整组都没键就不出现空标题；探测失败只给最小集并说明", async () => {
    const { buildParamSpec } = await import("../../plugins/uartix.yolo/main.mjs");
    // 探到的键一个都不在元数据里：只剩 `weights`（它是工作区词汇，不是引擎键，永远要有入口）
    const none = buildParamSpec({ keys: { unlisted_engine_key: ["int", 1] }, ultralytics: "9.9.9", degraded: false });
    expect(none.groups.map((g) => g.id)).toEqual(["base"]);
    expect(none.groups[0].items.map((i) => i.key)).toEqual(["weights"]);
    expect(none.count).toBe(1);

    const deg = buildParamSpec({ keys: {}, ultralytics: "", degraded: true, error: "没有 pyyaml" });
    expect(deg.degraded).toBe(true);
    expect(deg.error).toBe("没有 pyyaml");
    const keys = deg.groups.flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toContain("epochs");
    expect(keys).toContain("save_period");
    expect(keys, "降级时不许把没探到的键吹成有").not.toContain("lr0");
    expect(deg.groups.map((g) => g.id), "微调组在降级态没有可给的键，不该留一个空标题").not.toContain("finetune");
  });
});

describe("P175-W1 · 快照里值的形状（引擎看得懂的那一份）", () => {
  it("数字字符串转成数字、空数字项整个不写、下拉里的 false/true 转成布尔", async () => {
    const { coerceTrain } = await import("../../plugins/uartix.yolo/main.mjs");
    const out = coerceTrain({ epochs: "300", lr0: "0.005", time: "", batch: "-1", cache: "false", amp: "true", device: "0", name: "e1" });
    expect(out.epochs).toBe(300);
    expect(out.lr0).toBe(0.005);
    expect(out.batch).toBe(-1);
    expect("time" in out, "空着 = 不传这一项，传个空串进去会变成长度为 0 的时限").toBe(false);
    expect(out.cache).toBe(false);
    expect(out.amp).toBe(true);
    expect(out.device, "device 是文本项：0 是第 0 块卡，cpu 是 CPU，都不该被当成数字").toBe("0");
    expect(out.name).toBe("e1");
  });

  it("新增的引擎参数原样进快照，并能被自己的解析器读回来", async () => {
    const mod = await import("../../plugins/uartix.yolo/main.mjs");
    const cfg = {
      env: { proxy_enable: false, proxy: "" },
      dataset: { sources: [], output_dir: "D:/WS/datasets/x", val_ratio: 0.2, seed: 7, classes: ["a"], label_map: {} },
      train: {
        weights: "D:/WS/models/yolo26n-seg.pt",
        epochs: 60,
        imgsz: 640,
        batch: -1,
        lr0: 0.005,
        mosaic: 0.5,
        freeze: 10,
        copy_paste_mode: "mixup",
        optimizer: "MuSGD",
        cache: false,
        save_period: -1,
      },
    };
    const text = mod.dumpConfig(cfg);
    expect(text).toMatch(/^ {2}lr0: 0\.005$/m);
    expect(text).toMatch(/^ {2}optimizer: "MuSGD"$/m);
    expect(text).toMatch(/^ {2}cache: false$/m);
    expect(text).toMatch(/^ {2}batch: -1$/m);
    expect(mod.parseSimpleYaml(text).train).toEqual(cfg.train);
  });

  it("界面文案与生成的命令里不许出现 half（它已被 quantize 取代）", () => {
    const panel = readFileSync(path.join(PLUGIN_SRC, "panel.html"), "utf8");
    const main = readFileSync(path.join(PLUGIN_SRC, "main.mjs"), "utf8");
    const runner = readFileSync(path.join(PLUGIN_SRC, "runner", "train_job.py"), "utf8");
    for (const [name, text] of [["panel.html", panel], ["main.mjs", main], ["train_job.py", runner]]) {
      expect(text, `${name} 里出现了 half= 这种旧写法`).not.toMatch(/\bhalf\s*[:=]/);
    }
  });
});

describe("P175-W1 · 投料口与开跑前摘要", () => {
  it("precheck 让 runner 真的解析一遍：新增参数在 overrides 里，没工作区时也不抛", async () => {
    const ws = makeWorkspace("pre");
    const pluginDir = copyPlugin("pre");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const st = await p.call("panel.train.saveConfig", { train: { lr0: 0.005 } });
      expect(st.trainRuns, "预览快照不许混进 train_runs/（那一次都没开训）").toEqual([]);
      const r = await p.call("panel.train.precheck", { train: { epochs: 9 } });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.overrides.lr0).toBe(0.005);
      expect(r.overrides.epochs).toBe(9);
      expect(existsSync(path.join(ws, ".uartix", "yolo", "preview.yaml")), "预览要落在插件自己的状态目录里").toBe(true);
      // 预览之后，工作区里用户那批文件仍然一个没动
      expect(existsSync(path.join(ws, "train_runs")), "只预览不该创建实验快照目录里的文件").toBe(false);
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 60_000);

  it("投料口：只数不写；登记素材只动面板覆盖；名字来自盘上的目录，不给拼路径的机会", async () => {
    const ws = makeWorkspace("intake");
    const pluginDir = copyPlugin("intake");
    fakeRunner(pluginDir);
    const guard = userFilesFingerprint(ws);
    const before = readdirSync(ws).sort().filter((n) => n !== ".uartix"); // 插件自己的状态目录允许出现，其它一律不许
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const st = await p.call("panel.train.state", {});
      expect(st.intake.subdirs.map((s) => s.name)).toEqual(["第二批数字"]);

      // 目录没了才谈"建"：建完只多一个空目录，别的一个文件都不多
      rmSync(path.join(ws, "annotations"), { recursive: true, force: true });
      const made = await p.call("panel.train.intakeEnsure", {});
      expect(existsSync(path.join(ws, "annotations"))).toBe(true);
      expect(readdirSync(path.join(ws, "annotations"))).toEqual([]);
      expect(fwd(made.dir)).toBe(fwd(path.join(ws, "annotations")));

      // 重新数一遍后能登记成素材来源（只写 .uartix/yolo/config.json）
      mkdirSync(path.join(ws, "annotations", "第三批"), { recursive: true });
      writeFileSync(path.join(ws, "annotations", "第三批", "x.jpg"), "x");
      const used = await p.call("panel.train.intakeUse", "第三批");
      expect(used.config.effective.dataset.sources).toContain(fwd(path.join(ws, "annotations", "第三批")));
      expect(JSON.parse(readFileSync(path.join(ws, ".uartix", "yolo", "config.json"), "utf8")).dataset.sources).toEqual([
        "D:/fake/anno/one",
        "D:/fake/anno/two",
        fwd(path.join(ws, "annotations", "第三批")),
      ]);

      // 越界的名字必须拒：这条防的是"面板传什么路径就拼什么"，那样读到的就不是投料口里的东西了
      const bad = await p.call("panel.train.intakeUse", "../../config.yaml").then(
        () => null,
        (e) => String(e.message || e),
      );
      expect(bad, "带 .. 的名字被接受了").toBeTruthy();
      expect(readdirSync(ws).sort().filter((n) => n !== ".uartix"), "登记素材不该在工作区里造出新东西").toEqual(before);
      assertUntouched(guard, ws, "投料口整轮操作之后");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 60_000);
});
