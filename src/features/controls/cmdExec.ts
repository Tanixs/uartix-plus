import type { SendMode } from "./controlsStore";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "./variableStore";
import { beep, runScript } from "./scriptRunner";
import { tx } from "../../i18n/strings";
import * as sendStore from "../send/sendStore";
import { encodeSend, sendValues } from "../send/encodeSend";

/**
 * P104-R3：命令发送与脚本执行的**唯一**实现。
 *
 * 为什么要单独一个文件：命令库从控制画布的抽屉搬进左侧导轨之后，发送这条链路
 * 有了两个调用方（画布上的卡片 / 导轨里的命令行）。两边各写一份 `sendData` +
 * 组变量 + `runScript` 就是两份真值——改一处、漏一处，表现为"卡片里的脚本能用、
 * 命令行里的同一个脚本少一个变量"。
 *
 * 这里只管"怎么发、怎么跑"，不管"结果给谁看"：错误一律往上抛，
 * 由调用方写进自己的错误面（画布有画布的 err，导轨有导轨的 err）。
 */

export async function sendCmd(mode: SendMode, text: string): Promise<void> {
  await serialStore.sendData(mode, text);
}

/** 一条命令的最小形状：命令库的条目与快捷栏的条目都满足它 */
export interface RunnableCommand {
  sendMode: SendMode;
  template: string;
  script: string;
  scriptEnabled: boolean;
  /** 引用一张发送谱（P121-D）。带着它时 `template` 不再参与发送 */
  sendTemplateId?: string;
  overrides?: Record<string, string>;
}

/** 一条引用式命令此刻该发出的那一帧：字节已算好，`settle` 告诉它最后有没有出门 */
export interface PreparedSend {
  /** 引用式命令一律按 hex 出门：hex 是字节的确切描述，而 ascii 那支会把 ≥0x80 的字节按 UTF-8 重新编码 */
  mode: "hex";
  text: string;
  settle(sent: boolean): void;
}

/**
 * 谱引用 → 一帧的字节（**同步**，不发送）。
 *
 * 拆出来是因为序列器 / 编排器的引擎形状是"先解析出要发什么，再去发"：
 * 它们必须能在 `await` 之前拿到这帧字节，所以占号只能发生在解析那一刻
 * （占号若在发送之后，重叠的两步会拿到同一个号）。作为交换，调用方在帧
 * 真的出门后要 `settle(true)`，没出门 `settle(false)` 把号退回来 ——
 * `refundSeq` 只退"仍是最新一次占号"的那个，所以中途别人插了一帧也不会退错。
 */
export function prepareReferenceSend(cmd: RunnableCommand): PreparedSend {
  const tpl = sendStore.getTemplate(cmd.sendTemplateId ?? "");
  if (!tpl) {
    throw new Error(
      tx(
        "引用的发送谱已被删除：请重新「存为指令」，或把这条命令改回模板",
        "The referenced send template was deleted — save it as a command again, or turn this one back into a template command",
      ),
    );
  }
  const seq = sendStore.reserveSeq(tpl.id);
  try {
    const r = encodeSend(tpl, { values: sendValues(tpl, cmd.overrides), seq });
    return {
      mode: "hex",
      text: r.hex,
      settle: (sent) => {
        if (!sent) sendStore.refundSeq(tpl.id, seq);
      },
    };
  } catch (e) {
    sendStore.refundSeq(tpl.id, seq);
    throw e;
  }
}

/**
 * 把一条引用式命令**烤成字节**（断开引用时用）：此刻这一帧长什么样就永久发什么。
 * 不占号——它不是发送。自增序号会被定死在这里取到的那个值，这是"断开"这个词本来的代价，
 * 界面要把这句话说到（见 CommandLibrary 的引用块）。
 */
export function bakeReferenceFrame(cmd: RunnableCommand): string {
  const tpl = sendStore.getTemplate(cmd.sendTemplateId ?? "");
  if (!tpl) return "";
  return encodeSend(tpl, { values: sendValues(tpl, cmd.overrides), seq: tpl.nextSeq }).hex;
}

