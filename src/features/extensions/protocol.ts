/**
 * P174-A2：宿主 ↔ 扩展子进程的线协议（JSONL over stdio）。
 *
 * 为什么先写协议再写 supervisor：这条线一旦定错，`bootstrap.mjs`、`ext_supervisor.rs`、
 * 插件的 `main.mjs` 三边都要改，而它们分属 TS / Rust / 用户代码，返工成本是三层一起返。
 * 所以先把"一条消息长什么样、多大、多久算超时、坏了怎么判"固化成一个可单测的叶子模块。
 *
 * 三条设计取舍：
 * - **一行一条 JSON**：不用长度前缀。好处是 `cat` 就能读日志、坏一行不会毁掉后面所有行；
 *   代价是消息里不能有裸换行（`encode` 负责转义，`decode` 只按行切）。
 * - **协议版本只在 hello 里对一次**：不匹配就 `refuse`，不尝试兼容。扩展是代码，
 *   版本不对的语义差异不是"少个字段"而是"调错方法"。
 * - **错误是数据不是异常**：`rpc-result` 里 `ok:false` + `code`，宿主按 code 分支；
 *   进程崩了是另一回事（`exit`），两者不能混。
 */

/** 协议版本。任何不兼容改动都必须加一，不搞"向后兼容的悄悄改"。 */
export const PROTOCOL_VERSION = 1;

/** 单条消息上限。超过就拒发/拒收，不静默截断（截断的 JSON 更危险）。 */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** 一次 rpc 的默认超时。面板交互要手感，所以比旧的 module 调用（10s）短一半。 */
export const RPC_TIMEOUT_MS = 30_000;

/** 起进程到 `ready` 的时限。超了视为启动失败，不留一个"半活"的进程。 */
export const READY_TIMEOUT_MS = 15_000;

/** 宿主 → 扩展。 */
export type HostToExt =
  /**
   * 握手。`token` 是本次实例的 nonce，后续每条消息都必须带回（防串台）。
   * `roots` 是用户登记的外部目录（`$EXT:<key>` → 绝对路径）。**可选**：老夹具不带它也必须能跑。
   */
  | { t: "hello"; v: number; token: string; workspace: string; appDir: string; dev: boolean; roots?: Record<string, string> }
  /** 让扩展执行 `activate()`。 */
  | { t: "activate"; token: string }
  /** 调用扩展注册的某个方法（来自面板的 `uartix.call` 或命令）。 */
  | { t: "call"; token: string; id: string; method: string; args: unknown }
  /** 面板侧事件（`uartix.on` 的另一端由扩展主动 emit，这里只用于宿主转发）。 */
  | { t: "panel"; token: string; panelId: string; event: string; payload: unknown }
  /** 通知扩展：有东西要变了（工作区根被改、主题切换等）。 */
  | { t: "notify"; token: string; kind: string; data: unknown }
  /** 优雅退出：先让扩展跑完 disposer，再等进程自己走。 */
  | { t: "dispose"; token: string; reason: "disable" | "uninstall" | "reload" | "idle" | "quit" };

/** 扩展 → 宿主。 */
export type ExtToHost =
  /** 握手应答。版本不一致时宿主直接 kill，不进 activate。 */
  | { t: "ready"; token: string; v: number; node: string }
  /** 一条 rpc 的结果。`ok:false` 必须带 code。 */
  | { t: "result"; token: string; id: string; ok: true; data: unknown }
  | { t: "result"; token: string; id: string; ok: false; code: string; err: string }
  /** 扩展主动推给面板（日志、进度、状态）。 */
  | { t: "emit"; token: string; panelId: string; event: string; payload: unknown }
  /** 结构化日志，宿主原样落到 `extensions/<id>/logs/`。 */
  | { t: "log"; token: string; level: "debug" | "info" | "warn" | "error"; msg: string }
  /** 注册 AI 工具（需要 `permissions.ai.registerTools`）。 */
  | { t: "tools"; token: string; tools: ExtToolDef[] }
  /** disposer 跑完了，可以杀。 */
  | { t: "disposed"; token: string };

export interface ExtToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 错误码。宿主按 code 分支（而不是按错误文本），所以这张表是**契约**：
 * 加一个码就要在宿主侧加一个分支，加文本不用。
 */
export const EXT_ERROR_CODES = [
  "bad_request", // 参数形状不对
  "not_found", // 方法/文件不存在
  "denied", // 权限（只在 SDK 层做过的事上出现，比如写目录）
  "timeout", // 扩展自己判超时并返回
  "internal", // 扩展内部异常
  "unsupported", // 版本/平台不支持
] as const;
export type ExtErrorCode = (typeof EXT_ERROR_CODES)[number];

