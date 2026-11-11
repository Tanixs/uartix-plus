import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SliderCard } from "./controlsStore";

beforeEach(() => {
  vi.resetModules();
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedCommand(patch: Record<string, unknown> = {}) {
  const cmd = await import("./commandStore");
  cmd.addGroup("G");
  const groupId = cmd.getSnapshot().groups[0].id;
  const id = cmd.addCommand(groupId);
  cmd.patchCommand(id, {
    name: "点火",
    template: "GO!",
    sendMode: "ascii",
    ...patch,
  } as never);
  return { cmd, id };
}

function card(over: Partial<SliderCard> = {}): SliderCard {
  return {
    id: "c1",
    type: "slider",
    name: "滑条",
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    template: "OLD",
    sendMode: "hex",
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 0,
    sendTrigger: "continuous",
    minIntervalMs: 40,
    useScript: false,
    script: "",
    paramId: "p1",
    ...over,
  } as SliderCard;
}

describe("引用式挂载", () => {
  it("命令字段覆盖到卡上，paramId 仍归卡片", async () => {
    const { id } = await seedCommand();
    const { mountedState, withMountedCommand } = await import("./commandMount");
    const c = card({ commandId: id });
    expect(mountedState(c)).toMatchObject({ kind: "ok" });
    const eff = withMountedCommand(c);
    expect(eff.template).toBe("GO!");
    expect(eff.sendMode).toBe("ascii");
    expect(eff.paramId).toBe("p1");
  });

  it("单链：命令没引用谱时，卡上残留的谱引用必须被清掉", async () => {
    const { id } = await seedCommand();
    const { withMountedCommand } = await import("./commandMount");
    const eff = withMountedCommand(
      card({ commandId: id, sendTemplateId: "stale-spec" }),
    );
    expect(eff.sendTemplateId).toBeUndefined();
  });

  it("命令引用谱时，谱引用来自命令而不是卡片", async () => {
    const { id } = await seedCommand({
      template: "",
      sendTemplateId: "spec-from-command",
      overrides: { rate: "5" },
    });
    const { withMountedCommand } = await import("./commandMount");
    const eff = withMountedCommand(card({ commandId: id }));
    expect(eff.sendTemplateId).toBe("spec-from-command");
    expect(eff.mountOverrides).toEqual({ rate: "5" });
  });

  it("命令被删后是失效引用，而不是悄悄退回旧模板", async () => {
    const { cmd, id } = await seedCommand();
    const { mountedState, withMountedCommand } = await import("./commandMount");
    cmd.removeNode(id);
    const c = card({ commandId: id });
    expect(mountedState(c)).toEqual({ kind: "missing" });
    // 合并函数不动卡：拦发送的是调用方（resolveSendCard），不在这里假装成"没挂载"
    expect(withMountedCommand(c).template).toBe("OLD");
  });

  it("没有 commandId 的旧卡完全不受影响", async () => {
    const { mountedState, withMountedCommand } = await import("./commandMount");
    const c = card();
    expect(mountedState(c)).toEqual({ kind: "none" });
    expect(withMountedCommand(c)).toBe(c);
  });

  it("只有单模板语义的四种卡可挂载", async () => {
    const { isMountable } = await import("./commandMount");
    for (const t of ["slider", "button", "joystick", "keymon"] as const)
      expect(isMountable({ type: t })).toBe(true);
    for (const t of ["switch", "keypad", "group", "led", "monitor", "embed"] as const)
      expect(isMountable({ type: t })).toBe(false);
  });
});
