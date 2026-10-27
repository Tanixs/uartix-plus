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
    if (e.name === "node_modules" || e.name === ".versions" || e.name === "logs" || e.name === "__pycache__") continue;
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
      "console.log('[工作台自检] 不替用户装包: ' + (process.env.YOLO_AUTOINSTALL === 'false' && process.env.PYTHONIOENCODING === 'utf-8'));",
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
      // 等的是"真起一个子进程并跑完"：并行跑测试时这台机器会抢 CPU，上限给到 45 秒（跑得快时仍是 1 秒内返回）
      }, 45_000, "任务结束");

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
      // 端到端试用撞出来的两条：探针/子进程必须按 UTF-8 收，且不许让 ultralytics 替用户 pip install
      expect(
        logs.some((l) => l.text.includes("不替用户装包: true")),
        "子进程没拿到 YOLO_AUTOINSTALL=false / PYTHONIOENCODING=utf-8 —— 它会偷偷装包，中文也会串味",
      ).toBe(true);
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
  }, 90_000);
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
    const err = await p.call("panel.train.deployStart", { cfgName: "x.ps1", step: "validate" }).then(
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
    const evalRunner = readFileSync(path.join(PLUGIN_SRC, "runner", "eval_job.py"), "utf8");
    const exportRunner = readFileSync(path.join(PLUGIN_SRC, "runner", "export_job.py"), "utf8");
    for (const [name, text] of [
      ["panel.html", panel],
      ["main.mjs", main],
      ["train_job.py", runner],
      ["eval_job.py", evalRunner],
      ["export_job.py", exportRunner],
    ]) {
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
  }, 90_000);

  it("投料口：只数不写；登记素材只动面板覆盖；名字来自盘上的目录，不给拼路径的机会", async () => {
    const ws = makeWorkspace("intake");
    const pluginDir = copyPlugin("intake");
    fakeRunner(pluginDir);
    const guard = userFilesFingerprint(ws);
    // 牢笼判据（比白名单枚举更狠）：**只有清单里声明过的写目录**允许出现/变化。
    // 以后谁给插件加一枚写目录，这条会自动跟上；反过来，插件在工作区里造出一个没声明的东西就红。
    const declared = new Set(
      JSON.parse(readFileSync(path.join(PLUGIN_SRC, "plugin.json"), "utf8")).permissions.fs.write.map((w) => String(w).replace("$WS/", "")),
    );
    expect(declared.size, "清单里的写目录一个都没读到，这条判据是空的").toBeGreaterThanOrEqual(6);
    const outsideCage = (list) => list.filter((n) => !declared.has(n));
    const before = outsideCage(readdirSync(ws)).sort();
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

      /* ---- 用户裁定：素材夹留空时，「构建数据集」直接从投料口取 ---- */
      const cleared = await p.call("panel.train.saveConfig", { dataset: { sources: [] } });
      expect(cleared.dataset.sourcesFrom, "留空却没落到投料口").toBe("intake");
      expect(cleared.dataset.resolvedSources).toEqual([fwd(path.join(ws, "annotations", "第三批"))]);
      const ds = await p.call("panel.train.startDataset", {});
      await p.waitFor(() => {
        const jobs = p.events.filter((e) => e.event === "job").map((e) => e.payload);
        return jobs.find((j) => j.id === ds.id && j.state !== "running");
      }, 45_000, "数据集任务结束");
      const dlogs = p.events.filter((e) => e.event === "log").flatMap((e) => e.payload.lines);
      expect(dlogs.some((l) => /素材来源: 投料口 annotations\/ 自动取的 1 批/.test(l.text)), JSON.stringify(dlogs.slice(0, 8))).toBe(true);

      expect(outsideCage(readdirSync(ws)).sort(), "牢笼外的东西不许出现或变化").toEqual(before);
      assertUntouched(guard, ws, "投料口整轮操作之后");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});

/* ============================================================================
   P175-W3 · 标注体检（只读）与增强预览
   ============================================================================ */

describe("P175-W3 · 体检的解析部分（纯函数）", () => {
  it("一行标注解析成形状、越界与类别计数", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uartix-label-"));
    const f = path.join(dir, "a.txt");
    writeFileSync(
      f,
      [
        "0 0.5 0.5 0.2 0.2", // 合法框
        "1 1.2 0.5 0.2 0.2", // 坐标越界
        "2 0.1 0.1 0.4 0.1 0.4 0.4", // 3 点多边形
        "0 0.1 0.1 0.4 0.1 0.4 0.4 0.1 0.1", // 4 点（和 OBB 同形状）
        "x 1 2 3", // 非法
        "", // 空行不算
      ].join("\n"),
      "utf8",
    );
    const { parseLabelFile } = await import("../../plugins/uartix.yolo/main.mjs");
    const r = parseLabelFile(f);
    expect(r.boxes).toBe(2); // 越界那一行**也是**一个框：两件事要分开报，不许互相吞掉
    expect(r.polys).toBe(1);
    expect(r.quads).toBe(1);
    expect(r.outOfBounds).toBe(1);
    expect(r.bad).toBe(1);
    expect(r.classes).toEqual({ 0: 2, 1: 1, 2: 1 });
    expect(r.ids).toEqual([0, 1, 2, 0]);
    expect(parseLabelFile(path.join(dir, "nope.txt"))).toBeNull();
  });

  it("data.yaml 的 names 两种写法都要读得出来", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uartix-dy-"));
    const f = path.join(dir, "data.yaml");
    const { readDataYaml } = await import("../../plugins/uartix.yolo/main.mjs");
    writeFileSync(f, "path: D:/x\ntrain: images/train\nval: images/val\nnc: 3\nnames: ['1', '2', '3']\n", "utf8");
    expect(readDataYaml(f)).toMatchObject({ exists: true, nc: 3, names: ["1", "2", "3"] });
    writeFileSync(f, "nc: 2\nnames:\n  0: cat\n  1: dog\n", "utf8");
    expect(readDataYaml(f)).toMatchObject({ nc: 2, names: ["cat", "dog"] });
    expect(readDataYaml(path.join(dir, "nope.yaml")).exists).toBe(false);
  });
});

