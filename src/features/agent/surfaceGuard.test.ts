/**
 * P110-A · 表面阶梯守卫（详设 §3′/§3′.1）。
 *
 * 钉的是这一条：**格式合法 ≠ 不弄坏界面**。`isValidTokenValue` 对颜色类键是无条件放行的，
 * 于是一枚 `--raise-1: #ffffff` 能在暗色主题里把五处表面刷白（用户 2026-09-27 的图 3），
 * 从写入、落盘到门禁一路没人拦。这里补的是"施加之后读回实际颜色再判"的那一层。
 *
 * 两个方向都要有（§8-52）：坏值必须被撤、好值必须原样活着。
 * 尤其"好值活着"这一边——内置玻璃配方就是故意把 `--bg-panel` 写成 alpha=0.72 的
 * （`appearanceTools.glassVars`），守卫要把它判死就是自己造事故。
 *
 * 探针是注进来的：node 环境里没有 CSS 引擎，`color-mix` 读回来是垃圾值，
 * 判据只能对着"浏览器会给出的 RGBA"覆盖。真实浏览器那一遍留给 tauri dev 验收。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPEARANCE_TOKENS,
  RAISE_MAX_DELTA_L,
  SURFACE_PROBE_KEYS,
  contrastRatio,
  judgeSurfaceLadder,
  lstarOf,
  type Rgba,
  type SurfaceProbeKey,
} from "../../styles/themeCore";
import { clearOverlay, getOverrides, parseComputedRgba, patchTokens } from "./appearanceStore";

const c = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
/** `color-mix(in srgb, A p%, B)` 的算法本身：在 sRGB 编码值上线性插值 */
const mix = (A: Rgba, B: Rgba, pctOfA: number): Rgba => {
  const f = pctOfA / 100;
  return {
    r: A.r * f + B.r * (1 - f),
    g: A.g * f + B.g * (1 - f),
    b: A.b * f + B.b * (1 - f),
    a: A.a * f + B.a * (1 - f),
  };
};

/* 内置 dark 的实测锚点（node .tools/check-contrast.cjs 会打印同一批数：panel=9.1 raise1=17.2 raise2=22.9） */
const DARK: Partial<Record<SurfaceProbeKey, Rgba>> = {
  "--bg": c(15, 17, 21),
  "--bg-panel": c(22, 26, 32),
  "--bg-inset": c(11, 13, 16),
  "--bg-titlebar": c(11, 13, 17),
  "--text": c(230, 233, 238),
};
/* 内置 light 的锚点（panel=100.0 raise1=95.4 raise2=92.3 —— 亮底是"往暗里退"，方向与暗底相反） */
const LIGHT: Partial<Record<SurfaceProbeKey, Rgba>> = {
  "--bg": c(248, 250, 252),
  "--bg-panel": c(255, 255, 255),
  "--bg-inset": c(239, 241, 245),
  "--bg-titlebar": c(243, 245, 247),
  "--text": c(31, 35, 40),
};
const withRaise = (base: Partial<Record<SurfaceProbeKey, Rgba>>, p1: number, p2: number) => ({
  ...base,
  "--raise-1": mix(base["--bg-panel"]!, base["--text"]!, p1),
  "--raise-2": mix(base["--bg-panel"]!, base["--text"]!, p2),
});

