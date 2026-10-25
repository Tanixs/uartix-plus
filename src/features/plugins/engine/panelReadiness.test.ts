/**
 * P174-R6：面板的调用要**等到宿主真的就绪**，不是"没在跑就报错"。
 *
 * 用户报的形状是「在插件管理里点了启用，面板还是用不了，得回详情页再按一次启动」。
 * 成因不在启用判据，而在**时序**：面板挂载会自己拉起宿主，而 iframe 的 HTML 一进来就发
 * 第一句 `state` —— 那时进程还在 spawn/握手，`callExt` 如实拒绝"还没在运行"，
 * 而这类面板只在启动时读一次状态，于是错误就一直挂在屏幕上。
 *
 * 这里钉的是"补了等待、没顺手拆门"：
 *  1. 面板的 req 分支先 `ensureRunning` 再 `callExt`（顺序反了等于没修）；
 *  2. `callExt` 自己那判"不在运行就拒"必须还在——等待只加在调用方，
 *     不能把它改成"随便什么时候发都行"，否则未启动的插件会被 RPC 拖起来；
 *  3. `ensureRunning` 走 `start()`，启用/批准那两道门仍在那里面（等待不是豁免）。
 */

import { describe, expect, it } from "vitest";
import { readinessAction } from "./runtime";

// 读源码而不是 import：pluginEngine.ts 一被 import 就要拉 Tauri 的 invoke。
const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const here = dirname(fileURLToPath(import.meta.url));
const engineSrc = readFileSync(join(here, "pluginEngine.ts"), "utf8");
const panelSrc = readFileSync(join(here, "PluginViewPanel.tsx"), "utf8");

describe("面板调用等宿主就绪", () => {
  it("引擎导出 ensureRunning，且它把活儿交给 start（启用与批准的门仍在里面）", () => {
    expect(engineSrc).toContain("export async function ensureRunning");
    const body = engineSrc.slice(engineSrc.indexOf("export async function ensureRunning"), engineSrc.indexOf("export async function runCommand"));
    expect(body).toContain("await start(id)");
    expect(body).toContain("await waitForRunning(id");
  });

  it("面板的 req 分支：先等就绪，再调方法（顺序反了就是原 bug）", () => {
    const waitAt = panelSrc.indexOf("await ensureRunning(pluginId)");
    const callAt = panelSrc.indexOf("callExt(pluginId,");
    expect(waitAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect(waitAt).toBeLessThan(callAt);
  });

  it("等待不拆门：callExt 仍拒绝未运行的插件，start 仍拦未启用与未批准", () => {
    expect(engineSrc).toContain('if (e.phase !== "running")');
    expect(engineSrc).toContain("这个插件还没启用");
    expect(engineSrc).toContain('if (cur.verdict !== "trusted")');
  });

  it("命令与面板共用同一条就绪路径（不留两份各写各的等待）", () => {
    const runCmd = engineSrc.slice(engineSrc.indexOf("export async function runCommand"));
    expect(runCmd).toContain("await ensureRunning(pluginId)");
    expect(runCmd).not.toContain("waitForRunning");
  });

  it("starting 只等不起第二个进程；running 直接放行", () => {
    expect(readinessAction("starting")).toBe("wait");
    expect(readinessAction("running")).toBe("none");
    expect(readinessAction("stopped")).toBe("start");
  });
});
