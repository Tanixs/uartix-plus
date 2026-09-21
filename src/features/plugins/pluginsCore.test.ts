/**
 * P88b-3 约束测试（核心层）：artifact/manifest 校验、包路径规范化、能力双向校验、
 * 隔离裁决（nonce/能力/未知类型 fail-closed/被动推送/win 动作级）、插件库状态机
 * （安装/启停投影/违规隔离/导出白名单/导入副本/回滚/配置）。
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
vi.mock("../ai/extRuntime", () => ({ applyStyleExts: vi.fn() }));

import { validateArtifactPayload, validateArtifact } from "./artifact";
import {
  normalizeEntryPath,
  validateManifest,
  containsSecretLike,
  PLUGIN_CAPS,
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
  it("theme：空 vars 且无 css 拒绝；@import/外链 url 拒绝；P99a-A6 起 fixed 覆盖层从告警升为拒绝", () => {
    expect(validateArtifactPayload("theme", {}).ok).toBe(false);
    expect(validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: "@import url(x.css)" }).ok).toBe(false);
    expect(validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: "a{background:url(https://x.y)}" }).ok).toBe(false);
    const fixed = validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: ".x{position:fixed;inset:0}" });
    expect(fixed.ok, "一层 fixed 就能盖住批准弹层与停止入口，不能只给警告").toBe(false);
    expect(fixed.errors.join()).toContain("banned_position_fixed");
    /**
     * 证伪用：这条正是旧实现的漏洞——`body{display:none}` 以前只被"工具描述里的话术"拦，
     * 校验层放行，装上一个这样的主题＝整个界面关掉。现在与 style_patch 同一条净化器。
     */
    const kill = validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: "body{display:none}" });
    expect(kill.ok).toBe(false);
    expect(kill.errors.join()).toContain("global_selector");
    // 正常主题照旧放行（收紧不能把合法路径一起堵死）
    expect(validateArtifactPayload("theme", { vars: { "--bg": "#000" }, css: ".p3d-host{border-radius:8px}" }).ok).toBe(true);
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
});