describe("P110-A · judgeSurfaceLadder 判据", () => {
  it("内置两档混色（暗底 8%/14%、亮底 6%/10%）：既不能撤也不能提醒", () => {
    for (const [name, table] of [["dark", DARK], ["light", LIGHT]] as const) {
      const [p1, p2] = name === "dark" ? [92, 86] : [94, 90];
      const issues = judgeSurfaceLadder(withRaise(table, p1, p2));
      expect(issues, `${name} 的内置阶梯被判坏`).toEqual([]);
    }
  });

  it("图 3 那枚事故值：暗色主题把 --raise-1 写成接近白 ⇒ fatal，且点名是哪枚键", () => {
    const issues = judgeSurfaceLadder({ ...DARK, "--raise-1": c(255, 255, 255), "--raise-2": c(43, 47, 54) });
    const fatal = issues.filter((i) => i.fatal);
    expect(fatal.map((i) => i.key)).toEqual(["--raise-1"]);
    expect(fatal[0].reason).toContain("抬过头");
    expect(lstarOf(c(255, 255, 255)) - lstarOf(DARK["--bg-panel"]!)).toBeGreaterThan(RAISE_MAX_DELTA_L);
  });

  it("方向反了要撤：暗底的抬升档比面板还暗（层级被读成凹陷）", () => {
    const issues = judgeSurfaceLadder({ ...DARK, "--raise-1": c(12, 13, 15), "--raise-2": c(8, 9, 10) });
    expect(issues.filter((i) => i.fatal).map((i) => i.key).sort()).toEqual(["--raise-1", "--raise-2"]);
  });

  it("亮底的相反方向同样要撤：面板已经是最白，抬升档再往亮走等于没抬 + 方向反", () => {
    const issues = judgeSurfaceLadder({ ...LIGHT, "--raise-1": c(255, 255, 255), "--raise-2": c(255, 255, 255) });
    // 与面板同色走"看不出来"的提醒档；一旦超过面板就判方向
    expect(issues.every((i) => !i.fatal)).toBe(true);
    const over = judgeSurfaceLadder({ ...LIGHT, "--bg-panel": c(250, 250, 250), "--raise-1": c(255, 255, 255) });
    expect(over.filter((i) => i.fatal).map((i) => i.key)).toContain("--raise-1");
  });

  it("抬升档半透明 ⇒ fatal（漏底那一族）；基础档半透明只提醒——内置玻璃配方就是 alpha=0.72", () => {
    const raiseAlpha = judgeSurfaceLadder({ ...DARK, "--raise-1": c(39, 43, 49, 0.7) });
    expect(raiseAlpha.find((i) => i.key === "--raise-1")).toMatchObject({ fatal: true });
    const glass = judgeSurfaceLadder({
      ...DARK,
      "--bg-panel": c(22, 26, 32, 0.72),
      "--bg-inset": c(11, 13, 16, 0.6),
      "--bg-titlebar": c(11, 13, 17, 0.66),
      "--raise-1": mix(c(22, 26, 32), c(230, 233, 238), 92),
      "--raise-2": mix(c(22, 26, 32), c(230, 233, 238), 86),
    });
    expect(glass.some((i) => i.fatal), "玻璃配方被撤了").toBe(false);
    expect(glass.map((i) => i.key)).toContain("--bg-panel");
  });

  it("阶梯倒置与二级弱于一级：提醒，不撤（整套阶梯是四枚键的事，逐键撤会撤出更怪的中间态）", () => {
    const inverted = judgeSurfaceLadder({ ...DARK, "--bg-panel": c(11, 13, 16), "--bg-inset": c(22, 26, 32) });
    expect(inverted.find((i) => i.reason.includes("阶梯倒置"))?.fatal).toBe(false);
    const weak = judgeSurfaceLadder({ ...DARK, "--raise-1": c(60, 64, 72), "--raise-2": c(30, 32, 36) });
    const note = weak.find((i) => i.key === "--raise-2" && i.reason.includes("还弱"));
    expect(note?.fatal).toBe(false);
  });

  it("一枚都读不出来 ⇒ 什么都不判（不拿'读不到'当'不合格'）", () => {
    expect(judgeSurfaceLadder({})).toEqual([]);
    const nulls = Object.fromEntries(SURFACE_PROBE_KEYS.map((k) => [k, null]));
    expect(judgeSurfaceLadder(nulls)).toEqual([]);
  });
});

