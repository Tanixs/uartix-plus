import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, t, tx } from "./strings";

const store: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("locale 解析", () => {
  it("无存储默认中文", () => {
    expect(getLocale()).toBe("zh");
  });
  it("损坏 JSON 容错回中文", () => {
    store["vs.settings"] = "{oops";
    expect(getLocale()).toBe("zh");
  });
  it("en 生效", () => {
    store["vs.settings"] = JSON.stringify({ locale: "en" });
    expect(getLocale()).toBe("en");
  });
});

describe("t 中心键", () => {
  it("中文命中字典", () => {
    expect(t("c.ok")).toBe("确定");
  });
  it("未知键回退键名", () => {
    expect(t("no.such.key.xyz")).toBe("no.such.key.xyz");
  });
});

describe("tx 就近双语", () => {
  it("中文态取 zh", () => {
    expect(tx("结构发现", "X-Ray")).toBe("结构发现");
  });
  it("英文态取 en", () => {
    store["vs.settings"] = JSON.stringify({ locale: "en" });
    expect(tx("结构发现", "X-Ray")).toBe("X-Ray");
  });
});
