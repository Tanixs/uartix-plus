/**
 * P174-A5：插件运行时纯逻辑的判据。
 *
 * 这一层没有 IO，所以能测的东西恰好是"错了会静默"的那一批：
 * 环形缓冲少留一行、状态迁移把 failed 抹成 idle、`canStart` 在 starting 期间放行第二次启动。
 * 三种都不会抛错，只会让界面看着"有点不对"——正是最需要断言的形状。
 */

import { describe, expect, it } from "vitest";
import {
  appendLog,
  canStart,
  canStop,
  nextPhase,
  phaseLabel,
  readinessAction,
  LOG_MAX,
  type PluginLogLine,
  type PluginPhase,
} from "./runtime";

const line = (text: string, at = 1): PluginLogLine => ({ at, level: "info", text });

describe("appendLog（环形缓冲）", () => {
  it("按顺序追加", () => {
    const out = appendLog([line("a")], line("b", 2));
    expect(out.map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("每次返回新数组，且不改动入参", () => {
    // store 用 useSyncExternalStore：引用不变就不重渲染。
    // in-place push 在这个组合下就是"数据变了界面不动"，所以这条钉的是引用语义，不是内容。
    const cur = [line("a")];
    const out = appendLog(cur, line("b", 2));
    expect(out).not.toBe(cur);
    expect(cur).toHaveLength(1);
  });

  it("超过上限丢最旧的，长度不再增长", () => {
    let logs: PluginLogLine[] = [];
    for (let i = 0; i < LOG_MAX + 5; i++) logs = appendLog(logs, line(`L${i}`, i));
    expect(logs).toHaveLength(LOG_MAX);
    // 最旧的那 5 条应该已经不在：留下的是 L5..L(LOG_MAX+4)
    expect(logs[0].text).toBe("L5");
    expect(logs[logs.length - 1].text).toBe(`L${LOG_MAX + 4}`);
  });

  it("自定义上限也生效（判据不写死 LOG_MAX）", () => {
    let logs: PluginLogLine[] = [];
    for (let i = 0; i < 4; i++) logs = appendLog(logs, line(`L${i}`, i), 3);
    expect(logs.map((l) => l.text)).toEqual(["L1", "L2", "L3"]);
  });
});

describe("nextPhase（迁移表）", () => {
  it("正常一条线：idle → starting → running → stopped", () => {
    expect(nextPhase("idle", { type: "starting" })).toBe("starting");
    expect(nextPhase("starting", { type: "ready" })).toBe("running");
    expect(nextPhase("running", { type: "stopped" })).toBe("stopped");
  });

  it("失败的两种来路都落到 failed（起不来 / 起来就崩）", () => {
    expect(nextPhase("starting", { type: "failed", error: "x" })).toBe("failed");
    // 进程在握手前就退出：这不是 stopped，用户需要看见"它根本没跑起来"
    expect(nextPhase("starting", { type: "exit" })).toBe("failed");
  });

  it("回收与退出都落到 stopped", () => {
    expect(nextPhase("running", { type: "idle" })).toBe("stopped");
    expect(nextPhase("running", { type: "exit" })).toBe("stopped");
  });

  it("failed 不会被随后的事件抹掉（否则用户再也看不见上次为什么挂）", () => {
    expect(nextPhase("failed", { type: "exit" })).toBe("failed");
    expect(nextPhase("failed", { type: "idle" })).toBe("failed");
    expect(nextPhase("failed", { type: "ready" })).toBe("failed");
  });

  it("未列出的组合保持原状态，不兜底成 idle", () => {
    expect(nextPhase("idle", { type: "ready" })).toBe("idle");
    expect(nextPhase("idle", { type: "exit" })).toBe("idle");
    expect(nextPhase("running", { type: "starting" })).toBe("running");
  });

  it("stopped / failed 都能重新拉起", () => {
    expect(nextPhase("stopped", { type: "starting" })).toBe("starting");
    expect(nextPhase("failed", { type: "starting" })).toBe("starting");
  });
});

describe("canStart / canStop", () => {
  it("只有没在跑的状态允许启动", () => {
    expect(canStart("idle")).toBe(true);
    expect(canStart("stopped")).toBe(true);
    expect(canStart("failed")).toBe(true);
    // starting 期间再点一次不该起第二个进程——重复点"打开面板"就会走到这里
    expect(canStart("starting")).toBe(false);
    expect(canStart("running")).toBe(false);
  });

  it("starting 也算「在跑」，所以可以停（否则卡在启动中的进程只能去任务管理器杀）", () => {
    expect(canStop("starting")).toBe(true);
    expect(canStop("running")).toBe(true);
    expect(canStop("idle")).toBe(false);
    expect(canStop("stopped")).toBe(false);
    expect(canStop("failed")).toBe(false);
  });

  it("任何状态下都至少有一条路可走（不会出现两个按钮同时灰掉还转着圈）", () => {
    const all: PluginPhase[] = ["idle", "starting", "running", "stopped", "failed"];
    for (const p of all) expect(canStart(p) || canStop(p)).toBe(true);
  });
});

describe("readinessAction（「现在要用它」该怎么办）", () => {
  it("已在运行 ⇒ 什么都不用做（直接发调用）", () => {
    expect(readinessAction("running")).toBe("none");
  });

  it("从没跑过 / 被回收 / 上次挂了 ⇒ 先拉起再等", () => {
    expect(readinessAction("idle")).toBe("start");
    expect(readinessAction("stopped")).toBe("start");
    expect(readinessAction("failed")).toBe("start");
  });

  // 这一条就是"启用之后面板还是用不了"的成因：面板挂载自己会 start 一次，
  // iframe 的第一句请求几乎同时到达，那时状态是 starting。
  // 判成 start ⇒ 起第二个 Node 进程；判成 none ⇒ 立刻得到一个"还没在运行"。
  it("正在启动 ⇒ 只等，不再发起（否则第二次启动白跑，用户等的是前一个）", () => {
    expect(readinessAction("starting")).toBe("wait");
  });

  it("三种动作互斥且覆盖全部状态（不会有一种状态既不等也不起）", () => {
    const all: PluginPhase[] = ["idle", "starting", "running", "stopped", "failed"];
    const acts = all.map(readinessAction);
    expect(new Set(acts).size).toBe(3);
    for (const a of acts) expect(["none", "start", "wait"]).toContain(a);
  });
});

describe("phaseLabel", () => {
  it("五个状态都有中英两句话，且都不是空的", () => {
    const all: PluginPhase[] = ["idle", "starting", "running", "stopped", "failed"];
    for (const p of all) {
      const l = phaseLabel(p);
      expect(l.zh.trim()).not.toBe("");
      expect(l.en.trim()).not.toBe("");
    }
    // 五种状态的文案两两不同（复制粘贴出来的"运行中/运行中"会让徽标看不出区别）
    expect(new Set(all.map((p) => phaseLabel(p).zh)).size).toBe(all.length);
    expect(new Set(all.map((p) => phaseLabel(p).en)).size).toBe(all.length);
  });
});