describe("P110-A · parseComputedRgba（computed 串 → RGBA）", () => {
  it("吃得下真机会给出的全部形状，认不出的返回 null", () => {
    expect(parseComputedRgba("rgb(22, 26, 32)")).toEqual(c(22, 26, 32));
    expect(parseComputedRgba("rgba(22, 26, 32, 0.72)")).toEqual(c(22, 26, 32, 0.72));
    expect(parseComputedRgba("rgb(22 26 32 / 50%)")).toEqual(c(22, 26, 32, 0.5));
    // ↓ 两条是从真机（Edge/Chromium）原样抄回来的：color-mix 的结果**不是** rgb(...)
    const mixed = parseComputedRgba("color(srgb 0.151529 0.166902 0.190118)");
    expect(mixed).not.toBeNull();
    expect(Math.round(mixed!.r)).toBe(39);
    expect(Math.round(mixed!.g)).toBe(43);
    expect(Math.round(mixed!.b)).toBe(48);
    expect(parseComputedRgba("color(srgb 0.426752 0.436593 0.451355 / 0.805098)")?.a).toBeCloseTo(0.805, 2);
    expect(parseComputedRgba("lab(50% 40 59.5)")).toBeNull();
    expect(parseComputedRgba("")).toBeNull();
  });

  it("var 根本没有值时浏览器给的是 rgba(0, 0, 0, 0) —— 那是'读不到'，不是'读了个全黑'", () => {
    expect(parseComputedRgba("rgba(0, 0, 0, 0)")).toBeNull();
    expect(parseComputedRgba("rgba(0, 0, 0, 0.4)")).not.toBeNull();
  });

  it("内置那两档混色经浏览器算出来是 color(srgb …)：守卫读得动，才算得出 ΔL*", () => {
    const raise1 = parseComputedRgba("color(srgb 0.151529 0.166902 0.190118)")!;
    const panel = parseComputedRgba("rgb(22, 26, 32)")!;
    const d = lstarOf(raise1) - lstarOf(panel);
    // 与静态求值器（.tools/check-contrast.cjs 打印的 dark raise1=17.2 / Δ=8.1）同一枚数
    expect(d).toBeGreaterThan(7);
    expect(d).toBeLessThan(9);
  });
});

