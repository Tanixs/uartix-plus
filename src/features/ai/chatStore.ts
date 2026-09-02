import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as panelActivity from "../../panels/panelActivity";
import {
  getSnapshot as getSettings,
  subscribe as subscribeSettings,
} from "../settings/settingsStore";
import { buildSystemPrompt, sceneUserText, type AiScene } from "./prompts";
import {
  collectContext,
  contextToText,
  summaryTemplates,
  curveStatsText,
  DEFAULT_CONTEXT,
  type ContextBlock,
  type ContextSelection,
} from "./contextCollector";

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  ts: number;
  scene?: AiScene;
  error?: string;
  aborted?: boolean;
  contextTitles?: string[];
}

export interface ChatSnapshot {
  messages: ChatMsg[];
  streaming: boolean;
  reqId: string | null;
  contextSel: ContextSelection;
  pendingScene: { scene: AiScene; payload?: Record<string, unknown> } | null;
}

let snapshot: ChatSnapshot = {
  messages: [],
  streaming: false,
  reqId: null,
  contextSel: { ...DEFAULT_CONTEXT },
  pendingScene: null,
};

const listeners = new Set<() => void>();
let initialized = false;
let floatOpen = false;
let pendingDelta = "";
let pendingReasoning = "";
let flushRaf = 0;

function cleanBaseUrl(url: string): string {
  return url.replace(/[`"'\s]/g, "").replace(/\/+$/, "");
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

function streamingTarget(): ChatMsg | null {
  return snapshot.messages.length
    ? snapshot.messages[snapshot.messages.length - 1]
    : null;
}

function flushDelta() {
  flushRaf = 0;
  if (!pendingDelta && !pendingReasoning) return;
  const m = streamingTarget();
  if (m && m.role === "assistant") {
    if (pendingReasoning) {
      m.reasoning = (m.reasoning ?? "") + pendingReasoning;
      pendingReasoning = "";
    }
    if (pendingDelta) {
      m.content += pendingDelta;
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
    emit();
  });
  await listen<{ reqId: string; aborted: boolean }>("ai:done", (e) => {
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
    emit();
  });
  panelActivity.subscribe(recheckLifecycle);
  subscribeSettings(recheckLifecycle);
}

export function abort() {
  if (!snapshot.reqId) return;
  void invoke("ai_abort", { reqId: snapshot.reqId }).catch(() => undefined);
}

export function clearChat() {
  if (snapshot.streaming) abort();
  snapshot.messages = [];
  emit();
}

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

async function doSend(
  userText: string,
  scene: AiScene,
  blocks: ContextBlock[],
): Promise<void> {
  const st = getSettings();
  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content: buildSystemPrompt(scene, summaryTemplates(), {
        enabled: st.aiCreativity,
        send: st.aiWidgetSend,
      }),
    },
  ];
  for (const m of snapshot.messages.slice(-20)) {
    if (m.error) continue;
    messages.push({ role: m.role, content: m.content });
  }
  const contextText = contextToText(blocks);
  const contextTitles = blocks.map((b) => b.title);
  messages.push({ role: "user", content: userText + contextText });

  const assistant: ChatMsg = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    ts: Date.now(),
    scene,
    contextTitles,
  };
  snapshot.messages = [...snapshot.messages, assistant];
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
      const m = streamingTarget();
      if (m && m.role === "assistant") m.error = String(e).replace(/^Error:\s*/, "");
      snapshot.streaming = false;
      snapshot.reqId = null;
      emit();
    }
  }
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
  snapshot.messages = [
    ...snapshot.messages,
    { id: crypto.randomUUID(), role: "user", content: trimmed, ts: Date.now(), scene },
  ];
  emit();
  await doSend(trimmed, scene, collectContext(useSel));
}

export async function runScene(
  scene: AiScene,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (snapshot.streaming) return;
  const sel: Partial<ContextSelection> = {};
  if (scene === "protocol" || scene === "docTemplate" || scene === "explainBytes") {
    sel.protocol = true;
    sel.hex = scene === "docTemplate" ? false : true;
  } else if (scene === "interpret" || scene === "report") {
    sel.conn = true;
    sel.protocol = true;
    sel.samples = true;
    sel.hex = false;
  } else if (scene === "analyzeCurve") {
    sel.protocol = true;
    sel.samples = true;
    payload = { ...payload, stats: curveStatsText() };
  } else if (scene === "diagnose") {
    sel.conn = true;
    sel.protocol = true;
  }
  const text = sceneUserText(scene, payload);
  if (!text.trim()) return;
  snapshot.messages = [
    ...snapshot.messages,
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
