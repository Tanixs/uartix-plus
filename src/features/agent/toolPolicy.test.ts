import { expect, it, vi } from "vitest";
import type { PolicyContext, ToolPolicyMeta } from "./toolPolicy";
import { ACTION_POLICY_META, toolDefinitions, untaggedActions } from "./toolCatalog";
import { APP_ACTION_KINDS } from "../ai/appActionKinds";

// toolPolicy → settingsSchema → settingsStore 在模块加载时读 localStorage，先 stub 再动态导入
const storage = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) });
const { decide, settingsEffect } = await import("./toolPolicy");

const base: PolicyContext = { scope: "create", authorized: () => true, operatorLocked: false, deviceContext: "sim" };
const meta = (effect: ToolPolicyMeta["effect"], over: Partial<ToolPolicyMeta> = {}): ToolPolicyMeta => ({ effect, idempotent: false, reversible: true, mayTouchDevice: false, ...over });

it("four manual-confirmation categories always require local approval", () => {
  expect(decide(meta("destructive_write"), base)).toBe("require_local_approval");
  expect(decide(meta("irreversible"), base)).toBe("require_local_approval");
  expect(decide(meta("safety_boundary"), base)).toBe("require_local_approval");
  // 实车下发：real 与 unknown 都必须人工确认，不得猜成仿真
  expect(decide(meta("device_send", { mayTouchDevice: true }), { ...base, deviceContext: "real" })).toBe("require_local_approval");
  expect(decide(meta("device_send", { mayTouchDevice: true }), { ...base, deviceContext: "unknown" })).toBe("require_local_approval");
});

it("secrets are denied regardless of scope; protected config needs approval", () => {
  expect(decide(meta("secret"), { ...base, scope: "create" })).toBe("deny");
  expect(decide(meta("protected_config"), base)).toBe("require_local_approval");
  expect(settingsEffect("secret", true)).toBe("secret");
  expect(settingsEffect("protected", true)).toBe("protected_config");
  expect(settingsEffect("safe", false)).toBe("protected_config");
});

it("preview scope: writes downgraded, reads allowed", () => {
  const p = { ...base, scope: "preview" as const };
  expect(decide(meta("read"), p)).toBe("allow");
  expect(decide(meta("analysis"), p)).toBe("allow");
  expect(decide(meta("config_write"), p)).toBe("preview_only");
  expect(decide(meta("draft_write"), p)).toBe("preview_only");
});

it("operator lock blocks all writes but not reads", () => {
  const locked = { ...base, operatorLocked: true };
  expect(decide(meta("read"), locked)).toBe("allow");
  expect(decide(meta("config_write"), locked)).toBe("deny");
  expect(decide(meta("draft_write"), locked)).toBe("deny");
});

it("config_write outside task authorization falls back to approval", () => {
  expect(decide(meta("config_write"), { ...base, authorized: () => false })).toBe("require_local_approval");
  expect(decide(meta("config_write"), base)).toBe("allow");
});

it("custom scope: config/draft 按勾选域，device 仅授权时放行（P88b-3 档位三）", () => {
  const custom = (allowed: string[]): PolicyContext => ({ ...base, scope: "custom", authorized: (k) => allowed.includes(k) });
  expect(decide(meta("config_write"), custom(["config"]))).toBe("allow");
  expect(decide(meta("draft_write"), custom([]))).toBe("require_local_approval");
  expect(decide(meta("device_send", { mayTouchDevice: true }), custom(["device"]))).toBe("allow");
  expect(decide(meta("device_send", { mayTouchDevice: true }), custom(["config"]))).toBe("require_local_approval");
});

it("catalog covers every app action exactly once and exports definitions", () => {
  expect(untaggedActions()).toEqual([]);
  expect(Object.keys(ACTION_POLICY_META).sort()).toEqual([...APP_ACTION_KINDS].sort());
  const defs = toolDefinitions();
  expect(defs.length).toBe(APP_ACTION_KINDS.length);
  expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
});

it("destructive and device actions are marked non-auto in create scope", () => {
  for (const kind of ["removeProtocol", "clearPage", "removeWidget"] as const) {
    expect(decide(ACTION_POLICY_META[kind], base)).toBe("require_local_approval");
  }
  for (const kind of ["openPort", "modbus", "orchestrator"] as const) {
    expect(ACTION_POLICY_META[kind].mayTouchDevice).toBe(true);
    expect(decide(ACTION_POLICY_META[kind], { ...base, deviceContext: "unknown" })).toBe("require_local_approval");
  }
});
