/**
 * P121-E · AI 产发送谱（`writeSendSpec`）的门。
 *
 * 这批的核心不是"模型会写 JSON"，是**它写的 JSON 在落库前已经被真编码器跑过一遍**。
 * 所以这里钉的全是"什么情况下拒收"，而不是"格式对不对"：
 *  - 编不出帧的谱一张都进不来，且回执带的是**编码器自己的话**（模型照这句话能改对，
 *    只说"格式错误"就等于让它再猜一次）；
 *  - 参数块的名字在这里铸 id、同名并一个 —— 让模型自己管 id 只会长出悬空引用；
 *  - 只读锁开着时 `sendStore.importTemplates` 会静默返回 0，那是**假成功**，这里先问锁；
 *  - `checksum2` 明拒：发送侧的编码器只填第一段校验，第二段留在 0x00，
 *    一扇看着能推、推开是空房间的门。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSend } from "../send/encodeSend";

const lock = vi.hoisted(() => ({ value: false }));
vi.mock("../operator/lock", () => ({ guardLocked: () => lock.value }));

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});
vi.stubGlobal("structuredClone", (v: unknown) => JSON.parse(JSON.stringify(v)));
vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

let sendStore: typeof import("../send/sendStore");
let write: typeof import("./aiActions")["writeSendSpecFromAiJson"];

/** 一块最小的可用谱头：帧头 + 一个 u8 参数 */
const one = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "测试谱",
    fields: [
      { name: "帧头", type: "uint8", role: "header", source: { kind: "const", bytes: [0xaa] } },
      { name: "值", type: "uint8", source: { kind: "param", param: "油门", def: "50", min: 0, max: 100 } },
    ],
    ...over,
  });

const tpl = () => sendStore.getSnapshot().find((t) => t.name.startsWith("测试谱"));

beforeEach(async () => {
  vi.resetModules();
  mem.clear();
  lock.value = false;
  sendStore = await import("../send/sendStore");
  write = (await import("./aiActions")).writeSendSpecFromAiJson;
});

describe("writeSendSpecFromAiJson：能写进来的", () => {
  it("一张合法谱落到面板，参数表由这里代建且块引用的就是它", () => {
    const r = write(one());
    expect(r.ok, r.msg).toBe(true);
    const t = tpl();
    expect(t, "谱没进 sendStore").toBeTruthy();
    expect(t!.fields).toHaveLength(2);
    expect(t!.params).toHaveLength(1);
    expect(t!.params[0].name).toBe("油门");
    expect(t!.params[0].type, "u8 该配无符号参数").toBe("uint");
    const ref = t!.fields[1].source;
    expect(ref.kind).toBe("param");
    expect(ref.kind === "param" && ref.paramId, "参数块引到了一个不存在的参数").toBe(t!.params[0].id);
  });

  it("写进来的谱当场就编得出帧，且字节与描述一致", () => {
    write(one());
    const r = encodeSend(tpl()!, { seq: 0 });
    expect(r.hex).toBe("AA 32");
  });

  it("两块吃同一个参数名 ⇒ 参数表只长一条，两个块指向同一个 id", () => {
    const raw = JSON.stringify({
      name: "测试谱",
      fields: [
        { name: "高", type: "uint8", source: { kind: "param", param: "值" } },
        { name: "低", type: "uint8", source: { kind: "param", param: "值" } },
      ],
    });
    expect(write(raw).ok).toBe(true);
    const t = tpl()!;
    expect(t.params).toHaveLength(1);
    const ids = t.fields.map((f) => (f.source.kind === "param" ? f.source.paramId : ""));
    expect(ids[0]).toBe(ids[1]);
  });

  it("变量块（此刻还没有值）照样写得进来 —— 试编按占位值走，不问将来", () => {
    const raw = JSON.stringify({
      name: "测试谱",
      fields: [
        { name: "帧头", type: "uint8", source: { kind: "const", bytes: [0x55] } },
        { name: "俯仰", type: "int16", endian: "little", source: { kind: "var", name: "pitch" } },
      ],
    });
    const r = write(raw);
    expect(r.ok, r.msg).toBe(true);
  });

  it("批量：templates 数组两张都落库，各自成一条", () => {
    const raw = JSON.stringify({
      templates: [
        { name: "测试谱A", fields: [{ name: "b", type: "uint8", source: { kind: "const", bytes: [1] } }] },
        { name: "测试谱B", fields: [{ name: "b", type: "uint8", source: { kind: "const", bytes: [2] } }] },
      ],
    });
    const r = write(raw);
    expect(r.ok, r.msg).toBe(true);
    const names = sendStore.getSnapshot().map((t) => t.name);
    expect(names).toContain("测试谱A");
    expect(names).toContain("测试谱B");
    // 批量时选中停在最后一张：面板至少显示的是 AI 刚写出来的东西之一
    expect(sendStore.getSelectReq()?.id, "批量时面板停在了没写进来的那张上").toBe(sendStore.getSnapshot()[1].id);
  });

  it("写完把选中挪到刚写那张，不停在用户上一刻正在编的别张谱上", () => {
    const first = sendStore.addTemplate("先前就在编的一张");
    sendStore.requestSelect(first);
    const r = write(one());
    expect(r.ok, r.msg).toBe(true);
    expect(sendStore.getSelectReq()?.id, "面板还在给用户看原来那张，他会以为 AI 什么也没做").toBe(tpl()!.id);
  });
});

