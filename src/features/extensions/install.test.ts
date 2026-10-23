/**
 * P174-A6：安装判据的测试。
 *
 * 这一批最贵的错误是"信任账记错了"——它不会报错，只会在某一天让一个**多要了一个写目录**
 * 的插件悄悄跑起来，或者反过来，让用户每改一句描述就被要求重批一次。
 * 两种都只能靠断言发现，不能靠手点。
 */

import { describe, expect, it } from "vitest";
import { validateExtension, type ExtensionManifest } from "./manifest";
import { emptyIndex, emptyTrust, flattenPermissions, type TrustBook } from "./repo";
import {
  applyInstall,
  applyUninstall,
  fingerprintOf,
  needsApproval,
  planInstall,
  trustRecordFor,
} from "./install";
import { trustVerdict } from "./repo";

const APP = "C:/Users/u/AppData/Roaming/uartix";

function manifest(over: Record<string, unknown> = {}): ExtensionManifest {
  const r = validateExtension({
    format: "uartix-plugin",
    schemaVersion: 3,
    id: "demo.tool",
    version: "1.0.0",
    name: "示例工具",
    main: "main.mjs",
    activation: ["onPanel:p1"],
    permissions: { fs: { write: ["$WS/runs"], read: ["$WS"] } },
    contributes: { panels: [] },
    ...over,
  });
  if (!r.ok) throw new Error(`夹具清单不合法：${r.errors.join("；")}`);
  return r.manifest!;
}

function plan(m: ExtensionManifest, trust: TrustBook = emptyTrust(), draftId = "draft-1") {
  return planInstall({ appDir: APP, srcDir: "D:/pkgs/demo", manifest: m, trust, draftId });
}

describe("fingerprintOf（权限指纹）", () => {
  it("改描述/作者/名字不改指纹", () => {
    const a = manifest();
    const b = manifest({ name: "换个名字", description: "换个描述", author: "别人" });
    expect(fingerprintOf(b)).toBe(fingerprintOf(a));
  });

  it("加一个写目录、改版本、改 main 都会改指纹", () => {
    const base = fingerprintOf(manifest());
    expect(fingerprintOf(manifest({ permissions: { fs: { write: ["$WS/runs", "$WS/out"] } } }))).not.toBe(base);
    expect(fingerprintOf(manifest({ version: "1.0.1" }))).not.toBe(base);
    expect(fingerprintOf(manifest({ main: "other.mjs" }))).not.toBe(base);
  });

  it("权限项的书写顺序不影响指纹（同一份权限面不许算出两份）", () => {
    // 用户把清单调个顺序就要求他重批一次，是这个模型最容易被骂的地方。
    // A2 只对 activation 排了序，A6 补上这里——两个方向都钉。
    const a = manifest({ permissions: { fs: { write: ["$WS/a", "$WS/b"], read: ["$WS/y", "$WS/x"] } } });
    const b = manifest({ permissions: { fs: { write: ["$WS/b", "$WS/a"], read: ["$WS/x", "$WS/y"] } } });
    expect(fingerprintOf(b)).toBe(fingerprintOf(a));
    // 但少一个就必须是另一份
    const c = manifest({ permissions: { fs: { write: ["$WS/a"] } } });
    expect(fingerprintOf(c)).not.toBe(fingerprintOf(a));
  });
});

describe("planInstall（三态判定）", () => {
  it("第一次装 ⇒ needs-approval，权限行就是批准卡上要列的那些", () => {
    const m = manifest();
    const p = plan(m);
    expect(p.verdict).toBe("needs-approval");
    expect(needsApproval(p)).toBe(true);
    expect(p.permissions).toEqual(flattenPermissions(m));
    expect(p.permissions.some((s) => s.startsWith("写 "))).toBe(true);
    // 第一次装没有"上次批的"，delta 留空（界面据此换说法，而不是说"新增了全部权限"）
    expect(p.delta).toEqual({ added: [], removed: [] });
    expect(p.previous).toEqual([]);
  });

  it("同一份清单再装一次 ⇒ trusted（不重批）", () => {
    const m = manifest();
    const first = plan(m);
    const { trust } = applyInstall(emptyIndex(), emptyTrust(), first, { approvedAt: 1, source: "local" });
    const second = plan(m, trust);
    expect(second.verdict).toBe("trusted");
    expect(needsApproval(second)).toBe(false);
  });

  it("加了一个写目录 ⇒ changed，并且 delta 里点名了那一行", () => {
    const m = manifest();
    const { trust } = applyInstall(emptyIndex(), emptyTrust(), plan(m), { approvedAt: 1, source: "local" });
    const upgraded = manifest({ version: "1.1.0", permissions: { fs: { write: ["$WS/runs", "$WS/weights"], read: ["$WS"] } } });
    const p = plan(upgraded, trust);
    expect(p.verdict).toBe("changed");
    expect(p.delta.added).toContain("写 $WS/weights");
    expect(p.delta.removed).toEqual([]);
    // 旧的那一份要能摆出来（"你上次批的是这些"）
    expect(p.previous).toEqual(flattenPermissions(m));
  });

  it("只改描述 ⇒ 仍然 trusted（骚扰用户是这个模型最贵的失败方式）", () => {
    const m = manifest();
    const { trust } = applyInstall(emptyIndex(), emptyTrust(), plan(m), { approvedAt: 1, source: "local" });
    const renamed = manifest({ name: "改过的名字", description: "改过的描述" });
    expect(plan(renamed, trust).verdict).toBe("trusted");
  });
});

