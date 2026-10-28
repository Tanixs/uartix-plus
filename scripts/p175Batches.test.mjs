/**
 * P175 · 批次监工（机器判据，不是自查表）。
 *
 * 为什么单开一个文件：详设把 W1~W8 拆成了批，但"这批做完了"如果只写在文档里，
 * 那就是**我自己说做完**。这个文件把"做完"变成可证伪的东西：
 *
 * - 每批登记若干**证据**（文件 + 必须命中的模式）。没做到就是红，改不动就别标 done。
 * - 全时段红线（不分批）常驻：用户的手动流水线不许出现在写权限里、`half` 零出现、
 *   v5 字样零出现、runner 必须在包里、发布通道必须收 `.py`（否则发出去的插件没有 runner）。
 * - 八批全 done 之后自动加严：清单与 README 必须已经是 0.3.0。
 *
 * 未完成批**不红**（只打出来），这样每次提交都是绿的，而"还差哪几批"始终在测试输出里。
 * 想跳过某批：要么改详设里的范围裁定，要么别改这里。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const PKG = path.join(ROOT, "plugins", "uartix.yolo");

const read = (rel) => {
  const p = path.join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

/** 证据：`file` 里必须能命中 `mustMatch` 的每一条（正则源串）。 */
const LEDGER = [
  {
    id: "W1",
    title: "参数面由引擎驱动 + 自带 runner + train_runs 快照",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/main.mjs", mustMatch: ["DEFAULT_CFG_DICT", "function buildParamSpec", "async function probeParams", "train_runs"] },
      { file: "plugins/uartix.yolo/runner/train_job.py", mustMatch: ["def resolve", "get_cfg", "dropped"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["renderTrainParams", "paramSpec", "collectTrainPatch"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["userFilesFingerprint", "assertUntouched", "pruneToBase|改回基准值"] },
      { file: "scripts/yoloRunner.test.mjs", mustMatch: ["engine\\.accepted", "dry-run"] },
    ],
  },
  {
    id: "W2",
    title: "模型代际（只 11 / 26）+ 任务识别与拦截",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/main.mjs", mustMatch: ["MODEL_FAMILIES", "function weightsTaskFacts", "function detectTask", "function taskMismatch", "function resumeGuard", "function labelShape"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["模型库", "按建议设置"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["代际", "混合数据集必须报出来", "不落快照"] },
    ],
  },
  {
    id: "W3",
    title: "数据体检 + 增强预览 + 划分诊断",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/main.mjs", mustMatch: ["function auditDataset", "outOfBounds", "emptyLabel", "leak", "function scanTrainBatches", "previewImage"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["体检", "增强预览"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["体检改了", "只给训练产物里的"] },
    ],
  },
  {
    id: "W4",
    title: "监控页（曲线 + ETA + 显存 + 失败归类）",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/main.mjs", mustMatch: ["function parseResultsCsv", "function classifyFailure", "function memInfo", "function monitor", "results\\.csv"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["tab-monitor", "sparkline", "只看错误"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["失败归类", "OOM"] },
      { file: "scripts/yoloRealWorkspace.test.mjs", mustMatch: ["panel.train.monitor"] },
    ],
  },
  {
    id: "W5",
    title: "评估页（val + 混淆矩阵 + 逐图错例 + 阈值扫描 + 与上次 diff）",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/main.mjs", mustMatch: ["async function evalStart", "function diffArgs", "function scanEvals", "EVAL_IMAGES", "function compareRuns"] },
      { file: "plugins/uartix.yolo/runner/eval_job.py", mustMatch: ["conf_table", "save_crop", "eval.json", "confusion_matrix"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["阈值对照", "错例", "compareRuns"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["调用形状", "uartix\\.call"] },
    ],
  },
  {
    id: "W6",
    title: "导出矩阵 + quantize + benchmark + 端侧约束卡",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/main.mjs", mustMatch: ["EXPORT_FORMATS", "EDGE_CARDS", "function exportAdvice", "async function exportStart", "function scanExports", "MaixCam"] },
      { file: "plugins/uartix.yolo/runner/export_job.py", mustMatch: ["quantize", "--nms", "export.json", "msPerImage"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["开始导出", "端侧"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["分割模型上不了 MaixCam", "tflite"] },
    ],
  },
  {
    id: "W7",
    title: "实验管理（列表 / 备注 / 对比 / 等价命令 / 存 .bat / 归档）",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/main.mjs", mustMatch: ["function runProfile", "function reproCommands", "function writeReproBat", "function saveRunNote", "function archiveRun"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["等价命令", "train_runs/bat/", "存成 .bat"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["反解回同一份参数", "归档把用户的产物搬走了", "03_train.bat"] },
    ],
  },
  {
    id: "W8",
    title: "文档与发布准备（README / 面板帮助 / 包完整性账目）",
    done: true,
    evidence: [
      { file: "plugins/uartix.yolo/README.md", mustMatch: ["`0\\.3\\.0`", "runner/train_job.py", "deployStart"] },
      { file: "plugins/uartix.yolo/panel.html", mustMatch: ["tab-help", "为什么这次要重新批准"] },
      { file: "scripts/yoloPlugin.test.mjs", mustMatch: ["每块页签都有 section", "包里的每个代码文件都发得出去"] },
    ],
  },
];

