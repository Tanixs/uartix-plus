import type { SendMode } from "./controlsStore";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "./variableStore";
import { beep, runScript } from "./scriptRunner";
import { tx } from "../../i18n/strings";

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
}

/**
 * P121-A：**点击一条命令**的唯一执行入口。
 *
 * 之前这里有两份：命令库点 → `resolveVars(template)` 后发；控制台快捷栏点 → 直接发原文。
 * 同一条 `SPD:{speed}` 在两个入口发出的字节不一样，而悬浮提示显示的又是原文——
 * 三份不一致里没有任何一份是错的，它们只是**不是同一份**。`cmdExec` 的注释早就写明
 * 这个文件存在的理由就是消掉这种重复，但快捷栏那份一直留在原地没搬过来。
 *
 * 判据只在这里定一次：脚本命令走 `runCmdScript`，其余走"变量求值 → 发送"；
 * 空内容在发出前就报错（原先只有快捷栏查，命令库那边要靠 Rust 侧回一句「发送内容为空」）。
 */
export async function runCommand(
  cmd: RunnableCommand,
  ctx: Record<string, number | string> = {},
): Promise<void> {
  if (cmd.scriptEnabled && cmd.script.trim()) {
    await runCmdScript(cmd.script, ctx);
    return;
  }
  if (!(cmd.template ?? "").trim()) {
    throw new Error(tx("指令内容为空", "The command has no content"));
  }
  await sendCmd(cmd.sendMode, variableStore.resolveVars(cmd.template));
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
