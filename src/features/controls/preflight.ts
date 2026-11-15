/**
 * S4 · 模板变量预检（发送前的唯一一道拦截）。
 *
 * 病灶：`resolveVars` 取不到变量时把 `{速度:d}` **原样**返回，于是模板被当字面量
 * 发出去（体检报告 §5 的 UDP `SPD:{速度:d}!` 15B）。这里在"求值之前"先问一次
 * 模板里有没有取不到值的变量，按 §5 的口径处理：
 *
 *  - ASCII：拦截 + 点名 + 5 秒内可点「仍要发送」；超时不点 = 放弃本次；
 *  - HEX：一律拦截（缺失会发出 `7B E9 80 9F…` 这类垃圾字节，比不发更危险）；
 *  - 批量：短窗口内多条被拦只汇总一次，不逐条弹窗；
 *  - 同一轮：序列器 / 脚本 / 编排器传入 `scope`，用户点过「仍要发送」后，
 *    该轮内相同模板不再反复询问（换一轮/换模板仍会问）；
 *  - 每次真正被拦都进控制台发送日志（时间 / 来源 / 模板 / 缺失变量）。
 *
 * 只做判定与提示，不碰 `resolveVars`：能取到值时这里返回 `ok`，调用方照旧求值发送，
 * 格式化说明符（`d` / `.Nf` / 整数位 / `str`）一个字节都不改。
 */

import * as variableStore from "./variableStore";
import { note } from "../console/noteBus";
import { toast } from "../../shared/toast";
import { tx } from "../../i18n/strings";

type SendMode = "ascii" | "hex";

export interface BlockedEntry {
  at: number;
  /** "卡名(cardId)" 或命令名；调用方没给时写「未命名」 */
  source: string;
  template: string;
  mode: SendMode;
  missing: string[];
  reason: "hex" | "declined" | "timeout" | "batch";
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: BlockedEntry["reason"]; missing: string[] };

