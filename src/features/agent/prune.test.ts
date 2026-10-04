/**
 * P135-A · 无模型裁剪器的单元断言（对标 DSH `compaction-tool-result-pruner` + `spill-policy`）。
 *
 * 这里钉的是**判据**，不是效果（效果在 loop.context.test.ts 与 sessionLog.test.ts 里钉）：
 * ① 未超限一条不裁（逐点保真度不因"压得更聪明"而销毁）；
 * ② 裁到放得下就停手，多裁一条都是白毁；
 * ③ 末尾的工作集不裁；
 * ④ 形状未知（解析不出 JSON 对象 / 没有 data / 正文本来就短）就**跳过**，不猜形状；
 * ⑤ 尾部一定留着（失败原因与末行统计长在结尾）；
 * ⑥ "可用 read_artifact 取回"这句支票只在这份原文真的存进了缓存时才开
 *    （P94-G3 / P134-A ③ 两次都栽在无条件承诺，这是它的第三处）。
 */
import { expect, it } from "vitest";
import {
  PRUNE_HEAD_BYTES, PRUNE_MIN_BYTES, PRUNE_TAIL_BYTES,
  messageBytes, pruneToolResults, utf8Bytes,
} from "./context";
import type { AgentMessage } from "./types";

/** 一条 tool 消息，正文是约 N 字节的回执 JSON（尾部埋一个可搜索的失败原因） */
function toolMsg(callId: string, bytes: number, dataExtra: Record<string, unknown> = {}): AgentMessage {
  const fill = "x".repeat(Math.max(0, bytes - 200));
  return {
    role: "tool", callId,
    // `artifactRef` 在 **data 里**：那才是 `rememberArtifact` 对对象型回执的真实形状
    content: JSON.stringify({ callId, ok: true, status: "read", data: { text: fill, ...dataExtra, tail: "FAILED: device busy" } }),
  };
}

/** 尾部两条是工作集，各夹具都用这对收尾 */
const TAIL: AgentMessage[] = [
  { role: "assistant", content: "先记着" },
  { role: "tool", callId: "keep", content: "{}" },
];

function drive(msgs: AgentMessage[], limit: number, spill?: (ref: string, original: string) => string | null) {
  const total = (arr: AgentMessage[]) => arr.reduce((n, m) => n + messageBytes(m), 0);
  return pruneToolResults(msgs, { fits: (arr) => total(arr) <= limit, size: messageBytes, ...(spill ? { spill } : {}) });
}

const dataOf = (m: AgentMessage) => (JSON.parse(m.content) as { data: Record<string, unknown> }).data;

it("未超限时一条都不裁，而且返回原数组引用（无副作用要能被钉住）", () => {
  const msgs = [toolMsg("c1", 60_000), toolMsg("c2", 60_000), ...TAIL];
  const r = drive(msgs, 10_000_000);
  expect(r.pruned).toBe(0);
  expect(r.changed, "没动东西却返回了新数组：调用方无从区分原样与裁过").toBe(false);
  expect(r.messages).toBe(msgs);
});

it("只裁到放得下为止，后面那些巨型回执保持原文（多裁一条都是白毁的保真度）", () => {
  const msgs = [toolMsg("c1", 80_000), toolMsg("c2", 80_000), toolMsg("c3", 80_000), toolMsg("c4", 80_000), ...TAIL];
  // 每条 ≈80KB，限 200KB ⇒ 裁掉最旧两条就够（80+80 变 2×≈2.5KB）
  const r = drive(msgs, 200_000, (ref) => ref);
  expect(r.pruned, "裁够了一条就不该再动：多毁的那条原文再也回不来").toBe(2);
  expect(r.messages[2]!.content.length, "第三条明明放得下却被裁了").toBeGreaterThan(70_000);
  expect(dataOf(r.messages[0]!).pruned).toBe(true);
});

it("末尾的工作集不裁：模型正要照着它决定下一步", () => {
  // 三条远的 + 两条近的（近的这对故意也是巨型回执：裁剪必须**只扫到工作集边界为止**）
  const msgs = [...Array.from({ length: 3 }, (_, i) => toolMsg(`c${i}`, 80_000)), toolMsg("near1", 80_000), toolMsg("near2", 80_000)];
  const r = drive(msgs, 40_000, () => null);
  expect(r.pruned, "只该扫工作集之外那三条").toBe(3);
  for (const id of ["near1", "near2"]) {
    const m = r.messages.find((x) => x.callId === id)!;
    expect(m.content.length, `${id} 在工作集里却被裁了`).toBeGreaterThan(70_000);
    expect(m.content).not.toContain('"pruned":true');
  }
});