describe("applyInstall（写两本账）", () => {
  it("批准后索引与信任账都写对", () => {
    const m = manifest();
    const p = plan(m);
    const { index, trust } = applyInstall(emptyIndex(), emptyTrust(), p, { approvedAt: 1234, source: "local" });

    expect(index.items[m.id]).toEqual({
      dir: m.id,
      version: "1.0.0",
      digest: p.fingerprint,
      installedAt: 1234,
      source: "local",
    });
    expect(trust.items[m.id]).toEqual({
      id: m.id,
      version: "1.0.0",
      digest: p.fingerprint,
      grantedAt: 1234,
      // 账上存的就是批准卡上列的那几行，不是重新算一遍
      grantedSummary: p.permissions,
    });
  });

  it("trusted 时不重写信任账（grantedAt 不许被悄悄改成今天）", () => {
    const m = manifest();
    const first = applyInstall(emptyIndex(), emptyTrust(), plan(m), { approvedAt: 100, source: "local" });
    const second = applyInstall(first.index, first.trust, plan(m, first.trust), { approvedAt: 999, source: "local" });
    expect(second.trust).toBe(first.trust); // 引用都没变：连"内容相同但重写"都不该发生
    expect(second.trust.items[m.id].grantedAt).toBe(100);
    // 但索引要更新（重装时间变了，那是事实）
    expect(second.index.items[m.id].installedAt).toBe(999);
  });

  it("不覆盖别家的条目（两本账都是按 id 合并）", () => {
    const a = manifest();
    const b = manifest({ id: "other.pkg", name: "另一个" });
    let idx = emptyIndex();
    let trust = emptyTrust();
    ({ index: idx, trust } = applyInstall(idx, trust, plan(a), { approvedAt: 1, source: "local" }));
    ({ index: idx, trust } = applyInstall(idx, trust, plan(b), { approvedAt: 2, source: "market" }));
    expect(Object.keys(idx.items).sort()).toEqual(["demo.tool", "other.pkg"]);
    expect(trust.items["other.pkg"].grantedAt).toBe(2);
    expect(trust.items["demo.tool"].grantedAt).toBe(1);
  });
});

describe("trustRecordFor（批准磁盘上已有的扩展）", () => {
  it("补出来的记录能让它变成 trusted，且摘要与权限行同源", () => {
    const m = manifest();
    const rec = trustRecordFor(m, 999);
    expect(rec.id).toBe(m.id);
    expect(rec.version).toBe(m.version);
    expect(rec.digest).toBe(fingerprintOf(m));
    // 账上记的就是批准卡上列的那几行（不是另算一遍）
    expect(rec.grantedSummary).toEqual(flattenPermissions(m));
    expect(rec.grantedAt).toBe(999);
    // 关键：补完之后再判就是 trusted，不会"批了还让再批一次"
    expect(trustVerdict(rec, fingerprintOf(m))).toBe("trusted");
  });

  it("清单改了权限 ⇒ 补出来的记录对不上新指纹（必须重新批）", () => {
    const m = manifest();
    const rec = trustRecordFor(m, 1);
    const changed = manifest({ permissions: { fs: { write: ["$WS/other"] } } });
    expect(trustVerdict(rec, fingerprintOf(changed))).toBe("changed");
  });
});

describe("applyUninstall（两本账一起摘）", () => {
  it("索引与信任都不再有它", () => {
    const m = manifest();
    const a = applyInstall(emptyIndex(), emptyTrust(), plan(m), { approvedAt: 1, source: "local" });
    const b = applyUninstall(a.index, a.trust, m.id);
    expect(b.index.items[m.id]).toBeUndefined();
    expect(b.trust.items[m.id]).toBeUndefined();
  });

  it("不碰别人的条目", () => {
    const a = manifest();
    const b = manifest({ id: "other.pkg" });
    let idx = emptyIndex();
    let trust = emptyTrust();
    ({ index: idx, trust } = applyInstall(idx, trust, plan(a), { approvedAt: 1, source: "local" }));
    ({ index: idx, trust } = applyInstall(idx, trust, plan(b), { approvedAt: 2, source: "local" }));
    const out = applyUninstall(idx, trust, a.id);
    expect(Object.keys(out.index.items)).toEqual(["other.pkg"]);
    expect(Object.keys(out.trust.items)).toEqual(["other.pkg"]);
  });

  it("卸载一个没装过的 id 不炸（只会得到原样两本账）", () => {
    const out = applyUninstall(emptyIndex(), emptyTrust(), "nope.nope");
    expect(out.index.items).toEqual({});
    expect(out.trust.items).toEqual({});
  });
});
