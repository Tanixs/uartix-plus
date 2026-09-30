/**
 * P121-D · 引用式命令：改谱即改命令，序号只有一个计数器。
 *
 * 钉的是详设 §1.4 那个坑的正面回答。今天「存为指令」把当前参数值烤成 hex 字面量
 * （`QuickCommandBar.tsx:218-243`），存完参数就没了、长度不回填、校验不重算——
 * 用户以为存下的是"怎么做一帧"，实际存下的是"那一帧当时长什么样"。
 * 引用式（`CommandItem.sendTemplateId`）之后，这几件事必须成立：
 *  ① 发的是谱**现在**算出来的字节；
 *  ② 改谱，命令跟着变（不需要重新存）；
 *  ③ 谱被删 ⇒ 明确报错，**不退回**去发条目上残留的 `template` 字面量；
 *  ④ 自增序号存在谱里、四个入口共用，失败的那一帧不留下号洞；
 *  ⑤ 只读锁锁得住改谱，锁不住发帧（发一帧是现场操作员的本职）；
 *  ⑥ 号是**同步占**的、没发出去就退还 ⇒ 重叠的两次发送不撞同一个号，
 *     一个编不出来/发失败的帧也不烧号；
 *  ⑦ 计数器属于"这条流"：撤销配置改动不回拨它，副本与导入各自从 0 起。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendData: vi.fn<(mode: string, text: string) => Promise<void>>(),
  onFrames: vi.fn(),
  subscribe: vi.fn(),
  getSnapshot: vi.fn(() => ({ rules: { templates: [] } })),
}));

vi.mock("../serial/serialStore", () => ({ sendData: mocks.sendData }));
vi.mock("../../ipc/framesBus", () => ({ onFrames: mocks.onFrames }));
vi.mock("../protocol/templateStore", () => ({
  subscribe: mocks.subscribe,
  getSnapshot: mocks.getSnapshot,
}));

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});
vi.stubGlobal("structuredClone", (v: unknown) => JSON.parse(JSON.stringify(v)));

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};
/** 接线层是模块求值期就生效的单例（订阅帧流、挂面板生命周期），不好在测试里真 import；
 *  ⑭ 因此读源码钉形状——与 cmdExec.test.ts 第 ② 层同一手法。 */
const readSrc = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

let sendStore: typeof import("./sendStore");
let cmdExec: typeof import("../controls/cmdExec");
let cmdStore: typeof import("../controls/commandStore");
let lock: typeof import("../operator/lock");

beforeEach(async () => {
  vi.resetModules();
  mem.clear();
  mocks.sendData.mockReset().mockResolvedValue(undefined);
  sendStore = await import("./sendStore");
  cmdExec = await import("../controls/cmdExec");
  cmdStore = await import("../controls/commandStore");
  lock = await import("../operator/lock");
  lock.setOperatorLocked(false);
});

/** 一帧：AA | seq | len(它之后) | 校验 sum8 */
function buildSeqTemplate() {
  const id = sendStore.addTemplate("带序号");
  sendStore.addField(id, { id: "h", name: "HDR", type: "uint8", endian: "big", role: "header", source: { kind: "const", bytes: [0xaa] } });
  sendStore.addField(id, { id: "s", name: "SEQ", type: "uint8", endian: "big", role: "seq", source: { kind: "seq" } });
  sendStore.addField(id, { id: "l", name: "LEN", type: "uint8", endian: "big", role: "length", source: { kind: "len", covers: "after" } });
  sendStore.addField(id, { id: "c", name: "CK", type: "uint8", endian: "big", role: "checksum", source: { kind: "const", bytes: [] } });
  sendStore.patchTemplate(id, { checksum: { algo: "sum8", coverageStart: 0, coverageEnd: -1 } });
  return id;
}

