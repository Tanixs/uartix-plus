export type SendMode = "ascii" | "hex";

export type ControlType =
  | "slider"
  | "button"
  | "switch"
  | "led"
  | "monitor"
  | "joystick";

export interface BaseCard {
  id: string;
  type: ControlType;
  name: string;
  x: number;
  y: number;
  w: 1 | 2;
  h: number;
}

export interface SliderCard extends BaseCard {
  type: "slider";
  template: string;
  sendMode: SendMode;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  sendTrigger: "onRelease" | "continuous";
  minIntervalMs: number;
  useScript: boolean;
  script: string;
}

export interface ButtonCard extends BaseCard {
  type: "button";
  template: string;
  sendMode: SendMode;
  holdRepeat: boolean;
  minIntervalMs: number;
  useScript: boolean;
  script: string;
}

export type LedOp = "gt" | "ge" | "lt" | "le" | "eq" | "ne";

export interface SwitchCard extends BaseCard {
  type: "switch";
  positions: 2 | 3;
  templates: string[];
  labels: string[];
  sendMode: SendMode;
  state: number;
  useScript: boolean;
  script: string;
}

export interface LedCard extends BaseCard {
  type: "led";
  varName: string;
  op: LedOp;
  value: number;
  strValue: string;
  onColor: string;
}

export interface MonitorCard extends BaseCard {
  type: "monitor";
  varName: string;
  unit: string;
  decimals: number;
}

export interface JoystickCard extends BaseCard {
  type: "joystick";
  template: string;
  sendMode: SendMode;
  range: number;
  minIntervalMs: number;
  springBack: boolean;
  useScript: boolean;
  script: string;
}

export type ControlCard =
  | SliderCard
  | ButtonCard
  | SwitchCard
  | LedCard
  | MonitorCard
  | JoystickCard;

export const PANEL_TYPE_NAMES: Record<ControlType, string> = {
  slider: "滑条",
  button: "按钮",
  switch: "开关",
  led: "LED 灯",
  monitor: "数值监视",
  joystick: "摇杆",
};

export interface ControlPage {
  id: string;
  name: string;
  cols: number;
  cards: ControlCard[];
  locked: boolean;
}

export interface ControlsSnapshot {
  pages: ControlPage[];
  activePageId: string;
}

