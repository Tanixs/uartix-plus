import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as panelActivity from "../../panels/panelActivity";
import { updateChatFeed } from "./aiChatFeed";
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

let totalUsage: UsageCounter = loadUsage();

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

/** 当前活动会话（保证存在） */
function cur(): ChatSession {
  let s = snapshot.sessions.find((x) => x.id === snapshot.activeId);
  if (!s) {
    s = newSessionObj();
    snapshot.sessions = [s, ...snapshot.sessions];
    snapshot.activeId = s.id;
  }
  return s;
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = 0;
    persistNow();
  }, 600);
}

function persistNow() {
  const sessions = snapshot.sessions.slice(0, MAX_SESSIONS).map((s) => ({
    ...s,
    messages: s.messages.length > MAX_MSGS ? s.messages.slice(-MAX_MSGS) : s.messages,
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
  const exist = snapshot.sessions.find((x) => x.messages.length === 0);
  if (exist) {
    snapshot.activeId = exist.id;
    persistNow();
    emit();
    return;
  }
  const s = newSessionObj();
  snapshot.sessions = [s, ...snapshot.sessions];
  snapshot.activeId = s.id;
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
  s.messages.splice(idx, 1);
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
  s.messages = s.messages.slice(0, lastUserIdx + 1);
  emit();
  await doSend(user.content, user.scene ?? "qa", collectContext(snapshot.contextSel));
}

/** 编辑用户消息并重发（截断该消息之后的所有内容） */
export async function editResend(id: string, newText: string): Promise<void> {
  if (snapshot.streaming) return;
  const text = newText.trim();
  if (!text) return;
  const s = cur();
  const idx = s.messages.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const msg = s.messages[idx];
  if (msg.role !== "user") return;
  s.messages = s.messages.slice(0, idx);
  s.messages.push({ ...msg, id: crypto.randomUUID(), content: text, ts: Date.now() });
  emit();
  await doSend(text, msg.scene ?? "qa", collectContext(snapshot.contextSel));
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

/** 组装请求消息列表（system + 最近历史 + 本条用户消息） */
function buildRequestMessages(
  userText: string,
  scene: AiScene,
  blocks: ContextBlock[],
  extraSchemas?: NeedKey[],
): { role: string; content: string }[] {
  const st = getSettings();
  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content: buildSystemPrompt(
        scene,
        summaryTemplates(),
        {
          enabled: st.aiCreativity,
          send: st.aiWidgetSend,
          script: st.aiScript,
        },
        extraSchemas,
      ),
    },
  ];
  const s = cur();
  // userText 非空时，会话最后一条就是刚压入的用户消息，稍后会以 userText+上下文 追加，
  // 从历史中排除避免同一文本重复计费
  const hist = userText ? s.messages.slice(-21, -1) : s.messages.slice(-20);
  for (const m of hist) {
    if (m.error) continue;
    messages.push({ role: m.role, content: m.content });
  }
  const contextText = contextToText(blocks);
  messages.push({ role: "user", content: userText + contextText });
  return messages;
}

/** 底层请求：流式写回到 targetRef 指向的消息 */
async function requestChat(
  messages: { role: string; content: string }[],
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
): Promise<void> {
  const messages = buildRequestMessages(userText, scene, blocks, extraSchemas);
  const assistant: ChatMsg = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    ts: Date.now(),
    scene,
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
  const st = getSettings();
  const perms = { enabled: st.aiCreativity, send: st.aiWidgetSend, script: st.aiScript };
  let injection = "【系统自动补充】以下是你用 [[need:xxx]] 标记请求的输出格式规范：";
  for (const k of needs) injection += `\n\n${schemaFor(k, perms)}`;
  injection += "\n\n请基于以上规范立即继续输出完整代码块（不要再输出 [[need:xxx]] 标记）。";
  // 从展示内容中移除技术标记
  m.content = m.content.replace(/\[\[\s*need\s*:\s*[a-z]+\s*\]\]/gi, "").trimEnd();
  m.conts = (m.conts ?? 0) + 1;
  // 续写请求：隐藏 user 消息注入 schema（不写入会话）
  const messages = buildRequestMessages("", m.scene ?? "qa", []);
  messages.pop(); // 去掉 buildRequestMessages 追加的空 user
  messages.push({ role: "user", content: injection });
  streamingTargetRef.current = m;
  persistSoon();
  await requestChat(messages, streamingTargetRef);
}

export async function sendText(
  text: string,
  scene: AiScene = "qa",
  sel?: Partial<ContextSelection>,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || snapshot.streaming) return;
  const useSel = { ...snapshot.contextSel, ...sel };
  if (sel) snapshot.contextSel = useSel;
  const s = cur();
  s.messages = [
    ...s.messages,
    { id: crypto.randomUUID(), role: "user", content: trimmed, ts: Date.now(), scene },
  ];
  emit();
  // 普通对话：按用户消息预判需要的格式规范，命中则预注入（省去第二轮续写请求）
  const extra = scene === "qa" ? routeNeeds(trimmed).slice(0, 3) : undefined;
  await doSend(trimmed, scene, collectContext(useSel), extra);
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
  await doSend(text, scene, collectContext({ ...snapshot.contextSel, ...sel }));
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
