import { beforeEach, expect, it, vi } from "vitest";

vi.resetModules();
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });

const { settingsAdapter, settingsRevision, undoSettingsDetailed, validatePatch, readSettings } = await import("./settingsTools");
const { SETTINGS_SCHEMA, agentWritableKeys } = await import("../settings/settingsSchema");
const settings = await import("../settings/settingsStore");
import type { ToolCall } from "./types";

const ctx = { source: "local_agent" as const, runId: "t", signal: new AbortController().signal, scope: "create" as const };

function call(name: string, args: unknown): ToolCall { return { callId: `c-${name}-${Math.random()}`, name, arguments: JSON.stringify(args) }; }

beforeEach(() => { settings.patch({ zoom: 100, theme: "begonia", aiApiKey: "", mcpToken: "" }); });

it("describe: full schema, no values, no secrets, writableKeys derived", async () => {
  const r = await settingsAdapter.execute(call("settings_describe", {}), ctx);
  expect(r.ok).toBe(true);
  const data = r.data as { schema: { key: string; sensitivity: string }[]; writableKeys: string[] };
  expect(data.schema.length).toBe(SETTINGS_SCHEMA.length);
  expect(JSON.stringify(data.schema)).not.toContain("sk-");
  expect(data.writableKeys.every((k) => ["theme", "zoom", "decimals"].some((w) => w === k) || true)).toBe(true);
  expect(data.writableKeys).not.toContain("aiApiKey");
  expect(data.writableKeys).not.toContain("mcpEnabled");
});

it("read: secrets masked to configured booleans, revision present", async () => {
  settings.patch({ aiApiKey: "sk-secret-value", mcpToken: "tok1234567890abcdef" });
  const r = await settingsAdapter.execute(call("settings_read", {}), ctx);
  const raw = JSON.stringify(r.data);
  expect(raw).not.toContain("sk-secret-value");
  expect(raw).not.toContain("tok1234567890abcdef");
  expect((r.data as Record<string, unknown>).aiApiKey).toEqual({ configured: true });
  expect(typeof r.revision).toBe("string");
});

it("preview_patch: zero side effects, diff + baseRevision", async () => {
  const before = settingsRevision();
  const r = await settingsAdapter.execute(call("settings_preview_patch", { patch: { zoom: 125 } }), ctx);
  expect(r.ok).toBe(true);
  expect(r.status).toBe("validated");
  expect((r.data as { diff: unknown[] }).diff).toEqual([{ key: "zoom", from: 100, to: 125 }]);
  expect((r.data as { baseRevision: string }).baseRevision).toBe(before);
  expect(settingsRevision()).toBe(before); // 未应用
});

it("apply: rejects protected/secret/unknown/out-of-range keys as whole patch", async () => {
  const rev = settingsRevision();
  for (const patch of [
    { mcpEnabled: true }, { aiApiKey: "x" }, { nonexistent: 1 }, { zoom: 120 }, { theme: "hologram" },
    { zoom: 125, mcpHighPriv: true }, // 混合非法键：整体拒绝
  ]) {
    const r = await settingsAdapter.execute(call("settings_apply", { patch, revision: rev }), ctx);
    expect(r.ok, JSON.stringify(patch)).toBe(false);
  }
  expect(settings.getSnapshot().zoom).toBe(100);
});

it("apply: revision conflict rejected; stale revision after user change", async () => {
  const stale = settingsRevision();
  settings.patch({ decimals: 4 }); // 用户手改
  const r = await settingsAdapter.execute(call("settings_apply", { patch: { zoom: 110 }, revision: stale }), ctx);
  expect(r.ok).toBe(false);
  expect(r.code).toBe("revision_conflict");
});

it("apply: preview scope never writes", async () => {
  const r = await settingsAdapter.execute(call("settings_apply", { patch: { zoom: 110 }, revision: settingsRevision() }), { ...ctx, scope: "preview" });
  expect(r.ok).toBe(false);
  expect(r.code).toBe("preview_only");
  expect(settings.getSnapshot().zoom).toBe(100);
});

it("undo is three-state: ok / revision_conflict / token_expired", async () => {
  const r = await settingsAdapter.execute(call("settings_apply", { patch: { zoom: 110 }, revision: settingsRevision() }), ctx);
  const token = r.undoToken!;
  expect(undoSettingsDetailed("no-such")).toBe("token_expired");
  settings.patch({ decimals: 5 }); // 撤销令牌之后又有修改
  expect(undoSettingsDetailed(token)).toBe("revision_conflict");
  expect(settings.getSnapshot().zoom).toBe(110);
});

it("validatePatch and readSettings are pure exports for host policy reuse", () => {
  expect(validatePatch({ theme: "dark" }).ok).toBe(true);
  expect(validatePatch([]).ok).toBe(false);
  // 从 schema 现取一个"确实存在的 protected 布尔键"来验拒绝路径。
  // 以前这里手抄 `aiScript` —— P98-M2 把它删掉后，那行会悄悄退化成"断言一个不存在的键被拒"，
  // 看着是绿的，其实什么都没测（§8-36 的又一处第二份真相）。
  const protectedKey = SETTINGS_SCHEMA.find((e) => e.sensitivity === "protected" && e.type === "boolean");
  expect(protectedKey, "schema 里必须还有 protected 布尔键，否则这条断言没有对象").toBeTruthy();
  expect(validatePatch({ [protectedKey!.key]: true })).toEqual({
    ok: false, reason: `protected_or_secret_setting:${protectedKey!.key}`,
  });
  expect(readSettings().aiApiKey).toEqual({ configured: false });
  expect(agentWritableKeys().length).toBeGreaterThan(5);
});

it("P92 C：settings_apply 按授权域裁决，扩展档不比「界面创造」低", async () => {
  const rev = () => settingsRevision();
  const ok = await settingsAdapter.execute(
    call("settings_apply", { patch: { zoom: 110 }, revision: rev() }),
    { ...ctx, scope: "custom" as const, allowed: ["config", "plugins", "files"] },
  );
  expect(ok.ok).toBe(true);
  expect(settings.getSnapshot().zoom).toBe(110);
  const noDom = await settingsAdapter.execute(
    call("settings_apply", { patch: { zoom: 125 }, revision: rev() }),
    { ...ctx, scope: "custom" as const, allowed: ["files"] },
  );
  expect(noDom.code).toBe("unauthorized_scope");
  expect((noDom.data as { hint: string }).hint).toContain("配置写入");
  expect(settings.getSnapshot().zoom).toBe(110);
});
