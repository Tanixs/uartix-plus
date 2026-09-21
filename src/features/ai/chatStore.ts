import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as panelActivity from "../../panels/panelActivity";
import { updateChatFeed } from "./aiChatFeed";
import { occupiedSessionIds, setRunConclusionCb, setSessionTitleCb } from "../agent/agentRun";
// 半截话标记与 Agent 投影共用一份常量（sessionLog 零运行时依赖，不会成环；P94-G5）
import { INCOMPLETE_MARK } from "../agent/sessionLog";
// 体积口径与 Agent 侧共用同一常量与同一个 utf8 估算（context.ts 只依赖类型，不成环；P95-H4）
import { REQUEST_SOFT_LIMIT, utf8Bytes } from "../agent/context";
import { saveImage, restoreImages, deleteImages } from "./imageStore";
import {
  getSnapshot as getSettings,
  subscribe as subscribeSettings,
} from "../settings/settingsStore";
import {
  buildSystemPrompt,
  sceneUserText,
  extractNeeds,
  routeNeeds,
  schemaFor,
  type AiScene,
  type NeedKey,
} from "./prompts";
import {
  collectContext,
  contextToText,
  summaryTemplates,
  curveStatsText,
  DEFAULT_CONTEXT,
  type ContextBlock,
  type ContextSelection,
} from "./contextCollector";

/** 一轮「思考→正文」：r=该轮思维链，c=该轮正文，ms=该轮思考耗时 */
export interface ReasonRound {
  r: string;
  c: string;
  ms: number;
  /** 该轮思考开始时间（内部计时用） */
  t0?: number;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  /** 多段思维链（续写轮会开启新一轮）；reasoning/content 仍为拼接值供摘要与解析 */
  rounds?: ReasonRound[];
  ts: number;
  scene?: AiScene;
  error?: string;
  aborted?: boolean;
  contextTitles?: string[];
  /** 该消息已自动续写的次数（[[need:xxx]] 机制），上限 2 */
  conts?: number;
  /** 用户消息附带的图片（data URL，已压缩；本体存 IndexedDB（imageStore.ts），
   *  imgIds 随会话持久化，刷新后经 hydrateImages 恢复） */
  images?: string[];
  /** IndexedDB 图片记录 id（与 images 一一对应；持久化用） */
  imgIds?: string[];
  /** P95-H4：这一轮系统替用户做的取舍（如"未重发 N 张历史图片"）；纯展示，不进请求 */
  notice?: string;
  /** P90 A1：这条用户消息是 Agent 任务目标（重发时按 Agent 走，不当问答重发） */
  via?: "agent";
  /** P92 A4：这条助手气泡是某个 Agent 任务的结论回写（按 runId 幂等覆盖，卡片只留过程） */
  fromRunId?: string;
}

export interface UsageCounter {
  prompt: number;
  completion: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMsg[];
  createdAt: number;
  updatedAt: number;
  usage: UsageCounter;
}

export interface ChatSnapshot {
  sessions: ChatSession[];
  activeId: string;
  streaming: boolean;
  reqId: string | null;
  contextSel: ContextSelection;
  pendingScene: { scene: AiScene; payload?: Record<string, unknown> } | null;
}

const SESSIONS_KEY = "vs.aiSessions";
const USAGE_KEY = "vs.aiUsage";
const MAX_SESSIONS = 30;
const MAX_MSGS = 200;

function loadUsage(): UsageCounter {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<UsageCounter>;
      return { prompt: Number(p.prompt) || 0, completion: Number(p.completion) || 0 };
    }
  } catch {
    /* 忽略 */
  }
  return { prompt: 0, completion: 0 };
}

const totalUsage: UsageCounter = loadUsage();

export function usageTotals(): UsageCounter {
  return totalUsage;
}

function loadState(): Pick<ChatSnapshot, "sessions" | "activeId"> {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { sessions?: ChatSession[]; activeId?: string };
      const sessions = Array.isArray(p.sessions) ? p.sessions : [];
      if (sessions.length > 0) {
        const activeId =
          typeof p.activeId === "string" && sessions.some((s) => s.id === p.activeId)
            ? p.activeId
            : sessions[0].id;
        return { sessions, activeId };
      }
    }
  } catch {
    localStorage.removeItem(SESSIONS_KEY);
  }
  return { sessions: [], activeId: "" };
}

