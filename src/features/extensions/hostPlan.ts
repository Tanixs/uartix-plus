/**
 * P174-A3：起扩展宿主前的**参数装配**（纯函数，可单测）。
 *
 * 为什么单独一层而不是直接写在 client 里：这一层的输出就是 `ext_host_start` 的实参，
 * 错一个字段的后果是"进程起不来"或"权限参数没给上"——后者更糟，它表现为
 * "插件写文件报 EACCES"这种完全指错方向的现象。所以它必须是纯的、可断言的。
 *
 * 真正的 IPC 在 `hostClient.ts`，本文件不 import 任何 tauri 东西。
 */

import { buildHostNodeArgs, usesWorkspace, type ExtensionManifest, type PathVarBinding } from "./manifest";
import { extDir, extensionsRoot, STAGING_DIR } from "./repo";

export interface HostPlanInput {
  manifest: ExtensionManifest;
  bind: PathVarBinding;
  /** 扩展根（`<appDir>/extensions`）。`pluginDir` 由它推出，不接受调用方另给一份。 */
  appDir: string;
  /** 引导脚本路径（`<appDir>/ext-host/bootstrap.mjs`）。 */
  scriptPath: string;
  /** Node 可执行文件。空 = 未配置，直接拒（不猜系统里有没有）。 */
  nodePath: string;
  /** 一次性随机串，由调用方注入（测试里给固定值）。 */
  token: string;
}

export interface HostPlan {
  handle: string;
  nodePath: string;
  args: string[];
  scriptPath: string;
  pluginDir: string;
  cwd: string;
  token: string;
}

export class HostPlanError extends Error {
  constructor(
    message: string,
    readonly code: "no_main" | "no_node" | "no_workspace" | "bad_dir",
  ) {
    super(message);
    this.name = "HostPlanError";
  }
}

/**
 * 装配启动参数。
 *
 * 三条拒绝：
 * 1. **没有 `main`**：纯声明式插件不该起进程（详设 §5.1）。硬起一个只会白占内存。
 * 2. **没配 node**：不猜 `which node`。猜错的形态是"某个用户的机器上恰好有个旧 node"，
 *    然后插件在莫名其妙的运行时上跑出莫名其妙的行为——这种故障完全无法归因。
 * 3. **工作区根未登记，但插件声明要写 `$WS`**：命令行的 `--allow-fs-write` 会展开成空，
 *    于是插件一写就 `EACCES`。与其让它跑到那一步，不如在启动前说清楚"先去设置里选工作区"。
 */
export function planHostStart(input: HostPlanInput): HostPlan {
  const { manifest, bind, appDir, scriptPath, nodePath, token } = input;

  if (!manifest.main) {
    throw new HostPlanError("这个插件没有 main，不该起进程", "no_main");
  }
  if (!nodePath.trim()) {
    throw new HostPlanError(
      "还没指定 Node 运行时：请在设置 → 插件里选 node.exe（或安装自带运行时的版本）",
      "no_node",
    );
  }
  if (!token.trim()) {
    throw new HostPlanError("token 不能为空（它是本实例的消息护栏）", "bad_dir");
  }

  const pluginDir = extDir(appDir, manifest.id);

  // 声明了 $WS 却没有绑定：启动前就拒，别让它跑到 EACCES 再回来说"权限不足"
  if (usesWorkspace(manifest) && !bind.workspace) {
    // 指路要指对：这个开关在**扩展面板**顶上那一行，不在全局设置里
    // （全局设置里那个 `workspace` 是预设布局，同名不同义）。
    throw new HostPlanError("这个插件要用工作区（$WS），但还没选：请在「扩展」面板顶部选一个工作区目录", "no_workspace");
  }

  // 插件目录不能落在 staging 里（那是"装到一半"的地方，不该被当成已安装的包跑起来）
  if (pluginDir.includes(`/${STAGING_DIR}/`) || !pluginDir.startsWith(extensionsRoot(appDir) + "/")) {
    throw new HostPlanError(`插件目录不合法：${pluginDir}`, "bad_dir");
  }

  const args = buildHostNodeArgs(manifest, bind);

  return {
    handle: manifest.id,
    nodePath: nodePath.trim(),
    args,
    scriptPath,
    pluginDir,
    // 有工作区就用它当 cwd：插件里所有相对路径都会落在用户那个目录里，
    // 而不是落在 AppData 的插件目录里（那会让 `results.csv` 跑到用户找不到的地方）
    cwd: bind.workspace || pluginDir,
    token,
  };
}
