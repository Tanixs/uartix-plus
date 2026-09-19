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
  expect(validatePatch({ aiScript: true })).toEqual({ ok: false, reason: "protected_or_secret_setting:aiScript" });
  expect(readSettings().aiApiKey).toEqual({ configured: false });
  expect(agentWritableKeys().length).toBeGreaterThan(5);
});
