/**
 * P99a-B2：插件注册进来的工具 → 宿主 `AgentToolEntry` 的**投影层**。
 *
 * 这一层存在的意义就是"权力由宿主判"（详设 §5.3-2）：
 *  - 名字：强制 `plg_` 前缀 + 包 slug + 稳定哈希，宿主同名工具永远不被接管；
 *  - `effect / domain / mayTouchDevice`：**从包声明的 caps 与固定映射派生**，
 *    插件自报的 `effect`、`dangerous:false`、"我只是算个数"一类字段**一个都不读**；
 *  - 参数：进 worker 之前先按插件自己给的 lite schema 校一遍（宿主侧执行，不是装饰）；
 *  - 回执来源由管线盖 `src`，模型与 handler 都改不动。
 *
 * 依赖方向：agent → plugins（projection 读定义）。plugins 层不得反向 import 本文件。
 */
import { allPluginToolDefs, type PluginToolDef } from "../plugins/pluginToolDefs";
import { callPluginTool, moduleStatusOf } from "../plugins/moduleBus";
import { validateLiteArgs } from "../plugins/toolSchemaLite";
import {
  defineTool,
  notExecuted,
  pluginToolName,
  type AgentToolEntry,
  type ToolResultBody,
} from "./toolRegistry";
import type { ToolPolicyMeta } from "./toolPolicy";

/**
 * 插件工具的副作用判定。
 *
 * `config_write` 而不是 `read`：跑第三方代码不是零副作用观察——`read/analysis` 在 Operator
 * 锁下是豁免的，把插件工具标成只读等于"现场锁住了还能执行第三方 JS"。
 * `mayTouchDevice: false` 也不是给插件面子，是**事实**：worker 桥今天没有任何发送通道
 * （`uartix.host` 只有 post/rpc，宿主侧不受理任何发送请求）。**将来给 worker 接 send 时，
 * 这一行必须跟着改并过设备门**——所以它写在这里并有测试钉着（moduleBus.test §没有发送通道）。
 */
function pluginToolMeta(): ToolPolicyMeta {
  return { effect: "config_write", idempotent: false, reversible: false, mayTouchDevice: false };
}

function entryFor(def: PluginToolDef): AgentToolEntry {
  const name = pluginToolName(def.pkgId, def.baseName);
  const provenance = { kind: "plugin", pkgId: def.pkgId, version: def.version } as const;
  return defineTool({
    name,
    // 不加"插件"二字：时间线右侧另有来源徽标（B3），组件名里再标一次就是"来源两地说同一件事"
    labelZh: `${def.pkgName} · ${def.baseName}`,
    description: `[${def.pkgName} v${def.version}] ${def.description}`,
    parameters: def.parameters,
    effect: "config_write",
    domain: "plugins",
    provenance,
    assess: () => ({ meta: pluginToolMeta() }),
    summarize: () => `调用插件工具 ${def.baseName}`,
    async execute(args, ctx): Promise<ToolResultBody> {
      const callId = ctx.callId;
      const v = validateLiteArgs(def.parameters, args);
      if (!v.ok) {
        return notExecuted(callId, "invalid_tool_args", {
          tool: name,
          errors: v.errors.slice(0, 6),
          hint: "参数必须匹配这支插件工具自己声明的 parameters",
        });
      }
      const status = moduleStatusOf(def.pkgId);
      if (status !== "live") {
        return notExecuted(callId, "module_not_live", {
          pkgId: def.pkgId,
          status,
          hint: "该插件的逻辑模块当前不在线（停用/隔离/重建中）",
        });
      }
      const r = await callPluginTool(def.pkgId, def.baseName, args);
      if (!r.ok) {
        return notExecuted(callId, r.code ?? "plugin_error", { pkgId: def.pkgId, tool: def.baseName, err: r.err });
      }
      /**
       * `status:"read"` 说的是**宿主侧状态没变**这件事：插件工具只能算，碰不到宿主状态
       * （没有写通道）。它不代表插件内部无副作用——那由"启用前人工批准"那一层负责。
       */
      return { callId, ok: true, status: "read", data: r.data };
    },
  });
}

/**
 * 当前插件工具面（**每 run 起点取一次快照**，run 内不扩权）。
 * 一支坏定义不能拖垮整个 run：跳过它并出声，而不是 throw 到白屏。
 */
export function pluginToolEntries(): AgentToolEntry[] {
  const out: AgentToolEntry[] = [];
  const taken = new Set<string>();
  const skipped: string[] = [];
  for (const def of allPluginToolDefs()) {
    try {
      const e = entryFor(def);
      if (taken.has(e.name)) {
        skipped.push(`${def.pkgId}#${def.baseName}（组合名撞车）`);
        continue;
      }
      taken.add(e.name);
      out.push(e);
    } catch (err) {
      skipped.push(`${def.pkgId}#${def.baseName}（${String((err as Error)?.message ?? err).slice(0, 80)}）`);
    }
  }
  if (skipped.length) console.warn(`[pluginTools] 跳过 ${skipped.length} 支不可登记的插件工具：${skipped.join("；")}`);
  return out;
}
