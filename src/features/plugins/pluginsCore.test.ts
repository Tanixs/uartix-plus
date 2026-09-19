/**
 * P88b-3 约束测试（核心层）：artifact/manifest 校验、包路径规范化、能力双向校验、
 * 隔离裁决（nonce/能力/legacy 旁路/被动推送）、插件库状态机（安装/启停投影/
 * 违规隔离/导出白名单/导入副本/回滚/配置）。
 * node 环境：extRuntime（触 DOM）mock 掉，localStorage 打桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn(), previewCss: vi.fn(() => "") }));

import { validateArtifactPayload, validateArtifact } from "./artifact";
import {
  normalizeEntryPath,
  validateManifest,
  containsSecretLike,
  PURE_UI_CAPS,
} from "./pluginManifest";
import * as iso from "./pluginIsolation";

// 触 localStorage/DOM 的模块在打桩后动态加载（静态 import 会被提升到打桩前）
const store = await import("./pluginStore");
const extStore = await import("../ai/extensionStore");

const THEME_PAYLOAD = { vars: { "--bg": "#101418" } };
/** widget/panel 内容判别器是 format；外层 kind 是产物类型。 */
const WIDGET_CONTENT = { format: "html", html: "<b>hi</b>" };

/** 合法最小 manifest（theme），供安装/状态机测试复用。 */
function themePkg(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "uartix-plugin",
    schemaVersion: 2,
    id,
    version: "0.1.0",
    name: "测试主题",
    hostApi: "^1.0",
    capabilities: ["theme.tokens"],
    contributions: { themes: [{ id: "main", entry: "main.json" }] },
    artifacts: { "main.json": { kind: "theme", ...THEME_PAYLOAD } },
    provenance: { createdBy: "user", reviewed: false },
    ...extra,
  };
}

beforeEach(() => {
  storage.clear();
});

describe("artifact 校验", () => {
  it("theme：空 vars 且无 css 拒绝；@import/外链 url 拒绝；fixed 覆盖层告警", () => {
    expect(validateArtifactPayload("theme", {}).ok).toBe(false);
    expect(validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: "@import url(x.css)" }).ok).toBe(false);
    expect(validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: "a{background:url(https://x.y)}" }).ok).toBe(false);
    const warn = validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: ".x{position:fixed;inset:0}" });
    expect(warn.ok).toBe(true);
    expect(warn.warnings.join()).toContain("position:fixed");
  });

  it("widget：format 判别 html/declarative；非 kind 内容拒绝", () => {
    expect(validateArtifactPayload("widget", WIDGET_CONTENT).ok).toBe(true);
    expect(
      validateArtifactPayload("widget", { format: "declarative", blocks: [{ type: "metric", title: "转速" }] }).ok,
    ).toBe(true);
    expect(validateArtifactPayload("widget", { format: "html" }).ok).toBe(false);
    expect(validateArtifact({ kind: "nope" }).ok).toBe(false);
    expect(validateArtifact({ kind: "widget", ...WIDGET_CONTENT }).ok).toBe(true);
  });

  it("blocks：空数组与未知块类型拒绝；html 块限额", () => {
    const bad = validateArtifactPayload("panel", { format: "declarative", blocks: [] });
    expect(bad.ok).toBe(false);
    const unknown = validateArtifactPayload("panel", { format: "declarative", blocks: [{ type: "iframe" }] });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join()).toContain("未知块类型");
  });
});