describe("P110-A · patchTokens 的逐键降级（施加后撤回，不是整批拒绝）", () => {
  beforeEach(() => {
    clearOverlay();
  });

  /** 探针读回来的一屏颜色：12 项里只有 `--raise-1` 是那枚接近白的坏值 */
  const badRaiseProbe = () =>
    ({ ...DARK, "--raise-1": c(255, 255, 255), "--raise-2": mix(DARK["--bg-panel"]!, DARK["--text"]!, 86) }) as Record<
      SurfaceProbeKey,
      Rgba
    >;
  /** 内置那两档混色（暗底 92/8）——守卫不该动它们分毫 */
  const goodProbe = () => withRaise(DARK, 92, 86) as Record<SurfaceProbeKey, Rgba>;

  it("12 枚里 1 枚坏：坏的那枚被撤且点名，其余 11 枚照常生效", () => {
    const tokens: Record<string, string> = {
      "--bg": "#0f1115",
      "--bg-panel": "#161a20",
      "--bg-inset": "#0b0d10",
      "--border": "#262b33",
      "--text": "#e6e9ee",
      "--text-dim": "#8b93a1",
      "--accent": "#4e9cef",
      "--on-accent": "#0f1115",
      "--radius-m": "6px",
      "--fs-body": "11px",
      "--raise-1": "#ffffff",
      "--raise-2": "#2b303a",
    };
    const r = patchTokens(tokens, badRaiseProbe);
    expect(r.ok).toBe(true);
    expect(r.applied).toHaveLength(11);
    expect(r.applied).not.toContain("--raise-1");
    expect(r.dropped?.map((d) => d.key)).toEqual(["--raise-1"]);
    expect(String(r.dropped?.[0].reason)).toContain("抬过头");
    expect(getOverrides()["--raise-1"]).toBeUndefined();
    expect(getOverrides()["--bg-panel"]).toBe("#161a20");
    expect(r.warned).toBeUndefined();
  });

  it("全部被撤 ⇒ 整批回滚（不留'成功但什么都没改'的回执），err 点名是哪几枚", () => {
    // 探针读回的是"这一屏实际长什么样"：两档抬升一枚白一枚黑，都越过线
    const bothBad = () =>
      ({ ...DARK, "--raise-1": c(255, 255, 255), "--raise-2": c(0, 0, 0) }) as Record<SurfaceProbeKey, Rgba>;
    const r = patchTokens({ "--raise-1": "#ffffff", "--raise-2": "#000000" }, bothBad);
    expect(r.ok).toBe(false);
    expect(String(r.err)).toContain("rejected_by_surface_guard");
    expect(String(r.err)).toContain("--raise-1");
    expect(String(r.err)).toContain("--raise-2");
    expect(Object.keys(getOverrides())).toEqual([]);
  });

  it("好值一路放行：守卫在场时内置那套混色档一枚都不许掉", () => {
    const r = patchTokens({ "--raise-1": "#272b31", "--raise-2": "#33383f", "--bg-panel": "#161a20" }, goodProbe);
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(["--raise-1", "--raise-2", "--bg-panel"]);
    expect(r.dropped).toBeUndefined();
    expect(r.warned).toBeUndefined();
  });

  it("探针读不到（node/假 DOM）⇒ 一律放行：撤用户的值必须是看得见的判断，不能是环境的意外", () => {
    const r = patchTokens({ "--raise-1": "#ffffff" }, () => ({}));
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(["--raise-1"]);
    expect(getOverrides()["--raise-1"]).toBe("#ffffff");
  });

  it("非表面键根本不跑探针（字号/圆角那类与阶梯无关，别付这笔钱）", () => {
    let called = 0;
    const r = patchTokens({ "--fs-body": "12px", "--radius-m": "6px" }, () => {
      called++;
      return {};
    });
    expect(r.ok).toBe(true);
    expect(called).toBe(0);
  });

  it("上次留下的坏值：本次不撤它，但要在 warned 里说出来（凭空动用户没碰的键更糟）", () => {
    const first = patchTokens({ "--raise-1": "#ffffff" }, () => ({})); // 先绕守卫塞进去一枚坏值
    expect(first.ok).toBe(true);
    const second = patchTokens({ "--bg-panel": "#161a20" }, () => ({
      ...DARK,
      "--bg-panel": c(22, 26, 32),
      "--raise-1": c(255, 255, 255),
    }) as Record<SurfaceProbeKey, Rgba>);
    expect(second.ok).toBe(true);
    expect(second.dropped).toBeUndefined();
    expect(second.warned?.some((w) => w.key === "--raise-1" && w.reason.includes("未自动撤回"))).toBe(true);
    expect(getOverrides()["--raise-1"]).toBe("#ffffff");
  });

  it("探针键表与白名单对得上（漏一枚 = 那枚坏值没人看）", () => {
    expect(SURFACE_PROBE_KEYS).toContain("--raise-1");
    expect(SURFACE_PROBE_KEYS).toContain("--raise-2");
    for (const k of SURFACE_PROBE_KEYS) expect(k.startsWith("--")).toBe(true);
  });

  it("要守的键确实都是可写的（不可写的键不需要守卫，需要的是注释）", () => {
    for (const k of SURFACE_PROBE_KEYS) expect(APPEARANCE_TOKENS as readonly string[]).toContain(k);
    // 反向一半：另两枚派生档**不在**白名单里，这是 P103 定的口径（派生层由基础档算出来），
    // 别哪天"顺手"把它们加进去 —— 加了就必须同时在这里补判据，否则又是"写派生档打乱阶梯"。
    expect(APPEARANCE_TOKENS).not.toContain("--bar-bg" as never);
    expect(APPEARANCE_TOKENS).not.toContain("--text-faint" as never);
  });

  it("contrastRatio 用已知真值钉住（它与 .tools/check-contrast.cjs 那份必须同算法）", () => {
    expect(contrastRatio(c(0, 0, 0), c(255, 255, 255))).toBeCloseTo(21, 1);
    expect(contrastRatio(c(255, 255, 255), c(255, 255, 255))).toBeCloseTo(1, 3);
    // 内置 dark 的正文压面板：门禁给内置主题定的就是 4.5，这里跑到同一枚数才算同一套判据
    expect(contrastRatio(DARK["--text"]!, DARK["--bg-panel"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("低对比只出声、不撤（红线：任何变严都要用户先点头）", () => {
    const murky = judgeSurfaceLadder({
      ...withRaise(DARK, 92, 86),
      "--text": c(40, 44, 50), // 正文几乎与面板同色
    });
    expect(murky.length).toBeGreaterThan(0);
    expect(murky.every((i) => !i.fatal), "对比度守卫把值撤了 = 未经用户同意的变严").toBe(true);
    expect(murky.some((i) => i.reason.includes(":1"))).toBe(true);
  });
});
