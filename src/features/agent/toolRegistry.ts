/**
 * P99a-A1/A3：Agent 工具注册表与执行管线（单一能力面）。
 *
 * 为什么存在（详设 §1.2 / §3）：让一个工具被模型调用过去要同时改 13 处，其中 6 处
 * **没有任何东西在强制**——审批靠各 handler 自觉调 `decide()`（全仓只有一个调用点）、
 * 未派发的工具静默 `unknown_tool`、中文名/参数摘要/撤销路由各自一份表且类型不是穷举。
 * 直接在上面加"插件注册工具"等于把绕过审批正规化。本文件把六处静默点收成一处：
 *
 *  1. **一条 entry 描述一个工具的全部事实**：schema、中文名、授权域、副作用分类、
 *     参数摘要、撤销路由、来源。新增工具只写一条 entry，其余全部派生。
 *  2. **门禁在管线里，不在 handler 里**：`runToolCall` 负责 abort → 参数解析 →
 *     授权域 → `decide()` → 人工批准 → 执行 → 按引用裁剪。handler 只做它那件事，
 *     **拿不到 gate 对象，也没有"忘记检查"这件事可犯**。
 *  3. **发给模型的清单是白名单投影**：`modelDefinitions` 只吐 name/description/parameters，
 *     execute/labelZh/effect 等宿主字段结构上不可能漏进请求（对标 DSH `registry.schemas()`）。
 *     按域裁剪对**全部** entry 生效——旧实现只裁两组，外观与内联九支根本不进裁剪。
 *
 * 依赖纪律：本模块只依赖叶子（scopeTiers / toolPolicy / types），**不得 import 任何工具组、
 * pluginStore 或 agentAdapter**——注册表与被注册者成环就是 dev 白屏（§8-33）。
 */
import { shortHash } from "../plugins/pluginId"; // 零依赖叶子（与上面那条纪律不冲突：它不 import 任何 store）
import { DOMAIN_ZH, hasDomain, type Domain } from "./scopeTiers";
import { decide, type EffectClass, type PolicyContext, type ToolPolicyMeta } from "./toolPolicy";
import type { UndoResult } from "./settingsTools";
import type { RunScope, ToolCall, ToolDefinition, ToolProvenance, ToolReceipt, TaskContext } from "./types";

/** 工具来源。插件注册的工具必须在台账与 UI 上与宿主工具分得开（详设 §1.2 第 13 号静默点）。 */
export type { ToolProvenance } from "./types";

/** 插件工具的强制名字前缀：撞名不等于接管。 */
export const PLUGIN_TOOL_PREFIX = "plg_";

/** 一条工具名：小写下划线，3..40 字符。插件名再加前缀与包名 slug。 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,39}$/;

/**
 * handler 的返回值。`callId` **可选且必然被管线覆盖**：
 * 回执上带 callId 是渲染层与台账拼接的需要，但工具不能靠它冒充别人——
 * `runToolCall` 永远用本次调用自己的 callId 覆盖一次（有测试钉住）。
 */
export type ToolResultBody = Omit<ToolReceipt, "callId"> & { callId?: string };

/**
 * 一次任务的临时状态。工具 entry 是**模块级常量**（显示层要从它们派生），
 * 所以任何 per-run 的可变量都必须走这里，不能藏在 entry 的闭包里。
 */
export interface RunScratch {
  /** 超限回执的原文缓存（键 `call:<callId>`），只活在本任务内存里 */
  artifacts: Map<string, unknown>;
  /** 数据租约是否已申请过（plot_channels / plot_window 首调申请一次即可） */
  leaseRequested: boolean;
}

export function newRunScratch(): RunScratch {
  return { artifacts: new Map<string, unknown>(), leaseRequested: false };
}

/**
 * 交给 handler 的执行上下文。
 * 刻意**不含** gate/审批句柄与任何"绕过管线"的入口：能力要么由 handler 所在模块自己
 * 以宿主身份 import（宿主工具），要么只能经桥（插件工具，物理上没有本模块之外的能力）。
 */
