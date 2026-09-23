/**
 * uartix-plugin —— 在终端里看与装 Uartix+ 的插件货架（P99c-C1b/C1c），外加一条离线的投稿自检（P99b-N6）。
 *
 *   npm run build:plugin-cli && node dist-cli/uartix-plugin.cjs list
 *
 * 与 MCP 那个 CLI 的分工：**这个只发 `cli.*`，那个只发工具清单里的名字**，
 * 两边各自收窄（Q7「外来代码进本机由人批准」就是这么落的）——所以模型驱动 IDE 时够不到货架这条链。
 * 唯一的例外是 `validate`：它**压根不发桥**，在本机读文件跑校验器（不连应用、不联网、不读设置）。
 * 装包是**异步**的：`install` 起一次请求拿 token，然后按 token 轮 `cli.plugin_status`；
 * 一次调用绝不代替应用等几十秒（桥只等 3 秒，等到超时就成了"CLI 说超时、应用还在装"的悬案）。
 * 解析、判据与渲染都在 `plugin-cli-core.ts`（可测），这里只做连接、循环与退出码。
 */
import { bridgeCall, readEndpoint } from "./bridge-client";
import {
  argsFor,
  isLocalCommand,
  kindFor,
  parseArgs,
  pollVerdict,
  progressArgs,
  render,
  waitedOutLine,
  type Parsed,
  USAGE,
} from "./plugin-cli-core";

const log = (...a: unknown[]) => console.error("[uartix-plugin]", ...a);
/** 轮一次的间隔：明显小于人感的"卡住"，也不至于把本地 socket 打满 */
const POLL_MS = 700;
type Bridge = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 退出码：0 成功（含"还在跑，这是如实回答"）/ 1 连不上、被拒或没装上 / 2 参数本身没法执行 */
export async function run(argv: string[]): Promise<number> {
  let parsed: Parsed;
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
  // 本地命令排在读 endpoint 之前：`validate` 的整个卖点就是"不用开应用、不联网"
  if (isLocalCommand(parsed.command)) {
    if (parsed.command === "validate") return await validateFlow(parsed);
    log(`本地命令还没实现：${parsed.command}`);
    return 2;
  }
  const kind = kindFor(parsed.command);
  try {
    const ep = readEndpoint();
    if (parsed.command !== "install") {
      const data = (await bridgeCall(ep, kind, argsFor(parsed), { log })) as Bridge;
      console.log(parsed.json ? JSON.stringify(data, null, 2) : render({ parsed, data }));
      // progress 单独问一次时，终态没装上就回非零；还在跑是**有效回答**，不是错误
      return parsed.command === "progress" ? pollVerdict(data).exit : 0;
    }
    return await installFlow(ep, parsed);
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

/** 本地分支：投稿前自检。规则一条都不在这儿——全在 `marketValidate` 调的那几道生产校验器里。 */
async function validateFlow(parsed: Parsed): Promise<number> {
  const { validateSubmission, renderValidate } = await import("./marketValidate.mjs");
  const r = validateSubmission(parsed.id) as {
    ok: boolean; problems: string[]; warnings: string[]; ran: string[]; skipped: string[];
  };
  console.log(parsed.json ? JSON.stringify(r, null, 2) : renderValidate(r));
  return r.ok ? 0 : 1;
}

/** install：起请求 → 轮状态 → 打终态。全过程只有一个结论来源，就是应用侧给的 phase。 */
async function installFlow(ep: ReturnType<typeof readEndpoint>, parsed: Parsed): Promise<number> {
  const started = (await bridgeCall(ep, kindFor("install"), argsFor(parsed), { log })) as Bridge;
  if (parsed.json) console.log(JSON.stringify({ started }, null, 2));
  else console.log(render({ parsed, data: started }));
  if (started.ok !== true) return 1;
  const token = typeof started.token === "string" ? started.token : "";
  if (!token) return 1;

  const deadline = Date.now() + parsed.wait * 1000;
  for (;;) {
    const st = (await bridgeCall(ep, "cli.plugin_status", progressArgs(token), { log })) as Bridge;
    const v = pollVerdict(st);
    if (v.settled) {
      if (parsed.json) console.log(JSON.stringify({ started, final: st }, null, 2));
      else console.log(v.line);
      return v.exit;
    }
    if (!parsed.json) log(String(st.phaseText || "还在应用里跑"));
    if (Date.now() >= deadline) {
      if (!parsed.json) console.log(waitedOutLine(token, parsed.wait));
      else console.log(JSON.stringify({ started, final: st, waitedOut: true }, null, 2));
      return 1;
    }
    await sleep(POLL_MS);
  }
}

void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