function migrateCard(raw: Record<string, unknown>): ControlCard {
  const base = {
    id: String(raw.id ?? crypto.randomUUID()),
    name: String(raw.name ?? "卡片"),
    x: Number(raw.x ?? 0),
    y: Number(raw.y ?? 0),
    w: (Number(raw.w) === 2 ? 2 : 1) as 1 | 2,
    h: Math.max(1, Number(raw.h ?? 1)),
  };
  const type = (raw.type ?? "slider") as ControlType;
  switch (type) {
    case "button":
      return {
        ...base,
        type,
        template: String(raw.template ?? "CMD!"),
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        holdRepeat: Boolean(raw.holdRepeat),
        minIntervalMs: Number(raw.minIntervalMs ?? 100),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    case "switch":
      return {
        ...base,
        type,
        positions: (Number(raw.positions) === 3 ? 3 : 2) as 2 | 3,
        templates: (raw.templates as string[]) ?? ["SW:1!", "SW:0!"],
        labels: (raw.labels as string[]) ?? ["开", "关"],
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        state: Number(raw.state ?? 0),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    case "led":
      return {
        ...base,
        type,
        varName: String(raw.varName ?? ""),
        op: (raw.op as LedOp) ?? "gt",
        value: Number(raw.value ?? 0),
        strValue: String(raw.strValue ?? ""),
        onColor: String(raw.onColor ?? "#3fb950"),
      };
    case "monitor":
      return {
        ...base,
        type,
        varName: String(raw.varName ?? ""),
        unit: String(raw.unit ?? ""),
        decimals: Number(raw.decimals ?? 2),
      };
    case "joystick":
      return {
        ...base,
        type,
        template: String(raw.template ?? "J:%x,%y!"),
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        range: Number(raw.range ?? 100),
        minIntervalMs: Number(raw.minIntervalMs ?? 50),
        springBack: raw.springBack === undefined ? true : Boolean(raw.springBack),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    default:
      return {
        ...base,
        type: "slider",
        template: String(raw.template ?? "CMD:%.2f!"),
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        min: Number(raw.min ?? 0),
        max: Number(raw.max ?? 100),
        step: Number(raw.step ?? 1),
        defaultValue: Number(raw.defaultValue ?? 50),
        sendTrigger:
          (raw.sendTrigger as "onRelease" | "continuous") ?? "onRelease",
        minIntervalMs: Number(raw.minIntervalMs ?? 50),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
  }
}

function migrateLegacyScript(raw: Record<string, unknown>): ControlCard {
  return migrateCard({
    ...raw,
    type: "button",
    useScript: true,
    script: String(raw.code ?? ""),
    template: "",
  });
}

function load(): ControlsSnapshot {
  try {
    const saved = localStorage.getItem("vs.controls");
    if (saved) {
      const parsed = JSON.parse(saved) as ControlsSnapshot;
      if (parsed.pages && parsed.pages.length) {
        return {
          activePageId: parsed.activePageId,
          pages: parsed.pages.map((p) => ({
            ...p,
            locked: Boolean(p.locked),
            cards: (p.cards as unknown as Record<string, unknown>[]).map((r) =>
              r.type === "script" ? migrateLegacyScript(r) : migrateCard(r),
            ),
          })),
        };
      }
    }
  } catch {
    localStorage.removeItem("vs.controls");
  }
  const page: ControlPage = {
    id: crypto.randomUUID(),
    name: "控制页 1",
    cols: 3,
    cards: [],
    locked: false,
  };
  return { pages: [page], activePageId: page.id };
}

let snapshot: ControlsSnapshot = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    localStorage.setItem("vs.controls", JSON.stringify(snapshot));
  }, 250);
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

export function activePage(): ControlPage | undefined {
  return (
    snapshot.pages.find((p) => p.id === snapshot.activePageId) ??
    snapshot.pages[0]
  );
}

export function setActivePage(id: string) {
  snapshot = { ...snapshot, activePageId: id };
  emit();
}

export function addPage() {
  const page: ControlPage = {
    id: crypto.randomUUID(),
    name: `控制页 ${snapshot.pages.length + 1}`,
    cols: 3,
    cards: [],
    locked: false,
  };
  snapshot = {
    pages: [...snapshot.pages, page],
    activePageId: page.id,
  };
  emit();
}

export function removePage(id: string) {
  const pages = snapshot.pages.filter((p) => p.id !== id);
  if (!pages.length) return;
  snapshot = {
    pages,
    activePageId:
      snapshot.activePageId === id ? pages[0].id : snapshot.activePageId,
  };
  emit();
}

export function renamePage(id: string, name: string) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === id ? { ...p, name } : p)),
  };
  emit();
}

export function setPageCols(id: string, cols: number) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === id ? { ...p, cols } : p)),
  };
  emit();
}

export function setPageLocked(id: string, locked: boolean) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === id ? { ...p, locked } : p)),
  };
  emit();
}