export interface ToolCtx extends TaskContext {
  /** 本次调用的 callId，由 `runToolCall` 注入；回执上的 callId 仍由管线覆盖（handler 改不动） */
  callId: string;
  /** 本任务的临时状态（缓存/租约标记），不是全局单例 */
  scratch: RunScratch;
  /** 本任务冻结的授权域（`allowed` 的类型化视图） */
  allowedDomains: Domain[];
  /** 派发器已按 entry.domain 放行；只有"逐参数二次判定"才需要再调 */
  hasDomain(d: Domain): boolean;
  /** 策略上下文：deviceContext / operatorLocked 由装配方一次性求值，handler 不得各读各的 */
  policy: PolicyContext;
}

/** 批准请求（宿主实现 UI）。绑定 (runId, tool, argsHash)，参数变了就要重新批准。 */
export interface ApprovalRequest {
  id: string; runId: string; callId: string; tool: string;
  argsSummary: string; argsHash: string; effect: string; plan: string;
  createdAt: number; expiresAt: number;
}

/** 审批门：request 展示批准卡，takeToken 消费已批准令牌，reject 登记拒绝。 */
export interface ApprovalGate {
  request(req: ApprovalRequest): void;
  takeToken(runId: string, tool: string, argsHash: string, now: number): string | null;
  reject(req: ApprovalRequest): void;
}

