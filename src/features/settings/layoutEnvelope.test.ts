import { describe, expect, it, vi } from "vitest";
import {
  LAYOUT_KEY_CORRUPT,
  LAYOUT_KEY_V2,
  LAYOUT_KEY_V3,
  packEnvelope,
  unwrapEnvelope,
} from "./layoutEnvelope";

/** 最小版"dockview 布局长什么样"判定，与 applyLayout.looksLikeLayoutJson 同语义。 */
const looks = (v: unknown): boolean =>
  !!v && typeof v === "object" && !Array.isArray(v) && ("panels" in (v as object) || "grid" in (v as object) || "groups" in (v as object));

const V2_LAYOUT = { panels: [{ id: "console" }], grid: { root: { type: "branch" } } };

describe("B13① 版本信封：pack / unwrap 往返", () => {
  it("包起来再解开，拿回的就是那份布局", () => {
    const u = unwrapEnvelope(packEnvelope(V2_LAYOUT), looks);
    expect(u).toEqual({ kind: "envelope", layout: V2_LAYOUT });
  });

  it("信封里带版本号，且键名从 v2 换到了 v3", () => {
    expect(JSON.parse(packEnvelope(V2_LAYOUT))).toHaveProperty("v", 3);
    expect(LAYOUT_KEY_V3).toBe("vs.layout.v3");
    expect(LAYOUT_KEY_V2).toBe("vs.layout.v2");
  });
});

describe("B13① 迁移：老 v2 裸档必须还能读", () => {
  it("裸 dockview JSON 认成 bare，内容可用（这就是启动时读到的旧档）", () => {
    const u = unwrapEnvelope(JSON.stringify(V2_LAYOUT), looks);
    expect(u).toEqual({ kind: "bare", layout: V2_LAYOUT });
  });

  it("bare → 就地升级成 v3 之后，再读就是 envelope 而不是 bare", () => {
    const u = unwrapEnvelope(JSON.stringify(V2_LAYOUT), looks);
    // 联合类型：只有非 bad 的两支带 layout
    expect(u?.kind).toBe("bare");
    const upgraded = u?.kind === "bare" ? packEnvelope(u.layout) : "";
    expect(unwrapEnvelope(upgraded, looks)?.kind).toBe("envelope");
  });
});

describe("B13① 判据要保守：读不懂 ≠ 没有存档", () => {
  /* 这一组钉的是"不许把看不懂的档当成空档处理"。
     旧写法 `catch { localStorage.removeItem(LAYOUT_KEY) }` 会把用户摆好的布局删掉，
     而布局是不可重试的东西 —— 所以认不出来时必须返回 bad，让调用方**留着它**。 */

  it("比本版本更新的信封：判 bad，绝不硬喂给 dockview", () => {
    const future = JSON.stringify({ v: 99, layout: V2_LAYOUT });
    expect(unwrapEnvelope(future, looks)).toEqual({ kind: "bad", raw: future });
  });

  it("坏 JSON / 不是布局的东西：判 bad，并把原文带回去留证", () => {
    for (const raw of ["{not json", '"a string"', "[1,2,3]", '{"v":3,"layout":null}']) {
      const u = unwrapEnvelope(raw, looks);
      expect(u?.kind, raw).toBe("bad");
      if (u?.kind === "bad") expect(u.raw, raw).toBe(raw);
    }
  });

  it("键不存在才返回 null（null 与 bad 是两件事，不能合并处理）", () => {
    expect(unwrapEnvelope(null, looks)).toBeNull();
  });
});

describe("B13① clearStoredLayout 必须三个键一起清", () => {
  /* 只清 v3 的话，v2 备份会在下次启动被当旧档读回来 ——
     表现是"重置布局没生效 / ?preset= 静默失效"，而且不报任何错。 */
  it("v3 / v2 / corrupt 一起消失", async () => {
    const store = new Map<string, string>([
      [LAYOUT_KEY_V3, packEnvelope(V2_LAYOUT)],
      [LAYOUT_KEY_V2, JSON.stringify(V2_LAYOUT)],
      [LAYOUT_KEY_CORRUPT, "{not json"],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const { clearStoredLayout } = await import("./layoutsStore");
    clearStoredLayout();
    expect([...store.keys()]).toEqual([]);
    vi.unstubAllGlobals();
  });
});