/** 与 `resolveVars` 同一个正则：只有这一份"什么算占位"的判据 */
const MARKER = /\{([^{}]+)\}/g;
/** 只把"像变量名"的 marker 当候选：排除 `{"cmd":1}` / `{"a":[1,2]}` 这类故意发送的 JSON 字面量 */
const PLAUSIBLE = /^[^"',\s{}]+(:[^"',\s{}]+)?$/;
const PROMPT_MS = 5000;
/** 最后一条进批后多久汇总（等同一轮里的其它发送落定） */
const BATCH_FLUSH_MS = 400;
/** 同一条 HEX 拦截的 toast 去重窗口（连续拖动/高频发送不刷屏） */
const ADVISE_MS = 3000;
/** 环形缓冲上限：只够现场排查，不做长期归档 */
const LOG_CAP = 200;

const blocked: BlockedEntry[] = [];

/** 供测试与事后排查：最近 200 条被拦记录（浅拷贝，调用方改不到内部表） */
export function getBlockedLog(): readonly BlockedEntry[] {
  return blocked.slice();
}

/** 模板里的变量名（与出现顺序一致，重复只留一次） */
export function templateVarNames(tpl: string): string[] {
  if (!tpl.includes("{")) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of tpl.matchAll(MARKER)) {
    const expr = (m[1] ?? "").trim();
    if (!PLAUSIBLE.test(expr)) continue;
    const name = expr.split(":")[0].trim();
    if (!name || name.length > 32 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function notReady(v: number | string | undefined): boolean {
  if (v === undefined) return true;
  if (typeof v === "number") return !Number.isFinite(v);
  return v.trim() === "";
}

export type GetVar = (name: string) => number | string | undefined;

/** 取不到值的变量（按出现顺序，重复只报一次）。
 *  `getVar` 让编排器把「编排变量优先、控制变量兜底」的同一套取值接进来，
 *  不另写一份判定。 */
export function missingTemplateVars(tpl: string, getVar: GetVar = variableStore.getVar): string[] {
  return templateVarNames(tpl).filter((name) => notReady(getVar(name)));
}

/* ---------------- 提示适配器（生产 = DOM；单测注入） ---------------- */

type PromptAccept = () => void;
interface PromptHandle {
  close(): void;
}
type PromptShow = (message: string, accept: PromptAccept) => PromptHandle;

let promptAdapter: PromptShow | null = null;

/** 替换提示实现。单测用（node 环境没有 DOM）；传 null 恢复默认 DOM 提示。 */
export function setPreflightPrompt(show: PromptShow | null): void {
  promptAdapter = show;
}

function ensureHost(): HTMLElement {
  let host = document.querySelector<HTMLElement>(".ctl-pf-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "ctl-pf-host";
    document.body.appendChild(host);
  }
  return host;
}

function domPrompt(message: string, accept: PromptAccept): PromptHandle {
  if (typeof document === "undefined") return { close: () => {} };
  const el = document.createElement("div");
  el.className = "ctl-pf";
  el.setAttribute("role", "alert");
  el.setAttribute("aria-live", "assertive");

  const text = document.createElement("span");
  text.className = "ctl-pf-msg";
  text.textContent = message;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ctl-pf-btn";
  btn.textContent = tx("仍要发送", "Send anyway");
  btn.addEventListener("click", accept);

  el.append(text, btn);
  ensureHost().appendChild(el);
  return {
    close: () => {
      el.remove();
      if (!document.querySelector(".ctl-pf")) {
        document.querySelector(".ctl-pf-host")?.remove();
      }
    },
  };
}

/* ---------------- 提示 / 批量状态 ---------------- */

interface Active {
  key: string;
  entry: BlockedEntry;
  promise: Promise<PreflightResult>;
  finish(reason: "allow" | "timeout" | "batch"): void;
}

let active: Active | null = null;

interface Batch {
  count: number;
  names: string[];
  nameSet: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

let batch: Batch | null = null;

const advised = new Map<string, number>();

/** 同一轮内的放行记录：`scope\0mode\0模板\0缺失集` → 时间。
 *  只在用户点「仍要发送」后写入；有上限，防止长时间运行累积。 */
const grants = new Map<string, number>();
const GRANT_CAP = 500;

function grantKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

/** 结束一轮（运行结束/脚本退出）：丢弃该轮的放行记录。
 *  不调用也不会出错，只是把记录留到上限淘汰。 */
export function endPreflightScope(scope: string): void {
  const prefix = `${scope}\u0000`;
  for (const k of [...grants.keys()]) {
    if (k.startsWith(prefix)) grants.delete(k);
  }
}

function rememberGrant(scope: string | undefined, key: string): void {
  if (!scope) return;
  grants.set(grantKey(scope, key), Date.now());
  while (grants.size > GRANT_CAP) {
    const oldest = grants.keys().next().value;
    if (oldest === undefined) break;
    grants.delete(oldest);
  }
}

function advise(key: string, message: string): void {
  const now = Date.now();
  const last = advised.get(key);
  if (last !== undefined && now - last < ADVISE_MS) return;
  advised.set(key, now);
  toast(message);
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 被拦记录进控制台发送日志（时间 / 来源 / 模板 / 缺失变量） */
function record(entry: BlockedEntry): void {
  blocked.push(entry);
  if (blocked.length > LOG_CAP) blocked.splice(0, blocked.length - LOG_CAP);
  const names = entry.missing.join("、");
  note(
    tx(
      `[发送拦截 ${stamp(entry.at)}] ${entry.source} · 模板=${entry.template} · 缺失=${names} · 模式=${entry.mode.toUpperCase()}`,
      `[send blocked ${stamp(entry.at)}] ${entry.source} · template=${entry.template} · missing=${entry.missing.join(", ")} · mode=${entry.mode.toUpperCase()}`,
    ),
  );
}

function addToBatch(entry: BlockedEntry): void {
  if (!batch) batch = { count: 0, names: [], nameSet: new Set(), timer: null };
  batch.count += 1;
  for (const n of entry.missing) {
    if (batch.nameSet.has(n)) continue;
    batch.nameSet.add(n);
    batch.names.push(n);
  }
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(flushBatch, BATCH_FLUSH_MS);
}

function flushBatch(): void {
  const b = batch;
  batch = null;
  if (!b) return;
  const names = b.names.join("、");
  toast(
    tx(
      `已跳过 ${b.count} 条：变量缺失（${names}）`,
      `Skipped ${b.count} send(s): missing variable(s) (${b.names.join(", ")})`,
    ),
  );
  note(
    tx(
      `[发送拦截 ${stamp(Date.now())}] 已跳过 ${b.count} 条：变量缺失（${names}）`,
      `[send blocked ${stamp(Date.now())}] skipped ${b.count} send(s): missing variable(s) (${b.names.join(", ")})`,
    ),
  );
}

/* ---------------- 唯一入口 ---------------- */

function blockedMessage(missing: string[], mode: SendMode): string {
  return tx(
    `变量「${missing.join("」「")}」没有数据，${mode === "hex" ? "HEX 模式已拦截发送" : "已拦截发送"}`,
    `Variable(s) "${missing.join('", "')}" have no data — ${mode === "hex" ? "HEX send blocked" : "send blocked"}`,
  );
}

/** 被预检拦下：调用方（序列器/编排器）把它转成步骤失败原因，脚本里可被 catch。 */
export class SendBlockedError extends Error {
  constructor(
    public readonly missing: string[],
    public readonly mode: SendMode,
  ) {
    super(blockedMessage(missing, mode));
    this.name = "SendBlockedError";
  }
}

export interface PreflightOptions {
  /** 调用来源（序列器/脚本/编排器/控件卡），写进控制台发送日志与提示 */
  source?: string;
  /** 本轮标识：点过「仍要发送」后，同轮同模板不再询问 */
  scope?: string;
  /** 变量取值器（默认持久变量；编排器传「编排变量优先、控制变量兜底」） */
  getVar?: GetVar;
}

export async function preflightTemplate(
  tpl: string,
  mode: SendMode,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const missing = missingTemplateVars(tpl, opts.getVar);
  if (missing.length === 0) return { ok: true };

  const source = opts.source?.trim() || tx("未命名", "unnamed");
  const key = `${mode}\u0000${tpl}\u0000${missing.join("\u0000")}`;

  // 本轮已经放行过同一模板/同一缺失集：直接放行，不再打断连续操作
  if (opts.scope && grants.has(grantKey(opts.scope, key))) return { ok: true };

  if (mode === "hex") {
    // HEX 没有放行：缺失变量发出去的是错误字节，不给「仍要发送」
    record({ at: Date.now(), source, template: tpl, mode, missing, reason: "hex" });
    advise(key, tx(`变量「${missing.join("」「")}」没有数据，HEX 模式已拦截发送`, `Variable(s) "${missing.join('", "')}" have no data — HEX send blocked`));
    return { ok: false, reason: "hex", missing };
  }

  if (batch) {
    const entry: BlockedEntry = { at: Date.now(), source, template: tpl, mode, missing, reason: "batch" };
    record(entry);
    addToBatch(entry);
    return { ok: false, reason: "batch", missing };
  }

  if (active) {
    if (active.key === key) return active.promise;
    // 已经有一个不同模板在等决策：这条不另弹窗，两条一起转批量
    const first = active;
    const second: BlockedEntry = { at: Date.now(), source, template: tpl, mode, missing, reason: "batch" };
    first.finish("batch");
    record(second);
    addToBatch(second);
    return { ok: false, reason: "batch", missing };
  }

  let resolve!: (r: PreflightResult) => void;
  const promise = new Promise<PreflightResult>((r) => {
    resolve = r;
  });
  const entry: BlockedEntry = { at: Date.now(), source, template: tpl, mode, missing, reason: "declined" };
  let handle: PromptHandle | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (reason: "allow" | "timeout" | "batch") => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    handle?.close();
    if (active?.promise === promise) active = null;
    if (reason === "allow") {
      rememberGrant(opts.scope, key);
      resolve({ ok: true });
      return;
    }
    entry.reason = reason;
    entry.at = Date.now();
    record(entry);
    if (reason === "batch") addToBatch(entry);
    resolve({ ok: false, reason, missing });
    if (reason === "timeout") {
      advise(key, tx(`变量「${missing.join("」「")}」没有数据，已放弃发送`, `Variable(s) "${missing.join('", "')}" have no data — send abandoned`));
    }
  };

  active = { key, entry, promise, finish };
  timer = setTimeout(() => finish("timeout"), PROMPT_MS);
  const show = promptAdapter ?? domPrompt;
  const baseMsg = tx(`变量「${missing.join("」「")}」没有数据，已拦截发送`, `Variable(s) "${missing.join('", "')}" have no data — send blocked`);
  const roundHint = opts.scope
    ? tx("；本轮相同模板不再询问", "; the same template will not ask again this round")
    : "";
  handle = show(baseMsg + roundHint, () => finish("allow"));
  return promise;
}