/** 批准令牌有效期：绑定单次执行，过期重新评估（§7.4）。 */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** 参数摘要绑定：宿主端 FNV-1a（非加密，仅用于变更检测；绑定执行仍在宿主侧）。 */
export function argsHash(args: unknown): string {
  const s = JSON.stringify(args ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface AgentToolEntry {
  name: string;
  /** 发给模型的说明（英文，模型跟从度高） */
  description: string;
  parameters: Record<string, unknown>;
  /** 时间线卡片中文名——**必填**，漏了就编译期红，不再靠 `toolDisplay` 那张 `Record<string,…>` 记得住 */
  labelZh: string;
  /** 副作用分类。危险性由宿主声明，绝不读模型提交的 risk 字段（§8-35） */
  effect: EffectClass;
  /** 需要的授权域；null = 只读常发。派发器据此**既裁剪下发又拒绝调用** */
  domain: Domain | null;
  provenance: ToolProvenance;
  /** 执行体 */
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResultBody> | ToolResultBody;
  /**
   * 逐参数评估这一 call 的风险，并可先行拒绝。用途有三：
   *  - `run_app_action` 的风险在**内层 kind** 上；
   *  - `fs_write` 要 stat 之后才知道是"新建"还是"覆盖不可逆"；
   *  - `shell_exec` 的总开关关着时**不该弹批准卡**（白要一次人工确认＝把用户当橡皮图章）。
   * 返回 `refuse` 就地终止（不进审批、不跑 execute）；返回 `plan` 让评估时拿到的事实直接进批准卡
   * （fs_write 的"现有 512 字节会被替换"来自这里的 stat，planFor 拿不到）。
   * 缺省用 `defaultMeta(effect)`。
   */
  assess?: (
    args: Record<string, unknown>,
    ctx: ToolCtx,
  ) => Promise<Assessment> | Assessment;
  /** 需要人工批准时给用户看的一句话计划（详设 §7.1：目标、实际影响、差异提示）。
   *  `meta` 是 assess 刚评估出来的那一份，避免 planFor 自己再判一遍风险（两处判定就会漂）。 */
  planFor?: (args: Record<string, unknown>, meta: ToolPolicyMeta) => string;
  /** 批准卡上"要批准的是什么参数"的稳定绑定；缺省用整个 args 的哈希 */
  approvalBinding?: (args: Record<string, unknown>) => unknown;
  /**
   * 批准卡署名与令牌作用域里的"工具名"。缺省 `entry.name`；
   * `run_app_action` 必须覆盖成**内层 kind**——否则批准卡会写"执行应用动作"而不是"删除卡片"，
   * 用户批的和他实际放行的不是一个东西（P90 起的既有行为，A 批红线是不许悄悄变）。
   */
  approvalSubject?: (args: Record<string, unknown>) => string;
  /** 参数摘要；缺省时管线回退可读化兜底并**出声**（旧 `default: ""` 会静默空摘要） */
  summarize?: (args: Record<string, unknown>, truncated: boolean) => string;
  /** 撤销路径；带 undoToken 却没有这里的 entry 会在撤销时落 `unrouted_tool`（P98 口径） */
  undoRoute?: (token: string) => UndoResult;
  /** 回执 data 超限是否按引用缓存。只有 `read_artifact` 自己必须是 false——否则取回→缓存→再取回自我放大 */
  truncate?: boolean;
}

/**
 * entry 只声明 `effect` 时补齐策略元组的其余三项。
 * 今天 `decide()` 只读 `effect`，其余三项是给未来的并发/重试判定留的——所以**派生值一律取保守侧**
 * （写类不声称自己幂等/可逆，非只读类不声称"碰不到设备"），免得某天有人读它时读到一句好话。
 */
export function defaultMeta(effect: EffectClass): ToolPolicyMeta {
  const readOnly = effect === "read" || effect === "analysis";
  return { effect, idempotent: readOnly, reversible: readOnly, mayTouchDevice: !readOnly };
}

/** `assess` 的三种出口：给出风险与可选的批准计划 / 直接拒绝。 */
export type Assessment = { meta: ToolPolicyMeta; plan?: string } | { refuse: ToolResultBody };

/** defineTool 的入参：effect/domain/provenance 必填，其余可选。刻意不做默认值兜底。 */
export function defineTool(entry: AgentToolEntry): AgentToolEntry {
  if (!TOOL_NAME_RE.test(entry.name)) {
    throw new Error(`工具名不合法：${JSON.stringify(entry.name)}（要求 ${TOOL_NAME_RE.source}）`);
  }
  if (!entry.labelZh.trim()) throw new Error(`工具 ${entry.name} 缺少中文显示名`);
  if (!entry.description.trim()) throw new Error(`工具 ${entry.name} 缺少发给模型的说明`);
  if (!entry.parameters || entry.parameters.type !== "object") {
    throw new Error(`工具 ${entry.name} 的 parameters 必须是 type:"object" 的 JSON Schema`);
  }
  return Object.freeze({ ...entry, truncate: entry.truncate ?? true });
}

/**
 * 插件工具的组合名：`plg_<包名slug>_<裸名>_<稳定短哈希>`。宿主同名工具永远不被接管。
 *
 * 为什么补那 4 位哈希（旧实现没有）：slug 与裸名都要截断才能满足 `TOOL_NAME_RE` 的 40 字符上限，
 * 而截断会让两个长名字撞成同一支工具——撞上的后果是"注册时同名校验把它当第二支拒掉"或更糟的
 * "换包了却没换名，读到了别人的实现"。哈希取自 `pkgId#rawName` 全量，所以截断不再损失区分度
 * （与 `pluginId.shortHash` 同一条路子，P92 D2 的教训）。
 */
export function pluginToolName(pkgId: string, rawName: string): string {
  const slug = pkgId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 12);
  const base = (rawName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 18)) || "tool";
  const tag = shortHash(`${pkgId}#${rawName}`).slice(0, 4);
  return `${PLUGIN_TOOL_PREFIX}${slug || "pkg"}_${base}_${tag}`;
}

