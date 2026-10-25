/**
 * P174-B2：插件配置判据。
 *
 * 守两件事：只存"与默认值不同"的覆盖（清单升级改默认值时，没动过的字段自动跟上），
 * 以及 `null` 才是删除。键级 patch 不是整对象替换——后者会把未提及的键一起清掉。
 */
import { describe, expect, it } from "vitest";
import type { PluginSettingField } from "./manifest";
import {
  applyPluginConfigPatch,
  defaultPluginConfig,
  diffPluginConfig,
  effectivePluginConfig,
  normalizePluginConfig,
} from "./pluginConfig";

const FIELDS: PluginSettingField[] = [
  { key: "epochs", label: "轮数", type: "number", default: 100, min: 1, max: 1000 },
  { key: "model", label: "模型", type: "string", default: "yolo11n.pt" },
  { key: "amp", label: "混合精度", type: "boolean", default: true },
  { key: "device", label: "设备", type: "enum", default: "auto", options: ["auto", "cpu", "cuda"] },
];

describe("默认值与生效值", () => {
  it("默认值只来自清单", () => {
    expect(defaultPluginConfig(FIELDS)).toEqual({ epochs: 100, model: "yolo11n.pt", amp: true, device: "auto" });
  });

  it("覆盖值叠加在默认值上；存储里类型不对的键不会生效", () => {
    expect(effectivePluginConfig(FIELDS, { epochs: 30, amp: false })).toMatchObject({ epochs: 30, amp: false, model: "yolo11n.pt" });
    expect(effectivePluginConfig(FIELDS, { epochs: "三十" as unknown as number }).epochs).toBe(100);
    expect(effectivePluginConfig(FIELDS, { device: "tpu" as unknown as string }).device).toBe("auto");
  });
});

describe("键级 patch", () => {
  it("只改出现的键，其余保持", () => {
    const r = applyPluginConfigPatch(FIELDS, { epochs: 30, amp: false }, { epochs: 50 });
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({ epochs: 50, amp: false });
  });

  it("null = 删除覆盖、回落默认；结果里不会留一个等于默认值的覆盖", () => {
    const r = applyPluginConfigPatch(FIELDS, { epochs: 30, amp: false }, { epochs: null, amp: true });
    expect(r.values).toEqual({});
  });

  it("值等于默认时不落库（清单改默认值时能自动跟上）", () => {
    const r = applyPluginConfigPatch(FIELDS, {}, { epochs: 100, amp: true });
    expect(r.values).toEqual({});
  });

  it("未声明的键、类型不符、范围越界 ⇒ 整单拒绝并点名", () => {
    expect(applyPluginConfigPatch(FIELDS, {}, { nope: 1 }).ok).toBe(false);
    expect(applyPluginConfigPatch(FIELDS, {}, { nope: 1 }).errors.join()).toContain("nope");

    const badType = applyPluginConfigPatch(FIELDS, {}, { epochs: "五十" });
    expect(badType.ok).toBe(false);
    expect(badType.errors.join()).toContain("epochs");

    expect(applyPluginConfigPatch(FIELDS, {}, { epochs: 0 }).ok).toBe(false);
    expect(applyPluginConfigPatch(FIELDS, {}, { epochs: 1001 }).ok).toBe(false);
    expect(applyPluginConfigPatch(FIELDS, {}, { device: "tpu" }).ok).toBe(false);
    expect(applyPluginConfigPatch(FIELDS, {}, { model: 42 }).ok).toBe(false);
  });
});

describe("整值替换与差异", () => {
  it("normalizePluginConfig 用完整值替换，并再次过类型校验", () => {
    expect(normalizePluginConfig(FIELDS, { epochs: 20 }).values).toEqual({ epochs: 20 });
    expect(normalizePluginConfig(FIELDS, { device: "tpu" }).ok).toBe(false);
  });

  it("diffPluginConfig：目标里没有的键要显式 null 删除", () => {
    expect(diffPluginConfig(FIELDS, { epochs: 30, amp: false }, { epochs: 50 })).toEqual({ amp: null, epochs: 50 });
    expect(diffPluginConfig(FIELDS, {}, {})).toEqual({});
  });
});
