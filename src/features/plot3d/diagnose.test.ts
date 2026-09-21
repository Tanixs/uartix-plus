/**
 * P91 C1：归因器单测——每种"画面全黑"都要有自己的那句话和那枚按钮。
 * 这组测试的意义不在于函数逻辑，而在于钉死：任何一条静默路径都必须有出口。
 */
import { describe, expect, it } from "vitest";
import {
  REMEDY_ACTIONS, REMEDY_LABEL, diagStage, dispatchRemedy, whyEmpty,
  type EmptyDiagnosis, type GroupDiag, type RemedyDeps,
} from "./diagnose";

function g(over: Partial<GroupDiag> = {}): GroupDiag {
  return {
    id: "g1", name: "组1", visible: true, mode: "line", missingAxis: null, hasSource: true,
    paired: 100, skipped: 0, tailCount: 500, tailVisible: 500, windowStartSec: 0,
    overviewCount: 500, cursorSec: null, maxPoints: 0, markerKind: "point", hasLatest: true,
    ...over,
  };
}

const input = (groups: GroupDiag[], over: { calibOn?: boolean; panelVisible?: boolean } = {}) => ({
  groups, calibOn: over.calibOn ?? false, panelVisible: over.panelVisible ?? true,
});

describe("whyEmpty", () => {
  it("有可见点 → ok（绝不因为『看起来空』就误报）", () => {
    expect(whyEmpty(input([g()])).code).toBe("ok");
  });

  it("面板不在前台优先说前台", () => {
    const r = whyEmpty(input([g()], { panelVisible: false }));
    expect(r.code).toBe("panel-hidden");
    expect(r.action).toBeNull();
  });

  it("校准模式接管 → 给退出动作", () => {
    const r = whyEmpty(input([g({ tailVisible: 0, overviewCount: 0 })], { calibOn: true }));
    expect(r.code).toBe("calib-takeover");
    expect(r.action).toBe("exit-calib");
  });

  it("三组都隐藏 → 点亮组", () => {
    const r = whyEmpty(input([g({ visible: false }), g({ id: "g2", visible: false })]));
    expect(r.code).toBe("all-groups-hidden");
    expect(r.action).toBe("show-group");
  });

  it("缺 Z 轴绑定 → 指名组和轴", () => {
    const r = whyEmpty(input([g({ missingAxis: "z" })]));
    expect(r.code).toBe("no-binding");
    expect(r.text).toContain("Z");
    expect(r.text).toContain("组1");
    expect(r.action).toBe("bind-channel");
  });

  it("绑定齐但通道无数据 → 让用户去采集", () => {
    const r = whyEmpty(input([g({ hasSource: false, tailCount: 0, tailVisible: 0, overviewCount: 0 })]));
    expect(r.code).toBe("no-source");
    expect(r.action).toBe("start-data");
  });

  it("配对全跳过 → 报真实跳过数（这是过去完全静默的一条路径）", () => {
    const r = whyEmpty(input([g({ paired: 0, skipped: 849, tailCount: 0, tailVisible: 0, overviewCount: 0, hasSource: true })]));
    expect(r.code).toBe("pairing-skipped");
    expect(r.text).toContain("849");
  });

  it("游标早于保留窗口起点 → 明说『不是没数据』并给回到最新", () => {
    const r = whyEmpty(input([g({ tailCount: 1200, tailVisible: 0, overviewCount: 0, cursorSec: 0, windowStartSec: 3120.4 })]));
    expect(r.code).toBe("cursor-before-window");
    expect(r.text).toContain("不是没数据");
    expect(r.action).toBe("clear-cursor");
    // 文案单一来源在 REMEDY_LABEL（旧 `actionLabel` 字段 + 渲染侧回退三元链已删：那条链正是"组设置"错标签的出处）
    expect(REMEDY_LABEL["clear-cursor"][0]).toBe("回到最新");
  });

  it("缓冲有点但截断后为 0（游标落在窗口内却切到空）", () => {
    const r = whyEmpty(input([g({ tailCount: 800, tailVisible: 0, overviewCount: 0, cursorSec: 0, windowStartSec: 0 })]));
    expect(r.code).toBe("cursor-before-window");
    expect(r.text).toContain("800");
  });

  it("最大点数挤空缓冲 → 放宽上限", () => {
    const r = whyEmpty(input([g({ tailCount: 0, tailVisible: 0, overviewCount: 0, maxPoints: 10, paired: 500 })]));
    expect(r.code).toBe("max-points-trimmed");
    expect(r.action).toBe("raise-max-points");
  });

  it("实时定位模式无最新点 → 不算坏，只说明", () => {
    const r = whyEmpty(input([g({ mode: "point", hasLatest: false, tailCount: 0, tailVisible: 0, overviewCount: 0 })]));
    expect(r.code).toBe("point-mode-no-latest");
    expect(r.action).toBeNull();
  });

  it("多组时命中哪组报哪组", () => {
    const r = whyEmpty(input([g({ id: "g2", name: "组2" }), g({ id: "g1", name: "组1", missingAxis: "x" })]));
    expect(r.group).toBe("组1");
    expect(r.code).toBe("no-binding");
  });

  it("兜底也必须有文案（返回 ok 之外的任何码都不允许空 text）", () => {
    const cases = [
      input([]),
      input([g({ tailCount: 0, tailVisible: 0, overviewCount: 0, paired: 0, skipped: 0, hasSource: true })]),
    ];
    for (const c of cases) {
      const r = whyEmpty(c);
      if (r.code !== "ok") expect(r.text.length).toBeGreaterThan(4);
    }
  });
});

