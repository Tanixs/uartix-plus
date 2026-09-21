/**
 * P93-A6 / P92-C / P98-M3：授权档位的语义单测。
 * 钉住四件事：自定义不是更低一档、空勾选不会让任务瘫痪、pill 说清授了什么、
 * **收档不能收掉能力**（第 2 条：3 主档 + 3 预设必须覆盖收档前全部 7 个可达状态）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_TIER, DEFAULT_DOMAINS, DOMAIN_PRESETS, DOMAINS, DOMAIN_TIP, DOMAIN_ZH, PRIMARY_TIERS,
  TIERS, hasDomain, normalizeAllowed, rememberTier, resolveTier, restoreTier, tierBadge, tierIdOf, tierOf,
} from "./scopeTiers";
import type { Domain } from "./scopeTiers";

const storage = new Map<string, string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

beforeEach(() => storage.clear());

describe("scopeTiers 结构", () => {
  it("第一层只有三档；预设降级到高级区（用户数的「8 个发送方式」就是这两层混在一列）", () => {
    expect(PRIMARY_TIERS.map((t) => t.id)).toEqual(["read", "create", "full"]);
    expect(PRIMARY_TIERS.map((t) => t.label)).toEqual(["仅预览", "放手改界面", "全面放手"]);
    expect(DOMAIN_PRESETS.map((t) => t.id)).toEqual(["workspace", "device", "host"]);
    // custom 不再是 TIERS 里的一条预设，它是"勾选不等于任何预设"的落点
    expect(TIERS.some((t) => t.id === CUSTOM_TIER.id)).toBe(false);
  });

  /**
   * 收档的安全网。右边这份字面量**是**第二份清单——但它是故意的变更检测钉：
   * P98-M3 把 7 个 radio 收成 3 个 + 3 个 chip，若哪天有人删掉某个预设或改了域集，
   * 这里会红，逼他确认"能力少了"是有意的而不是手滑。平时不该动它。
   */
  it("3 主档 + 3 预设覆盖收档前全部 7 个可达状态，一个能力都没少", () => {
    const reachable = new Set(
      [...TIERS, CUSTOM_TIER].map((t) => `${t.scope}|${[...t.domains].sort().join(",")}`),
    );
    const before = [
      "preview|",
      "create|config,plugins",
      "custom|config,files,plugins",
      "custom|config,device,plugins",
      "custom|config,device,files,network,plugins,shell,ui",
      "custom|config,device,files,network,plugins,shell,ui,write",
      "custom|", // 手工勾选（空集→兜底，但状态本身可达）
    ].map((s) => {
      const [scope, dom] = s.split("|");
      return `${scope}|${dom.split(",").filter(Boolean).sort().join(",")}`;
    });
    for (const state of before) expect(reachable, `收档前的状态 ${state} 现在不可达了`).toContain(state);
  });

  it("预设与最高档都必须是「放手改界面」的严格超集（防「扩展档反而更低」复发）", () => {
    const base = TIERS.find((t) => t.id === "create")!;
    for (const ext of [...DOMAIN_PRESETS, TIERS.find((t) => t.id === "full")!]) {
      expect(ext.domains.length).toBeGreaterThan(base.domains.length);
      expect(ext.domains).toEqual(expect.arrayContaining(base.domains));
    }
  });

  it("域清单稳定且无重复；每档的域都在清单内", () => {
    expect(new Set(DOMAINS).size).toBe(DOMAINS.length);
    expect(DOMAINS).toEqual(["config", "plugins", "device", "files", "network", "shell", "ui", "write"]);
    for (const t of TIERS) expect(t.domains.every((d) => DOMAINS.includes(d))).toBe(true);
  });

  it("每一档都有名有说明，每个域都有中文名与边界说明（面板不再有第二份标签表）", () => {
    for (const t of [...TIERS, CUSTOM_TIER]) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(0);
    }
    for (const d of DOMAINS) {
      expect(DOMAIN_ZH[d].length).toBeGreaterThan(0);
      expect(DOMAIN_TIP[d].length).toBeGreaterThan(0);
    }
    expect(Object.keys(DOMAIN_ZH).sort()).toEqual([...DOMAINS].sort());
    expect(Object.keys(DOMAIN_TIP).sort()).toEqual([...DOMAINS].sort());
  });
});