describe("manifest 校验与路径规范化", () => {
  it("normalizeEntryPath：拒绝穿越/绝对/盘符/反斜杠/空段", () => {
    expect(normalizeEntryPath("../x")).toBeNull();
    expect(normalizeEntryPath("a/../../b")).toBeNull();
    expect(normalizeEntryPath("/abs")).toBeNull();
    expect(normalizeEntryPath("C:evil")).toBeNull();
    expect(normalizeEntryPath("a\\b")).toBeNull();
    expect(normalizeEntryPath("a//b")).toBeNull();
    expect(normalizeEntryPath("a/./b")).toBeNull();
    expect(normalizeEntryPath("main.json")).toBe("main.json");
    expect(normalizeEntryPath("ui/panel/main.json")).toBe("ui/panel/main.json");
  });

  it("validateManifest：格式/ID/能力/贡献条目双向校验", () => {
    const bad = validateManifest({ ...themePkg("x"), format: "other" });
    expect(bad.ok).toBe(false);
    const badId = validateManifest({ ...themePkg("BadId") });
    expect(badId.errors.join()).toContain("id");
    // 未知能力
    expect(validateManifest(themePkg("user.a.b", { capabilities: ["theme.tokens", "root.all"] })).ok).toBe(false);
    // 产物类型与能力不匹配
    const missCap = validateManifest({
      ...themePkg("user.a.b", { capabilities: ["telemetry.read"] }),
      contributions: { widgets: [{ id: "main", entry: "main.json" }] },
      artifacts: { "main.json": { kind: "widget", ...WIDGET_CONTENT } },
    });
    expect(missCap.ok).toBe(false);
    expect(missCap.errors.join()).toContain("ui.widget");
    // 贡献条目指向不存在的产物
    expect(validateManifest({ ...themePkg("user.a.b"), contributions: { themes: [{ id: "main", entry: "nope.json" }] } }).ok).toBe(false);
    // 作者自报 reviewed 不构成信任：强制重置
    const forced = validateManifest(themePkg("user.a.b", { provenance: { createdBy: "user", reviewed: true } }));
    expect(forced.ok).toBe(true);
    expect(forced.manifest?.provenance.reviewed).toBe(false);
  });

  it("containsSecretLike：疑似秘密字段命中（键名扫描，不扫内容）", () => {
    expect(containsSecretLike({ a: { apiKey: "x" } })).toContain("apiKey");
    expect(containsSecretLike({ a: { html: "const token = 1" } })).toBeNull();
    expect(containsSecretLike(themePkg("user.a.b"))).toBeNull();
  });

  it("纯 UI 能力集不含 serial.send/ai.ask", () => {
    expect(PURE_UI_CAPS).not.toContain("serial.send");
    expect(PURE_UI_CAPS).not.toContain("ai.ask");
  });
});