describe("P121-D · 引用式命令", () => {
  it("① 发的是谱算出来的字节，参数走默认值", async () => {
    const id = sendStore.addTemplate("设速度");
    sendStore.addField(id, { id: "h", name: "HDR", type: "uint8", endian: "big", role: "header", source: { kind: "const", bytes: [0xa5] } });
    sendStore.addField(id, { id: "v", name: "SPD", type: "uint16", endian: "big", role: "data", source: { kind: "param", paramId: "p1" } });
    sendStore.addParam(id, { id: "p1", name: "速度", type: "int", def: "300" });
    await cmdExec.runCommand({ sendMode: "hex", template: "", script: "", scriptEnabled: false, sendTemplateId: id });
    expect(mocks.sendData.mock.calls[0][0]).toBe("hex");
    expect(mocks.sendData.mock.calls[0][1]).toBe("A5 01 2C");
  });

  it("② 改谱即改命令：不重新存，命令发的字节跟着变", async () => {
    const id = buildSeqTemplate();
    const cmd = { sendMode: "hex" as const, template: "", script: "", scriptEnabled: false, sendTemplateId: id };
    await cmdExec.runCommand(cmd);
    const first = mocks.sendData.mock.calls[0][1];
    sendStore.patchField(id, "h", { name: "HDR", type: "uint8", endian: "big", role: "header", source: { kind: "const", bytes: [0xbb] } });
    await cmdExec.runCommand(cmd);
    const second = mocks.sendData.mock.calls[1][1];
    expect(first).not.toBe(second);
    expect(second.startsWith("BB")).toBe(true);
  });

  it("③ 谱被删 ⇒ 报错点名，且不退回发残留的 template 字面量", async () => {
    const id = buildSeqTemplate();
    sendStore.removeTemplate(id);
    await expect(
      cmdExec.runCommand({
        sendMode: "hex",
        template: "AA BB CC",
        script: "",
        scriptEnabled: false,
        sendTemplateId: id,
      }),
    ).rejects.toThrow(/发送谱已被删除|send template was deleted/);
    expect(mocks.sendData, "残留 template 被当成兜底发出去了：两份真相回潮").not.toHaveBeenCalled();
  });

  it("④ 序号存在谱里：发成功往前推一格，发失败不跳号", async () => {
    const id = buildSeqTemplate();
    const cmd = { sendMode: "hex" as const, template: "", script: "", scriptEnabled: false, sendTemplateId: id };
    await cmdExec.runCommand(cmd);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(1);
    mocks.sendData.mockRejectedValueOnce(new Error("串口没开"));
    await expect(cmdExec.runCommand(cmd)).rejects.toThrow(/串口没开/);
    expect(sendStore.getTemplate(id)!.nextSeq, "发失败也跳号：设备看到的空洞是我们自己造的").toBe(1);
    await cmdExec.runCommand(cmd);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(2);
    // AA | seq | len=1（它之后只有校验段） | sum8(前 3 字节)
    // 第二条与第三条**同为 seq=1**：失败那次没消耗序号，重试补的是同一个号。
    // 这正是"失败也跳号"的反面——设备侧不会看到我们自己造出来的空洞。
    expect(mocks.sendData.mock.calls.map((c) => c[1])).toEqual(["AA 00 01 AB", "AA 01 01 AC", "AA 01 01 AC"]);
  });

  it("⑤ 只读锁：改谱改不动，发帧照发（序号仍推进）", async () => {
    const id = buildSeqTemplate();
    lock.setOperatorLocked(true);
    sendStore.patchTemplate(id, { name: "改得动就有鬼了" });
    expect(sendStore.getTemplate(id)!.name).toBe("带序号");
    await cmdExec.runCommand({ sendMode: "hex", template: "", script: "", scriptEnabled: false, sendTemplateId: id });
    expect(mocks.sendData).toHaveBeenCalledTimes(1);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(1);
    lock.setOperatorLocked(false);
    sendStore.setSeq(id, 0);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(0);
  });

  it("⑥ overrides 覆盖默认值；缺值不发并点名参数", async () => {
    const id = sendStore.addTemplate("带参数");
    sendStore.addField(id, { id: "v", name: "V", type: "uint8", endian: "big", role: "data", source: { kind: "param", paramId: "p" } });
    sendStore.addParam(id, { id: "p", name: "值", type: "int", def: "7" });
    const base = { sendMode: "hex" as const, template: "", script: "", scriptEnabled: false, sendTemplateId: id };
    await cmdExec.runCommand({ ...base, overrides: { p: "19" } });
    expect(mocks.sendData.mock.calls[0][1]).toBe("13");
    sendStore.patchParam(id, "p", { def: "" });
    await expect(cmdExec.runCommand(base)).rejects.toThrow(/值.*没有值|没有值/);
  });

  it("⑦ 预览与发送同一个函数：面板显示的字节 == 命令发出的字节", async () => {
    const id = buildSeqTemplate();
    const tpl = sendStore.getTemplate(id)!;
    const { encodeSend, sendValues } = await import("./encodeSend");
    const shown = encodeSend(tpl, { values: sendValues(tpl, {}), seq: tpl.nextSeq }).hex;
    await cmdExec.runCommand({ sendMode: "hex", template: "", script: "", scriptEnabled: false, sendTemplateId: id });
    expect(mocks.sendData.mock.calls[0][1]).toBe(shown);
  });

  it("⑧ 两次发送重叠也不撞号：占号在 await 之前，不是发完才推", async () => {
    // 连点、循环发送、序列器都可能让两次发送在时间上叠起来。
    // 若计数器在 `await sendCmd` 之后才推，两次会读到同一个号各发一帧、再把计数器推两格——
    // 设备看到的是"同一个号来两次，中间还缺一个"，比跳号更糟。
    const id = buildSeqTemplate();
    const cmd = { sendMode: "hex" as const, template: "", script: "", scriptEnabled: false, sendTemplateId: id };
    const resolvers: (() => void)[] = [];
    mocks.sendData.mockImplementation(() => new Promise<void>((r) => void resolvers.push(r)));
    const a = cmdExec.runCommand(cmd);
    const b = cmdExec.runCommand(cmd);
    expect(resolvers).toHaveLength(2); // 两帧都已出门，第一帧的 ack 还没回来
    resolvers.forEach((r) => r());
    await Promise.all([a, b]);
    expect(mocks.sendData.mock.calls.map((c) => c[1])).toEqual(["AA 00 01 AB", "AA 01 01 AC"]);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(2);
  });

  it("⑨ 编不出帧就不占号：缺参数值那次，计数器原地不动", async () => {
    const id = sendStore.addTemplate("没默认值");
    sendStore.addField(id, { id: "v", name: "V", type: "uint8", endian: "big", role: "data", source: { kind: "param", paramId: "p" } });
    sendStore.addParam(id, { id: "p", name: "值", type: "int", def: "" });
    await expect(
      cmdExec.runCommand({ sendMode: "hex", template: "", script: "", scriptEnabled: false, sendTemplateId: id }),
    ).rejects.toThrow(/没有值/);
    expect(mocks.sendData).not.toHaveBeenCalled();
    expect(sendStore.getTemplate(id)!.nextSeq, "一个没出门的帧不该烧掉一个号").toBe(0);
  });

  it("⑩ 撤销回滚的是配置，不拨计数器", async () => {
    const id = buildSeqTemplate();
    const cmd = { sendMode: "hex" as const, template: "", script: "", scriptEnabled: false, sendTemplateId: id };
    for (let i = 0; i < 3; i++) await cmdExec.runCommand(cmd);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(3);
    sendStore.patchTemplate(id, { note: "改了备注" });
    sendStore.undo();
    expect(sendStore.getTemplate(id)!.note, "配置该退回去").toBe("");
    expect(sendStore.getTemplate(id)!.nextSeq, "撤销后把 seq 拨回 0 = 让设备重收一遍 0..2").toBe(3);
    await cmdExec.runCommand(cmd);
    expect(mocks.sendData.mock.calls[3]![1], "撤销后发出去的仍是下一个号").toContain("AA 03");
  });

  it("⑪ 副本与导入都是新的一条流：计数器从 0 起，不接原谱的尾巴", () => {
    const id = buildSeqTemplate();
    sendStore.setSeq(id, 7);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(7);
    const copy = sendStore.duplicateTemplate(id);
    expect(sendStore.getTemplate(copy)!.nextSeq).toBe(0);
    const added = sendStore.importTemplates([{ ...sendStore.getTemplate(id)!, id: "外来", name: "外来谱", nextSeq: 7 }]);
    expect(added).toBe(1);
    expect(sendStore.getSnapshot().find((t) => t.name === "外来谱")!.nextSeq).toBe(0);
  });
});

