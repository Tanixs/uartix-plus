/**
 * P174-R7②：宿主进程日志**落盘**。
 *
 * 这件事在仓库里欠了很久：`repo.logsDir()` 从 A2 起就声明了 `plugins/<id>/logs`，
 * 但**没有任何一行代码往里写过东西**（当时全仓库只有它自己的测试引用它）。后果不是"少个文件"，
 * 是这一面只能看见内存环形缓冲那 500 行——重启之后，"上次到底崩在哪一步"就没了，
 * 而那正是用户会来问"为什么用不了"的现场。
 *
 * 三条刻意的取舍：
 *  1. **不是实时 tail**，是把环形缓冲里没写过的部分追加过去。写一次要过一次 IPC，
 *     训练日志每行一发会把主线程点在 IPC 上；攒 2 秒（或停进程时）一次性写，行序不变。
 *  2. **追加而不是覆盖**，上限从头部截（判据在 `outputModel.appendLogFile`）。覆盖的写法
 *     等于"日志等于现在的内存缓冲"，那这份文件就没有存在的理由。
 *  3. **写失败不许影响任何东西**：日志是给人看的旁证，回滚一次成功的启动才是荒唐事。
 *     失败只留一句，下一次 flush 会连着新行一起再试。
 */

import { invoke } from "@tauri-apps/api/core";
import { pluginDir, pluginsRoot } from "./repo";
import { logBatchText, LOG_CAP_BYTES } from "./outputModel";
import type { PluginLogLine } from "./runtime";

/** 攒行窗口。比"每行一写"省两个数量级的 IPC，又短到不至于让人错过崩溃现场。 */
const FLUSH_DEBOUNCE_MS = 2000;

const timers = new Map<string, number>();
/** 每个插件"已经写到盘上的行数"游标：内存缓冲是环形，游标只追平最新一段即可。 */
const pending = new Map<string, PluginLogLine[]>();
const failures = new Map<string, string>();

export function logsFilePath(appDir: string, id: string): string {
  return `${pluginDir(appDir, id)}/logs/host.log`;
}

export function logsFileDir(appDir: string, id: string): string {
  return `${pluginDir(appDir, id)}/logs`;
}

/** 最近一次落盘失败的话；「运行日志」把它显示在顶上，别让文件默默停在半路。 */
export function logWriteIssue(id: string): string {
  return failures.get(id) ?? "";
}

export function logWriteIssues(): [string, string][] {
  return [...failures.entries()];
}

/** 来了一行：记账 + 重排定时器。停进程/退出走 `flushNow`，不等这个窗口。 */
export function scheduleFlush(id: string, line: PluginLogLine): void {
  const cur = pending.get(id) ?? [];
  cur.push(line);
  pending.set(id, cur);
  const old = timers.get(id);
  if (old) window.clearTimeout(old);
  timers.set(id, window.setTimeout(() => void flushNow(id), FLUSH_DEBOUNCE_MS));
}

/**
 * 立刻把攒下的行追加进去（轮转在 Rust 那一侧：从头部截、只断在换行）。
 *
 * 先摘走再写：写期间又来一行是常态（训练正在输出），若在写完才清，那一行会被清掉而丢。
 * 空批不碰磁盘——"打开面板就写出一个空文件"是多余的痕迹。
 */
export async function flushNow(id: string): Promise<void> {
  const t = timers.get(id);
  if (t) {
    window.clearTimeout(t);
    timers.delete(id);
  }
  const lines = pending.get(id);
  if (!lines || !lines.length) return;
  pending.delete(id);
  const appDir = resolveAppDir();
  if (!appDir) return;
  const batch = logBatchText(lines);
  if (!batch) return;
  try {
    await invoke("plugin_fs_append", {
      path: logsFilePath(appDir, id),
      content: batch,
      roots: [pluginsRoot(appDir)],
      maxBytes: LOG_CAP_BYTES,
    });
    failures.delete(id);
  } catch (e) {
    // 这批不重试：留着就等于"游标永远追不上"，越积越大。记一句失败，
    // 让「运行日志」说清楚盘上缺了哪一段——内存里的那份仍然完整。
    failures.set(id, `${id} 的日志落盘失败：${String((e as Error)?.message ?? e)}`);
  }
}

/** 停/卸载/退出时收尾：写完并把这个插件的记账清干净。 */
export async function closeOut(id: string): Promise<void> {
  await flushNow(id);
  pending.delete(id);
}

/**
 * `appDir` 由调用方（引擎）注册一个取值函数：这一层不自己 invoke、也不在模块求值期摸引擎，
 * 才能在 vitest 里被直接驱动（`plugin_paths` 在测试环境里根本不存在）。
 */
let resolveAppDir: () => string = () => "";
export function setLogsRootResolver(fn: () => string): void {
  resolveAppDir = fn;
}
