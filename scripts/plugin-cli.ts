/**
 * uartix-plugin —— 在终端里看 Uartix+ 的插件货架（P99c-C1b，只读半边）。
 *
 *   npm run build:plugin-cli && node dist-cli/uartix-plugin.cjs list
 *
 * 与 MCP 那个 CLI 的分工：**这个只发 `cli.*`，那个只发工具清单里的名字**，
 * 两边各自收窄（Q7「AI 只读不装」就是这么落的）——所以模型驱动 IDE 时够不到装包，
 * 人在终端里也拿不到装包能力（那条要等任务面）。
 * 解析与渲染在 `plugin-cli-core.ts`（可测），这里只做连接与退出码。
 */
import { bridgeCall, readEndpoint } from "./bridge-client";
import { argsFor, kindFor, parseArgs, render, USAGE } from "./plugin-cli-core";

const log = (...a: unknown[]) => console.error("[uartix-plugin]", ...a);

/** 退出码：0 成功 / 1 连不上或被拒 / 2 参数本身没法执行 */
export async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const kind = kindFor(parsed.command);
  try {
    const ep = readEndpoint();
    const data = await bridgeCall(ep, kind, argsFor(parsed), { log });
    console.log(parsed.json ? JSON.stringify(data, null, 2) : render({ parsed, data }));
    return 0;
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