export function isExtErrorCode(v: unknown): v is ExtErrorCode {
  return typeof v === "string" && (EXT_ERROR_CODES as readonly string[]).includes(v);
}

/** 编码一条消息成单行。超长直接抛——不截断，截断的 JSON 更危险。 */
export function encodeMessage(m: HostToExt | ExtToHost): string {
  const s = JSON.stringify(m);
  /**
   * JSON.stringify 会把 \n / \r 转义掉，所以真正能破坏分帧的是 **U+2028 / U+2029**：
   * 它们在 JSON 里是合法字符、不会被转义，但相当一部分按行切分的读取器会把它们当换行。
   * 只在"编码后真的含它们"时拒——这条检查是可被夹具触发的（见 protocol.test.ts），
   * 不是一句永远为假的保险（§4-3 永真判据的教训）。
   */
  if (/[\u2028\u2029]/.test(s)) {
    throw new Error("消息含 U+2028/U+2029：会破坏按行分帧，请改用 \\u 转义写法");
  }
  if (s.length > MAX_MESSAGE_BYTES) {
    throw new Error(`消息 ${s.length} 字节，超过 ${MAX_MESSAGE_BYTES} 上限：请改成分页或用文件传递`);
  }
  return s;
}

export interface DecodeOk {
  ok: true;
  msg: HostToExt | ExtToHost;
}
export interface DecodeFail {
  ok: false;
  code: "empty" | "not_json" | "not_object" | "no_type" | "too_large";
  detail: string;
}
export type DecodeResult = DecodeOk | DecodeFail;

/**
 * 解析一行。**不做类型收窄**（那要靠 `token` 与 `t` 的联合判定，见 `isHostToExt`）：
 * 这里只保证"是一行合法的 JSON 对象、有字符串 t、不超长"。语义校验留给调用方，
 * 因为宿主要核 token，而 token 是每次实例一个的运行时值。
 */
export function decodeMessage(line: string): DecodeResult {
  const s = line.trim();
  if (!s) return { ok: false, code: "empty", detail: "空行" };
  if (s.length > MAX_MESSAGE_BYTES) {
    return { ok: false, code: "too_large", detail: `${s.length} 字节超过上限` };
  }
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch (e) {
    return { ok: false, code: "not_json", detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, code: "not_object", detail: "不是 JSON 对象" };
  }
  const t = (v as Record<string, unknown>).t;
  if (typeof t !== "string" || !t) {
    return { ok: false, code: "no_type", detail: "缺 t 字段" };
  }
  return { ok: true, msg: v as HostToExt | ExtToHost };
}

/**
 * 判定一条已解析消息是否属于某个方向。
 *
 * 为什么要方向判定：两个方向的类型集合不重叠，但 JSON 是弱类型的——
 * 一条 `{t:"call"}` 从扩展发过来，如果宿主不看方向就会把它当成自己的指令回灌，
 * 形成"自说自话"的循环。所以**先分方向，再验 token**。
 */
const HOST_TO_EXT_TYPES = new Set(["hello", "activate", "call", "panel", "notify", "dispose"]);
const EXT_TO_HOST_TYPES = new Set(["ready", "result", "emit", "log", "tools", "disposed"]);

export function isHostToExt(m: HostToExt | ExtToHost): m is HostToExt {
  return HOST_TO_EXT_TYPES.has((m as { t: string }).t);
}

export function isExtToHost(m: HostToExt | ExtToHost): m is ExtToHost {
  return EXT_TO_HOST_TYPES.has((m as { t: string }).t);
}

/** 未知类型（可能是更新版本的扩展）：返回 false，宿主据此判 `unsupported`。 */
export function isKnownType(t: string): boolean {
  return HOST_TO_EXT_TYPES.has(t) || EXT_TO_HOST_TYPES.has(t);
}

/**
 * token 校验。**每一条消息都必须带同一个 token，包括 `ready`**——
 * 它是 `hello` 的应答，扩展必须原样回带；不回带就分不清是"这个实例在说话"还是
 * "上一个实例的残留消息"（空闲挂起后重启时，这种情况真会发生）。
 */
export function tokenMatches(msg: HostToExt | ExtToHost, token: string): boolean {
  const t = (msg as { token?: unknown }).token;
  return typeof t === "string" && t === token;
}
