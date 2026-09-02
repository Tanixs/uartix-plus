import type { AiScene } from "./prompts";

export interface AiInvoke {
  scene: AiScene;
  payload?: Record<string, unknown>;
}

const EVT = "uartix-ai-invoke";
const EVT_SETTINGS = "uartix-ai-open-settings";
const EVT_POP = "uartix-ai-pop";

export function invokeAiScene(scene: AiScene, payload?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent<EiPayload>(EVT, { detail: { scene, payload } }));
}

export function invokeOpenSettings() {
  window.dispatchEvent(new CustomEvent(EVT_SETTINGS));
}

export function onOpenSettings(cb: () => void): () => void {
  const h = () => cb();
  window.addEventListener(EVT_SETTINGS, h);
  return () => window.removeEventListener(EVT_SETTINGS, h);
}

export function invokePop() {
  window.dispatchEvent(new CustomEvent(EVT_POP));
}

export function onPop(cb: () => void): () => void {
  const h = () => cb();
  window.addEventListener(EVT_POP, h);
  return () => window.removeEventListener(EVT_POP, h);
}

interface EiPayload {
  scene: AiScene;
  payload?: Record<string, unknown>;
}

export function onAiScene(cb: (req: AiInvoke) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<EiPayload>).detail;
    if (d) cb(d);
  };
  window.addEventListener(EVT, h);
  return () => window.removeEventListener(EVT, h);
}