/**
 * P96-K1c：补救动作"每个都必须有人接"——「组设置按了没反应」的回归钉。
 * 根因不是没接 onClick，而是 action 联合扩到 6 个、渲染侧的分发函数只写了 4 个 if 分支，
 * `bind-channel` / `start-data` 落到函数末尾静默返回。分发搬进本文件后用
 * `Record<RemedyAction, …>` 编译期兜住，这组测试再钉运行时行为。
 */
describe("dispatchRemedy", () => {
  const deps = (hits: string[]): RemedyDeps => ({
    clearScrub: () => hits.push("clearScrub"),
    showAllGroups: () => hits.push("showAllGroups"),
    exitCalib: () => hits.push("exitCalib"),
    raiseMaxPoints: (gid) => hits.push(`raiseMaxPoints:${gid}`),
    openGroupDialog: (gid) => hits.push(`openGroupDialog:${gid}`),
    startDemo: () => hits.push("startDemo"),
    unknown: (what) => hits.push(`unknown:${what}`),
  });
  const d = (action: EmptyDiagnosis["action"], gid?: string): EmptyDiagnosis => ({
    code: "no-binding", text: "t", action, ...(gid ? { gid } : {}),
  });

  it("六个动作码全部有落点，且各自只打到对应的那个依赖", () => {
    const want: Record<string, string> = {
      "clear-cursor": "clearScrub",
      "show-group": "showAllGroups",
      "exit-calib": "exitCalib",
      "raise-max-points": "raiseMaxPoints:g1",
      "bind-channel": "openGroupDialog:g1",
      "start-data": "startDemo",
    };
    for (const a of REMEDY_ACTIONS) {
      const hits: string[] = [];
      expect(dispatchRemedy(d(a, "g1"), deps(hits)), `${a} 必须被处理`).toBe(true);
      expect(hits, a).toEqual([want[a]]);
    }
  });

  it("whyEmpty 真会产出的每个动作都分发得动（不是只测枚举表）", () => {
    const produced = [
      whyEmpty(input([g({ missingAxis: "x" })])),
      whyEmpty(input([g({ hasSource: false })])),
      whyEmpty(input([g({ tailCount: 1200, tailVisible: 0, overviewCount: 0, cursorSec: 0, windowStartSec: 3120 })])),
      whyEmpty(input([g({ visible: false })])),
      whyEmpty(input([g()], { calibOn: true })),
      whyEmpty(input([g({ maxPoints: 10, tailCount: 0, tailVisible: 0, overviewCount: 0, paired: 20 })])),
    ];
    for (const e of produced) {
      expect(e.code).not.toBe("ok");
      if (!e.action) continue;
      const hits: string[] = [];
      expect(dispatchRemedy(e, deps(hits)), e.code).toBe(true);
      expect(hits[0], `${e.code} 落到了 unknown`).not.toMatch(/^unknown/);
    }
  });

  it("需要组 id 的动作缺了 id 不静默：走 unknown 出口并回 false", () => {
    const hits: string[] = [];
    expect(dispatchRemedy(d("bind-channel"), deps(hits))).toBe(false);
    expect(hits).toEqual(["unknown:bind-channel（缺组 id）"]);
  });

  it("台账里读到未知动作码必须出声（旧台账/新代码混跑时不许静默失败）", () => {
    const hits: string[] = [];
    const ghost = { code: "no-binding", text: "t", action: "fly-to-moon", gid: "g1" } as unknown as EmptyDiagnosis;
    expect(dispatchRemedy(ghost, deps(hits))).toBe(false);
    expect(hits).toEqual(["unknown:fly-to-moon"]);
  });

  it("action 为 null（画面正常/只能等数据）时什么都不做也不报错", () => {
    const hits: string[] = [];
    expect(dispatchRemedy(d(null), deps(hits))).toBe(false);
    expect(hits).toEqual([]);
  });
});

/** P96-K1：引导卡（start）与诊断条（blocked）同源互斥，未绑齐时不再两张卡说同一句话 */
describe("diagStage", () => {
  const CODES: EmptyDiagnosis["code"][] = [
    "ok", "panel-hidden", "calib-takeover", "no-binding", "no-source", "pairing-skipped",
    "cursor-before-window", "max-points-trimmed", "point-mode-no-latest", "all-groups-hidden",
  ];

  it("每个码都有唯一阶段（新增码忘了登记会在这里红）", () => {
    for (const c of CODES) expect(["none", "start", "blocked"]).toContain(diagStage(c));
    expect(diagStage("no-binding")).toBe("start");
    expect(diagStage("no-source")).toBe("start");
    expect(diagStage("cursor-before-window")).toBe("blocked");
    expect(diagStage("ok")).toBe("none");
  });

  it("start 阶段必须自带可点出口（引导卡不能只说问题不给按钮）", () => {
    for (const e of [whyEmpty(input([g({ missingAxis: "x" })])), whyEmpty(input([g({ hasSource: false })]))]) {
      expect(diagStage(e.code)).toBe("start");
      expect(e.action, `${e.code} 的引导必须有出口`).not.toBeNull();
    }
  });
});