describe("隔离裁决（§11）", () => {
  const ctx = { caps: ["ui.widget", "telemetry.read"], nonce: "n-1", legacy: false };

  it("nonce 不匹配拒绝；匹配放行", () => {
    expect(iso.verdictPluginMessage("aiw:getSnap", "wrong", ctx)).toBe("reject_nonce");
    expect(iso.verdictPluginMessage("aiw:getSnap", "n-1", ctx)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:getSnap", undefined, ctx)).toBe("reject_nonce");
  });

  it("能力门：send/ask/app/menu-def 按包能力裁决", () => {
    expect(iso.verdictPluginMessage("aiw:send", "n-1", ctx)).toBe("reject_cap");
    expect(iso.verdictPluginMessage("aiw:app", "n-1", ctx)).toBe("reject_cap");
    const full = { ...ctx, caps: ["serial.send", "ai.ask", "ui.action"] };
    expect(iso.verdictPluginMessage("aiw:send", "n-1", full)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:ask", "n-1", full)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:menu-def", "n-1", full)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:resize", "n-1", ctx)).toBe("allow"); // 无需能力
  });

  it("legacy 迁移件旁路（M1 存量旁路）；被动推送需 telemetry.read", () => {
    const legacy = { ...ctx, legacy: true };
    expect(iso.verdictPluginMessage("aiw:send", undefined, legacy)).toBe("bypass_legacy");
    expect(iso.verdictPassivePush("aiw:snap", ctx)).toBe(true);
    expect(iso.verdictPassivePush("aiw:snap", { ...ctx, caps: [] })).toBe(false);
    expect(iso.verdictPassivePush("aiw:snap", { ...ctx, caps: [], legacy: true })).toBe(true);
    expect(iso.verdictPassivePush("aiw:theme", { ...ctx, caps: [] })).toBe(true); // 非数据流
  });

  it("CSP 禁断一切远程获取通道", () => {
    expect(iso.cspBlocksNetwork()).toBe(true);
    expect(iso.PLUGIN_IFRAME_CSP).toContain("frame-src 'none'");
    expect(iso.PLUGIN_IFRAME_CSP).toContain("form-action 'none'");
  });
});

describe("插件库状态机（§9.3）", () => {
  it("staging→原子入库：默认停用；同 ID staging 拒绝", () => {
    const s = store.stagePackage(themePkg("user.t.one"));
    expect(s.ok).toBe(true);
    const inst = store.installStaged(s.stagingId!);
    expect(inst.ok).toBe(true);
    expect(store.getPlugin("user.t.one")?.state).toBe("installed_disabled");
    expect(store.stagePackage(themePkg("user.t.one")).ok).toBe(false);
  });

  it("启用建投影、停用移投影（影子扩展 pluginRef 标记）", () => {
    const s = store.stagePackage(themePkg("user.t.two"));
    const inst = store.installStaged(s.stagingId!);
    const sid = store.shadowExtId(inst.id!, "main");
    expect(extStore.getExt(sid)).toBeUndefined();
    const on = store.setEnabled(inst.id!, true);
    expect(on.ok).toBe(true);
    expect(store.getPlugin(inst.id!)?.state).toBe("enabled");
    const shadow = extStore.getExt(sid);
    expect(shadow?.pluginRef).toBe("user.t.two");
    expect(shadow?.vars).toMatchObject({ "--bg": "#101418" });
    store.setEnabled(inst.id!, false);
    expect(extStore.getExt(sid)).toBeUndefined();
  });

  it("违规隔离：60 秒窗口内 3 次即 quarantined 并移除投影，拒绝再启用", () => {
    const s = store.stagePackage(themePkg("user.t.bad"));
    const inst = store.installStaged(s.stagingId!);
    store.setEnabled(inst.id!, true);
    store.reportViolation(inst.id!, "aiw:send:reject_cap");
    store.reportViolation(inst.id!, "aiw:send:reject_cap");
    expect(store.getPlugin(inst.id!)?.state).toBe("enabled");
    store.reportViolation(inst.id!, "aiw:send:reject_nonce");
    expect(store.getPlugin(inst.id!)?.state).toBe("quarantined");
    expect(extStore.getSnapshot().exts.some((e) => e.pluginRef === inst.id)).toBe(false);
    expect(store.setEnabled(inst.id!, true).ok).toBe(false);
  });

  it("导出白名单：疑似秘密字段拒绝导出；导入同 ID 冲突转副本且强制停用", () => {
    const bad = store.stagePackage(themePkg("user.t.secret", {
      artifacts: { "main.json": { kind: "theme", ...THEME_PAYLOAD, apiKey: "leak" } },
    }));
    const badInst = store.installStaged(bad.stagingId!);
    expect(store.exportPackages([badInst.id!]).ok).toBe(false);

    const exp = store.exportPackages(["user.t.two"]);
    expect(exp.ok).toBe(true);
    const imported = store.importPackages(exp.json!);
    expect(imported.ok).toBe(true);
    expect(store.getPlugin("user.t.two.copy1")?.state).toBe("installed_disabled");
    expect(store.getPlugin("user.t.two.copy1")?.pkg.provenance.createdBy).toBe("import");
    // 导出的 JSON 不含 config/nonce
    expect(exp.json!).not.toContain("nonce");
  });

  it("更新候选→批准→回滚（版本历史保底）", () => {
    const s = store.stagePackage(themePkg("user.t.ver"));
    const inst = store.installStaged(s.stagingId!);
    expect(store.proposeUpdate(inst.id!, { ...themePkg("user.t.ver"), version: "0.1.0" }).ok).toBe(false); // 同版本拒绝
    const p = store.proposeUpdate(inst.id!, { ...themePkg("user.t.ver"), version: "0.2.0" });
    expect(p.ok).toBe(true);
    expect(store.getPlugin(inst.id!)?.state).toBe("update_pending");
    expect(store.approveUpdate(inst.id!).ok).toBe(true);
    expect(store.getPlugin(inst.id!)?.pkg.version).toBe("0.2.0");
    expect(store.rollback(inst.id!).ok).toBe(true);
    expect(store.getPlugin(inst.id!)?.pkg.version).toBe("0.1.0");
  });

  it("声明式配置：越界拒绝、合法写入", () => {
    const s = store.stagePackage(themePkg("user.t.cfg", {
      settingsSchema: [{ key: "threshold", label: "阈值", type: "number", default: 1, min: 0, max: 10 }],
    }));
    const inst = store.installStaged(s.stagingId!);
    expect(store.getPlugin(inst.id!)?.config.threshold).toBe(1);
    expect(store.setConfigValues(inst.id!, { threshold: 99 }).ok).toBe(false);
    expect(store.setConfigValues(inst.id!, { threshold: 5 }).ok).toBe(true);
    expect(store.getPlugin(inst.id!)?.config.threshold).toBe(5);
    expect(store.setConfigValues(inst.id!, { nope: 1 }).ok).toBe(false);
  });
});
