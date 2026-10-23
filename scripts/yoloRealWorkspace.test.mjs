/**
 * P174-A9：**对着真工作区**跑一遍（只读，不写一个字节）。
 *
 * 前面那些用例用的是临时假工作区 —— 它们证明"插件的逻辑对"，证明不了"它认得这套真项目"。
 * 这一条专门验后者：真实的 `config.yaml`（两层嵌套、注释、字符串列表）、真实的数据集目录、
 * 真实的训练记录，以及**用工作区自己的 python 读 YAML**（`baseSource === "python"`）。
 *
 * 机器上没有这个工作区时**跳过并说明原因**（同 P172 那条真串口台架的口径：
 * 依赖现场的东西不能装成永远通过的样子）。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_SOURCE } from "../src/features/extensions/bootstrap.ts";
import { encodeMessage } from "../src/features/extensions/protocol.ts";

const WS = "D:/YOLO-Workspace";
const PY = "D:/projects/anaconda3/envs/yolo_env/python.exe";
const TOKEN = "yolo-real-1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, "..", "plugins", "uartix.yolo");
const OK = existsSync(path.join(WS, "config.yaml")) && existsSync(PY);

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

const dir = mkdtempSync(path.join(tmpdir(), "uartix-yolo-real-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("P174-A9 · 真工作区自检（只读）", () => {
  const maybe = OK ? it : it.skip;

  maybe(
    "读得懂真实的 config.yaml、数据集与训练记录",
    async () => {
      const pluginDir = path.join(dir, "uartix.yolo");
      mkdirSync(pluginDir, { recursive: true });
      for (const f of ["extension.json", "main.mjs", "panel.html"]) {
        writeFileSync(path.join(pluginDir, f), readFileSync(path.join(PLUGIN_SRC, f), "utf8"), "utf8");
      }
      const boot = path.join(dir, "bootstrap.mjs");
      writeFileSync(boot, BOOTSTRAP_SOURCE, "utf8");

      // **不给 --allow-fs-write**：这一条就是要证明"只读也能把面板画出来"
      const child = spawn(
        process.execPath,
        [permFlag(), "--allow-fs-read=*", "--allow-child-process", boot, pluginDir],
        { cwd: pluginDir, windowsHide: true },
      );

      const results = new Map();
      const events = [];
      let buf = "";
      let seq = 0;
      let activated = false;
      let markReady = () => {};
      const readyP = new Promise((r) => {
        markReady = r;
      });

      const exited = new Promise((r) => child.on("exit", r));
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
          if (m.t === "ready" && !activated) {
            activated = true;
            child.stdin.write(encodeMessage({ t: "activate", token: TOKEN }) + "\n");
            markReady();
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

      const call = (method, args) =>
        new Promise((resolve, reject) => {
          const id = `r${++seq}`;
          results.set(id, (m) => (m.ok ? resolve(m.data) : reject(new Error(m.err))));
          child.stdin.write(encodeMessage({ t: "call", token: TOKEN, id, method, args: args ?? null }) + "\n");
          setTimeout(() => {
            if (results.has(id)) {
              results.delete(id);
              reject(new Error(`调用超时：${method}`));
            }
          }, 40_000);
        });

      try {
        child.stdin.write(
          encodeMessage({ t: "hello", v: 1, token: TOKEN, workspace: WS, appDir: dir, dev: true }) + "\n",
        );

        // 先等握手：**call 不能抢在 activate 前面**（引导脚本会把未激活的 call 直接拒掉）
        await readyP;
        const st = await call("panel.train.state", {});

        // python 来自 `_env.bat`，而且它能读 YAML（这条是兜底解析器之外的正路）
        expect(st.python.ok, JSON.stringify(st.python)).toBe(true);
        expect(st.python.source).toBe("_env.bat");
        expect(st.config.baseFound, st.config.baseError).toBe(true);
        expect(st.config.baseSource).toBe("python");

        // 真实配置里的关键值
        expect(st.config.effective.dataset.classes).toEqual(["1", "2", "3"]);
        expect(st.config.effective.train.imgsz).toBe(640);
        expect(st.config.effective.train.fliplr).toBe(0);
        expect(st.config.effective.train.workers).toBe(0);
        expect(String(st.config.effective.dataset.output_dir)).toContain("123lmages_seg");

        // 真实数据集与训练记录
        expect(st.dataset.exists).toBe(true);
        expect(st.dataset.trainCount).toBeGreaterThan(1000);
        expect(st.dataset.valCount).toBeGreaterThan(100);
        expect(st.dataset.classes).toEqual(["1", "2", "3"]);
        expect(st.runs.length).toBeGreaterThan(0);
        expect(st.runs.some((r) => r.hasBest)).toBe(true);
        // 那次 mAP50(M) = 0.995 的训练记录应该还在（README 第七节）
        const best = st.runs.find((r) => r.name === "yolo11n_seg_640");
        expect(best, JSON.stringify(st.runs.map((r) => r.name))).toBeTruthy();
        expect(Number(best.metrics.mAP50M)).toBeGreaterThan(0.9);

        // 把"到底读到了什么"打出来：这条用例平时是跳过的，跳过时没人看，跑起来时要能当体检报告读
        console.log(
          "[真工作区] python " +
            st.python.version +
            " · 训练 " +
            st.dataset.trainCount +
            " / 验证 " +
            st.dataset.valCount +
            " · 类别 " +
            st.dataset.classes.join(",") +
            " · 训练记录 " +
            st.runs.length +
            " 条（最佳 mAP50(M)=" +
            best.metrics.mAP50M +
            "）",
        );

        // 深度自检：torch / ultralytics 都要能报出来（慢，但这是真机才验得了的那一半）
        const probe = await call("panel.train.probe", {});
        expect(probe.ok, JSON.stringify(probe)).toBe(true);
        expect(String(probe.torch || "")).toMatch(/^\d+\./);
        expect(String(probe.ultralytics || "")).toMatch(/^\d+\./);
        expect(probe.cuda).toBe(true);
      } finally {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      }
    },
    120_000,
  );

  if (!OK) {
    it("（真工作区不在这台机器上，跳过上面那条）", () => {
      expect(`${WS} 或 ${PY} 不存在，跳过真机自检`).toContain("跳过");
    });
  }
});
