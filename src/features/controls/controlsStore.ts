export type SendMode = "ascii" | "hex";

export type ControlType =
  | "slider"
  | "button"
  | "switch"
  | "led"
  | "buzzer"
  | "monitor"
  | "joystick"
  | "keypad"
  | "keymon";

export interface BaseCard {
  id: string;
  type: ControlType;
  name: string;
  x: number;
  y: number;
  w: number;
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

export interface BuzzerCard extends BaseCard {
  type: "buzzer";
  varName: string;
  op: LedOp;
  value: number;
  strValue: string;
  onColor: string;
  freq: number;
  volume: number;
  durationMs: number;
  /** 循环鸣叫时两次鸣叫的间隔（ms） */
  gapMs: number;
  repeat: boolean;
}

/** 键盘遥控：四方向键位触发（按下/松开可各发一条指令） */
export interface KeypadCard extends BaseCard {
  type: "keypad";
  sendMode: SendMode;
  /** 上/下/左/右 的键盘键位（KeyboardEvent.key） */
  keys: string[];
  labels: string[];
  /** 按下时发送的模板（按方向索引） */
  templates: string[];
  /** 松开时发送的模板（空 = 不发送） */
  releaseTemplates: string[];
  useScript: boolean;
  script: string;
}

/** 单键监控：单个键位触发 */
export interface KeymonCard extends BaseCard {
  type: "keymon";
  sendMode: SendMode;
  key: string;
  /** 按下时发送的模板 */
  template: string;
  /** 松开时发送的模板（空 = 不发送） */
  releaseTemplate: string;
  useScript: boolean;
  script: string;
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
  | BuzzerCard
  | MonitorCard
  | JoystickCard
  | KeypadCard
  | KeymonCard;

export const PANEL_TYPE_NAMES: Record<ControlType, string> = {
  slider: "滑条",
  button: "按钮",
  switch: "开关",
  led: "LED 灯",
  buzzer: "蜂鸣器",
  monitor: "数值监视",
  joystick: "摇杆",
  keypad: "键盘遥控",
  keymon: "单键监控",
};

export interface ControlPage {
  id: string;
  name: string;
  cols: number;
  rows: number;
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
    x: Math.max(0, Math.round(Number(raw.x) || 0)),
    y: Math.max(0, Math.round(Number(raw.y) || 0)),
    w: Math.max(1, Math.min(64, Math.round(Number(raw.w) || 1))),
    h: Math.max(1, Math.min(64, Math.round(Number(raw.h) || 1))),
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
    case "buzzer":
      return {
        ...base,
        type,
        varName: String(raw.varName ?? ""),
        op: (raw.op as LedOp) ?? "gt",
        value: Number(raw.value ?? 0),
        strValue: String(raw.strValue ?? ""),
        onColor: String(raw.onColor ?? "#d29922"),
        freq: Math.max(20, Math.min(20000, Number(raw.freq ?? 2000))),
        volume: Math.max(0, Math.min(100, Number(raw.volume ?? 50))),
        durationMs: Math.max(30, Math.min(5000, Number(raw.durationMs ?? 200))),
        gapMs: Math.max(30, Math.min(10000, Number(raw.gapMs ?? 300))),
        repeat: Boolean(raw.repeat),
      };
    case "keypad": {
      // 强制正方形（n×n），历史数据里被拉成长条的自动还原
      const side = Math.max(base.w, base.h);
      const sq = { ...base, w: side, h: side };
      const keys = (raw.keys as string[]) ?? [];
      const labels = (raw.labels as string[]) ?? [];
      const templates = (raw.templates as string[]) ?? [];
      const releaseTemplates = (raw.releaseTemplates as string[]) ?? [];
      const fix = (arr: string[], dflt: string[]) =>
        [0, 1, 2, 3].map((i) => String(arr[i] ?? dflt[i]));
      return {
        ...sq,
        type: "keypad",
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        keys: fix(keys, ["w", "s", "a", "d"]),
        labels: fix(labels, ["上", "下", "左", "右"]),
        templates: fix(templates, ["KEY:U!", "KEY:D!", "KEY:L!", "KEY:R!"]),
        releaseTemplates: fix(releaseTemplates, ["", "", "", ""]),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    }
    case "keymon":
      return {
        ...base,
        type,
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        key: String(raw.key ?? "b"),
        template: String(raw.template ?? "SHOT!"),
        releaseTemplate: String(raw.releaseTemplate ?? ""),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    case "monitor":
      return {
        ...base,
        type,
        varName: String(raw.varName ?? ""),
        unit: String(raw.unit ?? ""),
        decimals: Number(raw.decimals ?? 2),
      };
    case "joystick": {
      const side = Math.max(base.w, base.h);
      return {
        ...base,
        w: side,
        h: side,
        type,
        template: String(raw.template ?? "J:%x,%y!"),
        sendMode: (raw.sendMode as SendMode) ?? "ascii",
        range: Number(raw.range ?? 100),
        minIntervalMs: Number(raw.minIntervalMs ?? 50),
        springBack: raw.springBack === undefined ? true : Boolean(raw.springBack),
        useScript: Boolean(raw.useScript),
        script: String(raw.script ?? ""),
      };
    }
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

/** 统一几何出口：类型形状约束 + 整数化 + 页边界钳制（只动位置不动形状，页缩小时才缩尺寸） */
export function normalizeGeometry(
  card: ControlCard,
  cols: number,
  rows: number,
): ControlCard {
  const c = { ...card };
  // 全字段数值防护：NaN/Infinity/负数/小数一律收敛到合法格尺寸。
  // 任何非法值穿透都会让渲染层算出 sub-cell 宽度（卡片被压成不足一格的扁条）。
  const qw = Math.round(Number(c.w));
  const qh = Math.round(Number(c.h ?? 1));
  c.w = Number.isFinite(qw) && qw >= 1 ? qw : 1;
  c.h = Number.isFinite(qh) && qh >= 1 ? qh : 1;
  if (c.type === "keypad" || c.type === "joystick") {
    const side = Math.max(c.w, c.h);
    c.w = side;
    c.h = side;
  }
  const maxW = Math.max(1, Math.round(Number(cols)) || 1);
  const maxH = Math.max(1, Math.round(Number(rows)) || 1);
  if (c.w > maxW || c.h > maxH) {
    if (c.type === "keypad" || c.type === "joystick") {
      const side = Math.min(c.w, c.h, maxW, maxH);
      c.w = side;
      c.h = side;
    } else {
      c.w = Math.min(c.w, maxW);
      c.h = Math.min(c.h, maxH);
    }
  }
  const qx = Math.round(Number(c.x));
  const qy = Math.round(Number(c.y));
  c.x = Number.isFinite(qx) ? Math.max(0, Math.min(qx, maxW - c.w)) : 0;
  c.y = Number.isFinite(qy) ? Math.max(0, Math.min(qy, maxH - c.h)) : 0;
  return c;
}

function declumpCards(cards: ControlCard[], cols: number, rows: number): ControlCard[] {
  const placed: ControlCard[] = [];
  const free = (x: number, y: number, w: number, h: number) =>
    !placed.some(
      (c) => !(x + w <= c.x || c.x + c.w <= x || y + h <= c.y || c.y + (c.h || 1) <= y),
    );
  const sorted = [...cards].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of sorted) {
    const n = normalizeGeometry(c, cols, rows);
    const w = n.w;
    const h = n.h;
    let x = n.x;
    let y = n.y;
    let guard = 0;
    while (!free(x, y, w, h) && guard < rows * 2) {
      y++;
      if (y > rows - h) {
        y = 0;
        x = x + w > cols - w ? 0 : x + w;
      }
      guard++;
    }
    placed.push({ ...c, w, h, x: Math.max(0, x), y: Math.max(0, y) });
  }
  return placed;
}

function load(): ControlsSnapshot {
  try {
    const saved = localStorage.getItem("vs.controls");
    if (saved) {
      const parsed = JSON.parse(saved) as ControlsSnapshot;
      if (parsed.pages && parsed.pages.length) {
        return {
          activePageId: parsed.activePageId,
          pages: parsed.pages.map((p) => {
            const cols = Math.max(2, Math.min(24, Math.round(Number(p.cols) || 8)));
            const rows = Math.max(2, Math.min(48, Math.round(Number((p as ControlPage).rows) || 8)));
            const cards = (p.cards as unknown as Record<string, unknown>[]).map((r) =>
              r.type === "script" ? migrateLegacyScript(r) : migrateCard(r),
            );
            return {
              ...p,
              cols,
              rows,
              locked: Boolean(p.locked),
              cards: declumpCards(cards, cols, rows),
            };
          }),
        };
      }
    }
  } catch {
    localStorage.removeItem("vs.controls");
  }
  const page: ControlPage = {
    id: crypto.randomUUID(),
    name: "控制页 1",
    cols: 8,
    rows: 8,
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
    cols: 12,
    rows: 12,
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

export function importPage(raw: {
  name?: string;
  cols?: number;
  rows?: number;
  cards?: Record<string, unknown>[];
}): string {
  pushHistoryLike();
  const page: ControlPage = {
    id: crypto.randomUUID(),
    name: String(raw.name ?? "导入控制页").slice(0, 24),
    cols: clampGrid(raw.cols ?? 8, 24),
    rows: clampGrid(raw.rows ?? 8, 48),
    locked: false,
    cards: (raw.cards ?? []).map((r) =>
      r.type === "script" ? migrateLegacyScript(r) : migrateCard(r),
    ),
  };
  snapshot = {
    pages: [...snapshot.pages, page],
    activePageId: page.id,
  };
  emit();
  return page.id;
}

export function exportPages(): ControlPage[] {
  return structuredClone(snapshot.pages);
}

function pushHistoryLike() {
  localStorage.setItem("vs.controls", JSON.stringify(snapshot));
}

export function renamePage(id: string, name: string) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === id ? { ...p, name } : p)),
  };
  emit();
}

export function setPageCols(id: string, cols: number) {
  const nc = clampGrid(cols, 24);
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === id
        ? {
            ...p,
            cols: nc,
            cards: p.cards.map((c) => normalizeGeometry(c, nc, p.rows || 48)),
          }
        : p,
    ),
  };
  emit();
}

