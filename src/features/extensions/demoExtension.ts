/**
 * P174-A5：内置示例扩展。
 *
 * 存在理由：这一批要打通"面板 → 进程 → 日志"的竖线，而装包流程（staging / zip / 批准卡）
 * 还没做。与其等，不如先放一个**写死的**示例——它同时充当"新格式长什么样"的活文档，
 * 用户第一次打开面板看到的那条心跳，就是这套东西真的能跑的证据。
 *
 * 它不装任何权限：没有 fs、没有 process、没有 net。所以它不会弹批准卡，
 * 也不该弹——**能跑起来的最小集合本来就不需要特权**。
 */

import { validateExtension, type ExtensionManifest } from "./manifest";

export const DEMO_EXT_ID = "uartix.demo.host";

const RAW = {
  format: "uartix-extension",
  schemaVersion: 3,
  id: DEMO_EXT_ID,
  version: "1.0.0",
  name: "宿主自检",
  description: "每 2 秒打一条心跳，用来验证扩展宿主真的在跑",
  author: "uartix",
  main: "main.mjs",
  activation: ["onPanel:host-demo"],
  permissions: {},
  contributes: { panels: [] },
};

/** 示例清单（过一遍真校验器：示例自己都不合法，就没有说服力）。 */
export function demoManifest(): ExtensionManifest {
  const r = validateExtension(RAW);
  if (!r.ok) throw new Error(`内置示例清单不合法：${r.errors.join("；")}`);
  return r.manifest!;
}

/**
 * 示例插件的 `main.mjs`。
 *
 * 两件事刻意做出来：
 * 1. `ctx.workspace` 打出来——验证宿主把工作区传进来了（空说明没配，也是有用信息）；
 * 2. `onDispose` 里打一行"再见"——**面板关掉后日志里能看到它**，才说明 disposer 真的跑了。
 */
export const DEMO_MAIN = [
  "let timer = null;",
  "let n = 0;",
  "export async function activate(ctx) {",
  '  ctx.log.info("宿主已连接；工作区 = " + (ctx.workspace || "(未配置)"));',
  "  timer = setInterval(() => {",
  "    n += 1;",
  '    ctx.log.info("心跳 " + n);',
  "  }, 2000);",
  "  ctx.onDispose(() => {",
  "    if (timer) clearInterval(timer);",
  '    ctx.log.info("已停止：共 " + n + " 次心跳");',
  "  });",
  "}",
].join("\n");