function newSessionObj(): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { prompt: 0, completion: 0 },
  };
}

const loaded = loadState();
let snapshot: ChatSnapshot = {
  sessions: loaded.sessions,
  activeId: loaded.activeId,
  streaming: false,
  reqId: null,
  contextSel: { ...DEFAULT_CONTEXT },
  pendingScene: null,
};
if (snapshot.sessions.length === 0) {
  const s = newSessionObj();
  snapshot.sessions = [s];
  snapshot.activeId = s.id;
}

const listeners = new Set<() => void>();
let initialized = false;
let floatOpen = false;
let pendingDelta = "";
let pendingReasoning = "";
let flushRaf = 0;
let persistTimer = 0;

function cleanBaseUrl(url: string): string {
  return url.replace(/[`"'\s]/g, "").replace(/\/+$/, "");
}

/** P89 A5：activeId 失效自愈——失效成因：localStorage 写满时 persistNow 丢旧会话、
 *  外部清空存储、持久化数据被手改。写入路径（cur）直接补建，读取路径（getSnapshot）延迟一拍通知。 */
function cur(): ChatSession {
  const found = snapshot.sessions.find((x) => x.id === snapshot.activeId);
  if (found) return found;
  const s = newSessionObj();
  snapshot.sessions = [s, ...snapshot.sessions];
  snapshot.activeId = s.id;
  return s;
}

function activeValid(): boolean {
  return snapshot.sessions.some((s) => s.id === snapshot.activeId);
}

let healQueued = false;

function persistSoon() {
  if (persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = 0;
    persistNow();
  }, 600);
}

function persistNow() {
  // 图片 data URL 不落 localStorage（容量保护）：本体在 IndexedDB（imageStore.ts），
  // 这里只保留轻量 imgIds，刷新后由 hydrateImages 恢复
  const sessions = snapshot.sessions.slice(0, MAX_SESSIONS).map((s) => ({
    ...s,
    messages: (s.messages.length > MAX_MSGS ? s.messages.slice(-MAX_MSGS) : s.messages).map(
      (m) => (m.images ? { ...m, images: undefined } : m),
    ),
  }));
  try {
    localStorage.setItem(
      SESSIONS_KEY,
      JSON.stringify({ sessions, activeId: snapshot.activeId }),
    );
  } catch {
    // 存储满：丢弃最旧的一半会话后重试一次
    try {
      const half = sessions.slice(0, Math.max(1, Math.floor(sessions.length / 2)));
      localStorage.setItem(
        SESSIONS_KEY,
        JSON.stringify({ sessions: half, activeId: snapshot.activeId }),
      );
      snapshot.sessions = half;
      if (!activeValid()) cur(); // activeId 指向被丢弃的旧会话 → 就地自愈（P89 A5）
    } catch {
      /* 放弃 */
    }
  }
}

function persistUsage() {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(totalUsage));
  } catch {
    /* 忽略 */
  }
}

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  // P89 A5：读到失效 activeId 时排队自愈（微任务里补建+通知）。渲染期不 emit，
  // 否则 React 报「render 中更新别的组件」；UI 层不再自备 sessions[0] 兜底。
  if (!healQueued && !activeValid()) {
    healQueued = true;
    queueMicrotask(() => {
      healQueued = false;
      if (activeValid()) return;
      cur();
      persistNow();
      emit();
    });
  }
  return snapshot;
}

/** AI 对话状态 → 小部件 feed 桥（widgetHub 订阅时调用，供挂件感知 AI） */
export function updateChatFeedBridge(p: {
  streaming: boolean;
  lastMsg?: { role: string; content: string; reasoning?: string; error?: string };
}) {
  updateChatFeed(p);
}

function streamingTarget(): ChatMsg | null {
  const s = cur();
  return s.messages.length ? s.messages[s.messages.length - 1] : null;
}

function flushDelta() {
  flushRaf = 0;
  if (!pendingDelta && !pendingReasoning) return;
  const m = streamingTarget();
  if (m && m.role === "assistant") {
    const rs = (m.rounds ??= []);
    if (pendingReasoning) {
      m.reasoning = (m.reasoning ?? "") + pendingReasoning;
      const last = rs[rs.length - 1];
      if (!last || last.c) {
        // 新一轮思考（首次，或上一轮已输出正文后续写）
        if (last && !last.ms) last.ms = Math.max(0, Date.now() - (last.t0 ?? Date.now()));
        rs.push({ r: pendingReasoning, c: "", ms: 0, t0: Date.now() });
      } else {
        last.r += pendingReasoning;
      }
      pendingReasoning = "";
    }
    if (pendingDelta) {
      m.content += pendingDelta;
      const last = rs[rs.length - 1];
      if (!last) {
        rs.push({ r: "", c: pendingDelta, ms: 0 });
      } else {
        if (!last.c && !last.ms) last.ms = Math.max(1, Date.now() - (last.t0 ?? Date.now()));
        last.c += pendingDelta;
      }
      pendingDelta = "";
    }
    emit();
  } else {
    pendingDelta = "";
    pendingReasoning = "";
  }
}

export function setContextSel(sel: ContextSelection) {
  snapshot.contextSel = { ...sel };
  emit();
}

export function setFloatOpen(v: boolean) {
  floatOpen = v;
  recheckLifecycle();
}

function recheckLifecycle() {
  if (floatOpen || panelActivity.isOpen("ai")) return;
  if (snapshot.streaming && snapshot.reqId) {
    void invoke("ai_abort", { reqId: snapshot.reqId }).catch(() => undefined);
  }
}

export async function init() {
  if (initialized) return;
  initialized = true;
  pruneEmptySessions(); // P89 A3：启动即清掉历史攒下的空会话
  setSessionTitleCb(setTitleIfEmpty); // P89 A4：Agent 任务会话有标题可分辨
  // P92 A4：Agent 任务结论回写会话 → 普通聊天与 Agent 共享同一份记忆
  setRunConclusionCb(upsertRunConclusion);
  await listen<{ reqId: string; delta?: string; reasoning?: string }>("ai:chunk", (e) => {
    if (e.payload.reqId !== snapshot.reqId) return;
    pendingDelta += e.payload.delta ?? "";
    pendingReasoning += e.payload.reasoning ?? "";
    if (!flushRaf) flushRaf = requestAnimationFrame(flushDelta);
  });
  await listen<{ reqId: string; msg: string }>("ai:error", (e) => {
    if (e.payload.reqId !== snapshot.reqId) return;
    if (flushRaf) {
      cancelAnimationFrame(flushRaf);
      flushRaf = 0;
    }
    flushDelta();
    const m = streamingTarget();
    if (m && m.role === "assistant") {
      m.error = e.payload.msg;
    }
    snapshot.streaming = false;
    snapshot.reqId = null;
    const s = cur();
    s.updatedAt = Date.now();
    persistNow();
    emit();
    drainAsks();
  });
  await listen<{
    reqId: string;
    aborted: boolean;
    usage?: { prompt?: number; completion?: number };
  }>("ai:done", (e) => {
    if (e.payload.reqId !== snapshot.reqId) return;
    if (flushRaf) {
      cancelAnimationFrame(flushRaf);
      flushRaf = 0;
    }
    flushDelta();
    const m = streamingTarget();
    if (m && m.role === "assistant" && e.payload.aborted) {
      m.aborted = true;
    }
    snapshot.streaming = false;
    snapshot.reqId = null;
    const u = e.payload.usage;
    if (u) {
      const p = Number(u.prompt) || 0;
      const c = Number(u.completion) || 0;
      if (p > 0 || c > 0) {
        const s = cur();
        s.usage.prompt += p;
        s.usage.completion += c;
        totalUsage.prompt += p;
        totalUsage.completion += c;
        persistUsage();
      }
    }
    const s = cur();
    s.updatedAt = Date.now();
    persistNow();
    emit();
    // [[need:xxx]] 自动续写（用户主动中止时不续写）；续写链结束后再排空 ask 队列
    if (!e.payload.aborted) {
      void maybeContinueNeeds()
        .catch(() => undefined)
        .finally(() => drainAsks());
    } else {
      drainAsks();
    }
  });
  panelActivity.subscribe(recheckLifecycle);
  subscribeSettings(recheckLifecycle);
  // 历史图片恢复（P51）：刷新后有 imgIds 的消息从 IndexedDB 拉回图片本体
  void hydrateImages();
}

/** 为有 imgIds 而 images 缺失的消息恢复图片（模块加载后/刷新后调用一次） */
async function hydrateImages(): Promise<void> {
  let changed = false;
  for (const sess of snapshot.sessions) {
    for (const m of sess.messages) {
      if (m.imgIds?.length && !m.images) {
        const imgs = await restoreImages(m.imgIds);
        if (imgs.length) {
          m.images = imgs;
          changed = true;
        }
      }
    }
  }
  if (changed) emit();
}

/* ---------------- ask 队列（小部件/脚本向 AI 提问，忙时排队） ---------------- */

const pendingAsks: string[] = [];
const ASK_QUEUE_MAX = 3;

/** 提交一条提问：空闲立即发送；流式中入队（上限 3）。不校验发送权限（调用方负责） */
export function requestAsk(text: string): { ok: boolean; queued: boolean; err?: string } {
  const t = text.trim().slice(0, 4000);
  if (!t) return { ok: false, queued: false, err: "提问内容为空" };
  if (snapshot.streaming) {
    if (pendingAsks.length >= ASK_QUEUE_MAX) {
      return { ok: false, queued: false, err: `提问队列已满（${ASK_QUEUE_MAX} 条），稍后再试` };
    }
    pendingAsks.push(t);
    return { ok: true, queued: true };
  }
  void sendText(t, "qa").catch(() => undefined);
  return { ok: true, queued: false };
}

function drainAsks() {
  if (snapshot.streaming || pendingAsks.length === 0) return;
  const t = pendingAsks.shift();
  if (t) void sendText(t, "qa").catch(() => undefined);
}

export function clearAskQueue() {
  pendingAsks.length = 0;
}

export function abort() {
  if (!snapshot.reqId) return;
  void invoke("ai_abort", { reqId: snapshot.reqId }).catch(() => undefined);
}

export function clearChat() {
  if (snapshot.streaming) abort();
  const s = cur();
  s.messages = [];
  s.title = "";
  s.usage = { prompt: 0, completion: 0 };
  persistNow();
  emit();
}

/* ---------------- 多会话管理 ---------------- */

export function newSession() {
  if (snapshot.streaming) abort();
  // P89 A3：永远新建。旧「复用空会话」逻辑是"点新建没用"的根因——历史上攒下的空会话
  // （尤其 Agent 任务会话 messages 恒空）被反复复用，用户切进的是不知何时留下的旧会话。
  const s = newSessionObj();
  snapshot.sessions = [s, ...snapshot.sessions];
  snapshot.activeId = s.id;
  persistNow();
  emit();
}

/** P89 A3：一次性清理历史遗留的空会话（无消息且无 Agent run 关联；有标题的手动重命名保留）。 */
function pruneEmptySessions(): void {
  const occupied = occupiedSessionIds();
  const kept = snapshot.sessions.filter(
    (s) => s.messages.length > 0 || s.title || occupied.has(s.id),
  );
  if (kept.length === snapshot.sessions.length) return;
  if (kept.length === 0) {
    const s = newSessionObj();
    snapshot.sessions = [s];
    snapshot.activeId = s.id;
  } else {
    snapshot.sessions = kept;
    if (!activeValid()) snapshot.activeId = kept[0].id;
  }
  persistNow();
  emit();
}

/** P89 A4：仅当会话无标题时写入（用户手动重命名/已有首条消息命名的优先）。 */
export function setTitleIfEmpty(id: string, text: string): void {
  const s = snapshot.sessions.find((x) => x.id === id);
  if (!s || s.title) return;
  const t = text.replace(/\s+/g, " ").trim().slice(0, 22);
  if (!t) return;
  s.title = t;
  persistNow();
  emit();
}

export function switchSession(id: string) {
  if (!snapshot.sessions.some((s) => s.id === id)) return;
  if (snapshot.streaming) abort();
  snapshot.activeId = id;
  persistNow();
  emit();
}

export function renameSession(id: string, title: string) {
  const s = snapshot.sessions.find((x) => x.id === id);
  if (!s) return;
  s.title = title.trim().slice(0, 40);
  persistNow();
  emit();
}

export function deleteSession(id: string) {
  const idx = snapshot.sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  if (snapshot.streaming && id === snapshot.activeId) abort();
  // 会话内图片记录一并清理（尽力而为）
  for (const m of snapshot.sessions[idx].messages) {
    if (m.imgIds?.length) void deleteImages(m.imgIds);
  }
  snapshot.sessions.splice(idx, 1);
  if (snapshot.sessions.length === 0) {
    const s = newSessionObj();
    snapshot.sessions = [s];
    snapshot.activeId = s.id;
  } else if (snapshot.activeId === id) {
    snapshot.activeId = snapshot.sessions[Math.max(0, idx - 1)].id;
  }
  persistNow();
  emit();
}

/* ---------------- 消息级操作 ---------------- */

/** 删除单条消息 */
export function deleteMsg(id: string) {
  const s = cur();
  const idx = s.messages.findIndex((m) => m.id === id);
  if (idx < 0) return;
  if (snapshot.streaming && idx === s.messages.length - 1) abort();
  const [rm] = s.messages.splice(idx, 1);
  if (rm?.imgIds?.length) void deleteImages(rm.imgIds);
  persistSoon();
  emit();
}

/** 重新生成最后一条 AI 回复（复用最后一条用户消息） */
export async function regenerate(): Promise<void> {
  if (snapshot.streaming) return;
  const s = cur();
  let lastUserIdx = -1;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return;
  const user = s.messages[lastUserIdx];
  // P94-G5：Agent 任务目标不能当普通问答重发（旧实现会 slice 掉那之后的全部消息，
  // 并把目标当一句话问模型）。重跑任务走 AiChat 的「重跑任务」按钮（按 via 分流）。
  if (resendKindOf(user) === "agent") return;
  s.messages = s.messages.slice(0, lastUserIdx + 1);
  emit();
  await doSend(user.content, user.scene ?? "qa", collectContext(snapshot.contextSel), undefined, user.images);
}

/** P90 A1：该消息当初怎么发的就怎么重发——Agent 目标重发为任务，普通消息重发为问答。 */
export function resendKindOf(m: Pick<ChatMsg, "via">): "agent" | "chat" {
  return m.via === "agent" ? "agent" : "chat";
}

/** 截断到该用户消息并用新文本替换（不发请求）；返回新消息供调用方决定走哪条链路。 */
export function rewriteForResend(id: string, newText: string): ChatMsg | null {
  const text = newText.trim();
  if (!text) return null;
  const s = cur();
  const idx = s.messages.findIndex((m) => m.id === id);
  if (idx < 0) return null;
  const msg = s.messages[idx];
  if (msg.role !== "user") return null;
  // 被截断的消息图片记录一并清理（尽力而为）
  for (const m of s.messages.slice(idx)) {
    if (m.imgIds?.length) void deleteImages(m.imgIds);
  }
  const next: ChatMsg = {
    ...msg,
    id: crypto.randomUUID(),
    content: text,
    ts: Date.now(),
    imgIds: undefined,
    images: undefined,
  };
  s.messages = [...s.messages.slice(0, idx), next];
  s.updatedAt = Date.now();
  persistNow();
  emit();
  return next;
}

export async function editResend(id: string, newText: string): Promise<void> {
  if (snapshot.streaming) return;
  const msg = rewriteForResend(id, newText);
  if (!msg) return;
  await doSend(msg.content, msg.scene ?? "qa", collectContext(snapshot.contextSel));
}

/* ---------------- 发送链路 ---------------- */

export function pushScene(scene: AiScene, payload?: Record<string, unknown>) {
  snapshot.pendingScene = { scene, payload };
  emit();
}

export function consumeScene():
  | { scene: AiScene; payload?: Record<string, unknown> }
  | null {
  const p = snapshot.pendingScene;
  if (p) {
    snapshot.pendingScene = null;
    emit();
  }
  return p;
}

/** 请求 content：纯文本，或 文本+图片 parts（OpenAI 风格，Rust 侧按 format 转换） */
type ReqContent = string | Array<{ type: string; [k: string]: unknown }>;

/** 用户消息 → 请求 content：带图片时展开为 parts */
function userContent(text: string, images?: string[]): ReqContent {
  if (!images || images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

/** P95-H4：估算发往 `ai_chat` 的 body 体积（Rust 侧对这条通道**没有**体积守卫，
 *  只有 Agent 通道有 2 MiB 熔断——所以聊天侧至少不能盲发）。 */
function wireBytes(msgs: { role: string; content: ReqContent }[]): number {
  let n = 0;
  for (const m of msgs) {
    if (typeof m.content === "string") {
      n += utf8Bytes(m.content);
      continue;
    }
    for (const p of m.content) {
      n += utf8Bytes(String(p.text ?? ""));
      const url = (p.image_url as { url?: string } | undefined)?.url;
      if (url) n += url.length; // data URL 已是 base64 文本
    }
  }
  return n + 256;
}

function buildRequestMessages(
  userText: string,
  scene: AiScene,
  blocks: ContextBlock[],
  extraSchemas?: NeedKey[],
  images?: string[],
): { messages: { role: string; content: ReqContent }[]; droppedImages: number } {
  const messages: { role: string; content: ReqContent }[] = [
    {
      role: "system",
      content: buildSystemPrompt(
        scene,
        scene === "inertial" ? "" : summaryTemplates(),
        extraSchemas,
      ),
    },
  ];
  const s = cur();
  // userText 非空时，会话最后一条就是刚压入的用户消息，稍后会以 userText+上下文 追加，
  // 从历史中排除避免同一文本重复计费
  const hist = scene === "inertial" ? [] : userText ? s.messages.slice(-21, -1) : s.messages.slice(-20);
  const histPlain: { role: string; body: string; images?: string[] }[] = [];
  let historyImages = 0;
  for (const m of hist) {
    // P94-G5：与 Agent 投影同一口径——被中止/出错的轮次不再整条丢弃，也不裸着当完整回答，
    // 而是带统一前缀（旧实现丢 error、对 aborted 完全不管，模型会把半截话当作自己说过的结论）。
    if (m.error && !m.content) continue;
    const mark = m.aborted ? INCOMPLETE_MARK.aborted : m.error ? INCOMPLETE_MARK.error : "";
    const body = mark && m.content ? `${mark}\n${m.content}` : m.content;
    histPlain.push({ role: m.role, body, ...(m.images?.length ? { images: m.images } : {}) });
    historyImages += m.images?.length ?? 0;
  }
  const contextText = scene === "inertial" ? "" : contextToText(blocks);
  const tailMsg = { role: "user", content: userContent(userText + contextText, scene === "inertial" ? undefined : images) };
  const withHistory = histPlain.map((h) => ({
    role: h.role,
    content: h.images?.length ? userContent(h.body, h.images) : h.body,
  }));
  let droppedImages = 0;
  let history = withHistory;
  // P95-H4：请求过大就先丢**历史**附图（本轮附图保留），并在返回里报出来——
  // 聊天通道在 Rust 侧没有体积守卫，不主动收就只能等上游报错。
  if (historyImages && wireBytes([...messages, ...history, tailMsg]) > REQUEST_SOFT_LIMIT) {
    droppedImages = historyImages;
    history = histPlain.map((h) => ({ role: h.role, content: h.body }));
  }
  return { messages: [...messages, ...history, tailMsg], droppedImages };
}

/** 底层请求：流式写回到 targetRef 指向的消息 */
async function requestChat(
  messages: { role: string; content: ReqContent }[],
  targetRef: { current: ChatMsg | null },
): Promise<void> {
  const st = getSettings();
  const s = cur();
  s.updatedAt = Date.now();
  snapshot.streaming = true;
  const reqId = crypto.randomUUID();
  snapshot.reqId = reqId;
  emit();
  try {
    await invoke("ai_chat", {
      reqId,
      baseUrl: cleanBaseUrl(st.aiBaseUrl),
      apiKey: st.aiApiKey,
      model: st.aiModel,
      temperature: st.aiTemperature,
      format: st.aiFormat,
      proxy: st.aiProxy,
      noProxy: st.aiNoProxy,
      messages,
      // P96-K4：模型是否先想后答 = deepThink（原先借用界面开关 showThinking，一个开关管两件事）
      thinking: st.deepThink,
    });
  } catch (e) {
    if (snapshot.reqId === reqId) {
      const m = targetRef.current;
      if (m && m.role === "assistant") m.error = String(e).replace(/^Error:\s*/, "");
      snapshot.streaming = false;
      snapshot.reqId = null;
      persistNow();
      emit();
    }
  }
}

async function doSend(
  userText: string,
  scene: AiScene,
  blocks: ContextBlock[],
  extraSchemas?: NeedKey[],
  images?: string[],
): Promise<void> {
  const { messages, droppedImages } = buildRequestMessages(userText, scene, blocks, extraSchemas, images);
  const assistant: ChatMsg = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    ts: Date.now(),
    scene,
    // P95-H4：丢过的东西必须说给用户听（不说就等于"AI 莫名其妙忘了我发的图"）
    ...(droppedImages ? { notice: `本轮请求过大，未重发较早的 ${droppedImages} 张历史图片（本轮附图保留）` } : {}),
  };
  assistant.contextTitles = blocks.map((b) => b.title);
  const s = cur();
  s.messages = [...s.messages, assistant];
  if (!s.title) {
    s.title = userText.replace(/\s+/g, " ").slice(0, 22) || "新对话";
  }
  streamingTargetRef.current = assistant;
  persistNow();
  await requestChat(messages, streamingTargetRef);
}

/** 流式写回目标（续写时指向同一条 assistant 消息） */
const streamingTargetRef: { current: ChatMsg | null } = { current: null };

/** [[need:xxx]] 自动续写：检测标记 → 注入 schema → 同一条消息继续输出 */
async function maybeContinueNeeds(): Promise<void> {
  const s = cur();
  const m = s.messages[s.messages.length - 1];
  if (!m || m.role !== "assistant" || m.error) return;
  if ((m.conts ?? 0) >= 2) return;
  const needs = extractNeeds(m.content);
  if (needs.length === 0) return;
  // 标记之后已经输出了代码块 → 不需要续写
  const lastMarker = m.content.lastIndexOf("[[");
  if (m.content.slice(lastMarker).includes("```")) return;
  let injection = "【系统自动补充】以下是你用 [[need:xxx]] 标记请求的输出格式规范：";
  for (const k of needs) injection += `\n\n${schemaFor(k)}`;
  injection += "\n\n请基于以上规范立即继续输出完整代码块（不要再输出 [[need:xxx]] 标记）。";
  // 从展示内容中移除技术标记
  m.content = m.content.replace(/\[\[\s*need\s*:\s*[a-z]+\s*\]\]/gi, "").trimEnd();
  m.conts = (m.conts ?? 0) + 1;
  // 续写请求：隐藏 user 消息注入 schema（不写入会话）
  const built = buildRequestMessages("", m.scene ?? "qa", []).messages;
  built.pop(); // 去掉 buildRequestMessages 追加的空 user
  built.push({ role: "user", content: injection });
  streamingTargetRef.current = m;
  persistSoon();
  await requestChat(built, streamingTargetRef);
}

/** 落一条用户消息（含图片本体入 IndexedDB 的尽力而为）；标题为空时按首条原话命名。 */
function pushUserMsg(text: string, scene: AiScene, images?: string[], via?: "agent"): void {
  const s = cur();
  const msgId = crypto.randomUUID();
  s.messages = [
    ...s.messages,
    {
      id: msgId,
      role: "user",
      content: text,
      ts: Date.now(),
      scene,
      ...(images && images.length ? { images } : {}),
      ...(via ? { via } : {}),
    },
  ];
  if (!s.title) s.title = text.replace(/\s+/g, " ").slice(0, 22) || "新对话";
  s.updatedAt = Date.now();
  persistNow();
  emit();
  if (images && images.length) {
    void (async () => {
      try {
        const ids: string[] = [];
        for (const d of images) ids.push(await saveImage(msgId, d));
        const m = s.messages.find((x) => x.id === msgId);
        if (m) {
          m.imgIds = ids;
          persistSoon();
        }
      } catch {
        /* IndexedDB 不可用：跳过持久化 */
      }
    })();
  }
}

/** P90 A1：Agent 任务目标也留一条用户气泡——只写用户原话，附件全文进 goal 给模型、不进气泡。 */
export function appendUserMessage(text: string, opts?: { via?: "agent"; images?: string[] }): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  pushUserMsg(trimmed, "qa", opts?.images, opts?.via);
}

/**
 * P92 A4：Agent 任务结论回写会话（分工从此明确：**气泡=结论、卡片=过程**）。
 * 这是"Agent 与普通聊天共享同一份记忆"的关键一步——旧实现里任务答复只在事件台账，
 * 切回普通对话模型就看不见自己刚说过什么，用户照抄上一轮的选项回复会被当成新需求。
 * 按 runId 幂等（续跑/重试再次终态覆盖同一条，不堆重复气泡）；目标会话可能不是当前
 * 会话（任务跑着用户切走了），所以按 sessionId 定位而非 cur()。
 */
export function upsertRunConclusion(sessionId: string, runId: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const s = snapshot.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const at = s.messages.findIndex((m) => m.fromRunId === runId);
  if (at >= 0) {
    if (s.messages[at].content === trimmed) return;
    s.messages = s.messages.map((m, i) => (i === at ? { ...m, content: trimmed, ts: Date.now() } : m));
  } else {
    s.messages = [
      ...s.messages,
      { id: crypto.randomUUID(), role: "assistant", content: trimmed, ts: Date.now(), fromRunId: runId },
    ];
    if (!s.title) s.title = trimmed.replace(/\s+/g, " ").slice(0, 22) || "新对话";
  }
  s.updatedAt = Date.now();
  persistNow();
  emit();
}

export async function sendText(
  text: string,
  scene: AiScene = "qa",
  sel?: Partial<ContextSelection>,
  images?: string[],
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || snapshot.streaming) return;
  const useSel = { ...snapshot.contextSel, ...sel };
  if (sel) snapshot.contextSel = useSel;
  pushUserMsg(trimmed, scene, images);
  // 普通对话：按用户消息预判需要的格式规范，命中则预注入（省去第二轮续写请求）
  const extra = scene === "qa" ? routeNeeds(trimmed).slice(0, 3) : undefined;
  await doSend(trimmed, scene, collectContext(useSel), extra, images);
}