export interface ToolRegistry {
  /** 全部 entry（注册顺序，稳定） */
  list(): readonly AgentToolEntry[];
  byName(name: string): AgentToolEntry | undefined;
  /** 发给模型的投影 + 按授权域裁剪（白名单字段，宿主字段不可能泄漏） */
  modelDefinitions(scope: RunScope, allowed: readonly string[]): ToolDefinition[];
  /** 不裁剪的全量投影：给"只挂一组工具"的独立适配器与 MCP 用（它们各有自己的授权口径） */
  definitions(): ToolDefinition[];
  /** 本任务实际可见的工具名（自省与快照注入用；C1 的 app_catalog 同源） */
  visibleNames(scope: RunScope, allowed: readonly string[]): string[];
}

/** 域裁剪的唯一实现：entry.domain 为 null 恒发，否则看授权。派发器与投影共用，杜绝"看得见却调不动"。 */
function permitted(entry: AgentToolEntry, scope: RunScope, allowed: readonly string[]): boolean {
  return !entry.domain || hasDomain(scope, allowed, entry.domain);
}

/**
 * 建注册表。同名直接抛——静默覆盖等于给"插件劫持宿主工具"开门，
 * 也让两份 defs 撞车时无人知晓（旧实现靠 if 链顺序碰运气）。
 */
export function createToolRegistry(entries: readonly AgentToolEntry[]): ToolRegistry {
  const byName = new Map<string, AgentToolEntry>();
  for (const e of entries) {
    if (byName.has(e.name)) throw new Error(`工具重名：${e.name}（后注册者不会静默顶掉先注册者，必须显式改）`);
    byName.set(e.name, e);
  }
  const frozen = Object.freeze([...entries]);
  const project = (e: AgentToolEntry) => ({ name: e.name, description: e.description, parameters: e.parameters });
  return {
    list: () => frozen,
    byName: (name) => byName.get(name),
    modelDefinitions: (scope, allowed) => frozen.filter((e) => permitted(e, scope, allowed)).map(project),
    definitions: () => frozen.map(project),
    visibleNames: (scope, allowed) => frozen.filter((e) => permitted(e, scope, allowed)).map((e) => e.name),
  };
}

/** 管线的宿主侧挂钩：裁剪出口与审批门。注册表本身不认识 UI。 */
export interface PipelineHooks {
  /** 大回执 data 的按引用裁剪（A7：超限必须留得下"这里原本有内容"） */
  truncate(receipt: ToolReceipt): ToolReceipt;
  gate: ApprovalGate;
  /** 宿主时钟注入，测试可换 */
  now(): number;
  /** 批准请求的 id（默认 crypto.randomUUID，测试可注入定值） */
  newRequestId(): string;
}

/**
 * 域门拒绝的**唯一出口**，文案与码都按档位分岔：
 *  - 仅预览档 → `preview_only`：这一档**根本不含任何域**，对用户可操作的下一步是"换档位"，
 *    说"你没勾域"是误导（手工档才有勾选可言）。旧实现同码，P98 之前的 `general_tool_requires_custom`
 *    也归到这里；
 *  - 手工/其它档 → `unauthorized_scope`：确实是勾选项里少了这一域。
 * 旧实现另有一种 `preview_only`/`general_tool_requires_custom` 并存的写法（同一事实两个码），
 * 现在收敛成一条：域门只回这两个码，策略判定要批准另说。
 */
function deniedDomain(entry: AgentToolEntry, scope: RunScope, callId: string): ToolReceipt {
  const dom = entry.domain ? DOMAIN_ZH[entry.domain] : "";
  return notExecuted(callId, scope === "preview" ? "preview_only" : "unauthorized_scope", {
    tool: entry.name,
    hint:
      scope === "preview"
        ? `当前档位为仅预览，不含「${dom}」授权域；换更高档位才能用「${entry.labelZh}」`
        : `当前档位未勾选「${dom}」授权域；改选更高档位或手工勾上这一项`,
  });
}

/** 把 TaskContext 装配成 ToolCtx。`policy` 由装配方给——只有它认识串口/Operator store，
 *  注册表必须保持叶子（在这里 import store 就是把环写进求值期，§8-33）。 */
