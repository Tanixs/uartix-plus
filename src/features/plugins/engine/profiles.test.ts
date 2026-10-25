/**
 * P174-B2：工作场景的纯判据与执行器。
 *
 * 重点不是"能应用"，而是三件会静默出错的事：
 * 1. 未批准的插件被场景顺手启用（信任链旁路）；
 * 2. patch 变成整对象替换（没提到的配置被清掉）；
 * 3. 应用中途失败后留下半套状态（scope 没登记 undo）。
 */
import { describe, expect, it } from "vitest";
import type { PluginSettingField } from "./manifest";
import {
  ProfileApplyError,
  applyProfilePlan,
  emptyProfilesBook,
  normalizeProfiles,
  planProfileApply,
  revertProfileState,
  type WorkProfile,
  type ProfileIo,
  type ProfilePluginFact,
  type ProfileWorld,
} from "./profiles";

const FIELDS: PluginSettingField[] = [
  { key: "epochs", label: "轮数", type: "number", default: 100, min: 1, max: 1000 },
  { key: "amp", label: "混合精度", type: "boolean", default: true },
];

function fact(id: string, over: Partial<ProfilePluginFact> = {}): ProfilePluginFact {
  return { id, enabled: false, verdict: "trusted", fields: [], config: {}, ...over };
}

function profile(over: Partial<WorkProfile> = {}): WorkProfile {
  return {
    id: "p-yolo",
    name: "YOLO",
    plugins: [],
    patch: {},
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const world: ProfileWorld = {
  activeTheme: "",
  workspaceRoot: "D:/old",
  roots: { deploy: "D:/dep1", assets: "D:/assets" },
  themes: ["plg:a:dark"],
  rootKeys: ["deploy", "assets"],
};

const facts = [
  fact("a", { enabled: true, fields: FIELDS, config: { epochs: 30 } }),
  fact("b"),
  fact("c", { verdict: "needs-approval" }),
  fact("d", { enabled: true }),
];

/** 一份把启用集/主题/工作区/外部目录/配置都碰到的场景。 */
function fullProfile(): WorkProfile {
  return profile({
    plugins: [{ id: "b" }, { id: "a" }],
    patch: {
      settings: {
        activeTheme: "plg:a:dark",
        workspaceRoot: "D:/new",
        roots: { deploy: "D:/dep2", assets: null },
      },
      pluginSettings: { a: { epochs: 50 } },
    },
  });
}

describe("planProfileApply：精确集合与信任门", () => {
  it("未列出的已启用插件停用；未批准插件跳过；顺序保持", () => {
    const r = planProfileApply(profile({ plugins: [{ id: "b" }, { id: "c" }, { id: "a" }] }), facts, world);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.enabledSet).toEqual(["b", "a"]);
    expect(r.plan.toEnable).toEqual(["b"]);
    expect(r.plan.toDisable).toEqual(["d"]);
    expect(r.plan.skipped).toEqual([{ id: "c", reason: "untrusted" }]);
    expect(r.plan.before.enabled).toEqual(["a", "d"]);
    expect(r.plan.warnings.join()).toContain("c");
    expect(r.plan.warnings.join()).toContain("d");
  });

  it("未安装 / 重复 id 都跳过并说清楚；重复按第一次的位置", () => {
    const r = planProfileApply(profile({ plugins: [{ id: "zz" }, { id: "b" }, { id: "b" }] }), facts, world);
    if (!r.ok) return;
    expect(r.plan.enabledSet).toEqual(["b"]);
    expect(r.plan.skipped).toEqual([
      { id: "zz", reason: "missing" },
      { id: "b", reason: "duplicate" },
    ]);
  });

  it("主题不存在 ⇒ 忽略这一条并警告（不让场景卡死在一条旧主题上）", () => {
    const r = planProfileApply(
      profile({ patch: { settings: { activeTheme: "plg:gone:theme" } } }),
      facts,
      world,
    );
    if (!r.ok) return;
    expect(r.plan.extensionPatch.activeTheme).toBeUndefined();
    expect(r.plan.warnings.join()).toContain("不在了");
  });

  it("null = 清空主题/工作区/解绑；未声明的外部目录键被跳过", () => {
    const r = planProfileApply(
      profile({
        patch: {
          settings: {
            activeTheme: null,
            workspaceRoot: null,
            roots: { deploy: null, ghost: "D:/ghost" },
          },
        },
      }),
      facts,
      world,
    );
    if (!r.ok) return;
    expect(r.plan.extensionPatch.activeTheme).toBe("");
    expect(r.plan.extensionPatch.workspaceRoot).toBe("");
    expect(r.plan.extensionPatch.roots).toEqual([["deploy", null]]);
    expect(r.plan.warnings.join()).toContain("ghost");
  });
});

describe("planProfileApply：配置补丁", () => {
  it("键级合并，`null` 删除覆盖；before 留的是覆盖值", () => {
    const r = planProfileApply(profile({ patch: { pluginSettings: { a: { epochs: 50 } } } }), facts, world);
    if (!r.ok) return;
    expect(r.plan.settings).toEqual([{ id: "a", patch: { epochs: 50 } }]);
    expect(r.plan.before.pluginSettings).toEqual({ a: { epochs: 30 } });
  });

  it("改成默认值时，diff 用一个 null 把覆盖删掉", () => {
    const r = planProfileApply(profile({ patch: { pluginSettings: { a: { epochs: 100 } } } }), facts, world);
    if (!r.ok) return;
    expect(r.plan.settings).toEqual([{ id: "a", patch: { epochs: null } }]);
  });

  it("未知字段 / 类型错 ⇒ 整单拒绝，不应用半套", () => {
    const unknown = planProfileApply(profile({ patch: { pluginSettings: { a: { nope: 1 } } } }), facts, world);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.join()).toContain("nope");

    const badType = planProfileApply(profile({ patch: { pluginSettings: { a: { epochs: "五十" } } } }), facts, world);
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.errors.join()).toContain("epochs");
  });

  it("配置补丁指向没装的插件 ⇒ 跳过 + 警告（不影响其它步骤）", () => {
    const r = planProfileApply(profile({ patch: { pluginSettings: { ghost: { epochs: 5 } } } }), facts, world);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.settings).toEqual([]);
      expect(r.plan.warnings.join()).toContain("ghost");
    }
  });
});

