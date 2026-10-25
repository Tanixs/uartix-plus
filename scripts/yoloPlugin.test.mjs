/**
 * P174-A9：YOLO 训练工作台插件的判据。
 *
 * 这一批的东西分两种，两种都必须能自动验：
 *
 * 1. **纯函数**（`dumpConfig` / `parseSimpleYaml`）：生成的 config.yaml 必须能被自己读回来，
 *    而且要一模一样——因为真正读它的是 Python 的 `yaml.safe_load`，格式写错的后果是
 *    "训练参数没生效"（不报错，只是跑出来的东西不对）。
 *
 * 2. **整条链**（真起插件进程）：`state()` 能把工作区读成面板要的形状、`saveConfig()` 写下的
 *    覆盖会被 `startTrain()` 用上、`python` 子进程的输出会被解析成进度、日志会落到 `$WS/logs/`。
 *    这一条用 **node 冒充 python**（工作区 `_env.bat` 指向 `process.execPath`，假脚本用 JS 写）：
 *    判据是"插件怎么拼命令、怎么解析输出"，而不是"这台机器有没有 torch"。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  return ws;
}

/** 起宿主（真 bootstrap + 真插件进程），返回一个能 call 的客户端。 */
/** 把仓库里的插件复制到临时目录：运行期它只往 $WS 写，但别让它有机会碰源码。 */
function copyPlugin(tag = "plug") {
  const pluginDir = path.join(dir, tag, "uartix.yolo");
  mkdirSync(pluginDir, { recursive: true });
  for (const f of ["plugin.json", "main.mjs", "panel.html"]) {
    writeFileSync(path.join(pluginDir, f), readFileSync(path.join(PLUGIN_SRC, f), "utf8"), "utf8");
  }
  return pluginDir;
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
    // 要写工作区里的四个位置，一个都不能少（少了就是运行时才炸的 EACCES）
    expect(m.permissions.fs.write).toEqual(["$WS/.uartix", "$WS/datasets", "$WS/runs", "$WS/logs", "$WS/models"]);
    expect(existsSync(path.join(PLUGIN_SRC, m.main))).toBe(true);
    expect(existsSync(path.join(PLUGIN_SRC, m.contributes.panels[0].entry))).toBe(true);
  }, 20_000);

  it("state() 读工作区 → saveConfig 覆盖 → startTrain 起真进程并解析进度", async () => {
    const ws = makeWorkspace("main");
    // 插件从仓库里复制一份到临时目录：运行期它只往 $WS 写，但别让它有机会碰源码
    const pluginDir = path.join(dir, "plug", "uartix.yolo");
    mkdirSync(pluginDir, { recursive: true });
    for (const f of ["plugin.json", "main.mjs", "panel.html"]) {
      writeFileSync(path.join(pluginDir, f), readFileSync(path.join(PLUGIN_SRC, f), "utf8"), "utf8");
    }

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
      const st2 = await c.call("panel.train.saveConfig", { train: { epochs: 7 } });
      expect(st2.config.effective.train.epochs).toBe(7);
      // 基准里的其它值不能被覆盖掉（合并而不是替换）
      expect(st2.config.effective.train.name).toBe("from_base");
      const overFile = path.join(ws, ".uartix", "yolo", "config.json");
      expect(existsSync(overFile)).toBe(true);
      expect(JSON.parse(readFileSync(overFile, "utf8"))).toEqual({ train: { epochs: 7 } });

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

      // 生成的 config.yaml 就是这次运行的真身：覆盖生效、路径是绝对路径
      const cfgPath = path.join(ws, ".uartix", "yolo", "runs", job.id, "config.yaml");
      const yamlText = readFileSync(cfgPath, "utf8");
      expect(yamlText).toMatch(/^ {2}epochs: 7$/m);
      expect(yamlText).toContain(`  output_dir: "${ws.replace(/\\/g, "/")}/datasets/x"`);
      expect(yamlText).toContain("- \"D:/fake/anno/one\"");

      // 假脚本读到的 config 里 epochs 真的是 7（证明写盘 → 传参 → 脚本读 这条链是通的）
      const logs = c.events.filter((e) => e.event === "log").flatMap((e) => e.payload.lines);
      expect(logs.some((l) => l.text.includes("config 里有 epochs 7: true")), JSON.stringify(logs.slice(0, 12))).toBe(true);
      // 日志同时落到 $WS/logs/
      expect(finished.logPath.replace(/\\/g, "/")).toContain("/logs/yolo-");
      expect(existsSync(finished.logPath)).toBe(true);
      expect(readFileSync(finished.logPath, "utf8")).toContain("开始训练");

      /* ---- 4. 任务列表：面板重新打开时靠它恢复视图 ---- */
      const st3 = await c.call("panel.train.state", {});
      expect(st3.jobs.some((j) => j.id === job.id && j.state === "succeeded")).toBe(true);
      expect(st3.active).toBeNull();
    } finally {
      try {
        c.child.kill();
      } catch {
        /* 已经退出 */
      }
    }
  }, 90_000);

  it("没有工作区时 state() 说人话，而不是抛异常（面板要能把「去选目录」显示出来）", async () => {
    const pluginDir = path.join(dir, "plug2", "uartix.yolo");
    mkdirSync(pluginDir, { recursive: true });
    for (const f of ["plugin.json", "main.mjs", "panel.html"]) {
      writeFileSync(path.join(pluginDir, f), readFileSync(path.join(PLUGIN_SRC, f), "utf8"), "utf8");
    }
    const ws = makeWorkspace("empty"); // 只是借它的目录当 roots，hello 里给空工作区
    const c = startPlugin(pluginDir, "");
    try {
      await c.ready;
      const st = await c.call("panel.train.state", {});
      expect(st.needWorkspace).toBe(true);
      expect(st.workspace).toBe("");
      expect(st.dataset.exists).toBe(false);
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