describe("resolveTier / tierIdOf / tierBadge", () => {
  it("主档给出 scope，预设与 custom 给出 custom + 域集", () => {
    expect(resolveTier("read", [])).toEqual({ scope: "preview", allowed: [] });
    expect(resolveTier("create", ["shell"])).toEqual({ scope: "create", allowed: ["config", "plugins"] });
    expect(resolveTier("full", []).allowed).toEqual([...DOMAINS]);
    expect(resolveTier("workspace", []).allowed).toEqual(["config", "plugins", "files"]);
    expect(resolveTier("host", []).scope).toBe("custom");
    // custom 走手工勾选集，且不再是"查不到就兜底"
    expect(resolveTier("custom", ["network"])).toEqual({ scope: "custom", allowed: ["network"] });
  });

  it("空勾选兜底：任何路径都不会产出 authorized() 恒 false 的任务", () => {
    expect(resolveTier("custom", []).allowed).toEqual(DEFAULT_DOMAINS);
    expect(resolveTier("host", []).allowed.length).toBeGreaterThan(0);
    expect(normalizeAllowed("custom", [])).toEqual(DEFAULT_DOMAINS);
    expect(normalizeAllowed("custom", null)).toEqual(DEFAULT_DOMAINS);
    expect(normalizeAllowed("custom", ["nope", "shell"])).toEqual(["shell"]); // 未知域丢弃
    expect(normalizeAllowed("create", ["shell"])).toEqual([]); // 非 custom 一律空集
  });

  it("tierIdOf 反推：主档/预设认得出来，改过勾选就落回 custom", () => {
    expect(tierIdOf("preview", [])).toBe("read");
    expect(tierIdOf("create", [])).toBe("create");
    expect(tierIdOf("custom", [...DOMAINS])).toBe("full");
    expect(tierIdOf("custom", ["config", "plugins", "files"])).toBe("workspace");
    expect(tierIdOf("custom", ["plugins", "config", "files"])).toBe("workspace"); // 勾选顺序无关
    expect(tierIdOf("custom", ["files"])).toBe("custom");
    expect(tierIdOf("custom", ["config", "plugins"])).toBe("custom"); // 域集同 create 但 scope=custom → 仍是手工
    expect(tierOf("custom", ["files"]).id).toBe("custom");
    expect(tierOf("custom", [...DOMAINS]).label).toBe("全面放手");
  });

  it("tierBadge 把授权量说在明面上", () => {
    expect(tierBadge("preview", [])).toBe("仅预览");
    expect(tierBadge("create", [])).toBe("放手改界面");
    expect(tierBadge("custom", [...DOMAINS])).toBe("全面放手");
    expect(tierBadge("custom", ["config", "plugins", "files"])).toBe("工作区写入");
    expect(tierBadge("custom", ["files"])).toBe("自定义 · 1 项授权");
    expect(tierBadge("custom", [])).toBe("自定义 · 2 项授权"); // 空集按兜底 2 项显示，不说"0 项"
  });
});

describe("restoreTier（Q3 折中：记住选择，但高危档不自动恢复）", () => {
  it("没存过 → 默认「放手改界面」，且不算降级（不该弹提示）", () => {
    expect(restoreTier()).toEqual({ scope: "create", allowed: ["config", "plugins"], downgraded: false });
  });

  it("preview / create 原样恢复", () => {
    rememberTier("preview", []);
    expect(restoreTier()).toEqual({ scope: "preview", allowed: [], downgraded: false });
    rememberTier("create", []);
    expect(restoreTier().scope).toBe("create");
    expect(restoreTier().downgraded).toBe(false);
  });

  it("上次是全面放手或手工勾选 → 回落 create 并如实报 downgraded，让 UI 明说而不是静默改", () => {
    rememberTier("custom", [...DOMAINS] as Domain[]);
    const r = restoreTier();
    expect(r.scope).toBe("create");
    expect(r.downgraded).toBe(true);
    // 回落后的档位必须是"低危"的：全面放手绝不跨重启回来
    expect(hasDomain(r.scope, r.allowed, "shell")).toBe(false);
    expect(hasDomain(r.scope, r.allowed, "write")).toBe(false);
  });

  it("脏数据 / 坏 JSON / 未知 scope 一律回落默认，不抛", () => {
    storage.set("vs.agentTier.v1", "{not json");
    expect(restoreTier().scope).toBe("create");
    storage.set("vs.agentTier.v1", JSON.stringify({ scope: "yolo", allowed: [] }));
    expect(restoreTier()).toEqual({ scope: "create", allowed: ["config", "plugins"], downgraded: false });
    storage.set("vs.agentTier.v1", JSON.stringify({ scope: "custom", allowed: "nope" }));
    expect(restoreTier().scope).toBe("create");
  });

  it("localStorage 整个坏掉时也不能崩（隐私模式/配额满是真实场景）", () => {
    const saved = globalThis.localStorage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(() => rememberTier("create", [])).not.toThrow();
    expect(restoreTier().scope).toBe("create");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = saved;
  });
});

describe("hasDomain", () => {
  it("create=config+plugins；custom=勾选集；preview 恒 false", () => {
    expect(hasDomain("create", [], "config")).toBe(true);
    expect(hasDomain("create", [], "plugins")).toBe(true);
    expect(hasDomain("create", ["files"], "files")).toBe(false); // create 不含扩展域
    expect(hasDomain("custom", ["config"], "config")).toBe(true);
    expect(hasDomain("custom", ["files"], "config")).toBe(false);
    expect(hasDomain("custom", undefined, "config")).toBe(false);
    expect(hasDomain("preview", ["config", "plugins", "shell"], "config")).toBe(false);
  });

  it("P97 新域：界面深改与文件写入都要显式授权，create 档拿不到", () => {
    expect(hasDomain("create", [], "ui")).toBe(false);
    expect(hasDomain("create", [], "write")).toBe(false);
    expect(hasDomain("custom", ["ui"], "ui")).toBe(true);
    expect(resolveTier("host", []).allowed).toContain("ui");
    expect(resolveTier("host", []).allowed).not.toContain("write");
  });
});