export function buildToolCtx(t: TaskContext, policy: PolicyContext, scratch: RunScratch): ToolCtx {
  return {
    ...t,
    callId: "",
    scratch,
    allowedDomains: (t.allowed ?? []) as Domain[],
    hasDomain: (d) => hasDomain(t.scope, t.allowed ?? [], d),
    policy,
  };
}

/** 未登记摘要时的兜底名：snake_case → 空格分词（时间线里不再出现裸常量） */
export function readableToolName(name: string): string {
  return name.replace(/_/g, " ").trim();
}

/** 工具中文名：注册表派生（取代 `toolDisplay.TOOL_LABEL` 那张无编译期强制的表）。 */
export function toolLabelOf(entry: AgentToolEntry | undefined, name: string): string {
  return entry?.labelZh ?? readableToolName(name);
}

/**
 * 「没执行」的统一回执形状。以前 generalTools / appearanceTools / localEntries / uiTools
 * 各抄一份（第四份差点是插件投影），字段形状就有两份说法（§8-36①）——收在这里。
 * 返回 `ToolReceipt`（不是 `ToolResultBody`）：管线内的早退要能直接当完整回执用。
 */
export function notExecuted(callId: string, code: string, data?: unknown): ToolReceipt {
  return { callId, ok: false, status: "not_executed", code, ...(data !== undefined ? { data } : {}) };
}

/**
 * **执行管线**：abort → 授权域 → 副作用策略 → 人工批准 → 执行 → 裁剪 → 盖来源。
 *
 * 这里就是"忘记检查"不再可能的那一处：handler 看不到 gate，也拿不到 not_executed 之外的
 * 拒绝通道；反过来 handler 想跳过批准也没有入口。
 */
export async function runToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolCtx,
  hooks: PipelineHooks,
): Promise<ToolReceipt> {
  const receipt = await dispatchToolCall(registry, call, ctx, hooks);
  // 来源由管线盖：handler 与模型都改不动它。查不到 entry（unknown_tool）时算宿主产生——
  // 那条回执确实是宿主发的，说清"谁回的"比说清"谁被调"更要紧。
  return { ...receipt, src: receipt.src ?? registry.byName(call.name)?.provenance ?? { kind: "host" } };
}