describe("P175-W3 · 体检走真插件（只读判据）", () => {
  /** 在假工作区的数据集里种下几类真问题，看体检抓不抓得住。 */
  function plantDataset(ws) {
    const img = (split, name) => writeFileSync(path.join(ws, "datasets", "x", "images", split, name), "x");
    const lbl = (split, name, text) => {
      mkdirSync(path.join(ws, "datasets", "x", "labels", split), { recursive: true });
      writeFileSync(path.join(ws, "datasets", "x", "labels", split, name), text, "utf8");
    };
    img("train", "a0.jpg");
    img("train", "a1.jpg");
    img("train", "shared.jpg"); // 与 val 同名 → 泄漏
    img("val", "v0.jpg");
    img("val", "shared.jpg");
    lbl("train", "a0.txt", "0 0.5 0.5 0.2 0.2\n");
    lbl("train", "a1.txt", "1 1.4 0.5 0.2 0.2\n"); // 越界
    lbl("train", "shared.txt", ""); // 空标签
    lbl("train", "orphan.txt", "0 0.5 0.5 0.2 0.2\n"); // 没有同名图片
    lbl("val", "v0.txt", "7 0.5 0.5 0.2 0.2\n"); // 类别 id 7 而 nc=3
    lbl("val", "shared.txt", "0 0.5 0.5 0.2 0.2\n");
    writeFileSync(path.join(ws, "datasets", "x", "data.yaml"), "path: D:/x\ntrain: images/train\nval: images/val\nnc: 3\nnames: ['1', '2', '3']\n", "utf8");
  }

  it("越界 / 空标签 / 孤儿标签 / 泄漏 / nc 不匹配 / 缺类 全被抓到，且标签文件一个字节没变", async () => {
    const ws = makeWorkspace("audit");
    plantDataset(ws);
    const labelsBefore = {};
    for (const split of ["train", "val"]) {
      const d = path.join(ws, "datasets", "x", "labels", split);
      // 键里带上 split：两个 split 里有同名文件（这正是我种的泄漏用例），只按文件名会互相覆盖
      for (const f of readdirSync(d)) labelsBefore[split + "/" + f] = { text: readFileSync(path.join(d, f), "utf8"), mtime: statSync(path.join(d, f)).mtimeMs };
    }
    const pluginDir = copyPlugin("audit");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    let a;
    try {
      await p.ready;
      a = await p.call("panel.train.audit", "");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
    const keys = a.findings.map((f) => f.key);
    expect(keys, JSON.stringify(a.findings)).toContain("outOfBounds");
    expect(keys).toContain("emptyLabels");
    expect(keys).toContain("orphanLabels");
    expect(keys).toContain("leak");
    expect(keys).toContain("ncMismatch");
    expect(a.leakNames).toEqual(["shared"]);
    expect(a.missingClasses, "类别 3 一次都没出现，该报缺类").toEqual(["3"]);
    expect(a.splits.train.images).toBe(4); // 假工作区自带 a0~a2，加上种下去的 shared
    expect(a.splits.val.images).toBe(3);
    expect(a.splits.train.labels).toBe(4);
    expect(a.outOfBounds).toBe(1);
    // **只读判据**：体检一个标签文件都不许改
    for (const split of ["train", "val"]) {
      const d = path.join(ws, "datasets", "x", "labels", split);
      for (const f of readdirSync(d)) {
        const key = split + "/" + f;
        expect(readFileSync(path.join(d, f), "utf8"), `体检改了 ${f}`).toBe(labelsBefore[key].text);
        expect(statSync(path.join(d, f)).mtimeMs, `体检碰了 ${f} 的 mtime`).toBe(labelsBefore[key].mtime);
      }
    }
  }, 90_000);

  it("增强预览只给训练产物里的 train_batchN.jpg，别的路径一律拒", async () => {
    const ws = makeWorkspace("preview");
    mkdirSync(path.join(ws, "runs", "exp1"), { recursive: true });
    writeFileSync(path.join(ws, "runs", "exp1", "train_batch0.jpg"), "fakejpegbytes");
    const pluginDir = copyPlugin("preview");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const st = await p.call("panel.train.state", {});
      expect(st.batches.map((b) => b.run + "/" + b.name)).toEqual(["exp1/train_batch0.jpg"]);
      const ok = await p.call("panel.train.previewImage", path.join(ws, "runs", "exp1", "train_batch0.jpg").replace(/\\/g, "/"));
      expect(ok.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
      for (const [what, file] of [
        ["越出训练产物目录", path.join(ws, "config.yaml").replace(/\\/g, "/")],
        ["只给任意 jpg 也不行", path.join(ws, "datasets", "x", "images", "train", "a0.jpg").replace(/\\/g, "/")],
      ]) {
        const err = await p.call("panel.train.previewImage", file).then(
          () => null,
          (e) => String(e.message || e),
        );
        expect(err, what).toBeTruthy();
      }
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});

/* ============================================================================
   P175-W4 · 监控（曲线 / ETA / 显存 / 失败归类）
   ============================================================================ */

/** 真 `results.csv` 的形状（分割任务：loss 有 seg_loss，指标有 (B) 与 (M) 两组）。 */
const CSV_FIXTURE = [
  "epoch,        time,        train/box_loss,        train/seg_loss,        train/cls_loss,        train/dfl_loss,        metrics/precision(B),        metrics/recall(B),        metrics/mAP50(B),        metrics/mAP50-95(B),        metrics/precision(M),        metrics/recall(M),        metrics/mAP50(M),        metrics/mAP50-95(M),        val/box_loss,        val/seg_loss,        val/cls_loss,        val/dfl_loss,        lr/pg0,        lr/pg1,        lr/pg2",
  "1,         12.5,         1.2,         2.1,         1.8,         1.5,         0.30,         0.20,         0.250,         0.150,         0.28,         0.19,         0.230,         0.130,         1.1,         2.0,         1.7,         1.4,         0.001,         0.001,         0.001",
  "2,         25.0,         1.0,         1.7,         1.2,         1.2,         0.55,         0.41,         0.610,         0.400,         0.50,         0.38,         0.560,         0.360,         0.9,         1.6,         1.1,         1.0,         0.002,         0.002,         0.002",
  "3,         37.5,         0.8,         1.3,         0.9,         1.0,         0.72,         0.60,         0.810,         0.580,         0.70,         0.55,         0.770,         0.540,         0.7,         1.2,         0.9,         0.8,         0.003,         0.003,         0.003",
].join("\n");

describe("P175-W4 · 监控的解析与归类（纯函数）", () => {
  it("results.csv：列名去空白、值转数字、半行不报错", async () => {
    const { parseResultsCsv } = await import("../../plugins/uartix.yolo/main.mjs");
    const p = parseResultsCsv(CSV_FIXTURE);
    expect(p.columns[0]).toBe("epoch");
    expect(p.columns).toContain("train/seg_loss");
    expect(p.rows).toHaveLength(3);
    expect(p.rows[2]["metrics/mAP50(M)"]).toBe(0.77);
    expect(p.rows[1].time).toBe(25);
    expect(parseResultsCsv("epoch,time\n1,3").rows[0]).toEqual({ epoch: 1, time: 3 });
    expect(parseResultsCsv("epoch,time\n1").rows).toEqual([]); // 引擎正在写的半行
    expect(parseResultsCsv("").rows).toEqual([]);
  });

  it("只画实际存在的列；抽稀永远保留最后一个点", async () => {
    const m = await import("../../plugins/uartix.yolo/main.mjs");
    const p = m.parseResultsCsv(CSV_FIXTURE);
    const c = m.chartColumns(p.columns);
    // 按**规范顺序**给列，不是 csv 里的列序：列顺序变了（引擎改名/换序）也不影响画哪几条线
    expect(c.loss).toEqual(["train/box_loss", "train/cls_loss", "train/dfl_loss", "train/seg_loss"]);
    expect(c.map).toEqual(["metrics/mAP50(B)", "metrics/mAP50-95(B)", "metrics/mAP50(M)", "metrics/mAP50-95(M)"]);
    expect(m.chartColumns(["epoch"]).loss).toEqual([]);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ epoch: i + 1 }));
    const d = m.downsample(rows, 120);
    expect(d.length).toBeGreaterThanOrEqual(120);
    expect(d[d.length - 1]).toBe(rows[999]);
    expect(m.downsample(rows.slice(0, 3), 120)).toHaveLength(3);
  });

  it("失败归类：OOM / 路径 / 网络 / 用户停止 / 认不出来", async () => {
    const { classifyFailure } = await import("../../plugins/uartix.yolo/main.mjs");
    expect(classifyFailure(["bla", "torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB"]).kind).toBe("oom");
    expect(classifyFailure(["FileNotFoundError: [Errno 2] data.yaml"]).kind).toBe("path");
    expect(classifyFailure(["urllib.error.URLError: timed out"]).kind).toBe("download");
    expect(classifyFailure(["Label length 7 is not valid"]).kind).toBe("labels");
    expect(classifyFailure(["RuntimeError: 'lr0' is not a valid YOLO argument"]).kind).toBe("version");
    expect(classifyFailure(["[工作台] 用户要求停止"]).kind).toBe("stopped");
    expect(classifyFailure(["something weird"]).kind).toBe("unknown");
    expect(classifyFailure([])).toBeNull();
    // 每条归类都得给得出下一步做什么，否则等于没说
    for (const line of ["CUDA out of memory", "FileNotFoundError", "URLError", "Label length", "not a valid YOLO argument", "no CUDA GPUs are available"]) {
      const f = classifyFailure([line]);
      expect(f.advice, `${line} 这一类没给建议`).toBeTruthy();
      expect(f.label).toBeTruthy();
    }
  });
});

describe("P175-W4 · 监控走真插件", () => {
  it("现成的 results.csv 能离线读出曲线、进度与 ETA", async () => {
    const ws = makeWorkspace("mon");
    writeFileSync(path.join(ws, "runs", "exp1", "results.csv"), CSV_FIXTURE, "utf8");
    const pluginDir = copyPlugin("mon");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const m = await p.call("panel.train.monitor", "exp1");
      expect(m.ok, JSON.stringify(m)).toBe(true);
      expect(m.run).toBe("exp1");
      expect(m.rows).toHaveLength(3);
      expect(m.doneEpoch).toBe(3);
      expect(m.epochs).toBe(50); // 基准 config.yaml 里的 epochs
      expect(m.percent).toBe(6);
      expect(m.perEpochSec).toBeCloseTo(12.5, 1); // 37.5 秒 / 3 轮
      expect(m.remainText).toBeTruthy(); // 还剩 47 轮的估算
      expect(m.chart.map).toContain("metrics/mAP50(M)");
      expect(m.chart.loss).toContain("train/seg_loss");
      expect(m.lastRow["metrics/mAP50-95(B)"]).toBe(0.58);
      expect(typeof m.mem.ok).toBe("boolean");
      if (m.mem.ok) expect(m.mem.percent).toBeGreaterThanOrEqual(0);
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);

  it("任务失败后，监控里带着归类和下一步", async () => {
    const ws = makeWorkspace("monfail");
    const pluginDir = copyPlugin("monfail");
    fakeRunner(pluginDir);
    // 把假 runner 改成"以 OOM 退出"
    writeFileSync(
      path.join(pluginDir, "runner", "train_job.py"),
      [
        "console.log('[信息] ========== 开始训练 ==========');",
        "console.log('torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB');",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const job = await p.call("panel.train.startTrain", {});
      const fin = await p.waitFor(() => {
        const jobs = p.events.filter((e) => e.event === "job").map((e) => e.payload);
        return jobs.find((j) => j.id === job.id && j.state !== "running");
      // 等的是"真起一个子进程并跑完"：并行跑测试时这台机器会抢 CPU，上限给到 45 秒（跑得快时仍是 1 秒内返回）
      }, 45_000, "任务结束");
      expect(fin.state).toBe("failed");
      // 归类那行是 120ms 一批推出来的，别和它抢：等到日志里出现再断言
      await p.waitFor(
        () => p.events.some((e) => e.event === "log" && e.payload.lines.some((l) => /失败归类/.test(l.text))),
        10_000,
        "失败归类那行日志",
      );
      const logs = p.events.filter((e) => e.event === "log").flatMap((e) => e.payload.lines);
      expect(logs.some((l) => /失败归类：显存/.test(l.text)), "日志里没给失败归类").toBe(true);
      const m = await p.call("panel.train.monitor", "");
      expect(m.failure, "监控里没有失败结论").toBeTruthy();
      expect(m.failure.kind).toBe("oom");
      expect(m.failure.advice).toContain("batch");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});

/* ============================================================================
   P175-W5 · 评估与对比
   ============================================================================ */

describe("P175-W5 · 参数差异（纯函数）", () => {
  it("只比两边都有的标量；嵌套结构一边缺的都跳过", async () => {
    const { diffArgs } = await import("../../plugins/uartix.yolo/main.mjs");
    const d = diffArgs(
      { epochs: 300, imgsz: 640, lr0: 0.01, batch: 16, names: { 0: "a" }, onlyA: 1, same: 1 },
      { epochs: 100, imgsz: 640, lr0: 0.005, batch: -1, names: { 0: "b" }, onlyB: 2, same: 1 },
    );
    expect(d.map((x) => x.key)).toEqual(["batch", "epochs", "lr0"]);
    expect(d.find((x) => x.key === "batch").b).toBe(-1);
    expect(diffArgs({}, {})).toEqual([]);
  });
});

describe("P175-W6 · 导出矩阵与端侧约束", () => {
  it("格式矩阵：id 唯一、没有 tflite 这种别名、没有 half", async () => {
    const m = await import("../../plugins/uartix.yolo/main.mjs");
    const ids = m.EXPORT_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("onnx");
    expect(ids).toContain("openvino");
    expect(ids).toContain("engine");
    expect(ids).toContain("rknn");
    expect(ids, "tflite 是 saved_model 的别名，不该单列一个看起来像独立选项的东西").not.toContain("tflite");
    for (const f of m.EXPORT_FORMATS) expect(f.label).toBeTruthy();
  });

  it("端侧约束：分割模型上不了 MaixCam 在线转换器；额外要 SDK 的格式会提前说", async () => {
    const m = await import("../../plugins/uartix.yolo/main.mjs");
    const seg = m.exportAdvice("onnx", "segment", {});
    expect(seg.some((x) => x.level === "bad" && /MaixCam/.test(x.text)), JSON.stringify(seg)).toBe(true);
    expect(m.exportAdvice("onnx", "detect", {}).some((x) => x.level === "bad")).toBe(false);
    const trt = m.exportAdvice("engine", "detect", {});
    expect(trt.some((x) => x.level === "warn" && /libnvinfer/.test(x.text)), JSON.stringify(trt)).toBe(true);
    expect(m.exportAdvice("onnx", "detect", { dynamic: true }).some((x) => /dynamic/.test(x.text))).toBe(true);
    expect(m.exportAdvice("onnx", "detect", { opset: 13 }).some((x) => /opset=17/.test(x.text))).toBe(true);
    // 端到端模型部署这条要提：否则用户会在端侧找"以前那段后处理代码"
    expect(m.exportAdvice("onnx", "detect", {}).some((x) => /NMS/.test(x.text))).toBe(true);
  });

  it("导出状态与历史读得回来；非法格式与不存在的权重直接拒", async () => {
    const ws = makeWorkspace("export");
    const dir = path.join(ws, "train_runs", "export", "20261027-010101");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "export.json"),
      JSON.stringify({ ok: true, format: "onnx", file: "D:/x/y.onnx", bytes: 12345, task: "segment", speed: { ok: true, msPerImage: 8.2, fps: 122, images: 10 } }),
      "utf8",
    );
    const pluginDir = copyPlugin("export");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const s = await p.call("panel.train.exportState", {});
      expect(s.formats.length).toBeGreaterThan(10);
      expect(s.cards[0].tasks).toEqual(["detect"]);
      expect(s.history[0].format).toBe("onnx");
      expect(s.weights.map((w) => w.name)).toEqual([]); // 假工作区里没有 .pt

      const bad = await p.call("panel.train.exportStart", { format: "tflite", weights: "models/yolo11n-seg.pt" }).then(
        () => null,
        (e) => String(e.message || e),
      );
      expect(bad, "别名格式没被拒").toBeTruthy();
      const missing = await p.call("panel.train.exportStart", { format: "onnx", weights: "models/没有这个.pt" }).then(
        () => null,
        (e) => String(e.message || e),
      );
      expect(missing, "权重不存在却没拒").toBeTruthy();
      expect(missing).toContain("权重");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});

describe("P175-W8 · 终态事件不能被空日志批吞掉", () => {
  /**
   * 回归：子进程的输出刚好在两个 120ms 日志批之间被冲完时，`finishJob` 里那次
   * `flushLog()` 的批是**空的**，early-return 顺带跳过了它唯一的 job 事件——
   * 表现是面板永远停在"运行中"，只有下一次任务开始才解冻。满载的测试机上这个
   * 竞态会被反复抓到，所以判据要让子进程**主动**走进那个时间窗，而不是指望真 runner 恰好那么慢。
   */
  it("安静地退出的子进程也必须发出 succeeded 终态事件", async () => {
    const ws = makeWorkspace("silent-exit");
    const pluginDir = copyPlugin("silent-exit");
    const runner = fakeRunner(pluginDir);
    // 只打印一行 → 忙等 600ms（>4 个日志批，让那一行被定时器冲干净）→ 无声退出
    writeFileSync(
      runner,
      [
        "console.log('[信息] 只此一行，之后再无输出');",
        "const t = Date.now();",
        "while (Date.now() - t < 600) { /* 占住子进程，不给插件任何新行 */ }",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const job = await p.call("panel.train.startTrain", {});
      expect(job.state).toBe("running");

      const terminal = await p.waitFor(() => {
        const jobs = p.events.filter((e) => e.event === "job").map((e) => e.payload);
        return jobs.find((j) => j.id === job.id && (j.state === "succeeded" || j.state === "failed"));
      }, 30_000, "这个任务自身的终态事件");

      expect(terminal.state, JSON.stringify(terminal)).toBe("succeeded");
      expect(terminal.code).toBe(0);
      // 终态那条"[工作台] 进程结束"仍要留在日志里（事件不丢，行也不丢）
      expect(terminal.total).toBeGreaterThanOrEqual(2);
      // 任务结束不该把 active 留成脏：下一次 startTrain 依旧立刻有事件流
      const again = await p.call("panel.train.startTrain", {});
      expect(again.state).toBe("running");
      const t2 = await p.waitFor(() => {
        const jobs = p.events.filter((e) => e.event === "job").map((e) => e.payload);
        return jobs.find((j) => j.id === again.id && j.state !== "running");
      }, 30_000, "第二次任务的终态事件");
      expect(t2.state, JSON.stringify(t2)).toBe("succeeded");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});

describe("P175 · 中文配置经过 python 探针不能变味", () => {
  const PY = "D:/projects/anaconda3/envs/yolo_env/python.exe";
  const hasPy = (() => {
    try {
      execFileSync(PY, ["--version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();
  const test = hasPy ? it : it.skip;

  /**
   * 端到端试用（真数据集 + 中文类别名）抓出来的 bug：读 `config.yaml` 走的是
   * "让工作区的 python `yaml.safe_load` 一遍"这条正路，而 python 在 Windows 上
   * 默认按**控制台代码页**（这台是 cp936）写 stdout，插件按 UTF-8 解 ——
   * `classes: ['圆','方']` 变成 `["Բ",""]`。它不报错，只把乱码写进快照，
   * 于是「构建数据集」exit 0、标注框 0 个。用户的类别名是数字，所以一直没撞上。
   */
  test("config.yaml 里的中文类别名必须原样回到面板上", async () => {
    const ws = makeWorkspace("utf8-cfg");
    writeFileSync(path.join(ws, "_env.bat"), `@echo off\r\nset "PYTHON_EXE=${PY.replace(/\//g, "\\")}"\r\n`, "utf8");
    const cfg = readFileSync(path.join(ws, "config.yaml"), "utf8").replace("classes: ['1', '2', '3']", "classes: ['圆', '方']");
    expect(cfg, "假工作区的 classes 行形状变了，这条判据要跟着改").toContain("classes: ['圆', '方']");
    writeFileSync(path.join(ws, "config.yaml"), cfg, "utf8");

    const p = startPlugin(copyPlugin("utf8-cfg"), ws);
    try {
      await p.ready;
      const st = await p.call("panel.train.state", {});
      expect(st.config.baseSource, "没走 python 探针（pyyaml 不在）——这条判据就白写了").toBe("python");
      expect(st.python.ok, JSON.stringify(st.python)).toBe(true);
      expect(st.config.effective.dataset.classes, "中文类别名被探针改味了").toEqual(["圆", "方"]);

      // 落到盘上的那份也要是同一串字节：乱码的真正代价在这里
      await p.call("panel.train.precheck", {});
      const bytes = readFileSync(path.join(ws, ".uartix", "yolo", "preview.yaml"));
      expect(bytes.includes(Buffer.from("圆", "utf8")), "preview.yaml 里没有「圆」的 UTF-8 字节").toBe(true);
      expect(bytes.includes(Buffer.from([0xd4, 0xb2])), "preview.yaml 里出现了「圆」的 GBK 字节").toBe(false);
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 180_000);
});

describe("P175 · 构建「退出码 0 但 0 个标注框」不能悄悄过去", () => {
  it("成功结束时也要把脚本自己打的账读回来提醒", async () => {
    const ws = makeWorkspace("dwarn");
    // 用户的 build_dataset.py 对"标签名不在类别表"只打警告然后正常退出 —— 这正是静默毁掉数据集的样子
    writeFileSync(
      path.join(ws, "scripts", "build_dataset.py"),
      [
        "console.log('[信息] 素材文件夹 D:/fake/anno/one : 10 个样本');",
        "console.log('[信息] 合计 10 个样本（重名自动改名 0 个）');",
        "console.log('[信息] 划分完成: 训练集 8 张 / 验证集 2 张 (val_ratio=0.20, seed=7)');",
        "console.log('[信息] ========== 数据集构建完成 ==========');",
        "console.log('[信息]   类别 圆 : 0 个标注框');",
        "console.log('[信息]   类别 方 : 0 个标注框');",
        "console.log('[警告]   跳过 标签[圆]不在类别表 : 12 个');",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    const p = startPlugin(copyPlugin("dwarn"), ws);
    try {
      await p.ready;
      await p.call("panel.train.startDataset", {});
      const j = await p.waitFor(() => {
        const jobs = p.events.filter((e) => e.event === "job").map((e) => e.payload);
        return jobs.find((x) => x.kind === "dataset" && x.state !== "running");
      }, 45_000, "构建任务结束");
      expect(j.state, "假脚本是正常退出的").toBe("succeeded");
      expect(j.code).toBe(0);
      expect(j.warning, "0 个标注框却没提醒").toContain("一个标注框都没落盘");
      expect(j.warning).toContain("12 个");
      // 反向自证：账对得上时不许乱叫
      expect(await datasetWarnOf(["[信息]   类别 圆 : 44 个标注框", "[信息] 合计 10 个样本"])).toBe("");
      expect(await datasetWarnOf(["[信息]   类别 圆 : 0 个标注框"])).toContain("一个标注框都没落盘");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);

  /** 直接拿插件自己的纯函数算，省得再起一个进程 —— 也证明这条判据测的是函数本身。 */
  async function datasetWarnOf(lines) {
    const m = await import("../../plugins/uartix.yolo/main.mjs");
    return m.datasetWarning(lines);
  }
});

/* ============================================================================
   P175-W8 · 页签完整性与"这个包发出去是完整的"
   ============================================================================ */


describe("P175-W8 · 收官体检", () => {
  const panelSrc = () => readFileSync(path.join(PLUGIN_SRC, "panel.html"), "utf8");

  it("每块页签都有 section，且切换时都被显式处理（R16 那类「点了什么都不显示」）", () => {
    const panel = panelSrc();
    const tabs = [...panel.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
    expect(new Set(tabs).size, "页签按钮重名").toBe(tabs.length);
    expect(tabs.length, "页签少成这样，这条判据是空的").toBeGreaterThanOrEqual(6);
    for (const t of tabs) {
      expect(panel.includes(`id="tab-${t}"`), `缺 section #tab-${t}`).toBe(true);
      expect(panel.includes(`$("tab-${t}").hidden = name !== "${t}"`), `切换时没处理 #tab-${t}：点了「${t}」会什么都不显示`).toBe(true);
    }
  });

  it("包里的每个代码文件都发得出去（发布白名单不收 .py 的话，装回来就是个哑插件）", () => {
    const walk = (d, acc = []) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "__pycache__" || e.name === "node_modules" || e.name === ".versions") continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) acc = walk(p, acc);
        else if (!/(\.log|\.pyc)$/i.test(e.name)) acc.push(e.name);
      }
      return acc;
    };
    const names = walk(PLUGIN_SRC);
    // 与 `pluginPublish.ts` 里那三条保持一致（改了发布规则就要改这里，两边不许各说一套）
    const TEXT_EXT = /\.(json|mjs|js|cjs|html|htm|css|md|txt|yaml|yml|svg|py|ps1)$/i;
    const TEXT_NAME = /^(license|copying|notice|readme|changelog|authors|contributing|todo)$/i;
    const IMAGE = /\.(png|jpe?g|webp|gif|ico)$/i;
    const skipped = names.filter((n) => !TEXT_EXT.test(n) && !TEXT_NAME.test(n) && !IMAGE.test(n));
    expect(skipped, `这些文件发布时会被当二进制跳过：${skipped.join("、")}`).toEqual([]);
    expect(names.filter((n) => n.endsWith(".py")).length, "三个 runner 都该在包里").toBeGreaterThanOrEqual(3);
    // 发布上限 12：超了会静默跳过后面的文件，而"后面的文件"很可能就是 runner
    expect(names.length, `包里有 ${names.length} 个文件，超过发布上限就会被静默跳过`).toBeLessThanOrEqual(12);
  });

  it("清单与 README 已经是 0.3.0，且面板帮助里写了这次新增的规矩", () => {
    const raw = JSON.parse(readFileSync(path.join(PLUGIN_SRC, "plugin.json"), "utf8"));
    expect(raw.version).toBe("0.3.0");
    const readme = readFileSync(path.join(PLUGIN_SRC, "README.md"), "utf8");
    expect(readme.split("## 版本")[1].slice(0, 40)).toContain("`0.3.0`");
    const panel = panelSrc();
    for (const must of ["annotations", "train_runs", "runner", "half", "last.pt", "YOLO26"]) {
      expect(panel.includes(must), `面板帮助里没讲清 "${must}" 这条规矩`).toBe(true);
    }
  });
});


describe("P175-W7 · 实验管理", () => {
  /** 造一个"跑完了一次"的 run：args.yaml + results.csv + weights/best.pt。 */
  function makeRun(ws, name, argsText) {
    const d = path.join(ws, "runs", name);
    mkdirSync(path.join(d, "weights"), { recursive: true });
    writeFileSync(path.join(d, "args.yaml"), argsText, "utf8");
    writeFileSync(path.join(d, "results.csv"), CSV_FIXTURE, "utf8");
    writeFileSync(path.join(d, "weights", "best.pt"), "best");
    writeFileSync(path.join(d, "weights", "last.pt"), "last");
    return d;
  }

  it("等价命令能反解回同一份参数（往返判据），.bat 只落 train_runs/bat/", async () => {
    const ws = makeWorkspace("runs");
    makeRun(
      ws,
      "exp1",
      [
        "task: segment",
        "model: D:/WS/models/yolo11n-seg.pt",
        "data: D:/WS/datasets/x/data.yaml",
        "epochs: 77",
        "imgsz: 512",
        "batch: 8",
        "lr0: 0.004",
        "project: D:/WS/runs",
        "name: exp1",
      ].join("\n"),
    );
    const guard = userFilesFingerprint(ws);
    const pluginDir = copyPlugin("runs");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const x = await p.call("panel.train.repro", { run: "exp1" });
      expect(x.ok).toBe(true);
      expect(x.commands.map((c) => c.id)).toEqual(["runner", "workspace", "cli"]);
      // 三条命令都得指向那份快照 / args.yaml，且带工作区里的路径（不是面板内部的临时目录）
      expect(x.commands[0].cmd).toContain("runner/train_job.py");
      expect(x.commands[1].cmd).toContain("scripts/train.py");
      expect(x.commands[2].cmd).toContain("args.yaml");

      // **往返判据**：等价命令指向的快照，用插件自己的解析器读回来，参数得和 args.yaml 一致
      const mod = await import("../../plugins/uartix.yolo/main.mjs");
      const back = mod.parseSimpleYaml(x.text);
      expect(back.train.epochs).toBe(77);
      expect(back.train.imgsz).toBe(512);
      expect(back.train.lr0).toBe(0.004);
      expect(back.train.task).toBe("segment");
      expect(back.train.weights).toBe("D:/WS/models/yolo11n-seg.pt");

      const bat = await p.call("panel.train.saveReproBat", { run: "exp1", which: "workspace" });
      expect(bat.file.replace(/\\/g, "/")).toContain("/train_runs/bat/");
      expect(existsSync(bat.file)).toBe(true);
      const body = readFileSync(bat.file, "utf8");
      expect(body).toContain("train.py");
      expect(body).toContain("--config");
      // 编号脚本那批不许多出一个字节
      assertUntouched(guard, ws, "生成复现 .bat 之后");
      expect(readdirSync(ws).filter((f) => /^\d\d_.*\.bat$/.test(f))).toEqual(["03_train.bat"]);

      const bad = await p.call("panel.train.repro", { run: "没有这个run" }).then(
        () => null,
        (e) => String(e.message || e),
      );
      expect(bad, "不存在的 run 却没拒").toBeTruthy();
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);

  it("备注落在 train_runs/<实验>.note；归档只复制不搬走", async () => {
    const ws = makeWorkspace("archive");
    const dir = makeRun(ws, "exp1", "task: segment\nepochs: 3\nname: exp1\nproject: D:/WS/runs\n");
    const pluginDir = copyPlugin("archive");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const listed = await p.call("panel.train.experiments", {});
      expect(listed.runs[0].name).toBe("exp1");
      expect(listed.runs[0].task).toBe("segment");
      expect(listed.runs[0].epochs).toBe(3);
      expect(listed.runs[0].hasBest).toBe(true);

      const noted = await p.call("panel.train.saveNote", { run: "exp1", text: "这版把 mosaic 降到 0.5" });
      expect(noted.note).toContain("mosaic");
      expect(existsSync(path.join(ws, "train_runs", "exp1.note"))).toBe(true);
      // runs/ 里不许多出备注文件
      expect(readdirSync(dir).sort()).toEqual(["args.yaml", "results.csv", "weights"]);

      const arch = await p.call("panel.train.archiveRun", { run: "exp1" });
      expect(arch.moved, "归档把用户的产物搬走了").toBe(false);
      expect(arch.copied.sort()).toEqual(["args.yaml", "results.csv", "weights/best.pt"]);
      expect(existsSync(path.join(ws, "runs", "exp1", "results.csv")), "归档之后 runs/ 里的原件没了").toBe(true);
      expect(arch.dst.replace(/\\/g, "/")).toContain("/archive/exp1-");
      for (const f of ["args.yaml", "results.csv"]) {
        expect(readFileSync(path.join(arch.dst, f), "utf8")).toBe(readFileSync(path.join(dir, f), "utf8"));
      }

      const cleared = await p.call("panel.train.saveNote", { run: "exp1", text: "   " });
      expect(cleared.note).toBe("");
      expect(existsSync(path.join(ws, "train_runs", "exp1.note")), "清空备注后文件还在").toBe(false);
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});

describe("P175-W5 · 参数面与调用形状", () => {
  /** 扫面板里所有 `uartix.call(...)`，数最外层逗号（= 参数个数 - 1）。 */
  function callSites(src) {
    const re = /uartix\.call\(/g;
    const out = [];
    while (re.exec(src)) {
      let i = re.lastIndex;
      let depth = 1;
      let commas = 0;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) break;
        } else if (ch === "," && depth === 1) commas++;
        i++;
      }
      out.push({ commas, snippet: src.slice(re.lastIndex, Math.min(i, src.length)).replace(/\s+/g, " ").slice(0, 70) });
      re.lastIndex = i;
    }
    return out;
  }

  it("桥只转发 (method, args) 一个载荷 ⇒ 面板里不许出现三个参数的 uartix.call", () => {
    const panel = readFileSync(path.join(PLUGIN_SRC, "panel.html"), "utf8");
    const sites = callSites(panel);
    expect(sites.length, "一条 uartix.call 都没扫到，这条判据是空的").toBeGreaterThan(10);
    const bad = sites.filter((s) => s.commas > 1);
    expect(bad.map((b) => b.snippet), "这些调用传了第三个参数：插件那边永远收不到（曾经让「只检查环境」实际跑成全流程）").toEqual([]);
  });

  it("插件侧注册的每个面板方法都只有一个形参", () => {
    const main = readFileSync(path.join(PLUGIN_SRC, "main.mjs"), "utf8");
    const re = /^\s{4}(?:async )?([A-Za-z][\w]*)\(([^)]*)\) \{/gm;
    const multi = [];
    let m;
    while ((m = re.exec(main))) {
      const params = m[2].trim();
      if (!params) continue;
      if (params.includes(",")) multi.push(`${m[1]}(${params})`);
    }
    expect(multi, "这些插件方法声明了多个位置参数，桥只会送到第一个").toEqual([]);
  });
});

describe("P175-W5 · 评估状态与图（走真插件）", () => {
  /** 在 train_runs/eval/ 里种一份"上次评估的结果"，让面板能把它读回来。 */
  function plantEval(ws, name, result) {
    const dir = path.join(ws, "train_runs", "eval", name);
    mkdirSync(path.join(dir, "val"), { recursive: true });
    writeFileSync(path.join(dir, "eval.json"), JSON.stringify(result), "utf8");
    writeFileSync(path.join(dir, "val", "confusion_matrix.png"), "fakepng", "utf8");
    return dir;
  }

  it("evalState 读得回历史与可选权重；evalImage 只认白名单文件名与评估目录", async () => {
    const ws = makeWorkspace("eval");
    mkdirSync(path.join(ws, "models", "delivered"), { recursive: true });
    writeFileSync(path.join(ws, "models", "delivered", "digits-best.pt"), "x");
    mkdirSync(path.join(ws, "datasets", "x", "labels", "train"), { recursive: true });
    writeFileSync(path.join(ws, "datasets", "x", "labels", "train", "a0.txt"), "0 0.5 0.5 0.2 0.2\n", "utf8");
    const outDir = path.join(ws, "train_runs", "eval", "20261027-010101").replace(/\\/g, "/");
    plantEval(ws, "20261027-010101", {
      ok: true,
      weights: "D:/WS/models/delivered/digits-best.pt",
      data: "D:/WS/datasets/x/data.yaml",
      task: "segment",
      imgsz: 640,
      conf: 0.25,
      out: outDir,
      metrics: { "map50(B)": 0.91, "map50_95(B)": 0.62, "map50(M)": 0.88 },
      confTable: [{ conf: 0.25, precision: 0.9, recall: 0.85 }],
      plots: ["confusion_matrix.png"],
      errors: [],
      speedMs: 12.3,
    });
    const pluginDir = copyPlugin("eval");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const s = await p.call("panel.train.evalState", {});
      expect(s.last, JSON.stringify(s.history)).toBeTruthy();
      expect(s.last.metrics["map50(B)"]).toBe(0.91);
      expect(s.weights.map((w) => w.name)).toContain("digits-best.pt");
      expect(s.datasets.map((d) => d.name)).toContain("x");
      expect(s.current.data.replace(/\\/g, "/")).toContain("datasets/x/data.yaml");

      const img = await p.call("panel.train.evalImage", { dir: s.last.out, name: "confusion_matrix.png" });
      expect(img.dataUrl).toMatch(/^data:image\/png;base64,/);

      for (const [what, dir, name] of [
        ["白名单外的文件名要拒", s.last.out, "../../config.yaml"],
        ["不在评估目录下的要拒", path.join(ws, "runs", "exp1").replace(/\\/g, "/"), "confusion_matrix.png"],
      ]) {
        const err = await p.call("panel.train.evalImage", { dir, name }).then(
          () => null,
          (e) => String(e.message || e),
        );
        expect(err, what).toBeTruthy();
      }
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);

  it("两个 run 能对比出参数差异，并各自带回曲线", async () => {
    const ws = makeWorkspace("cmp");
    for (const [name, epochs, lr] of [["exp1", 300, 0.01], ["exp2", 100, 0.005]]) {
      const d = path.join(ws, "runs", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "args.yaml"), `epochs: ${epochs}\nlr0: ${lr}\nimgsz: 640\nname: ${name}\n`, "utf8");
      writeFileSync(path.join(d, "results.csv"), CSV_FIXTURE, "utf8");
    }
    const pluginDir = copyPlugin("cmp");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const r = await p.call("panel.train.compareRuns", { a: "exp1", b: "exp2" });
      expect(r.ok).toBe(true);
      expect(r.diff.map((x) => x.key)).toEqual(["epochs", "lr0", "name"]); // 夹具里这三项就是不一样的
      expect(r.a.rows.length).toBe(3);
      expect(r.a.chart.map).toContain("metrics/mAP50(B)");
      const bad = await p.call("panel.train.compareRuns", { a: "exp1", b: "" }).then(
        () => null,
        (e) => String(e.message || e),
      );
      expect(bad, "没选两个 run 却没拒").toBeTruthy();
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});

/* ============================================================================
   P175-W2 · 模型代际（只 11 / 26）与任务
   ============================================================================ */

describe("P175-W2 · 代际、任务与续训的判断（纯函数）", () => {
  it("官方名只有两代、两种任务；文件名推断不出来就承认不知道", async () => {
    const m = await import("../../plugins/uartix.yolo/main.mjs");
    const names = m.officialModels();
    expect(names).toHaveLength(20); // 两代 × 五档 × (检测 / 分割)
    for (const x of names) {
      expect(x.name).toMatch(/^yolo(11|26)[nsmlx](-seg)?\.pt$/);
      expect(["detect", "segment"]).toContain(x.task);
    }
    expect(names.map((x) => x.name).join(",")).not.toMatch(/v5/);
    expect(m.MODEL_FAMILIES.map((f) => f.id)).toEqual(["yolo11", "yolo26"]);

    expect(m.inferWeights("models/yolo11n-seg.pt").task).toBe("segment");
    expect(m.inferWeights("D:/WS/models/yolo26n.pt")).toMatchObject({ family: "yolo26", scale: "n", task: "detect", known: true });
    expect(m.inferWeights("runs/exp/weights/best.pt").known, "best.pt 什么也推不出来，不许假装推得出").toBe(false);
    expect(m.inferWeights("yolo11n-pose.pt").known, "姿态不在范围内").toBe(false);
  });

  it("任务与权重不搭要拦；读不出来时不拦也不猜", async () => {
    const { taskMismatch } = await import("../../plugins/uartix.yolo/main.mjs");
    const bad = taskMismatch("detect", { task: "segment", source: "读自权重" });
    expect(bad.ok).toBe(false);
    expect(bad.why).toContain("segment");
    expect(bad.why).toContain("detect");
    expect(taskMismatch("segment", { task: "segment" }).ok).toBe(true);
    expect(taskMismatch("detect", {}).known, "没有事实就没有判断可言").toBe(false);
    expect(taskMismatch("detect", {}).ok).toBe(true);
  });

  it("resume 只认 last.pt（best.pt 会静默退化，true 会让引擎去猜目录）", async () => {
    const { resumeGuard } = await import("../../plugins/uartix.yolo/main.mjs");
    expect(resumeGuard("").ok).toBe(true);
    expect(resumeGuard(false).ok).toBe(true);
    expect(resumeGuard("D:/WS/runs/exp/last.pt").ok).toBe(true);
    expect(resumeGuard("D:/WS/runs/exp/weights/best.pt").ok).toBe(false);
    expect(resumeGuard("true").ok).toBe(false);
    expect(resumeGuard("true").why).toContain("last.pt");
    expect(resumeGuard("D:/WS/别的.pt").ok).toBe(false);
  });

  it("标签 token 数 → 任务建议：框 / 多边形 / 四点（可能是 OBB）/ 混合", async () => {
    const { labelShape } = await import("../../plugins/uartix.yolo/main.mjs");
    // 合法形状：框 = 1+4 = 5 个 token；多边形 = 1+2N（N≥3）→ 7 / 11 个；9 个既可能是 4 点多边形也可能是 OBB
    const box = ["0 0.5 0.5 0.2 0.2", "1 0.1 0.2 0.3 0.4"];
    const poly = ["0 0.1 0.1 0.4 0.1 0.4 0.4", "1 0.2 0.2 0.5 0.2 0.5 0.5 0.2 0.5 0.3 0.1"];
    const quad = ["0 0.1 0.1 0.4 0.1 0.4 0.4 0.1 0.1", "0 0.2 0.2 0.5 0.2 0.5 0.5 0.2 0.2"];
    const detect = labelShape(box);
    expect(detect.task).toBe("detect");
    expect(detect.confidence).toBe(1);
    const seg = labelShape([...poly, ...poly]);
    expect(seg.task).toBe("segment");
    expect(seg.polys).toBe(4);
    // 全是 4 点（1+8）时，多边形与 OBB 分不开：只报出来，不替用户定
    const q = labelShape(quad);
    expect(q.obbSuspect, JSON.stringify(q)).toBe(true);
    expect(q.shaped).toBe(2);
    // 混合必须报出来：detect 遇混合会静默丢弃 segments（官方行为）
    const mixed = labelShape([...box, ...box, ...box, ...poly]);
    expect(mixed.mixed, JSON.stringify(mixed)).toBe(true);
    expect(labelShape([]).task).toBe("");
    expect(labelShape(["0 1 2"]).bad, "3 个 token 不是合法行").toBe(1);
  });
});

describe("P175-W2 · 拦截与识别走真插件", () => {
  /** 造一个带标签的数据集目录：rows 里的形状决定识别结果。 */
  function makeLabels(ws, split, rows) {
    const dir = path.join(ws, "datasets", "x", "labels", split);
    mkdirSync(dir, { recursive: true });
    rows.forEach((r, i) => writeFileSync(path.join(dir, `l${i}.txt`), r.join("\n"), "utf8"));
  }

  it("拿 detect 权重跑 segment（反之亦然）→ 开跑前就拦下来，且不落快照", async () => {
    const ws = makeWorkspace("task-guard");
    const pluginDir = copyPlugin("task-guard");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const st = await p.call("panel.train.saveConfig", { train: { weights: "models/yolo11n-seg.pt", task: "detect" } });
      expect(st.task.mismatch.ok, JSON.stringify(st.task.mismatch)).toBe(false);
      expect(st.task.chosen).toBe("detect");
      const err = await p.call("panel.train.startTrain", {}).then(
        () => null,
        (e) => String(e.message || e),
      );
      expect(err, "任务与权重不搭却没拦住").toBeTruthy();
      expect(err).toContain("segment");
      expect(err).toContain("detect");
      // 拦下来发生在写快照之前：不该在 train_runs/ 里留下一具尸体
      expect(existsSync(path.join(ws, "train_runs")), "被拦下的训练还是写了快照").toBe(false);

      // 改成搭的组合就能跑
      const ok = await p.call("panel.train.applyTask", "segment");
      expect(ok.task.mismatch.ok).toBe(true);
      const job = await p.call("panel.train.startTrain", {});
      expect(job.state).toBe("running");
      await p.waitFor(() => {
        const jobs = p.events.filter((e) => e.event === "job").map((e) => e.payload);
        return jobs.find((j) => j.id === job.id && j.state !== "running");
      }, 45_000, "训练结束");
      const snap = readdirSync(path.join(ws, "train_runs")).filter((f) => f.endsWith(".yaml"));
      expect(snap.length).toBe(1);
      expect(readFileSync(path.join(ws, "train_runs", snap[0]), "utf8")).toMatch(/^ {2}task: "segment"$/m);
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);

  it("任务只认 detect / segment；混合数据集必须报出来", async () => {
    const ws = makeWorkspace("task-detect");
    makeLabels(ws, "train", [
      ["0 0.5 0.5 0.2 0.2", "1 0.1 0.2 0.3 0.4", "0 0.3 0.3 0.1 0.1"],
      ["0 0.1 0.1 0.4 0.1 0.4 0.4 0.1 0.1"],
    ]);
    const pluginDir = copyPlugin("task-detect");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const s = await p.call("panel.train.detectTask", "");
      expect(s.files, JSON.stringify(s)).toBeGreaterThan(0);
      expect(s.mixed, JSON.stringify(s)).toBe(true);
      expect(["detect", "segment"]).toContain(s.task);
      expect(s.note).toContain("建议");
      // 建议不许自己溜进配置
      const st = await p.call("panel.train.state", {});
      expect(st.task.chosen, "识别结果没经确认就落盘了（红线 D）").not.toBe(s.task === "detect" ? "segment" : "detect");

      const bad = await p.call("panel.train.applyTask", "obb").then(
        () => null,
        (e) => String(e.message || e),
      );
      expect(bad, "obb 不在范围内却接受了").toBeTruthy();
      expect(bad).toContain("detect");
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);

  it("模型库：node 冒充的 python 读不了权重时，报失败而不是摆一堆假事实", async () => {
    const ws = makeWorkspace("mlib");
    mkdirSync(path.join(ws, "models"), { recursive: true });
    writeFileSync(path.join(ws, "models", "yolo11n-seg.pt"), "x");
    writeFileSync(path.join(ws, "models", "yolo26n.pt"), "x");
    const pluginDir = copyPlugin("mlib");
    fakeRunner(pluginDir);
    const p = startPlugin(pluginDir, ws);
    try {
      await p.ready;
      const st = await p.call("panel.train.state", {});
      expect(st.models.map((m) => m.name).sort()).toEqual(["yolo11n-seg.pt", "yolo26n.pt"]);
      // 没读过权重：只能有文件名推断出来的那一份，且标清楚来源
      expect(st.models.find((m) => m.name === "yolo26n.pt").facts.task).toBe("detect");
      expect(st.models.find((m) => m.name === "yolo26n.pt").facts.source).toBe("按文件名推断");
      const r = await p.call("panel.train.modelLibrary", true);
      expect(r.ok, "读不动却报了成功").toBe(false);
      expect(String(r.error || "")).toBeTruthy();
      expect(r.items.length).toBe(2);
    } finally {
      p.child.stdin.end();
      await p.done;
    }
  }, 90_000);
});
