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

let sendStore: typeof import("./sendStore");
let cmdExec: typeof import("../controls/cmdExec");
let lock: typeof import("../operator/lock");

beforeEach(async () => {
  vi.resetModules();
  mem.clear();
  mocks.sendData.mockReset().mockResolvedValue(undefined);
  sendStore = await import("./sendStore");
  cmdExec = await import("../controls/cmdExec");
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
