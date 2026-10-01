/**
 * P121-E · 出厂发送谱预设的自检。
 *
 * 预设是给第一次打开这个面板的人看的，它编不出帧就是当场打脸：
 * 所以这里不比对快照字节（那会把"预设长什么样"钉死成不敢改的样板），
 * 而是钉四件**改坏了就必然红**的事。
 */
import { describe, expect, it } from "vitest";
import { encodeSend } from "./encodeSend";
import { coverageRange } from "./byteGrid";
import { SEND_PRESETS, applySendPreset } from "./sendPresets";
import { DeriveError, toReceiveTpl } from "./specToProtocol";
import type { SendTemplate } from "./sendTypes";

const all = (): { pack: string; tpl: SendTemplate }[] =>
  SEND_PRESETS.flatMap((d) => d.build().map((t) => ({ pack: d.key, tpl: t })));

describe("发送谱预设 · 每张都得是真能发的", () => {
  it("三张 pack、至少四张谱（数量少了说明有人把示例删了却没说）", () => {
    expect(SEND_PRESETS.length).toBe(3);
    expect(all().length).toBeGreaterThanOrEqual(4);
  });

  it("每一张都编得出帧，且帧长至少等于块数", () => {
    for (const { pack, tpl } of all()) {
      const r = encodeSend(tpl, { seq: tpl.nextSeq });
      expect(r.bytes.length, `${pack}/${tpl.name} 编出来的帧`).toBeGreaterThan(0);
      expect(r.hex.split(" ").length).toBe(r.bytes.length);
    }
  });

  it("参数引用不悬空：块上写的 paramId 都得在 params 里", () => {
    for (const { pack, tpl } of all()) {
      const ids = new Set(tpl.params.map((p) => p.id));
      for (const f of tpl.fields) {
        if (f.source.kind === "param") {
          expect(ids.has(f.source.paramId), `${pack}/${tpl.name} 的块「${f.name}」引用了不存在的参数`).toBe(true);
        }
      }
      // 反向也查：预设里不该留着没人用的参数（那是"填了却不生效"的另一种骗人）
      const used = new Set(
        tpl.fields.filter((f) => f.source.kind === "param").map((f) => (f.source as { paramId: string }).paramId),
      );
      for (const p of tpl.params) expect(used.has(p.id), `${pack}/${tpl.name} 的参数「${p.name}」没有块引用`).toBe(true);
    }
  });

  it("带校验段的谱：算法、段宽与覆盖范围三者自洽", () => {
    const withCk = all().filter((x) => x.tpl.checksum && x.tpl.checksum.algo !== "none");
    expect(withCk.length, "预设里至少该有一张示范校验").toBeGreaterThan(0);
    for (const { pack, tpl } of withCk) {
      const ckIndex = tpl.fields.findIndex((f) => f.role === "checksum" || f.role === "checksum2");
      expect(ckIndex, `${pack}/${tpl.name} 选了算法却没有校验块`).toBeGreaterThan(-1);
      const r = encodeSend(tpl, { seq: tpl.nextSeq });
      // 校验覆盖的终点必须正好停在校验段之前：多算一字节就永远发不出自己算的校验
      const cov = coverageRange(tpl.checksum!.coverageStart, tpl.checksum!.coverageEnd, r.bytes.length);
      const ckStart = r.spans[ckIndex].at;
      expect(cov!.start + cov!.len, `${pack}/${tpl.name} 的覆盖范围与校验段位置不吻合`).toBe(ckStart);
    }
  });

  it("每张都还能反手派生成解析协议（P122-B 那座桥对预设同样成立）", () => {
    for (const { pack, tpl } of all()) {
      const enc = encodeSend(tpl, { seq: tpl.nextSeq });
      expect(() => toReceiveTpl(tpl, { bytes: enc.bytes, spans: enc.spans }, { id: "t" }), `${pack}/${tpl.name} 派生不出协议`).not.toThrow();
      expect(() => toReceiveTpl(tpl, { bytes: enc.bytes, spans: enc.spans }, { id: "t" })).not.toThrow(DeriveError);
    }
  });

  it("id 每次新建都是新的，且块 id 不撞（同一次 build 内）", () => {
    for (const { tpl } of all()) {
      const ids = tpl.fields.map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("applySendPreset 给每张谱打上 pack 的 groupKey（溯源），build 本身不落库", () => {
    for (const def of SEND_PRESETS) {
      const list = applySendPreset(def);
      expect(list.length).toBeGreaterThan(0);
      for (const t of list) expect(t.groupKey).toBe(def.key);
    }
  });

  it("有长度域的谱：长度数的是「这一帧去掉谁」，与 covers 说的一致", () => {
    const framed = all().find((x) => x.tpl.fields.some((f) => f.source.kind === "len"));
    expect(framed, "预设里该有一张演示长度回填").toBeTruthy();
    const enc = encodeSend(framed!.tpl, { seq: 0 });
    const at = framed!.tpl.fields.findIndex((f) => f.source.kind === "len");
    const declared = enc.bytes[at];
    expect(declared, "covers=after ⇒ 数长度域之后的字节").toBe(enc.bytes.length - at - 1);
  });
});
