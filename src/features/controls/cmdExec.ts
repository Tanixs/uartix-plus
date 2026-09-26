import type { SendMode } from "./controlsStore";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "./variableStore";
import { beep, runScript } from "./scriptRunner";

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