function defaultCard(type: ControlType, name: string): ControlCard {
  const base = {
    id: crypto.randomUUID(),
    type,
    name,
    x: 0,
    y: 0,
    w: 1 as 1 | 2,
    h: 1,
  };
  switch (type) {
    case "button":
      return {
        ...base,
        type,
        template: "CMD!",
        sendMode: "ascii",
        holdRepeat: false,
        minIntervalMs: 100,
        useScript: false,
        script: "",
      };
    case "switch":
      return {
        ...base,
        type,
        positions: 2,
        templates: ["SW:1!", "SW:0!"],
        labels: ["开", "关"],
        sendMode: "ascii",
        state: 0,
        useScript: false,
        script: "",
      };
    case "led":
      return {
        ...base,
        type,
        varName: "",
        op: "gt",
        value: 0,
        strValue: "",
        onColor: "#3fb950",
      };
    case "monitor":
      return { ...base, type, varName: "", unit: "", decimals: 2 };
    case "joystick":
      return {
        ...base,
        type,
        template: "J:%x,%y!",
        sendMode: "ascii",
        range: 100,
        minIntervalMs: 50,
        springBack: true,
        useScript: false,
        script: "",
      };
    default:
      return {
        ...base,
        type: "slider",
        template: "CMD:%.2f!",
        sendMode: "ascii",
        min: 0,
        max: 100,
        step: 1,
        defaultValue: 50,
        sendTrigger: "onRelease",
        minIntervalMs: 50,
        useScript: false,
        script: "",
      };
  }
}

export function addCard(pageId: string, type: ControlType = "slider"): string {
  const page = snapshot.pages.find((p) => p.id === pageId);
  const card = defaultCard(type, `${type}_${(page?.cards.length ?? 0) + 1}`);
  if (page) {
    const hh = card.h;
    const occupied = (x: number, y: number) =>
      page.cards.some(
        (c) =>
          !(
            x + card.w <= c.x ||
            c.x + c.w <= x ||
            y + hh <= c.y ||
            c.y + (c.h || 1) <= y
          ),
      );
    let y = 0;
    while (occupied(0, y) && y < 64) y++;
    card.y = y;
  }
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId ? { ...p, cards: [...p.cards, card] } : p,
    ),
  };
  emit();
  return card.id;
}

export function patchCard(
  pageId: string,
  cardId: string,
  patch: Record<string, unknown>,
) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            cards: p.cards.map((c) =>
              c.id === cardId
                ? (migrateCard({ ...c, ...patch }) as ControlCard)
                : c,
            ),
          }
        : p,
    ),
  };
  emit();
}

export function removeCard(pageId: string, cardId: string) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? { ...p, cards: p.cards.filter((c) => c.id !== cardId) }
        : p,
    ),
  };
  emit();
}

export function moveCard(
  pageId: string,
  cardId: string,
  x: number,
  y: number,
) {
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return;
  const card = page.cards.find((c) => c.id === cardId);
  if (!card) return;
  const ch = card.h || 1;
  const occupied = (nx: number, ny: number) =>
    page.cards.some(
      (c) =>
        c.id !== cardId &&
        !(
          nx + card.w <= c.x ||
          c.x + c.w <= nx ||
          ny + ch <= c.y ||
          c.y + (c.h || 1) <= ny
        ),
    );
  let ny = Math.max(0, y);
  while (occupied(x, ny) && ny < 200) ny++;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            cards: p.cards.map((c) =>
              c.id === cardId ? { ...c, x, y: ny } : c,
            ),
          }
        : p,
    ),
  };
  emit();
}

export function formatTemplate(
  tpl: string,
  value: number,
  mode: SendMode,
): string {
  if (mode === "hex") {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");
    return tpl.replace(/%%/g, hex);
  }
  return tpl
    .replace(
      /%(\d+)?(?:\.(\d+))?([fd])/g,
      (_m: string, _w: string, prec: string, type: string) => {
        if (type === "d") return String(Math.round(value));
        const p = prec === undefined ? 6 : parseInt(prec, 10);
        return value.toFixed(Math.min(p, 12));
      },
    )
    .replace(/%%/g, "%");
}

export function formatJoy(
  tpl: string,
  x: number,
  y: number,
  mode: SendMode,
): string {
  const f = (v: number) => String(Number(v.toFixed(2)));
  if (mode === "hex") {
    const enc = (v: number) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, v, true);
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join(" ");
    };
    return tpl.replace(/%x/g, enc(x)).replace(/%y/g, enc(y));
  }
  return tpl.replace(/%x/g, f(x)).replace(/%y/g, f(y));
}