describe("P175 · 批次监工", () => {
  it("八批一个都不能少，且每批都得留下可查的证据", () => {
    expect(LEDGER.map((b) => b.id)).toEqual(["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"]);
    for (const b of LEDGER) {
      expect(b.evidence.length, `${b.id} 没登记证据，这条批等于没监工`).toBeGreaterThan(0);
      for (const e of b.evidence) {
        expect(e.mustMatch.length, `${b.id} 的 ${e.file} 一条模式都没写——空证据会让"做完"变成自说自话`).toBeGreaterThan(0);
      }
    }
  });

  it("标了 done 的批：证据文件在、模式全命中（做不到就别标 done）", () => {
    const done = LEDGER.filter((b) => b.done);
    for (const b of done) {
      for (const e of b.evidence) {
        const text = read(e.file);
        expect(text, `${b.id}：证据文件不存在 ${e.file}`).not.toBeNull();
        for (const pat of e.mustMatch) {
          expect(new RegExp(pat).test(text), `${b.id}：${e.file} 里没有 "${pat}"，这批其实没做完`).toBe(true);
        }
      }
    }
    const pending = LEDGER.filter((b) => !b.done).map((b) => `${b.id} ${b.title}`);
    if (pending.length) console.log(`[P175 监工] 已完成 ${done.length}/8 · 还差：\n  - ${pending.join("\n  - ")}`);
    else console.log("[P175 监工] W1~W8 全部完成");
  });

  it("红线常驻：用户的手动流水线不在写权限里", () => {
    const raw = JSON.parse(readFileSync(path.join(PKG, "plugin.json"), "utf8"));
    for (const w of raw.permissions.fs.write) {
      expect(w, `写权限越界：${w}`).toMatch(/^\$WS\/[A-Za-z0-9._-]+$/);
      expect(w, `写权限里不许出现用户的脚本或配置：${w}`).not.toMatch(/config\.yaml|scripts|\.bat$/i);
    }
    expect(raw.permissions.fs.write).toContain("$WS/train_runs");
    expect(raw.permissions.fs.write).toContain("$WS/annotations");
  });

  it("红线常驻：`half` 在界面与命令里零出现（8.4 已被 quantize 取代）", () => {
    for (const rel of ["plugins/uartix.yolo/panel.html", "plugins/uartix.yolo/main.mjs", "plugins/uartix.yolo/runner/train_job.py"]) {
      const text = read(rel) ?? "";
      expect(text, `${rel} 里出现了 half= 这种旧写法`).not.toMatch(/\bhalf\s*[:=]/);
    }
  });

  it("红线常驻：范围只做 11 / 26，插件包里不许出现 v5 字样（README 可以解释为什么不做的）", () => {
    for (const rel of ["plugins/uartix.yolo/panel.html", "plugins/uartix.yolo/main.mjs", "plugins/uartix.yolo/plugin.json", "plugins/uartix.yolo/runner/train_job.py"]) {
      const text = read(rel) ?? "";
      expect(text, `${rel} 里出现了 yolov5 / v5u`).not.toMatch(/yolov5|v5u|yolo_v5/i);
    }
  });

  it("红线常驻：runner 必须在包里并被训练路径使用；发布通道必须收 .py", () => {
    expect(existsSync(path.join(PKG, "runner", "train_job.py"))).toBe(true);
    const main = read("plugins/uartix.yolo/main.mjs") ?? "";
    expect(main).toMatch(/runner\/train_job\.py/);
    const publish = read("src/features/plugins/engine/pluginPublish.ts") ?? "";
    expect(publish, "发布白名单不收 .py：发出去的插件会没有 runner").toContain("|py|");
  });

  it("八批全 done 之后自动加严：清单与 README 的版本账必须同步，且不低于 0.3.0", () => {
    if (LEDGER.some((b) => !b.done)) return; // 还没收官，这条不该说话
    const raw = JSON.parse(readFileSync(path.join(PKG, "plugin.json"), "utf8"));
    // P175 的基线是 0.3.0；之后的小版本（UI 重排之类）不该让这条红 —— 但**永远不许低于基线**，
    // 也不许清单升了 README 的版本账没跟上（那种"发出去没人知道改了啥"最难查）。
    const v = String(raw.version).split(".").map(Number);
    const base = [0, 3, 0];
    const cmp = v[0] - base[0] || v[1] - base[1] || v[2] - base[2];
    expect(Number.isFinite(cmp), `清单版本号读不懂：${raw.version}`).toBe(true);
    expect(cmp, `插件版本 ${raw.version} 低于 P175 基线 0.3.0`).toBeGreaterThanOrEqual(0);
    const readme = read("plugins/uartix.yolo/README.md") ?? "";
    expect(readme.split("\n## 版本")[1]?.slice(0, 48), `README 的版本账第一条得是 ${raw.version}`).toContain("`" + raw.version + "`");
  });
});