it("裁不动的形状一律跳过：正文本来就短、没有 data、解析不出对象、顶层是数组", () => {
  const tiny = toolMsg("c1", 100);
  expect(tiny.content.length).toBeLessThan(PRUNE_MIN_BYTES);
  const noData: AgentMessage = {
    role: "tool", callId: "c2",
    content: JSON.stringify({ callId: "c2", ok: false, status: "error", code: "tool_failed", hint: "h".repeat(9_000) }),
  };
  const notJson: AgentMessage = { role: "tool", callId: "c3", content: "x".repeat(9_000) };
  const arrShape: AgentMessage = { role: "tool", callId: "c4", content: JSON.stringify(["a".repeat(9_000), "b"]) };
  expect(utf8Bytes(noData.content)).toBeGreaterThan(PRUNE_MIN_BYTES); // 三条都得"够大但裁不动"，否则这条没牙
  const big = [toolMsg("c5", 200_000), toolMsg("c6", 200_000), toolMsg("c7", 200_000)];
  const msgs: AgentMessage[] = [tiny, noData, notJson, arrShape, ...big, ...TAIL];
  const r = drive(msgs, 10_000, () => null);
  expect(r.messages[0], "不足门槛的也被裁了").toBe(tiny);
  expect(r.messages[1], "没有正文可裁却被重写了").toBe(noData);
  expect(r.messages[2]!.content, "不可解析的正文被改写成我猜的形状").toBe(notJson.content);
  expect(r.messages[3]!.content, "顶层是数组的回执被改成对象（接住它的是「没有 data 就没有正文可裁」那条闸）").toBe(arrShape.content);
  expect(dataOf(r.messages[4]!).pruned, "该裁的那条没裁").toBe(true);
});

it("头尾都留：失败原因长在结尾，只给头部等于只给回声", () => {
  const msgs = [toolMsg("c1", 200_000), toolMsg("c2", 200_000), toolMsg("c3", 200_000), ...TAIL];
  const d = dataOf(drive(msgs, 10_000, () => null).messages[0]!) as Record<string, string | number>;
  const headText = String(d.head ?? "");
  const tailText = String(d.tail ?? "");
  expect(utf8Bytes(headText)).toBeLessThanOrEqual(PRUNE_HEAD_BYTES + 8);
  expect(tailText, "尾部没留：错误原因与末行统计就在结尾").toContain("FAILED: device busy");
  expect(tailText.length).toBeLessThanOrEqual(PRUNE_TAIL_BYTES + 16);
  expect(Number(d.omittedBytes), "省了多少字节要能复盘").toBeGreaterThan(100_000);
  expect(Number(d.fullBytes)).toBeGreaterThan(Number(d.omittedBytes));
});

it("捕获层已经存过原文的那条：沿用它的 ref，绝不另开一个键", () => {
  const stored: string[] = [];
  const msgs = [toolMsg("c1", 200_000, { artifactRef: "call:c1" }), toolMsg("c2", 200_000), toolMsg("c3", 200_000), ...TAIL];
  const r = drive(msgs, 10_000, (ref) => { stored.push(ref); return ref; });
  const d = dataOf(r.messages[0]!) as Record<string, string>;
  expect(d.artifactRef, "原本就有的 ref 被丢了：模型照着新的 ref 去取会撞空").toBe("call:c1");
  expect(d.note).toContain("read_artifact");
  expect(stored, "同一份原文存了两个键（c1 已有 ref，不该再 spill）").toEqual(["prune:c2", "prune:c3"]);
});

it("没有 ref 但存得进缓存：ref 用 prune:<callId>，存的是完整原文而不是裁过的壳", () => {
  const stored = new Map<string, string>();
  const msgs = [toolMsg("c1", 200_000), toolMsg("c2", 200_000), toolMsg("c3", 200_000), ...TAIL];
  const original = JSON.parse(msgs[0]!.content) as { data: unknown };
  const r = drive(msgs, 10_000, (ref, value) => { stored.set(ref, value); return ref; });
  const d = dataOf(r.messages[0]!) as Record<string, string>;
  expect(d.artifactRef).toBe("prune:c1");
  expect(stored.get("prune:c1"), "存进去的必须是能复演原文的那份").toBe(JSON.stringify(original.data));
  expect(String(stored.get("prune:c1"))).toContain("FAILED: device busy");
  expect(d.note).toContain("read_artifact");
});

it("存不下（没有缓存面）：说明自动降档，不许留一句兑不了的承诺", () => {
  const msgs = [toolMsg("c1", 200_000), toolMsg("c2", 200_000), toolMsg("c3", 200_000), ...TAIL];
  const viaNull = dataOf(drive(msgs, 10_000, () => null).messages[0]!);
  expect(viaNull.artifactRef, "spill 说存不下却还是写了 ref").toBeUndefined();
  expect(String(viaNull.note)).not.toContain("read_artifact");
  expect(String(viaNull.note)).toContain("重新调用");
  const viaAbsent = dataOf(drive(msgs, 10_000).messages[0]!);
  expect(viaAbsent.artifactRef).toBeUndefined();
  expect(String(viaAbsent.note)).toContain("台账"); // 要说清"台账里仍是全文"，否则模型以为历史被删了
});

it("压缩只作用于发出去那一份：原数组与每条原消息的对象引用都不许变", () => {
  const msgs = [toolMsg("c1", 200_000), toolMsg("c2", 200_000), toolMsg("c3", 200_000), ...TAIL];
  const before = msgs.map((m) => m.content);
  const r = drive(msgs, 10_000, (ref) => ref);
  expect(msgs.map((m) => m.content), "台账本体被就地改写了（与 foldContext 同一条判据）").toEqual(before);
  expect(r.messages[0], "裁过的条目必须是新对象").not.toBe(msgs[0]);
  expect(r.messages[4], "没裁的条目不该被复制一遍").toBe(msgs[4]);
});