export function setPageRows(id: string, rows: number) {
  const nr = clampGrid(rows, 48);
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === id
        ? {
            ...p,
            rows: nr,
            cards: p.cards.map((c) => normalizeGeometry(c, p.cols, nr)),
          }
        : p,
    ),
  };
  emit();
}

function clampGrid(v: number, max: number): number {
  return Math.max(2, Math.min(max, Math.round(Number(v) || 2)));
}

export function setPageLocked(id: string, locked: boolean) {
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === id ? { ...p, locked } : p)),
  };
  emit();
}

function defaultCard(type: ControlType, name: string): ControlCard {
  // monitor 默认 2×2（应用图标式正方，此前 2×1 拖入即扁）
  const size =
    type === "joystick"
      ? { w: 2, h: 2 }
      : type === "keypad"
        ? { w: 3, h: 3 }
        : type === "monitor"
          ? { w: 2, h: 2 }
          : { w: 1, h: 1 };
  const base = {
    id: crypto.randomUUID(),
    type,
    name,
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
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
    case "buzzer":
      return {
        ...base,
        type,
        varName: "",
        op: "gt",
        value: 0,
        strValue: "",
        onColor: "#d29922",
        freq: 2000,
        volume: 50,
        durationMs: 200,
        gapMs: 300,
        repeat: false,
      };
    case "keypad":
      return {
        ...base,
        type,
        sendMode: "ascii",
        keys: ["w", "s", "a", "d"],
        labels: ["上", "下", "左", "右"],
        templates: ["KEY:U!", "KEY:D!", "KEY:L!", "KEY:R!"],
        releaseTemplates: ["", "", "", ""],
        useScript: false,
        script: "",
      };
    case "keymon":
      return {
        ...base,
        type,
        sendMode: "ascii",
        key: "b",
        template: "SHOT!",
        releaseTemplate: "",
        useScript: false,
        script: "",
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
            cards: p.cards.map((c) => {
              if (c.id !== cardId) return c;
              const merged = migrateCard({ ...c, ...patch }) as ControlCard;
              return normalizeGeometry(merged, p.cols, p.rows || 48);
            }),
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

export function declumpPage(pageId: string) {
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? { ...p, cards: declumpCards(p.cards, p.cols, p.rows || 8) }
        : p,
    ),
  };
  emit();
}

/** 修复重叠：只挪动确实与其他卡片重叠的卡片（就近找空位），不动正常卡片 */
export function resolveOverlaps(pageId: string) {
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page) return;
  const cols = page.cols;
  const rows = page.rows || 8;
  const cards = page.cards.map((c) => ({ ...c }));
  const placed: ControlCard[] = [];
  const free = (x: number, y: number, w: number, h: number) =>
    !placed.some(
      (c) => !(x + w <= c.x || c.x + c.w <= x || y + h <= c.y || c.y + (c.h || 1) <= y),
    );
  let changed = false;
  for (const c of cards) {
    const ch = c.h || 1;
    if (free(c.x, c.y, c.w, ch)) {
      placed.push(c);
      continue;
    }
    // 就近搜索空位（环形，半径最多撑满画布）
    let found: { x: number; y: number } | null = null;
    const maxR = Math.max(cols, rows);
    for (let r = 0; r <= maxR && !found; r++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = c.x + dx;
          const y = c.y + dy;
          if (x < 0 || y < 0 || x + c.w > cols || y + ch > rows) continue;
          if (free(x, y, c.w, ch)) found = { x, y };
        }
      }
    }
    if (found) {
      c.x = found.x;
      c.y = found.y;
      changed = true;
    }
    placed.push(c);
  }
  if (!changed) return;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) => (p.id === pageId ? { ...p, cards } : p)),
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
  const maxX = Math.max(0, page.cols - card.w);
  const maxY = Math.max(0, (page.rows || 48) - ch);
  const cx = Math.max(0, Math.min(x, maxX));
  const cy = Math.max(0, Math.min(y, maxY));
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            cards: p.cards.map((c) =>
              c.id === cardId ? { ...c, x: cx, y: cy } : c,
            ),
          }
        : p,
    ),
  };
  emit();
}