describe("隔离裁决（§11）", () => {
  const ctx = { caps: ["ui.widget", "telemetry.read"], nonce: "n-1" };

  it("nonce 不匹配拒绝；匹配放行", () => {
    // 用真实存在的入站类型（旧用例写的 "aiw:getSnap" 当年代码里根本没有，正好落在旧表的
    // "未列出即免检"缝上——那条缝 P99a-A4 已反成 fail-closed；而 getSnap 确实是 WidgetFrame
    // 在处理的分支，B1a 起它登记为需要 telemetry.read）
    expect(iso.verdictPluginMessage("aiw:cursor", "wrong", ctx)).toBe("reject_nonce");
    expect(iso.verdictPluginMessage("aiw:cursor", "n-1", ctx)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:cursor", undefined, ctx)).toBe("reject_nonce");
  });

  it("P99a-A4：未登记入站类型 fail-closed（旧表查不到就 allow，等于新增特权消息免检）", () => {
    expect(iso.verdictPluginMessage("aiw:whatever", "n-1", ctx)).toBe("reject_unknown");
    expect(iso.verdictPluginMessage("aiw:mod-teleport", "n-1", ctx)).toBe("reject_unknown");
    // 裁决顺序也要成立：nonce 对了也照样拒（未知类型排在验签之前，不给试探留缝）
    expect(iso.verdictPluginMessage("aiw:whatever", "n-1", { ...ctx, caps: [] })).toBe("reject_unknown");
  });

  /** B2：worker 通道与 iframe 共用同一张裁决表（多一个宿主不多一份门禁）。 */
  it("P99a-B2：worker 通道的 tool-def 需要 agent.tool；两张表键集合不相交", () => {
    const noTool = { caps: ["logic.run"], nonce: "n-1" };
    expect(iso.verdictPluginMessage("aiw:tool-def", "n-1", noTool)).toBe("reject_cap");
    expect(iso.verdictPluginMessage("aiw:tool-undef", "n-1", noTool)).toBe("reject_cap");
    expect(iso.verdictPluginMessage("aiw:tool-def", "n-1", { caps: ["agent.tool"], nonce: "n-1" })).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:tool-ack", "n-1", noTool)).toBe("allow"); // 回执只看 nonce + callId
    expect(iso.verdictPluginMessage("aiw:mod-probe", "n-1", noTool)).toBe("allow");
    const iframe = Object.keys(iso.MSG_CAP_REQUIREMENT);
    const worker = Object.keys(iso.WORKER_MSG_CAP);
    expect(iframe.filter((k) => worker.includes(k))).toEqual([]);
  });

  it("P99a-B1a 零兼容：自称 legacy 不再买到任何免检（旁路还在时这三条全红）", () => {
    const forged = { ...ctx, legacy: true } as unknown as typeof ctx;
    expect(iso.verdictPluginMessage("aiw:whatever", "n-1", forged)).toBe("reject_unknown");
    expect(iso.verdictPluginMessage("aiw:send", undefined, forged)).toBe("reject_nonce");
    expect(iso.verdictPluginMessage("aiw:send", "n-1", forged)).toBe("reject_cap");
    expect(iso.verdictPassivePush("aiw:snap", forged)).toBe(true); // 这条只看 caps
    expect(iso.verdictPassivePush("aiw:snap", { ...ctx, caps: [] })).toBe(false);
    // 编译期钉：bypass_legacy 必须已从 MsgVerdict 消失（还在 ⇒ 这行类型不匹配，tsc 直接红）
    const noBypass: "bypass_legacy" extends iso.MsgVerdict ? "仍在" : "已删" = "已删";
    expect(noBypass).toBe("已删");
  });

  it("入站类型清单与 WidgetFrame 实际处理的分支一一对应（漏登记即红）", async () => {
    // node 内置模块要绕 vite：与 helpCoverage.test 同一手法
    const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };
    const { fileURLToPath } = (await import("node:" + "url")) as { fileURLToPath: (u: URL | string) => string };
    const src = readFileSync(fileURLToPath(new URL("../ai/WidgetFrame.tsx", import.meta.url)), "utf8");
    const handled = [...src.matchAll(/case "(aiw:[A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
    expect(handled.length).toBeGreaterThan(0);
    /**
     * 守卫自己的正则也是探针。上一版这里是 `aiw:[a-z-]+`：不匹配数字（`aiw:x2w`）、
     * 不匹配驼峰（`aiw:getSnap`），于是这两支"WidgetFrame 在处理、裁决表里却没有"的消息
     * 让守卫一路绿着过关——插件库里的挂件只要用广播/取快照就是 reject_unknown + 计违规，
     * 三次即被隔离。这两条断言就是防那只瞎探针自己再退化。
     */
    expect(handled).toEqual(expect.arrayContaining(["aiw:x2w", "aiw:getSnap"]));
    for (const t of handled) {
      expect(iso.MSG_CAP_REQUIREMENT, `WidgetFrame 处理了 ${t} 但裁决表没登记`).toHaveProperty(t);
    }
    expect(Object.keys(iso.MSG_CAP_REQUIREMENT).sort()).toEqual([...new Set(handled)].sort());
  });

  it("能力门：send/ask/app/menu-def/getSnap 按包能力裁决", () => {
    expect(iso.verdictPluginMessage("aiw:send", "n-1", ctx)).toBe("reject_cap");
    expect(iso.verdictPluginMessage("aiw:app", "n-1", ctx)).toBe("reject_cap");
    // 索取一次快照＝数据流出，不给它走 telemetry.read 之外的后门
    expect(iso.verdictPluginMessage("aiw:getSnap", "n-1", { ...ctx, caps: ["ui.widget"] })).toBe("reject_cap");
    expect(iso.verdictPluginMessage("aiw:getSnap", "n-1", ctx)).toBe("allow");
    // 挂件间广播只中继发送方自己的数据，显式免检
    expect(iso.verdictPluginMessage("aiw:x2w", "n-1", { ...ctx, caps: [] })).toBe("allow");
    const full = { ...ctx, caps: ["serial.send", "ai.ask", "ui.action"] };
    expect(iso.verdictPluginMessage("aiw:send", "n-1", full)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:ask", "n-1", full)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:menu-def", "n-1", full)).toBe("allow");
    expect(iso.verdictPluginMessage("aiw:resize", "n-1", ctx)).toBe("allow"); // 无需能力
  });

  it("被动推送需 telemetry.read；非数据流类型不受门", () => {
    expect(iso.verdictPassivePush("aiw:snap", ctx)).toBe(true);
    expect(iso.verdictPassivePush("aiw:chat", ctx)).toBe(true);
    expect(iso.verdictPassivePush("aiw:snap", { ...ctx, caps: [] })).toBe(false);
    expect(iso.verdictPassivePush("aiw:theme", { ...ctx, caps: [] })).toBe(true);
  });

  it("CSP 禁断一切远程获取通道", () => {
    expect(iso.cspBlocksNetwork()).toBe(true);
    expect(iso.PLUGIN_IFRAME_CSP).toContain("frame-src 'none'");
    expect(iso.PLUGIN_IFRAME_CSP).toContain("form-action 'none'");
  });
});

/** P99a-B0（详设 §13.2）：一条 `aiw:win` 里 11 个动作的风险差得很远，按动作裁决。 */
describe("aiw:win 动作级裁决", () => {
  const plain = ["ui.widget"];
  const withWin = ["ui.widget", "win.control"];

  it("展示子集免检（挪动/缩放/关自己都算，close 是破坏不是特权）", () => {
    for (const a of ["move", "moveBy", "dragDelta", "dragEnd", "size", "get", "menu", "close"]) {
      expect(iso.verdictWinAction(a, plain), a).toBe("allow");
    }
  });

  it("危险子集需 win.control：置顶 + 点击穿透合起来就是点击劫持；popOut 是形态升级", () => {
    for (const a of ["alwaysOnTop", "ignoreCursorEvents", "popOut"]) {
      expect(iso.verdictWinAction(a, plain), a).toBe("reject_cap");
      expect(iso.verdictWinAction(a, withWin), a).toBe("allow");
    }
  });

  it("未知动作默认关：新增 action 忘记进表 ≠ 免检", () => {
    expect(iso.verdictWinAction("minimize", withWin)).toBe("reject_unknown");
    expect(iso.verdictWinAction("", withWin)).toBe("reject_unknown");
  });

  it("win.control 在册但**不在**自动放行集（否则 Agent 能自我启用置顶穿透挂件）", () => {
    expect(PLUGIN_CAPS).toContain("win.control");
    expect(PURE_UI_CAPS).not.toContain("win.control");
    expect(PURE_UI_CAPS).not.toContain("serial.send");
    expect(PURE_UI_CAPS).not.toContain("ai.ask");
  });

  it("桥侧真会发的 action 全部在册（漏登记即红）", async () => {
    const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };
    const { fileURLToPath } = (await import("node:" + "url")) as { fileURLToPath: (u: URL | string) => string };
    const src = readFileSync(fileURLToPath(new URL("../ai/widgetBridge.ts", import.meta.url)), "utf8");
    const sent = [...new Set([...src.matchAll(/action:\s*"([A-Za-z]+)"/g)].map((m) => m[1]))];
    expect(sent.length).toBeGreaterThan(0);
    for (const a of sent) {
      expect(iso.WIN_ACTION_CAP, `桥会发 action=${a}，但裁决表没登记`).toHaveProperty(a);
    }
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

/**
 * P92-F（dev 整窗白屏实录）：pluginStore 曾在模块顶层 `restoreProjections()` 里直接调
 * extRuntime 的 applyStyleExts，而 extRuntime 经 chatStore→agentRun→agentAdapter 又拉进
 * pluginStore ⇒ 求值期成环 ⇒ `ReferenceError: Cannot access 'appliedVars' before
 * initialization` ⇒ React 从未挂载（tsc/vitest/build 当时全绿，只有 dev 的 ESM 顺序会炸）。
 */
describe("P92-F 样式层接线", () => {
  it("pluginStore 不得再静态依赖 extRuntime（这条边就是白屏的环）", async () => {
    // 计算式说明符：本 tsconfig 不含 @types/node，直接 import "node:fs" 会 TS2307
    const spec = "node:fs";
    const { readFileSync } = (await import(spec)) as {
      readFileSync: (p: string, enc: string) => string;
    };
    const src = readFileSync(new URL("./pluginStore.ts", import.meta.url).pathname.slice(1), "utf8");
    // 只看代码：本文件顶部的教训注释里**引用**了那行 import，不能算命中
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+["']\.\.\/ai\/extRuntime["']/);
    expect(code).not.toMatch(/\bapplyStyleExts\s*\(/);
  });

  it("启动路径：模块求值期的投影变更记脏，注册 applier 时立刻补跑一次", async () => {
    // 先真实装好一个「已启用」的主题并落进 localStorage 桩
    const s = store.stagePackage(themePkg("user.t.boot"));
    const inst = store.installStaged(s.stagingId!);
    expect(store.setEnabled(inst.id!, true).ok).toBe(true);
    // 重开模块 ⇒ restoreProjections() 在 import 期重放投影（此时无人注册）
    vi.resetModules();
    const fresh = await import("./pluginStore");
    const applied = vi.fn();
    fresh.setStyleApplier(applied);
    expect(applied).toHaveBeenCalledTimes(1);
    // 脏已清：再注册不会重复补跑
    const again = vi.fn();
    fresh.setStyleApplier(again);
    expect(again).not.toHaveBeenCalled();
  });

  it("注册之后的投影变更同步应用（启用/停用各一次）", () => {
    const applier = vi.fn();
    store.setStyleApplier(applier);
    const s = store.stagePackage(themePkg("user.t.styles"));
    const inst = store.installStaged(s.stagingId!);
    const before = applier.mock.calls.length;
    expect(store.setEnabled(inst.id!, true).ok).toBe(true);
    expect(applier.mock.calls.length).toBeGreaterThan(before);
    const mid = applier.mock.calls.length;
    expect(store.setEnabled(inst.id!, false).ok).toBe(true);
    expect(applier.mock.calls.length).toBeGreaterThan(mid);
  });
});

/** 详设 §5.5：`module` 第一次让插件能带逻辑，这张边界卡钉死它不产出旧 script 通道。 */
describe("P99a-B1：module 产物的投影边界", () => {
  function modulePkg(id: string): Record<string, unknown> {
    return {
      format: "uartix-plugin",
      schemaVersion: 2,
      id,
      version: "0.1.0",
      name: "逻辑包",
      hostApi: "^1.0",
      capabilities: ["logic.run"],
      contributions: { modules: [{ id: "m1", entry: "m1.json" }] },
      artifacts: { "m1.json": { kind: "module", format: "js", code: "var ok = 1;" } },
    };
  }

  it("安装＋强行启用：零影子扩展（module 不投影，更不会悄悄产出一条能跑 JS 的扩展）", () => {
    const s = store.stagePackage(modulePkg("user.t.mod"));
    expect(s.ok).toBe(true);
    const inst = store.installStaged(s.stagingId!);
    expect(inst.ok).toBe(true);
    // setEnabled 是同步的，封网探针在调用方（插件库开关 / enable_plugin）——这里直接经 store
    // 强行启用，钉的是"就算启用了，也不会产出一条可执行扩展"。
    expect(store.setEnabled(inst.id!, true).ok).toBe(true);
    expect(extStore.getSnapshot().exts.filter((e) => e.pluginRef === inst.id)).toHaveLength(0);
  });

  it("armModulePackage：没有模块＝直接通过；有模块而环境无 Worker＝失败并保持停用", async () => {
    const t = store.installStaged(store.stagePackage(themePkg("user.t.nomod")).stagingId!);
    expect(await store.armModulePackage(t.id!)).toMatchObject({ ok: true, modules: 0 });
    const m = store.installStaged(store.stagePackage(modulePkg("user.t.mod2")).stagingId!);
    const r = await store.armModulePackage(m.id!);
    expect(r.ok).toBe(false);
    expect(r.modules).toBe(1);
    expect(r.msg).toContain("no-worker");
    expect(store.getPlugin(m.id!)?.state).not.toBe("enabled");
  });
});

/**
 * 证伪用的"接线卡"：`verdictWinAction` / `probePackageModules` 都是纯函数，单测能证明它们
 * 判得对，却证明不了**有人调它们**。`bypass_legacy` 活到今天靠的正是这一类缺口
 * （表写对了、调用点漏了也没人红）。node 环境没有 RTL，所以这里用源码断言钉调用点。
 */
describe("P99a-B0/B1 闸的接线（不只裁决对，还要真的在门后）", () => {
  const read = async (rel: string): Promise<string> => {
    const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };
    const { fileURLToPath } = (await import("node:" + "url")) as { fileURLToPath: (u: URL | string) => string };
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  };

  it("WidgetFrame 的 aiw:win 分支必须过 verdictWinAction，并按裁决计违规", async () => {
    const src = await read("../ai/WidgetFrame.tsx");
    const from = src.indexOf('case "aiw:win"');
    const to = src.indexOf('case "aiw:x2w"');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = src.slice(from, to);
    expect(body).toContain("verdictWinAction(");
    expect(body).toContain("reportViolation(");
    expect(body).toContain('!== "allow"');
  });

  it("插件库启用带模块的包之前必须等封网自证；探针没过就走不到 setEnabled(true)", async () => {
    const src = await read("./PluginLibraryDialog.tsx");
    expect(src).toContain("moduleArtifactsOf(");
    expect(src).toContain("armModulePackage(");
    // 只看臂起之后的那段：先判 !probe.ok 才允许启用（无模块的短路分支不在这一段里）
    const after = src.slice(src.indexOf("armModulePackage("));
    expect(after.indexOf("if (!probe.ok)")).toBeGreaterThan(-1);
    expect(after.indexOf("if (!probe.ok)")).toBeLessThan(after.indexOf("setEnabled(r.pkg.id, true)"));
  });
});
