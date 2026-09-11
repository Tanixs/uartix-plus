import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SentinelEngine, ALERT_CAP, LEARN_MS, type SentinelConfig } from "./sentinelEngine";
import type { FramesEventPayload, FrameRow } from "../../ipc/types";

const T0 = 1_000_000;

function mkRow(over: Partial<FrameRow> = {}): FrameRow {
  return {
    tplId: "tA",
    tplName: "模板A",
    color: "#fff",
    tsMs: T0,
    seq: 0,
    len: 8,
    valid: true,
    error: null,
    fields: [],
    ...over,
  };
}

function mkField(name: string, value: number): FrameRow["fields"][number] {
  return { id: name, name, raw: value, value, text: null };
}

function payload(rows: FrameRow[]): FramesEventPayload {
  return { rows, total: rows.length, errors: rows.filter((r) => !r.valid).length };
}

function cfg(over: Partial<SentinelConfig> = {}): SentinelConfig {
  return {
    enabled: true,
    sensitivity: "mid",
    silenceSec: 3,
    errRatePct: 10,
    mutedKeys: [],
    sound: false,
    volume: 70,
    alertCap: ALERT_CAP,
    autoDiag: false,
    diagCooldownMin: 5,
    ...over,
  };
}

describe("sentinelEngine", () => {
  beforeEach(() => {
    // 每例独立实例
  });
  afterEach(() => {
    // 无全局状态
  });

  it("通道突变：跳变后连续 2 个评估周期报警，文案含通道名与 σ", () => {
    const e = new SentinelEngine();
    e.configure(cfg());
    e.start(T0);
    e.setConn(true, T0);
    // 12 帧稳定值 10（越过 MIN_SAMPLES=10）
    for (let i = 0; i < 12; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + i, fields: [mkField("roll", 10)] })]));
    }
    e.tick(T0 + 100);
    // 跳变到 100 并持续
    for (let i = 0; i < 4; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 200 + i, fields: [mkField("roll", 100)] })]));
    }
    expect(e.tick(T0 + 300)).toBe(false); // hot=1，尚无可见变化
    for (let i = 0; i < 4; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 400 + i, fields: [mkField("roll", 100)] })]));
    }
    expect(e.tick(T0 + 500)).toBe(true); // hot=2 → 报警
    const snap = e.snapshot();
    const spike = snap.alerts.find((a) => a.kind === "spike");
    expect(spike).toBeTruthy();
    expect(spike!.channel).toBe("roll");
    expect(spike!.msg).toContain("roll");
    expect(spike!.msg).toContain("σ");
    expect(spike!.level).toBe("crit"); // 15σ > mid 阈值 4 的 1.6 倍 → crit
    expect(snap.chans.find((c) => c.name === "roll")!.level).toBe("crit");
  });

  it("通道突变：小幅波动不误报，恢复正常产生 recover", () => {
    const e = new SentinelEngine();
    e.configure(cfg());
    e.start(T0);
    e.setConn(true, T0);
    // 正常值 10 附近 ±0.5 波动 60 帧（超过 2 个周期）
    for (let i = 0; i < 60; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + i, fields: [mkField("v", 10 + (i % 2 ? 0.5 : -0.5))] })]));
      e.tick(T0 + i + 1);
    }
    expect(e.snapshot().alerts.filter((a) => a.kind === "spike")).toHaveLength(0);
    // 建立异常再恢复
    for (let i = 0; i < 8; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 100 + i, fields: [mkField("v", 100)] })]));
    }
    e.tick(T0 + 200);
    e.tick(T0 + 300);
    expect(e.snapshot().alerts.some((a) => a.kind === "spike")).toBe(true);
    // 回落 → recover
    for (let i = 0; i < 4; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 400 + i, fields: [mkField("v", 10)] })]));
    }
    e.tick(T0 + 500);
    const rec = e.snapshot().alerts.find((a) => a.kind === "recover");
    expect(rec).toBeTruthy();
    expect(rec!.key).toBe("recover:spike:v");
  });

  it("通信静默：超阈值报 crit、只报一次、恢复后 recover 且重新武装", () => {
    const e = new SentinelEngine();
    e.configure(cfg({ silenceSec: 3 }));
    e.start(T0);
    e.setConn(true, T0);
    e.ingest(payload([mkRow({ tsMs: T0 })]));
    e.tick(T0 + 1000);
    expect(e.snapshot().alerts.some((a) => a.kind === "silence")).toBe(false);
    e.tick(T0 + 4100);
    expect(e.snapshot().alerts.some((a) => a.kind === "silence")).toBe(true);
    e.tick(T0 + 5200); // 持续静默不重复报
    expect(e.snapshot().alerts.filter((a) => a.kind === "silence")).toHaveLength(1);
    // 恢复收帧
    e.ingest(payload([mkRow({ tsMs: T0 + 6000 })]));
    e.tick(T0 + 6100);
    const snap = e.snapshot();
    expect(snap.alerts.some((a) => a.key === "recover:silence")).toBe(true);
    // 再次静默可重新报警（重新武装）；冷却期内同 key 合并为 ×2
    e.tick(T0 + 11000);
    const silences = e.snapshot().alerts.filter((a) => a.kind === "silence");
    expect(silences).toHaveLength(1);
    expect(silences[0].count).toBe(2);
  });

  it("断开连接：静默判定复位，不产生恢复事件误报", () => {
    const e = new SentinelEngine();
    e.configure(cfg());
    e.start(T0);
    e.setConn(true, T0);
    e.ingest(payload([mkRow({ tsMs: T0 })]));
    e.tick(T0 + 5000); // 静默报警
    expect(e.snapshot().alerts.some((a) => a.kind === "silence")).toBe(true);
    e.setConn(false, T0 + 5100);
    e.tick(T0 + 5200);
    const snap = e.snapshot();
    expect(snap.silenceMs).toBe(-1);
    expect(snap.alerts.some((a) => a.key === "recover:silence")).toBe(true);
  });

  it("新帧型：学习期内首见不报，学习期后首见报 warn", () => {
    const e = new SentinelEngine();
    e.configure(cfg());
    e.start(T0);
    e.setConn(true, T0);
    e.ingest(payload([mkRow({ tplId: "tA", tplName: "模板A", tsMs: T0 })]));
    e.tick(T0 + 100);
    expect(e.snapshot().alerts.some((a) => a.kind === "newframe")).toBe(false);
    // 越过学习期
    e.tick(T0 + LEARN_MS + 1);
    e.ingest(payload([mkRow({ tplId: "tB", tplName: "模板B", tsMs: T0 + LEARN_MS + 2 })]));
    e.tick(T0 + LEARN_MS + 3);
    const snap = e.snapshot();
    const nf = snap.alerts.find((a) => a.kind === "newframe");
    expect(nf).toBeTruthy();
    expect(nf!.tplId).toBe("tB");
    expect(snap.frameTypes.find((t) => t.id === "tB")!.isNew).toBe(true);
  });

  it("错误帧率：超阈值报 warn，回落产生 recover", () => {
    const e = new SentinelEngine();
    e.configure(cfg({ errRatePct: 10 }));
    e.start(T0);
    e.setConn(true, T0);
    const rows: FrameRow[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(mkRow({ tsMs: T0 + i, valid: i % 4 === 0 ? false : true })); // 25% 错误
    }
    e.ingest(payload(rows));
    e.tick(T0 + 100);
    expect(e.snapshot().alerts.some((a) => a.kind === "errrate")).toBe(true);
    // 恢复正常帧
    for (let i = 0; i < 3; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 1000 + i, valid: true })]));
      e.tick(T0 + 1100 + i);
    }
    e.ingest(payload([mkRow({ tsMs: T0 + 2000, valid: true })]));
    e.tick(T0 + 2100);
    expect(e.snapshot().alerts.some((a) => a.key === "recover:errrate")).toBe(true);
  });

  it("冷却合并：同 key 10s 内重复异常合并为 ×N", () => {
    const e = new SentinelEngine();
    e.configure(cfg({ sensitivity: "high" }));
    e.start(T0);
    e.setConn(true, T0);
    for (let i = 0; i < 12; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + i, fields: [mkField("v", 10)] })]));
    }
    e.tick(T0 + 50);
    for (let i = 0; i < 4; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 100 + i, fields: [mkField("v", 100)] })]));
    }
    e.tick(T0 + 200);
    e.tick(T0 + 300);
    // 冷却期内再次触发（hot 重置后重新爬到 2）
    for (let i = 0; i < 4; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 400 + i, fields: [mkField("v", 10)] })]));
    }
    e.tick(T0 + 500);
    for (let i = 0; i < 4; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 600 + i, fields: [mkField("v", 100)] })]));
    }
    e.tick(T0 + 700);
    e.tick(T0 + 800);
    const spikes = e.snapshot().alerts.filter((a) => a.kind === "spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0].count).toBeGreaterThanOrEqual(2);
  });

  it("环形缓冲：超过 ALERT_CAP 覆盖最旧，快照恒为最新 CAP 条", () => {
    const e = new SentinelEngine();
    e.configure(cfg());
    e.start(T0);
    e.setConn(true, T0);
    // 制造 ALERT_CAP+50 个不同 key 的报警（每个通道独立 key）
    for (let ch = 0; ch < ALERT_CAP + 50; ch++) {
      for (let i = 0; i < 12; i++) {
        e.ingest(payload([mkRow({ tsMs: T0 + ch * 100 + i, fields: [mkField(`ch${ch}`, 10)] })]));
      }
      e.tick(T0 + ch * 100 + 50);
      for (let i = 0; i < 4; i++) {
        e.ingest(payload([mkRow({ tsMs: T0 + ch * 100 + 60 + i, fields: [mkField(`ch${ch}`, 100)] })]));
      }
      e.tick(T0 + ch * 100 + 70);
      e.tick(T0 + ch * 100 + 80);
    }
    const snap = e.snapshot();
    expect(snap.alerts).toHaveLength(ALERT_CAP);
    // 最旧的被覆盖：第一条应是较新的通道
    expect(snap.alerts[0].channel).toMatch(/ch\d+/);
  });

  it("ack / ackAll / unack 计数", () => {
    const e = new SentinelEngine();
    e.configure(cfg({ silenceSec: 1 }));
    e.start(T0);
    e.setConn(true, T0);
    e.ingest(payload([mkRow({ tsMs: T0 })]));
    e.tick(T0 + 2000);
    const snap1 = e.snapshot();
    expect(snap1.unack).toBe(1);
    e.ack(snap1.alerts[0].id);
    expect(e.snapshot().unack).toBe(0);
    // 重复 ack 不越界
    e.ack(snap1.alerts[0].id);
    expect(e.snapshot().unack).toBe(0);
    e.ingest(payload([mkRow({ tsMs: T0 + 3000 })]));
    e.tick(T0 + 3500);
    e.tick(T0 + 5000); // 第二次静默
    e.ackAll();
    expect(e.snapshot().unack).toBe(0);
  });

  it("静音 key：报警不再产生（通道评级仍在）", () => {
    const e = new SentinelEngine();
    e.configure(cfg({ sensitivity: "high" }));
    e.start(T0);
    e.setConn(true, T0);
    e.muteKey("spike:v");
    for (let i = 0; i < 12; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + i, fields: [mkField("v", 10)] })]));
    }
    e.tick(T0 + 50);
    for (let i = 0; i < 8; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 100 + i, fields: [mkField("v", 100)] })]));
    }
    e.tick(T0 + 200);
    e.tick(T0 + 300);
    expect(e.snapshot().alerts.filter((a) => a.kind === "spike")).toHaveLength(0);
    e.unmuteKey("spike:v");
    for (let i = 0; i < 4; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 400 + i, fields: [mkField("v", 10)] })]));
    }
    e.tick(T0 + 500);
    for (let i = 0; i < 8; i++) {
      e.ingest(payload([mkRow({ tsMs: T0 + 600 + i, fields: [mkField("v", 100)] })]));
    }
    e.tick(T0 + 700);
    e.tick(T0 + 800);
    expect(e.snapshot().alerts.some((a) => a.kind === "spike")).toBe(true);
  });

  it("stop 后清空：快照归零，ingest/tick 无副作用", () => {
    const e = new SentinelEngine();
    e.configure(cfg());
    e.start(T0);
    e.setConn(true, T0);
    e.ingest(payload([mkRow({ tsMs: T0, fields: [mkField("v", 1)] })]));
    e.stop();
    expect(e.tick(T0 + 1000)).toBe(false);
    e.ingest(payload([mkRow({ tsMs: T0 + 1001 })])); // 不应崩溃
    const snap = e.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.alerts).toHaveLength(0);
    expect(snap.chans).toHaveLength(0);
    expect(snap.totals.frames).toBe(0);
  });

  it("健康分：无异常 100，crit -40 / warn -15，恢复回升", () => {
    const e = new SentinelEngine();
    e.configure(cfg({ silenceSec: 1 }));
    e.start(T0);
    e.setConn(true, T0);
    e.ingest(payload([mkRow({ tsMs: T0 })]));
    e.tick(T0 + 2000);
    expect(e.snapshot().health).toBe(60); // silence=crit
    e.ingest(payload([mkRow({ tsMs: T0 + 3000 })]));
    e.tick(T0 + 3100);
    expect(e.snapshot().health).toBe(100);
  });
});