export function findCardByName(
  name: string,
): { pageId: string; card: ControlCard } | null {
  for (const p of snapshot.pages) {
    const c = p.cards.find((x) => x.name === name);
    if (c) return { pageId: p.id, card: c };
  }
  return null;
}

let clipboard: ControlCard | null = null;

export function copyCard(pageId: string, cardId: string) {
  const page = snapshot.pages.find((p) => p.id === pageId);
  const card = page?.cards.find((c) => c.id === cardId);
  if (card) clipboard = structuredClone(card);
}

export function hasClipboard(): boolean {
  return clipboard !== null;
}

/** 粘贴卡片：全属性复制，新 id，名字自动 _1/_2；gx/gy 为期望左上格坐标，被占则就近找空位 */
export function pasteCard(
  pageId: string,
  gx?: number,
  gy?: number,
): string | null {
  const page = snapshot.pages.find((p) => p.id === pageId);
  if (!page || !clipboard) return null;
  const rows = page.rows || 48;
  const card = normalizeGeometry(
    structuredClone(clipboard),
    page.cols,
    rows,
  );
  card.id = crypto.randomUUID();
  const base = card.name.replace(/_\d+$/, "") || card.name;
  const used = new Set(page.cards.map((c) => c.name));
  let i = 1;
  while (used.has(`${base}_${i}`)) i++;
  card.name = `${base}_${i}`;
  const tx = Math.max(0, Math.min(Math.round(gx ?? 0), page.cols - card.w));
  const ty = Math.max(0, Math.min(Math.round(gy ?? 0), rows - card.h));
  const freeAt = (x: number, y: number) =>
    !page.cards.some(
      (c) =>
        !(
          x + card.w <= c.x ||
          c.x + c.w <= x ||
          y + card.h <= c.y ||
          c.y + c.h <= y
        ),
    );
  let pos = { x: tx, y: ty };
  if (!freeAt(tx, ty)) {
    let found: { x: number; y: number } | null = null;
    const maxR = Math.max(page.cols, rows);
    for (let r = 0; r <= maxR && !found; r++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        for (let dy = -r; dy <= r && !found; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x + card.w > page.cols || y + card.h > rows)
            continue;
          if (freeAt(x, y)) found = { x, y };
        }
      }
    }
    if (found) pos = found;
  }
  card.x = pos.x;
  card.y = pos.y;
  snapshot = {
    ...snapshot,
    pages: snapshot.pages.map((p) =>
      p.id === pageId ? { ...p, cards: [...p.cards, card] } : p,
    ),
  };
  emit();
  return card.id;
}

export function findCardById(
  cardId: string,
): { pageId: string; card: ControlCard } | null {
  for (const p of snapshot.pages) {
    const c = p.cards.find((x) => x.id === cardId);
    if (c) return { pageId: p.id, card: c };
  }
  return null;
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