describe("applyProfilePlan：顺序与逆序撤销", () => {
  function recorder(failAt?: string) {
    const calls: string[] = [];
    const io: ProfileIo = {
      setEnabledSet: async (ids) => {
        calls.push(`enabled:${ids.join(",")}`);
        if (failAt === "enabled") throw new Error("boom");
      },
      setActiveTheme: async (key) => {
        calls.push(`theme:${key}`);
        if (failAt === "theme") throw new Error("boom");
      },
      setWorkspaceRoot: async (path) => {
        calls.push(`workspace:${path}`);
        if (failAt === "workspace") throw new Error("boom");
      },
      setExternalRoot: async (key, path) => {
        calls.push(`root:${key}=${path}`);
        if (failAt === "root") throw new Error("boom");
      },
      setPluginConfig: async (id, patch) => {
        calls.push(`config:${id}:${JSON.stringify(patch)}`);
        if (failAt === "config") throw new Error("boom");
      },
      replacePluginConfig: async (id, values) => {
        calls.push(`replace:${id}:${JSON.stringify(values)}`);
      },
    };
    return { calls, io };
  }

  function plan() {
    const r = planProfileApply(fullProfile(), facts, world);
    if (!r.ok) throw new Error(r.errors.join("；"));
    return r.plan;
  }

  it("按 启用集 → 主题 → 工作区 → 目录 → 配置 的顺序执行", async () => {
    const { calls, io } = recorder();
    await applyProfilePlan(plan(), io);
    expect(calls).toEqual([
      "enabled:b,a",
      "theme:plg:a:dark",
      "workspace:D:/new",
      "root:deploy=D:/dep2",
      "root:assets=",
      "config:a:{\"epochs\":50}",
    ]);
  });

  it("最后一步失败 ⇒ 全部逆序撤销，并报 ProfileApplyError", async () => {
    const { calls, io } = recorder("config");
    await expect(applyProfilePlan(plan(), io)).rejects.toBeInstanceOf(ProfileApplyError);
    expect(calls.slice(0, 6)).toEqual([
      "enabled:b,a",
      "theme:plg:a:dark",
      "workspace:D:/new",
      "root:deploy=D:/dep2",
      "root:assets=",
      "config:a:{\"epochs\":50}",
    ]);
    expect(calls.slice(6)).toEqual([
      "replace:a:{\"epochs\":30}",
      "root:assets=D:/assets",
      "root:deploy=D:/dep1",
      "workspace:D:/old",
      "theme:",
      "enabled:a,d",
    ]);
  });

  it("主题就失败 ⇒ 先回退主题再回退启用集（undo 在执行前就登记）", async () => {
    const { calls, io } = recorder("theme");
    await expect(applyProfilePlan(plan(), io)).rejects.toBeInstanceOf(ProfileApplyError);
    expect(calls).toEqual(["enabled:b,a", "theme:plg:a:dark", "theme:", "enabled:a,d"]);
  });
});