async function dispatchToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolCtx,
  hooks: PipelineHooks,
): Promise<ToolReceipt> {
  if (ctx.signal.aborted) return notExecuted(call.callId, "cancelled");
  const entry = registry.byName(call.name);
  if (!entry) {
    /**
     * P99a-F3：`plg_` 开头的名字查不到，绝大多数情况不是"名字打错"，而是**这条规则**的现场——
     * 工具面在任务开始时冻结，中途启用的插件包这一轮看不见（详设 §4.5-2「自扩展不等于自提权」）。
     * 以前这里一律回裸 `unknown_tool`，等于把"设计如此"误诊成"这工具不存在"，模型于是去重命名重试、
     * 用户于是以为注册没生效。名字带前缀就给这一条专属码，其余仍走 `unknown_tool`。
     */
    if (call.name.startsWith(PLUGIN_TOOL_PREFIX)) {
      return notExecuted(call.callId, "tool_frozen_for_this_run", {
        tool: call.name,
        hint: "本任务的工具清单在任务开始时冻结：中途启用的插件包要到下一个任务才看得见；中途停用/卸载的包，它的工具仍在本轮清单里但会回「插件模块未在线」。",
      });
    }
    return notExecuted(call.callId, "unknown_tool", { tool: call.name });
  }

  if (!permitted(entry, ctx.scope, ctx.allowed ?? [])) {
    return deniedDomain(entry, ctx.scope, call.callId);
  }

  let args: Record<string, unknown> = {};
  if (call.arguments && call.arguments.trim()) {
    try {
      const v = JSON.parse(call.arguments) as unknown;
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        return notExecuted(call.callId, "invalid_json", { hint: "参数必须是一个 JSON 对象" });
      }
      args = v as Record<string, unknown>;
    } catch {
      return notExecuted(call.callId, "invalid_json");
    }
  }

  const execCtx = { ...ctx, callId: call.callId };
  const assessed = entry.assess ? await entry.assess(args, execCtx) : { meta: defaultMeta(entry.effect) };
  if ("refuse" in assessed) return { ...assessed.refuse, callId: call.callId };
  const meta: ToolPolicyMeta = assessed.meta;
  if (meta) {
    // 声明了自己授权域的写工具，**域门就是它的写许可**（上面 permitted() 已核验通过）；
    // 未声明域的（run_app_action 这类目标由参数决定的）继续按 key 逐项判。
    // 不这样会在域门之上再叠一道 `config` 判定：两套词汇判同一件事，勾了「界面深改」却因没勾
    // 「配置写入」被要批准——那是新增摩擦，不是修 bug。
    const policy: PolicyContext = entry.domain ? { ...ctx.policy, authorized: () => true } : ctx.policy;
    const decision = decide(meta, policy);
    if (decision === "deny") {
      return notExecuted(call.callId, "denied_by_policy", { tool: entry.name, effect: meta.effect, hint: "Operator 锁生效或策略禁止" });
    }
    if (decision === "preview_only") {
      return notExecuted(call.callId, "preview_only", { tool: entry.name, hint: `当前档位为仅预览：${entry.labelZh}不会改动工作区` });
    }
    if (decision === "require_local_approval") {
      const hash = argsHash(entry.approvalBinding ? entry.approvalBinding(args) : args);
      const subject = entry.approvalSubject ? entry.approvalSubject(args) : entry.name;
      const now = hooks.now();
      if (!hooks.gate.takeToken(ctx.runId, subject, hash, now)) {
        hooks.gate.request({
          id: hooks.newRequestId(),
          runId: ctx.runId,
          callId: call.callId,
          tool: subject,
          argsSummary: JSON.stringify(args).slice(0, 600),
          argsHash: hash,
          effect: meta.effect,
          plan: assessed.plan
            ?? (entry.planFor ? entry.planFor(args, meta) : `${entry.labelZh}（${meta.effect}）需要你确认后才会执行`),
          createdAt: now,
          expiresAt: now + APPROVAL_TTL_MS,
        });
        return notExecuted(call.callId, "needs_local_approval", {
          tool: entry.name,
          effect: meta.effect,
          hint: "等待用户在任务卡批准；批准后用相同参数重试",
        });
      }
    }
  }

  let receipt: ToolReceipt;
  try {
    const body = await entry.execute(args, execCtx);
    receipt = { ...body, callId: call.callId };
  } catch (e) {
    // 抛出来不等于"没发生"：至少留一条可读失败，不再静默吞（P94 口径）
    console.warn("[toolRegistry] 工具执行抛错", entry.name, e);
    receipt = { callId: call.callId, ok: false, status: "error", code: "tool_threw", data: { msg: String(e instanceof Error ? e.message : e) } };
  }
  return entry.truncate === false ? receipt : hooks.truncate(receipt);
}

/**
 * 用一组 entry 现搭一个 TaskAdapter——让"只挂设置四工具"的旧调用方（MCP、loop 测试）
 * 走**同一条管线**，而不是给它们留一条不带门的第二执行路径。
 */
export function adapterFromEntries(
  entries: readonly AgentToolEntry[],
  hooks: PipelineHooks,
  makeCtx: (t: TaskContext) => ToolCtx,
): { registry: ToolRegistry; definitions: ToolDefinition[]; execute(call: ToolCall, ctx: TaskContext): Promise<ToolReceipt> } {
  const registry = createToolRegistry(entries);
  return {
    registry,
    definitions: registry.definitions(),
    async execute(call, ctx) {
      return runToolCall(registry, call, makeCtx(ctx), hooks);
    },
  };
}