/**
 * 发一帧发送谱。三件事只有在这里定一次才成立：
 *  - 参数值 = 谱里的默认值 + 命令上的覆盖；缺值由编码器报错点名，不凑数；
 *  - 自增序号**同步占号**、包没发出去就退还（见 `sendStore.reserveSeq`）：
 *    占号在 `await` 之前 ⇒ 重叠的两次发送不会拿到同一个号；退还 ⇒ 失败不跳号；
 *  - 引用被删 ⇒ 明确报错，**不退回**去发那条命令残留的 `template` 字面量
 *    （一台机器上同时留着两份真相是 P121-A 刚清掉的那个病）。
 */
async function sendByTemplate(cmd: RunnableCommand): Promise<void> {
  const p = prepareReferenceSend(cmd);
  try {
    await sendCmd(p.mode, p.text);
    p.settle(true);
  } catch (e) {
    p.settle(false);
    throw e;
  }
}

/**
 * P121-A：**点击一条命令**的唯一执行入口。
 *
 * 之前这里有两份：命令库点 → `resolveVars(template)` 后发；控制台快捷栏点 → 直接发原文。
 * 同一条 `SPD:{speed}` 在两个入口发出的字节不一样，而悬浮提示显示的又是原文——
 * 三份不一致里没有任何一份是错的，它们只是**不是同一份**。`cmdExec` 的注释早就写明
 * 这个文件存在的理由就是消掉这种重复，但快捷栏那份一直留在原地没搬过来。
 *
 * 判据只在这里定一次：脚本命令走 `runCmdScript`，引用谱的走 `sendByTemplate`，
 * 其余走"变量求值 → 发送"；空内容在发出前就报错（原先只有快捷栏查，命令库那边要靠 Rust 侧回一句「发送内容为空」）。
 */
export async function runCommand(
  cmd: RunnableCommand,
  ctx: Record<string, number | string> = {},
): Promise<void> {
  if (cmd.scriptEnabled && cmd.script.trim()) {
    await runCmdScript(cmd.script, ctx);
    return;
  }
  if (cmd.sendTemplateId) {
    await sendByTemplate(cmd);
    return;
  }
  if (!(cmd.template ?? "").trim()) {
    throw new Error(tx("指令内容为空", "The command has no content"));
  }
  await sendCmd(cmd.sendMode, variableStore.resolveVars(cmd.template));
}

/**
 * 控制画布上那张卡 → 一次发送。卡的值灌进卡自己记着的 `paramId`（映射存在卡上，
 * 不靠"参数叫什么名字"去猜——同名参数、改过名的参数都会让猜错变成发错字节）。
 * 没配 `paramId` 的卡（按钮卡）就发谱的默认值。
 */
export async function runSpecCard(
  card: { sendTemplateId?: string; paramId?: string },
  value?: number,
): Promise<void> {
  await runCommand({
    sendMode: "hex",
    template: "",
    script: "",
    scriptEnabled: false,
    sendTemplateId: card.sendTemplateId,
    overrides: value !== undefined && card.paramId ? { [card.paramId]: String(value) } : undefined,
  });
}

/** `ctx` 是卡片传进来的即时值（滑条 value、开关 state…），排在持久变量之后覆盖同名 */
export async function runCmdScript(
  script: string,
  ctx: Record<string, number | string>,
): Promise<void> {
  const vars = variableStore
    .listVars()
    .map((vd) => ({
      name: vd.name,
      value: variableStore.getVar(vd.name) ?? (vd.kind === "str" ? "" : 0),
    }));
  for (const [k, v] of Object.entries(ctx)) vars.push({ name: k, value: v });
  await runScript(
    script,
    {
      send: (text, mode) => sendCmd(mode ?? "ascii", String(text)),
      beep,
      delay_ms: (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.max(0, ms))),
      get: (name: string) => variableStore.getVar(name),
    },
    vars,
  );
}