/**
 * 序列器 / 编排器的引擎形状是"先解析出这一帧发什么，再去发"，两者之间隔着 await。
 * 所以占号必须发生在解析（`prepareReferenceSend`）、出门与否由引擎回话（`settle`）——
 * 这一组钉的就是这条缝：号在解析那一刻已经占用，`settle(false)` 才把它退回来。
 */
describe("P121-D · 引擎侧的解析/发送两段式", () => {
  it("⑫ 解析即占号：settle(true) 才算数，settle(false) 把号退回去", () => {
    const id = buildSeqTemplate();
    const cmd = { sendMode: "hex" as const, template: "", script: "", scriptEnabled: false, sendTemplateId: id };
    const p = cmdExec.prepareReferenceSend(cmd);
    expect(p.text).toBe("AA 00 01 AB");
    expect(sendStore.getTemplate(id)!.nextSeq, "还没发就已经占下 0 号：这是不撞号的代价").toBe(1);
    p.settle(true);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(1);

    const q = cmdExec.prepareReferenceSend(cmd);
    expect(q.text).toBe("AA 01 01 AC");
    q.settle(false); // 串口没开 / 中途停止
    expect(sendStore.getTemplate(id)!.nextSeq, "没出门的帧不该烧号").toBe(1);
    expect(cmdExec.prepareReferenceSend(cmd).text).toBe("AA 01 01 AC");
  });

  it("⑬ settle(false) 只退自己那一个号：中间别人插了一帧就不退", () => {
    const id = buildSeqTemplate();
    const cmd = { sendMode: "hex" as const, template: "", script: "", scriptEnabled: false, sendTemplateId: id };
    const p = cmdExec.prepareReferenceSend(cmd); // 占 0，计数器 → 1
    const q = cmdExec.prepareReferenceSend(cmd); // 占 1，计数器 → 2
    q.settle(false); // 退 1：计数器仍是最新 → 回到 1
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(1);
    const r = cmdExec.prepareReferenceSend(cmd); // 占 1，计数器 → 2
    p.settle(false); // p 的号早被 r 顶掉了，退它等于把已用的 1 再放出去
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(2);
    expect(r.text).toBe("AA 01 01 AC");
  });

  it("⑭ 序列器与编排器都认谱：解析走 prepareReferenceSend，回话走 settle", async () => {
    const binds = [
      ["序列器接线", readSrc("../sequencer/sequencerBind.ts")],
      ["编排器接线", readSrc("../orchestrator/orchestratorBind.ts")],
    ] as const;
    for (const [who, src] of binds) {
      expect(src, `${who}：命令带 sendTemplateId 时不能再看一眼 template 就 return null`).toMatch(/sendTemplateId/);
      expect(src, `${who}：解析要走同一条判据，不许在接线层自己 encodeSend 一份`).toContain(
        "cmdExec.prepareReferenceSend",
      );
    }
    const engines = [
      ["序列器引擎", readSrc("../sequencer/runner.ts")],
      ["编排器引擎", readSrc("../orchestrator/engine.ts")],
    ] as const;
    for (const [who, src] of engines) {
      expect(src, `${who}：帧真出门了要回话，否则占下的号退不回来`).toContain("settle?.(true)");
      expect(src, `${who}：发送失败要回 false`).toContain("settle?.(false)");
    }
  });

  it("⑮ 序列器接线真解析得出一张谱：老命令带 sendTemplateId 不再被当成空命令", async () => {
    const bind = await import("../sequencer/sequencerBind");
    const id = buildSeqTemplate();
    const cmdId = cmdStore.addReferenceCommand({ templateId: id, name: "带序号", note: "" });
    expect(cmdId, "存成引用式命令").toBeTruthy();
    expect(bind.resolveSend({ type: "cmd", cmdId })).toEqual({
      mode: "hex",
      text: "AA 00 01 AB",
      settle: expect.any(Function),
    });
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(1);
    // 谱被删 ⇒ 解析失败（引擎记 fail），而不是悄悄发一条空内容
    sendStore.removeTemplate(id);
    expect(bind.resolveSend({ type: "cmd", cmdId })).toBeNull();
  });

  it("⑯ 只读锁下「存为指令」什么都不会改：不建分组、不建命令", () => {
    const id = buildSeqTemplate();
    const before = JSON.stringify(cmdStore.getSnapshot().groups);
    lock.setOperatorLocked(true);
    expect(cmdStore.addReferenceCommand({ templateId: id, name: "偷偷存", note: "" })).toBe("");
    expect(JSON.stringify(cmdStore.getSnapshot().groups), "只读发行包里能悄悄往命令库塞一条命令").toBe(before);
  });

  it("⑰ 断开引用：烤成字节之后就不跟谱走了，而且不占号", async () => {
    const id = sendStore.addTemplate("设速度");
    sendStore.addField(id, { id: "h", name: "HDR", type: "uint8", endian: "big", role: "header", source: { kind: "const", bytes: [0xa5] } });
    sendStore.addField(id, { id: "v", name: "SPD", type: "uint16", endian: "big", role: "data", source: { kind: "param", paramId: "p1" } });
    sendStore.addParam(id, { id: "p1", name: "速度", type: "int", def: "300" });
    const cmdId = cmdStore.addReferenceCommand({ templateId: id, name: "设速度", note: "" });
    const item = cmdStore.getCommand(cmdId)!;
    const hex = cmdExec.bakeReferenceFrame(item);
    expect(hex).toBe("A5 01 2C");
    expect(sendStore.getTemplate(id)!.nextSeq, "断开不是发送，不该占号").toBe(0);

    cmdStore.patchCommand(cmdId, { template: hex, sendTemplateId: undefined, overrides: undefined });
    sendStore.patchParam(id, "p1", { def: "500" }); // 改谱
    await cmdExec.runCommand(cmdStore.getCommand(cmdId)!);
    expect(mocks.sendData.mock.calls[0][1], "断开后就该定格在那一帧").toBe("A5 01 2C");
  });

  it("⑱ 卡片引用：卡的值灌进卡自己记着的 paramId，改谱卡片跟着变", async () => {
    const id = sendStore.addTemplate("设速度");
    sendStore.addField(id, { id: "h", name: "HDR", type: "uint8", endian: "big", role: "header", source: { kind: "const", bytes: [0xa5] } });
    sendStore.addField(id, { id: "v", name: "SPD", type: "uint16", endian: "big", role: "data", source: { kind: "param", paramId: "p1" } });
    sendStore.addParam(id, { id: "p1", name: "速度", type: "int", def: "300" });

    const slider = { sendTemplateId: id, paramId: "p1" };
    await cmdExec.runSpecCard(slider, 500);
    expect(mocks.sendData.mock.calls[0][1], "滑条的值就是这一帧的那个参数").toBe("A5 01 F4");

    await cmdExec.runSpecCard({ sendTemplateId: id });
    expect(mocks.sendData.mock.calls[1][1], "按钮卡没配参数 ⇒ 发谱的默认值").toBe("A5 01 2C");

    sendStore.patchField(id, "h", { name: "HDR", type: "uint8", endian: "big", role: "header", source: { kind: "const", bytes: [0xbb] } });
    await cmdExec.runSpecCard(slider, 7);
    expect(mocks.sendData.mock.calls[2][1], "改谱不重新生成卡片，卡片发的字节跟着变").toBe("BB 00 07");
  });

  it("⑲ 卡片引用的号也走同一个计数器", async () => {
    const id = buildSeqTemplate();
    const card = { sendTemplateId: id, paramId: "" };
    await cmdExec.runSpecCard(card);
    await cmdExec.runSpecCard(card);
    expect(sendStore.getTemplate(id)!.nextSeq).toBe(2);
    expect(mocks.sendData.mock.calls.map((c) => c[1])).toEqual(["AA 00 01 AB", "AA 01 01 AC"]);
  });
});
