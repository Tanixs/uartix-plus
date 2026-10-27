/**
 * P175-W1：**真 python 对着真 runner** 的判据（详设 §10 判据 5 的前半）。
 *
 * `yoloPlugin.test.mjs` 用 node 冒充 python，它钉的是"插件怎么拼命令、怎么解析输出"；
 * 它钉不住的是另一半：**新参数到底会不会被 ultralytics 接受**。那需要真包、真配置校验，
 * 所以单开这个文件。机器上没有 `yolo_env` 时**跳过并说明原因**（同真串口台架的口径：
 * 依赖现场的东西不能装成永远通过的样子）。
 *
 * 只跑 `--dry-run`：它不 import torch、不开训、不写工作区产物。真训练留给用户点按钮。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = "D:/projects/anaconda3/envs/yolo_env/python.exe";
const RUNNER = path.join(HERE, "..", "plugins", "uartix.yolo", "runner", "train_job.py");
const OK = (() => {
  try {
    execFileSync(PY, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(path.join(tmpdir(), "uartix-yolo-runner-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

/** 用**插件自己的** dumpConfig 生成快照：测的是"面板写的东西 runner 读得懂"，不是手搓一份 fixture。 */
async function snapshot(extra) {
  const mod = await import("../../plugins/uartix.yolo/main.mjs");
  const cfg = {
    env: { proxy_enable: false, proxy: "" },
    dataset: { sources: [], output_dir: "D:/YOLO-Workspace/datasets/123lmages_seg", val_ratio: 0.15, seed: 42, classes: ["1", "2", "3"], label_map: {} },
    train: {
      weights: "D:/YOLO-Workspace/models/yolo11n-seg.pt",
      epochs: 1,
      imgsz: 640,
      batch: -1,
      workers: 0,
      device: "0",
      name: "w1_dry",
      project: "D:/YOLO-Workspace/runs",
      optimizer: "MuSGD",
      cache: "disk",
      seed: 42,
      ...extra,
    },
  };
  const f = path.join(dir, "w1_dry.yaml");
  writeFileSync(f, mod.dumpConfig(cfg), "utf8");
  return { file: f, text: readFileSync(f, "utf8") };
}

function dryRun(file) {
  const out = execFileSync(PY, [RUNNER, "--config", file, "--root", "D:/YOLO-Workspace", "--dry-run"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split(/\r?\n/).pop());
}

describe("P175-W1 · 真 runner 吃真配置", () => {
  const maybe = OK ? it : it.skip;

  maybe("新增参数原样进 overrides，并被 ultralytics 自己的配置校验接受", async () => {
    const { file, text } = await snapshot({ lr0: 0.005, mosaic: 0.5, freeze: 10, copy_paste_mode: "mixup", cos_lr: true });
    const r = dryRun(file);
    expect(r.ok).toBe(true);
    // 工作区词汇 `weights` → 引擎词汇 `model`，只在这一处翻译
    expect(r.overrides.model.replace(/\\/g, "/")).toBe("D:/YOLO-Workspace/models/yolo11n-seg.pt");
    expect("weights" in r.overrides).toBe(false);
    // 这几条是"面板新增的项"——用户的 scripts/train.py 一个都不读，runner 必须全带上
    expect(r.overrides.lr0).toBe(0.005);
    expect(r.overrides.mosaic).toBe(0.5);
    expect(r.overrides.freeze).toBe(10);
    expect(r.overrides.copy_paste_mode).toBe("mixup");
    expect(r.overrides.optimizer).toBe("MuSGD");
    // data 由 dataset.output_dir 推出来（和 train.py 同一条规则）
    expect(r.data.replace(/\\/g, "/")).toContain("datasets/123lmages_seg/data.yaml");
    // 判据的硬部分：**引擎自己**认不认。`engine.echo` 就是会写进 args.yaml 的那份归一化值
    expect(r.engine.accepted, JSON.stringify(r.engine.error)).toBe(true);
    expect(r.engine.echo.lr0).toBe(0.005);
    expect(r.engine.echo.freeze).toBe(10);
    expect(r.dropped).toEqual([]);
    // 同一份快照仍然是"工作区 config.yaml 的形状"：用户自己的 train.py 照旧读得到 weights
    expect(text).toMatch(/^ {2}weights: "D:\/YOLO-Workspace\/models\/yolo11n-seg\.pt"$/m);
    expect(text).toMatch(/^ {2}lr0: 0\.005$/m);
  }, 120_000);

  maybe("batch 三态（-1 / 比例 / 整数）与空值：不许把空输入变成 0", async () => {
    const auto = dryRun((await snapshot({ batch: -1 })).file);
    expect(auto.overrides.batch).toBe(-1);
    expect(auto.engine.accepted, JSON.stringify(auto.engine.error)).toBe(true);
    const ratio = dryRun((await snapshot({ batch: 0.7 })).file);
    expect(ratio.overrides.batch).toBe(0.7);
    // `time` 留空时**整条不出现**：写成 `time: ""` 会被当成时限，而这不是用户的意思
    const noTime = (await snapshot({ epochs: 2 })).text;
    expect(noTime).not.toMatch(/^ {2}time:/m);
  }, 120_000);

  maybe("引擎不认识的键：点名丢掉、不冒充成功", async () => {
    const { file } = await snapshot({ half: true, mratio: 4 });
    const r = dryRun(file);
    expect(r.dropped).toEqual(["half", "mratio"]);
    expect("half" in r.overrides).toBe(false);
    // `half` 在 8.4 里已经被删掉了（详设 §1.5）：面板上绝不能有它，runner 也绝不兜它
    expect(r.engine.accepted).toBe(true);
  }, 120_000);

  maybe("两个 runner 都能被真 python 解析（语法错不会让门禁红，只会让面板点了没反应）", () => {
    for (const f of ["train_job.py", "eval_job.py", "export_job.py"]) {
      const p = path.join(HERE, "..", "plugins", "uartix.yolo", "runner", f);
      expect(existsSync(p), `缺 runner/${f}`).toBe(true);
      let err = "";
      try {
        // 用 compile() 而不是 py_compile：后者会在插件包里落下 `__pycache__`，
        // 那些 .pyc 会被发布通道当二进制跳过，还会让"包里有几个文件"这件事说谎。
        execFileSync(PY, ["-c", "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')", p], { stdio: "pipe" });
      } catch (e) {
        err = String(e.stderr || e.message || "").slice(0, 400);
      }
      expect(err, `runner/${f} 解析不过`).toBe("");
    }
    expect(existsSync(path.join(HERE, "..", "plugins", "uartix.yolo", "runner", "__pycache__")), "测试在插件包里留下了 __pycache__").toBe(false);
  }, 60_000);

  maybe("eval_job.py 的 --help 起得来（argparse 形状是面板拼命令的依据）", () => {
    const out = execFileSync(PY, [path.join(HERE, "..", "plugins", "uartix.yolo", "runner", "eval_job.py"), "--help"], { encoding: "utf8" });
    for (const flag of ["--config", "--weights", "--data", "--out", "--conf", "--errors"]) {
      expect(out, `--help 里没有 ${flag}`).toContain(flag);
    }
  }, 60_000);

  if (!OK) {
    it("（这台机器上没有 yolo_env，跳过真 runner 自检）", () => {
      expect(`${PY} 不存在，跳过真 runner 自检`).toContain("跳过");
    });
  }
});