describe("writeSendSpecFromAiJson：拒收的与回执说的话", () => {
  it("选了算法却没有校验段 ⇒ 拒收，且回执里是编码器的原话", () => {
    const r = write(
      one({ checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2 } }),
    );
    expect(r.ok, "没有校验段却配了算法，这张谱不该进得来").toBe(false);
    expect(r.msg).toContain("但没有一个字段标成校验段");
    expect(tpl(), "被拒的谱不该留下半个").toBeUndefined();
  });

  it("补上校验段（空的 const）就编得出来，CRC 由算法填", () => {
    const raw = JSON.stringify({
      name: "测试谱",
      fields: [
        { name: "从站", type: "uint8", role: "addr", source: { kind: "param", param: "addr", def: "1" } },
        { name: "功能码", type: "uint8", source: { kind: "const", bytes: [0x03] } },
        { name: "校验", type: "uint8", role: "checksum", source: { kind: "const", bytes: [] } },
      ],
      checksum: { algo: "crc16_modbus", coverageStart: 0, coverageEnd: -2 },
    });
    const r = write(raw);
    expect(r.ok, r.msg).toBe(true);
    expect(encodeSend(tpl()!, { seq: 0 }).hex).toBe("01 03 40 21");
  });

  it("csv 块点名拒收：那是解析侧的显示类型，发不出去", () => {
    const r = write(
      JSON.stringify({
        name: "测试谱",
        fields: [{ name: "t", type: "csv", source: { kind: "const", bytes: [1] } }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("csv");
    expect(r.msg).toContain("改用 ascii");
  });

  it("checksum2 明拒，不悄悄降成 data", () => {
    const r = write(
      one({
        fields: [
          { name: "校验", type: "uint8", role: "checksum", source: { kind: "const", bytes: [] } },
          { name: "附加", type: "uint8", role: "checksum2", source: { kind: "const", bytes: [] } },
        ],
        checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -2 },
      }),
    );
    expect(r.ok, "发送侧只算一段校验，第二段会留在 0x00").toBe(false);
    expect(r.msg).toContain("checksum2");
  });

  it("bcd 没给字节数 ⇒ 拒收并说出是编不出帧", () => {
    const r = write(
      JSON.stringify({
        name: "测试谱",
        fields: [{ name: "时间", type: "bcd", source: { kind: "param", param: "t", def: "12" } }],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("编不出帧");
  });

  it("crc_custom 少给参数 ⇒ 拒收，六项都要齐", () => {
    const r = write(
      one({
        checksum: { algo: "crc_custom", coverageStart: 0, coverageEnd: -2, crc: { width: 16, poly: 4129 } },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("width/poly/init/refin/refout/xorout");
  });

  it("非法 JSON 说的是「不是合法 JSON」，不是「没有可写入的命令」那一类含糊话", () => {
    const r = write("{name:");
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("不是合法 JSON");
  });

  it("只读锁开着：明说拒收，且一张都没落库", () => {
    lock.value = true;
    const r = write(one());
    expect(r.ok, "锁着的时候回 ok 就是假成功").toBe(false);
    expect(r.msg).toContain("只读锁");
    expect(sendStore.getSnapshot()).toHaveLength(0);
  });

  it("只新增不覆盖：已有同名谱时新的加序号，原来那条一个字没变", () => {
    write(one());
    const first = tpl()!;
    const firstJson = JSON.stringify(first);
    const r = write(one());
    expect(r.ok, r.msg).toBe(true);
    expect(sendStore.getSnapshot()).toHaveLength(2);
    expect(JSON.stringify(sendStore.getSnapshot()[0])).toBe(firstJson);
    expect(sendStore.getSnapshot()[1].name).toBe("测试谱 (2)");
  });
});