export async function runScene(
  scene: AiScene,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (snapshot.streaming) return;
  const sel: Partial<ContextSelection> = {};
  if (scene === "protocol" || scene === "docTemplate" || scene === "explainBytes") {
    sel.protocol = true;
    sel.protoFull = true;
    sel.hex = scene === "docTemplate" ? false : true;
  } else if (scene === "interpret" || scene === "report") {
    sel.conn = true;
    sel.protocol = true;
    sel.protoFull = true;
    sel.samples = true;
    sel.hex = false;
  } else if (scene === "analyzeCurve") {
    sel.protocol = true;
    sel.protoFull = true;
    sel.samples = true;
    payload = { ...payload, stats: curveStatsText() };
  } else if (scene === "diagnose") {
    sel.conn = true;
    sel.protocol = true;
    sel.protoFull = true;
  }
  const text = sceneUserText(scene, payload);
  if (!text.trim()) return;
  const s = cur();
  s.messages = [
    ...s.messages,
    {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ts: Date.now(),
      scene,
    },
  ];
  emit();
  await doSend(text, scene, scene === "inertial" ? [] : collectContext({ ...snapshot.contextSel, ...sel }));
}

/** 导出当前会话为 Markdown 文本 */
export function exportSessionMd(): string {
  const s = cur();
  const lines: string[] = [
    `# Uartix+ 对话记录`,
    "",
    `- 导出时间：${new Date().toLocaleString()}`,
    `- 会话：${s.title || "未命名"}`,
    `- 消息数：${s.messages.length}`,
    "",
  ];
  for (const m of s.messages) {
    const who = m.role === "user" ? "用户" : "AI";
    lines.push(`## ${who} · ${new Date(m.ts).toLocaleTimeString()}`);
    lines.push("");
    lines.push(m.error ? `> 出错：${m.error}` : m.content || "（空）");
    lines.push("");
  }
  return lines.join("\n");
}

/** 会话搜索：返回 [sessionId, msg] 匹配项 */
export function searchSessions(q: string): { sessionId: string; title: string; msg: ChatMsg }[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const out: { sessionId: string; title: string; msg: ChatMsg }[] = [];
  for (const s of snapshot.sessions) {
    for (const m of s.messages) {
      if (m.content.toLowerCase().includes(query)) {
        out.push({ sessionId: s.id, title: s.title || "未命名", msg: m });
        if (out.length >= 40) return out;
      }
    }
  }
  return out;
}