describe("revertProfileState", () => {
  function recorder() {
    const calls: string[] = [];
    const io: ProfileIo = {
      setEnabledSet: async (ids) => void calls.push(`enabled:${ids.join(",")}`),
      setActiveTheme: async (key) => void calls.push(`theme:${key}`),
      setWorkspaceRoot: async (path) => void calls.push(`workspace:${path}`),
      setExternalRoot: async (key, path) => void calls.push(`root:${key}=${path}`),
      setPluginConfig: async () => undefined,
      replacePluginConfig: async (id, values) => void calls.push(`replace:${id}:${JSON.stringify(values)}`),
    };
    return { calls, io };
  }

  const before = {
    enabled: ["a"],
    settings: { activeTheme: "plg:a:dark", workspaceRoot: "D:/old", roots: { deploy: "D:/dep1" } },
    pluginSettings: { a: { epochs: 30 } },
  };

  it("恢复启用集/主题/工作区/目录，并解绑场景新增的目录", async () => {
    const { calls, io } = recorder();
    const r = await revertProfileState(before, io, { deploy: "D:/dep2", extra: "D:/extra" });
    expect(r.failed).toBe(0);
    expect(calls).toEqual([
      "enabled:a",
      "theme:plg:a:dark",
      "workspace:D:/old",
      "root:extra=",
      "root:deploy=D:/dep1",
      "replace:a:{\"epochs\":30}",
    ]);
  });

  it("失败不中断其余步骤，并如实返回条数", async () => {
    const { calls, io } = recorder();
    io.setActiveTheme = async () => {
      throw new Error("主题坏了");
    };
    const r = await revertProfileState(before, io, {});
    expect(r.failed).toBe(1);
    expect(r.errors.join()).toContain("主题");
    expect(calls).toContain("enabled:a");
    expect(calls).toContain("root:deploy=D:/dep1");
  });
});

describe("normalizeProfiles", () => {
  it("正常账本原样读回；null/没写过不报错", () => {
    const raw = {
      version: 1,
      profiles: [fullProfile()],
      activeId: "p-yolo",
      applied: { id: "p-yolo", at: 2, before: { enabled: ["a"], settings: { activeTheme: "", workspaceRoot: "", roots: {} }, pluginSettings: {} } },
    };
    const r = normalizeProfiles(raw);
    expect(r.issues).toEqual([]);
    expect(r.book.profiles[0].plugins).toEqual([{ id: "b" }, { id: "a" }]);
    expect(r.book.profiles[0].patch.settings?.roots).toEqual({ deploy: "D:/dep2", assets: null });
    expect(normalizeProfiles(null).issues).toEqual([]);
    expect(normalizeProfiles(null).book).toEqual(emptyProfilesBook());
  });

  it("坏条目逐条丢弃；activeId 指向不存在的场景 ⇒ 清空", () => {
    const r = normalizeProfiles({
      version: 1,
      profiles: [{ id: "BAD", name: "x", plugins: [] }, { id: "ok", name: "好的", plugins: [] }],
      activeId: "gone",
    });
    expect(r.book.profiles.map((p) => p.id)).toEqual(["ok"]);
    expect(r.book.activeId).toBe("");
    expect(r.issues.join()).toContain("BAD");
    expect(r.issues.join()).toContain("gone");
  });

  it("应用前快照读不出来 ⇒ 清空活动状态（不留一个回不去的场景）", () => {
    const r = normalizeProfiles({
      version: 1,
      profiles: [profile()],
      activeId: "p-yolo",
      applied: { id: "p-yolo", at: 1, before: { enabled: "nope" } },
    });
    expect(r.book.activeId).toBe("");
    expect(r.book.applied).toBeUndefined();
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("版本不认 ⇒ 空账本 + 一句", () => {
    const r = normalizeProfiles({ version: 99, profiles: [profile()] });
    expect(r.book).toEqual(emptyProfilesBook());
    expect(r.issues.join()).toContain("99");
  });
});
