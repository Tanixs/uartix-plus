import { describe, expect, it, vi } from "vitest";
import {
  executeManagedControl,
  managedActionReady,
  routeSliderValue,
  type SessionActions,
} from "./controlExecution";
import type { ButtonCard, SliderCard } from "./controlsStore";
import type { DebugRole } from "./debugPreset";

const sessionIdle: SessionActions = {
  phase: () => "idle",
  start: vi.fn(async () => true),
  stop: vi.fn(async () => true),
  annotate: vi.fn(async () => true),
};
const sessionRecording: SessionActions = {
  ...sessionIdle,
  phase: () => "recording",
};

const mkManagedButton = (role: DebugRole): ButtonCard => ({
  id: "b1", type: "button", name: role, x: 0, y: 0, w: 4, h: 2,
  template: "", sendMode: "ascii", holdRepeat: false, minIntervalMs: 200,
  useScript: false, script: "",
  managed: { schema: "vs-control-debug/v1", role, paramId: "" },
});

const ordinarySlider: SliderCard = {
  id: "s1", type: "slider", name: "普通", x: 0, y: 0, w: 8, h: 3,
  template: "V:{v}", sendMode: "ascii", min: 0, max: 10, step: 1,
  defaultValue: 0, sendTrigger: "onRelease", minIntervalMs: 200,
  useScript: false, script: "",
};
const managedSlider: SliderCard = {
  ...ordinarySlider,
  id: "s2", name: "Kp", managed: { schema: "vs-control-debug/v1", role: "parameter", paramId: "kp" },
};

describe("controlExecution", () => {
  it("blocks managed device actions with unconfigured adapter", async () => {
    for (const role of ["emergency", "calibrate", "mode", "blocked"] as const) {
      const receipt = await executeManagedControl(mkManagedButton(role), sessionIdle);
      expect(receipt.status).toBe("blocked");
    }
    expect(sessionIdle.start).not.toHaveBeenCalled();
  });

  it("routes whitelisted session actions through sessionStore adapter only", async () => {
    expect(managedActionReady(mkManagedButton("record.start"), "idle")).toBe(true);
    expect(managedActionReady(mkManagedButton("record.start"), "recording")).toBe(false);
    expect(managedActionReady(mkManagedButton("annotate"), "idle")).toBe(false);
    const ok = await executeManagedControl(mkManagedButton("record.start"), sessionIdle);
    expect(ok.status).toBe("completed");
    expect(sessionIdle.start).toHaveBeenCalledTimes(1);
  });

  it("managed slider saves local draft and never reaches ordinary send", () => {
    const saveDraft = vi.fn();
    const ordinarySend = vi.fn();
    routeSliderValue(managedSlider, 3.5, saveDraft, ordinarySend);
    expect(saveDraft).toHaveBeenCalledWith(3.5);
    expect(ordinarySend).not.toHaveBeenCalled();
    routeSliderValue(ordinarySlider, 7, saveDraft, ordinarySend);
    expect(ordinarySend).toHaveBeenCalledTimes(1);
  });

  it("reports session rejection and failure without claiming device verification", async () => {
    expect((await executeManagedControl(mkManagedButton("record.stop"), sessionRecording)).status).toBe("completed");
    expect((await executeManagedControl(mkManagedButton("annotate"), { ...sessionRecording, annotate: async () => false })).status).toBe("failed");
    expect((await executeManagedControl(mkManagedButton("annotate"), { ...sessionRecording, annotate: async () => { throw new Error("offline"); } })).status).toBe("failed");
  });

  it.each(["onRelease", "continuous"] as const)("keeps dragging and release local for %s managed sliders", async sendTrigger => {
    const draft = vi.fn();
    const send = vi.fn();
    const card = { ...managedSlider, sendTrigger, useScript: true, script: "send('bad')" };
    routeSliderValue(card, 3, draft, send);
    routeSliderValue(card, 4, draft, send);
    expect((await executeManagedControl(card, sessionIdle)).status).toBe("blocked");
    expect(draft.mock.calls).toEqual([[3], [4]]);
    expect(send).not.toHaveBeenCalled();
  });
});
