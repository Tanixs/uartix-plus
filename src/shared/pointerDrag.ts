export interface DragSpec {
  kind: string;
  data?: string;
  label: string;
  sub?: string;
  color?: string;
  onEnd?: () => void;
}

export interface PdragDetail {
  kind: string;
  data: string;
  x: number;
  y: number;
}

let spec: DragSpec | null = null;
let ghost: HTMLDivElement | null = null;
let overEl: Element | null = null;
let active = false;
let startX = 0;
let startY = 0;
let clickKiller: ((e: MouseEvent) => void) | null = null;

const THRESHOLD = 5;

function zoomF(): number {
  return Number(getComputedStyle(document.documentElement).zoom) || 1;
}

function zoneAt(x: number, y: number): Element | null {
  if (!spec) return null;
  const stack = document.elementsFromPoint(x, y);
  const seen = new Set<Element>();
  for (const el of stack) {
    let z: Element | null = el.closest("[data-pdrag]");
    while (z) {
      if (!seen.has(z)) {
        seen.add(z);
        const kinds = (z.getAttribute("data-pdrag") || "").split(/\s+/);
        if (kinds.includes(spec.kind)) return z;
      }
      const parent = z.parentElement;
      z = parent ? parent.closest("[data-pdrag]") : null;
    }
  }
  return null;
}

function setOver(el: Element | null, x: number, y: number) {
  if (el !== overEl) {
    if (overEl) {
      overEl.classList.remove("pdrag-over");
      overEl.dispatchEvent(
        new CustomEvent("pdrag:leave", { detail: { kind: spec?.kind ?? "" } }),
      );
    }
    overEl = el;
    if (overEl) overEl.classList.add("pdrag-over");
  }
  if (overEl && spec) {
    overEl.dispatchEvent(
      new CustomEvent("pdrag:over", {
        bubbles: true,
        detail: { kind: spec.kind, data: spec.data ?? "", x, y },
      }),
    );
  }
}

function spawnGhost() {
  if (!spec || ghost) return;
  ghost = document.createElement("div");
  ghost.className = "pdrag-ghost";
  if (spec.color) {
    const d = document.createElement("i");
    d.className = "pdrag-dot";
    d.style.background = spec.color;
    ghost.appendChild(d);
  }
  const t = document.createElement("span");
  t.textContent = spec.label;
  ghost.appendChild(t);
  if (spec.sub) {
    const s = document.createElement("span");
    s.className = "pdrag-sub";
    s.textContent = spec.sub;
    ghost.appendChild(s);
  }
  document.body.appendChild(ghost);
}

function onMove(e: PointerEvent) {
  if (!spec) return;
  if (!active) {
    if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < THRESHOLD) return;
    active = true;
    spawnGhost();
    document.body.classList.add("pdrag-active");
    clickKiller = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (clickKiller) window.removeEventListener("click", clickKiller, true);
      clickKiller = null;
    };
    window.addEventListener("click", clickKiller, true);
  }
  e.preventDefault();
  if (ghost) {
    const zf = zoomF();
    ghost.style.left = `${(e.clientX + 14) / zf}px`;
    ghost.style.top = `${(e.clientY + 16) / zf}px`;
  }
  setOver(zoneAt(e.clientX, e.clientY), e.clientX, e.clientY);
}

function onUp(e: PointerEvent) {
  if (active && overEl && spec) {
    overEl.dispatchEvent(
      new CustomEvent("pdrag:drop", {
        bubbles: true,
        detail: { kind: spec.kind, data: spec.data ?? "", x: e.clientX, y: e.clientY },
      }),
    );
  }
  cleanup();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") cleanup();
}

function cleanup() {
  window.removeEventListener("pointermove", onMove, true);
  window.removeEventListener("pointerup", onUp, true);
  window.removeEventListener("pointercancel", cleanup, true);
  window.removeEventListener("keydown", onKey, true);
  if (clickKiller) {
    window.removeEventListener("click", clickKiller, true);
    clickKiller = null;
  }
  if (overEl) {
    overEl.classList.remove("pdrag-over");
    overEl = null;
  }
  if (ghost) {
    ghost.remove();
    ghost = null;
  }
  document.body.classList.remove("pdrag-active");
  const s = spec;
  spec = null;
  active = false;
  s?.onEnd?.();
}

export function beginPointerDrag(
  e: { clientX: number; clientY: number; button: number },
  s: DragSpec,
): void {
  if (e.button !== 0 || spec) return;
  spec = s;
  startX = e.clientX;
  startY = e.clientY;
  active = false;
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", cleanup, true);
  window.addEventListener("keydown", onKey, true);
}

export function isPointerDragging(): boolean {
  return active;
}

export interface PdragZoneHandlers {
  onOver?: (d: PdragDetail, target: HTMLElement) => void;
  onLeave?: (kind: string) => void;
  onDrop: (d: PdragDetail) => void;
  kinds: string;
}

/** 在 el 上挂 data-pdrag 并监听 pdrag:* 自定义事件（内核派发、冒泡）。
 *  只有当事件的最深命中区就是 el 本身时才回调（嵌套区各管各的）。 */
export function attachPdragZone(el: HTMLElement, h: PdragZoneHandlers): () => void {
  el.setAttribute("data-pdrag", h.kinds);
  const isForMe = (t: EventTarget | null): t is HTMLElement => {
    const e = t as HTMLElement | null;
    if (!e || typeof e.closest !== "function") return false;
    return e.closest("[data-pdrag]") === el;
  };
  const onOver = (ev: Event) => {
    if (!isForMe(ev.target)) return;
    h.onOver?.((ev as CustomEvent<PdragDetail>).detail, ev.target as HTMLElement);
  };
  const onLeave = () => {
    h.onLeave?.(spec?.kind ?? "");
  };
  const onDrop = (ev: Event) => {
    if (!isForMe(ev.target)) return;
    h.onDrop((ev as CustomEvent<PdragDetail>).detail);
  };
  el.addEventListener("pdrag:over", onOver);
  el.addEventListener("pdrag:leave", onLeave);
  el.addEventListener("pdrag:drop", onDrop);
  return () => {
    el.removeEventListener("pdrag:over", onOver);
    el.removeEventListener("pdrag:leave", onLeave);
    el.removeEventListener("pdrag:drop", onDrop);
  };
}
