/**
 * P174-A2：线协议的判据。重点不是"能编能解"，而是三件容易写错的事：
 * 1. **方向**：一条 `{t:"call"}` 从插件发过来，宿主不能当成自己的指令；
 * 2. **分帧**：U+2028/U+2029 会破坏按行切分，必须在编码时拒（且这条能被夹具触发）；
 * 3. **token**：每一条都要对，包括 `ready`——空闲挂起重启后，旧实例的残留消息真会来。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  isPluginToHost,
  isHostToExt,
  isKnownType,
  tokenMatches,
  type PluginToHost,
  type HostToExt,
} from "./protocol";

const TOKEN = "abc123";

describe("P174-A2 · 编解码往返", () => {
  it("宿主指令与插件回执都能一行一解码，字段不丢", () => {
    const call: HostToExt = { t: "call", token: TOKEN, id: "r1", method: "startJob", args: { kind: "train" } };
    const line = encodeMessage(call);
    expect(line).not.toContain("\n");
    const back = decodeMessage(line);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.msg).toEqual(call);

    const res: PluginToHost = { t: "result", token: TOKEN, id: "r1", ok: false, code: "internal", err: "炸了" };
    const r2 = decodeMessage(encodeMessage(res));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.msg).toEqual(res);
  });

  it("payload 里的换行被转义，不会把一条消息劈成两条", () => {
    const m: PluginToHost = { t: "emit", token: TOKEN, panelId: "p", event: "log", payload: "line1\nline2" };
    const line = encodeMessage(m);
    const parts = line.split("\n");
    expect(parts).toHaveLength(1);
    const back = decodeMessage(parts[0]);
    expect(back.ok).toBe(true);
    if (back.ok) expect((back.msg as { payload: string }).payload).toBe("line1\nline2");
  });
});

describe("P174-A2 · 分帧的硬边界", () => {
  it("U+2028 / U+2029 会让编码直接抛（不是静默截断）", () => {
    const bad = { t: "emit", token: TOKEN, panelId: "p", event: "x", payload: "a\u2028b" } as PluginToHost;
    expect(() => encodeMessage(bad)).toThrow(/U\+2028/);
    const bad2 = { ...bad, payload: "a\u2029b" } as PluginToHost;
    expect(() => encodeMessage(bad2)).toThrow();
  });

  it("超过 1 MiB 的消息拒发，并说清上限", () => {
    const huge = { t: "emit", token: TOKEN, panelId: "p", event: "x", payload: "x".repeat(MAX_MESSAGE_BYTES) } as PluginToHost;
    expect(() => encodeMessage(huge)).toThrow(/超过/);
  });

  it("超长行在解码侧也拒（不能只靠发送方自觉）", () => {
    const line = `{"t":"emit","token":"${TOKEN}","panelId":"p","event":"x","payload":"${"y".repeat(MAX_MESSAGE_BYTES)}"}`;
    const r = decodeMessage(line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("too_large");
  });
});

describe("P174-A2 · 坏输入一律有归因码，不抛异常", () => {
  it("空行 / 非 JSON / 非对象 / 缺 t，各给各的码", () => {
    expect(decodeMessage("   ")).toMatchObject({ ok: false, code: "empty" });
    expect(decodeMessage("{oops")).toMatchObject({ ok: false, code: "not_json" });
    expect(decodeMessage("[1,2]")).toMatchObject({ ok: false, code: "not_object" });
    expect(decodeMessage('"str"')).toMatchObject({ ok: false, code: "not_object" });
    expect(decodeMessage('{"token":"x"}')).toMatchObject({ ok: false, code: "no_type" });
    expect(decodeMessage('{"t":""}')).toMatchObject({ ok: false, code: "no_type" });
  });
});

describe("P174-A2 · 方向判定（防自说自话）", () => {
  it("call/activate/dispose 只属于宿主 → 插件", () => {
    for (const t of ["hello", "activate", "call", "panel", "notify", "dispose"]) {
      expect(isKnownType(t), t).toBe(true);
      expect(isHostToExt({ t } as HostToExt), t).toBe(true);
      expect(isPluginToHost({ t } as PluginToHost), t).toBe(false);
    }
  });

  it("ready/result/emit/log/tools/disposed 只属于插件 → 宿主", () => {
    for (const t of ["ready", "result", "emit", "log", "tools", "disposed"]) {
      expect(isKnownType(t), t).toBe(true);
      expect(isPluginToHost({ t } as PluginToHost), t).toBe(true);
      expect(isHostToExt({ t } as HostToExt), t).toBe(false);
    }
  });

  it("未知类型判 false（更新版插件的新消息不会被老宿主误执行）", () => {
    expect(isKnownType("future-thing")).toBe(false);
    expect(isHostToExt({ t: "future-thing" } as unknown as HostToExt)).toBe(false);
    expect(isPluginToHost({ t: "future-thing" } as unknown as PluginToHost)).toBe(false);
  });
});

describe("P174-A2 · token", () => {
  it("对得上才算；ready 也必须带 token（重启后旧实例的残留消息靠它挡）", () => {
    expect(tokenMatches({ t: "ready", token: TOKEN, v: PROTOCOL_VERSION, node: "22" }, TOKEN)).toBe(true);
    expect(tokenMatches({ t: "call", token: "other", id: "1", method: "m", args: {} }, TOKEN)).toBe(false);
    // 不带 token 的一律不算
    expect(tokenMatches({ t: "disposed" } as PluginToHost, TOKEN)).toBe(false);
    // 类型不对的 token 也不算（防 `{token:123}`）
    expect(tokenMatches({ t: "disposed", token: 123 } as unknown as PluginToHost, TOKEN)).toBe(false);
  });
});
