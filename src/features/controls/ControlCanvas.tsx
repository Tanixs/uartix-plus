import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as store from "./controlsStore";
import type { ControlCard, ControlType, SendMode, SliderCard } from "./controlsStore";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "./variableStore";
import * as commandStore from "./commandStore";
import { isGroup } from "./commandStore";
import { useSettings } from "../settings/settingsStore";
import { beep, runScript } from "./scriptRunner";
import { TextInput } from "../protocol/PropertiesPanel";
import { WIDGET_ICONS, IconLock, IconUnlock, IconSidebar, IconSlider, IconChevron } from "../../shared/icons";
import { EmptyState } from "../../shared/EmptyState";
import { Flyout } from "../../shared/Flyout";
import type { CommandItem, CommandNode } from "./commandStore";
import {
  BuzzerCardView,
  ButtonCardView,
  CardModal,
  JoystickCardView,
  LedCardView,
  MonitorCardView,
  SliderCardView,
  SwitchCardView,
} from "./CardViews";

const GAP = 8;
const OFF = GAP / 2;


const WIDGET_TYPES: { type: ControlType; label: string }[] = [
  { type: "slider", label: "滑条" },
  { type: "button", label: "按钮" },
  { type: "switch", label: "开关" },
  { type: "led", label: "LED 灯" },
  { type: "buzzer", label: "蜂鸣器" },
  { type: "monitor", label: "数值监视" },
  { type: "joystick", label: "摇杆" },
];

function MountCascade(props: {
  anchorEl: HTMLElement | null;
  zf: number;
  onArm: () => void;
  onDisarm: () => void;
  onPick: (item: CommandItem) => void;
}) {
  const cmds = useSyncExternalStore(commandStore.subscribe, commandStore.getSnapshot);
  const [path, setPath] = useState<string[]>([]);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());

  const childrenOf = (id: string | null): CommandNode[] => {
    const walk = (ns: CommandNode[]): CommandNode[] | null => {
      for (const n of ns) {
        if (!isGroup(n)) continue;
        if (n.id === id) return n.items;
        const sub = walk(n.items);
        if (sub) return sub;
      }
      return null;
    };
    return id === null ? cmds.groups : (walk(cmds.groups) ?? []);
  };

  const levels: CommandNode[][] = [];
  for (let i = 0; i <= path.length; i++) {
    levels.push(childrenOf(i === 0 ? null : path[i - 1]));
  }

  return (
    <>
      {levels.map((nodes, i) => (
        <Flyout
          key={i}
          anchor={i === 0 ? props.anchorEl : (rowRefs.current.get(path[i - 1]) ?? null)}
          zf={props.zf}
          onArm={props.onArm}
          onDisarm={props.onDisarm}
        >
          {nodes.length === 0 && (
            <div className="ctx-group">
              {i === 0 ? "命令库为空（左侧「命令」Tab 添加）" : "空分组"}
            </div>
          )}
          {nodes.map((n) =>
            isGroup(n) ? (
              <div
                key={n.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(n.id, el);
                  else rowRefs.current.delete(n.id);
                }}
                className="ctx-item ctx-has-sub"
                onMouseEnter={() => {
                  props.onDisarm();
                  setPath([...path.slice(0, i), n.id]);
                }}
              >
                {n.name} <span className="ctx-arrow"><IconChevron size={12} /></span>
              </div>
            ) : (
              <button
                key={n.id}
                className="ctx-item"
                title={n.scriptEnabled && n.script ? "脚本命令" : n.template}
                onClick={() => props.onPick(n)}
                onMouseEnter={() => {
                  props.onDisarm();
                  setPath(path.slice(0, i));
                }}
              >
                {n.name}
                {n.scriptEnabled && n.script ? " ⚡" : ""}
              </button>
            ),
          )}
        </Flyout>
      ))}
    </>
  );
}

export function ControlCanvas() {
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const settings = useSettings();
  const CELL = [48, 60, 72, 90, 110].includes(settings.cellSize) ? settings.cellSize : 60;
  // 全局 CSS zoom 会让卡片边框与背景网格线落在不同取整结果上（视觉间隙随机），
  // 这里把几何值预先取整到 zoom 缩放后的整数设备像素，保证间隙恒定。
  const zfactor = (settings.zoom || 100) / 100;
  const snapPx = (v: number) => (zfactor === 1 ? v : Math.round(v * zfactor) / zfactor);
  const showGhost = (
    gx: number,
    gy: number,
    gw: number,
    gh: number,
    ok: boolean,
  ) => {
    const g = ghostRef.current;
    if (!g) return;
    const step = CELL + GAP;
    g.style.display = "block";
    g.style.left = `${snapPx(gx * step + OFF)}px`;
    g.style.top = `${snapPx(gy * step + OFF)}px`;
    g.style.width = `${snapPx(gw * step - GAP)}px`;
    g.style.height = `${snapPx(gh * step - GAP)}px`;
    g.className = `ctl-ghost ${ok ? "ok" : "bad"}`;
  };
  const hideGhost = () => {
    const g = ghostRef.current;
    if (g) g.style.display = "none";
  };
  const cmds = useSyncExternalStore(commandStore.subscribe, commandStore.getSnapshot);
  const page = store.activePage();
  const gridRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const valuesRef = useRef<Map<string, number>>(new Map());
  const throttleRef = useRef<
    Map<string, { last: number; pending: number | null; timer: number | null }>
  >(new Map());
  const dragRef = useRef<
    | null
    | {
        card: ControlCard;
        el: HTMLDivElement;
        moved: boolean;
        /** 按下时指针 client 坐标 */
        startClientX: number;
        startClientY: number;
        /** 卡片初始逻辑像素位置（含 OFF） */
        cardLeft0: number;
        cardTop0: number;
        /** 网格内容器按下时 rect 宽度（用于实测缩放比，规避 offsetWidth 新旧规范差异） */
        innerW0: number;
        /** 当前落点候选（幽灵框位置） */
        settleX: number;
        settleY: number;
        /** 落点候选是否合法 */
        valid: boolean;
      }
  >(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<
    | null
    | {
        card: ControlCard;
        el: HTMLDivElement;
        startClientX: number;
        startClientY: number;
        innerW0: number;
        w?: number;
        h?: number;
      }
  >(null);

  /**
   * 实测缩放比：用"当前 rect 宽 / 按下时 rect 宽"两个同源测量值的比值，
   * 不依赖 offsetWidth（新版 WebView2/Chromium 的 offsetWidth 已含 zoom，
   * 旧的 rect/offsetWidth 换算在新内核下恒为 1，曾导致拖拽时指针与卡片分离）。
   */
  const liveScale = (innerW0: number) => {
    const g = gridRef.current;
    if (!g || !innerW0) return 1;
    return g.getBoundingClientRect().width / innerW0;
  };
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [mountOpen, setMountOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const mountAnchorRef = useRef<HTMLDivElement | null>(null);
  const mountCloseRef = useRef<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [renamingCard, setRenamingCard] = useState<string | null>(null);
  const [renamingPage, setRenamingPage] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<"widgets" | "commands" | null>(null);
  const [editingCmd, setEditingCmd] = useState<string | null>(null);
  const [renamingNode, setRenamingNode] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [flashCmd, setFlashCmd] = useState<string | null>(null);
  const [cmdMenu, setCmdMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [cmdMenuPos, setCmdMenuPos] = useState<{ left: number; top: number } | null>(null);
  const cmdMenuRef = useRef<HTMLDivElement | null>(null);
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    pos: "before" | "after" | "into";
  } | null>(null);
  const dragNodeRef = useRef<{ id: string; kind: "cmd" | "group" } | null>(null);
  const dropPosRef = useRef<{ id: string; pos: "before" | "after" | "into" } | null>(null);

  const doMove = (
    dragId: string,
    refId: string,
    pos: "before" | "after" | "into",
  ): boolean => {
    if (pos === "into") {
      if (commandStore.moveNode(dragId, refId)) return true;
      setErr("不能移动到自己的子分组内");
      return false;
    }
    const parent = commandStore.parentOfId(refId) ?? null;
    if (commandStore.moveNode(dragId, parent, refId, pos === "before"))
      return true;
    if (parent !== null && commandStore.moveNode(dragId, parent)) return true;
    return false;
  };
  const [sideW, setSideW] = useState(190);
  const sideDragRef = useRef<null | { startX: number; w0: number }>(null);

  useEffect(() => {
    if (!groupMenuId) return;
    const close = () => setGroupMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [groupMenuId]);

  useEffect(() => {
    if (!cmdMenu) return;
    const close = () => setCmdMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [cmdMenu]);

  useLayoutEffect(() => {
    if (!cmdMenu || !cmdMenuRef.current) return;
    const r = cmdMenuRef.current.getBoundingClientRect();
    const zf = zfactor || 1;
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    let left = Math.max(8, Math.min(cmdMenu.x / zf, vw - w - 8));
    let top = cmdMenu.y / zf;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    setCmdMenuPos({ left, top });
  }, [cmdMenu, zfactor]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = sideDragRef.current;
      if (!d) return;
      setSideW(Math.max(140, Math.min(420, d.w0 + (e.clientX - d.startX))));
    };
    const up = () => {
      sideDragRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  useEffect(() => {
    const STEP = CELL + GAP;
    const move = (e: MouseEvent) => {
      const rz = resizeRef.current;
      if (rz) {
        const cur = store.activePage();
        const maxW = Math.max(1, (cur?.cols ?? 8) - rz.card.x);
        const maxH = Math.max(1, (cur?.rows || 48) - rz.card.y);
        const scale = liveScale(rz.innerW0);
        const nw0 = Math.max(
          1,
          Math.min(maxW, rz.card.w + Math.round((e.clientX - rz.startClientX) / (STEP * scale))),
        );
        const nh0 = Math.max(
          1,
          Math.min(maxH, (rz.card.h || 1) + Math.round((e.clientY - rz.startClientY) / (STEP * scale))),
        );
        const isJoy = rz.card.type === "joystick";
        const nw = isJoy ? Math.min(nw0, nh0) : nw0;
        const nh = isJoy ? Math.min(nw0, nh0) : nh0;
        rz.w = nw;
        rz.h = nh;
        rz.el.style.width = `${snapPx(nw * STEP - GAP)}px`;
        rz.el.style.height = `${snapPx(nh * STEP - GAP)}px`;
        rz.el.style.zIndex = "60";
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      // 释放保护：指针在窗口外松开时 mouseup 可能丢失（buttons=0 说明已松开）
      if (e.buttons === 0) {
        finish();
        return;
      }
      if (!d.moved) {
        const sdx = e.clientX - d.startClientX;
        const sdy = e.clientY - d.startClientY;
        if (Math.abs(sdx) < 3 && Math.abs(sdy) < 3) return;
        d.moved = true;
        // 卡片本体原地变暗，不跟随指针——拖动期间任何东西都不会与其他卡片重叠
        d.el.classList.add("drag-src");
      }
      const cur = store.activePage();
      if (!cur) return;
      const cols = cur.cols ?? 8;
      const rows = cur.rows || 48;
      const ch = d.card.h || 1;
      // 指针逻辑位移（用于推导目标格）
      const scale = liveScale(d.innerW0);
      const leftPx = d.cardLeft0 + (e.clientX - d.startClientX) / scale;
      const topPx = d.cardTop0 + (e.clientY - d.startClientY) / scale;
      // 落点格（clamp 在画布内）
      const tx = Math.max(0, Math.min(cols - d.card.w, Math.round((leftPx - OFF) / STEP)));
      const ty = Math.max(0, Math.min(rows - ch, Math.round((topPx - OFF) / STEP)));
      // 落点候选：目标格空 → 直接用；占用 → 半径 2 格内找最近空位（禁长距离瞬移）
      const s = settleNear(cur, d.card, tx, ty);
      if (s) {
        d.valid = true;
        d.settleX = s.x;
        d.settleY = s.y;
        showGhost(s.x, s.y, d.card.w, ch, true);
      } else {
        d.valid = false;
        showGhost(tx, ty, d.card.w, ch, false);
      }
    };
    const finish = () => {
      const rz = resizeRef.current;
      if (rz) {
        resizeRef.current = null;
        rz.el.style.zIndex = "";
        const cur = store.activePage();
        if (!cur) {
          rz.el.style.width = "";
          rz.el.style.height = "";
          return;
        }
        const nw = rz.w ?? rz.card.w;
        const nh = rz.h ?? (rz.card.h || 1);
        const hit = (w: number, h: number) =>
          cur.cards.some(
            (c) =>
              c.id !== rz.card.id &&
              !(
                rz.card.x + w <= c.x ||
                c.x + c.w <= rz.card.x ||
                rz.card.y + h <= c.y ||
                c.y + (c.h || 1) <= rz.card.y
              ),
          );
        let fw = nw;
        let fh = nh;
        while (fw > 1 && hit(fw, fh)) fw--;
        while (fh > 1 && hit(fw, fh)) fh--;
        if (rz.card.type === "joystick") {
          const n = Math.min(fw, fh);
          fw = n;
          fh = n;
        }
        if (fw === rz.card.w && fh === (rz.card.h || 1)) {
          rz.el.style.width = `${snapPx(fw * STEP - GAP)}px`;
          rz.el.style.height = `${snapPx(fh * STEP - GAP)}px`;
          return;
        }
        rz.el.style.width = "";
        rz.el.style.height = "";
        store.patchCard(cur.id, rz.card.id, { w: fw, h: fh });
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      d.el.classList.remove("drag-src");
      hideGhost();
      if (!d.moved) return;
      const cur = store.activePage();
      if (!cur) return;
      // 无合法落点 → 卡片回原位（本体一直没动）
      if (!d.valid) return;
      if (d.settleX !== d.card.x || d.settleY !== d.card.y) {
        store.moveCard(cur.id, d.card.id, d.settleX, d.settleY);
      }
      // 保险：修复历史遗留的重叠卡片（只挪动确实重叠的）
      store.resolveOverlaps(cur.id);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
    };
  }, [CELL, zfactor]);

  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(null);
      setMountOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const zf = zfactor || 1;
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    let left = Math.max(8, Math.min(menu.x / zf, vw - w - 8));
    let top = menu.y / zf;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    setMenuPos({ left, top });
  }, [menu, zfactor]);

  const armMountClose = () => {
    if (mountCloseRef.current !== null) window.clearTimeout(mountCloseRef.current);
    mountCloseRef.current = window.setTimeout(() => setMountOpen(false), 300);
  };
  const disarmMountClose = () => {
    if (mountCloseRef.current !== null) {
      window.clearTimeout(mountCloseRef.current);
      mountCloseRef.current = null;
    }
  };
  useEffect(
    () => () => {
      if (mountCloseRef.current !== null) window.clearTimeout(mountCloseRef.current);
    },
    [],
  );

  if (!page) {
    return <div className="ctl"><div className="ctl-empty">无控制页</div></div>;
  }

  const getVal = (c: SliderCard): number =>
    valuesRef.current.get(c.id) ?? c.defaultValue;

  const sendRaw = async (mode: SendMode, text: string) => {
    try {
      await serialStore.sendData(mode, text);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  const runCardScript = async (
    script: string,
    ctx: Record<string, number | string>,
  ) => {
    const vars = variableStore
      .listVars()
      .map((vd) => ({
        name: vd.name,
        value: variableStore.getVar(vd.name) ?? (vd.kind === "str" ? "" : 0),
      }));
    for (const [k, v] of Object.entries(ctx)) vars.push({ name: k, value: v });
    await runScript(script, {
      send: (text, mode) => sendRaw(mode ?? "ascii", String(text)),
      beep,
      delay_ms: (ms: number) =>
        new Promise<void>((r) => setTimeout(r, Math.max(0, ms))),
      get: (name: string) => variableStore.getVar(name),
    }, vars);
  };

  const sendControl = async (
    card: ControlCard,
    ctx: Record<string, number | string>,
    force = false,
  ) => {
    if (
      card.type !== "led" &&
      card.type !== "buzzer" &&
      card.type !== "monitor" &&
      card.useScript
    ) {
      try {
        await runCardScript(card.script, ctx);
        setErr(null);
      } catch (e) {
        setErr(String(e));
      }
      return;
    }
    switch (card.type) {
      case "slider": {
        const value = Number(ctx.value ?? getVal(card));
        if (!force && card.sendTrigger === "continuous") {
          throttledSend(card, value);
        } else {
          doSend(card, value);
        }
        break;
      }
      case "button":
        await sendRaw(card.sendMode, variableStore.resolveVars(card.template));
        break;
      case "switch": {
        const i = Number(ctx.state ?? card.state);
        await sendRaw(
          card.sendMode,
          variableStore.resolveVars(card.templates[i] ?? ""),
        );
        break;
      }
      case "joystick":
        await sendRaw(
          card.sendMode,
          store.formatJoy(
            variableStore.resolveVars(card.template),
            Number(ctx.x ?? 0),
            Number(ctx.y ?? 0),
            card.sendMode,
          ),
        );
        break;
      default:
        break;
    }
  };

  const doSend = async (card: SliderCard, value: number) => {
    const text = store.formatTemplate(
      variableStore.resolveVars(card.template),
      value,
      card.sendMode,
    );
    try {
      await serialStore.sendData(card.sendMode, text);
      setErr(null);
      const st = throttleRef.current.get(card.id);
      if (st) {
        st.last = Date.now();
        st.pending = null;
        if (st.timer) {
          clearTimeout(st.timer);
          st.timer = null;
        }
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  const throttledSend = (card: SliderCard, value: number) => {
    const st =
      throttleRef.current.get(card.id) ??
      { last: 0, pending: null as number | null, timer: null as number | null };
    throttleRef.current.set(card.id, st);
    const now = Date.now();
    const dt = now - st.last;
    if (dt >= card.minIntervalMs) {
      st.last = now;
      doSend(card, value);
    } else {
      st.pending = value;
      if (!st.timer) {
        st.timer = window.setTimeout(() => {
          st.timer = null;
          if (st.pending !== null) {
            const v = st.pending;
            st.pending = null;
            st.last = Date.now();
            doSend(card, v);
          }
        }, card.minIntervalMs - dt);
      }
    }
  };

  const onValue = (card: SliderCard, v: number) => {
    valuesRef.current.set(card.id, v);
    if (card.sendTrigger === "continuous") {
      if (card.useScript) {
        void sendControl(card, { value: v });
      } else {
        throttledSend(card, v);
      }
    }
  };

  const onRelease = (card: SliderCard, v: number) => {
    valuesRef.current.set(card.id, v);
    if (card.sendTrigger === "onRelease") void sendControl(card, { value: v }, true);
  };

  const onCardDragStart = (e: React.MouseEvent<HTMLDivElement>, card: ControlCard) => {
    if (e.button !== 0 || page.locked) return;
    const el = (e.currentTarget as HTMLElement).closest(
      ".ctl-card",
    ) as HTMLDivElement;
    const inner = gridRef.current;
    if (!inner) return;
    dragRef.current = {
      card,
      el,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      cardLeft0: card.x * (CELL + GAP) + OFF,
      cardTop0: card.y * (CELL + GAP) + OFF,
      innerW0: inner.getBoundingClientRect().width,
      settleX: card.x,
      settleY: card.y,
      valid: true,
    };
  };

  /** 落点候选：目标格空 → 直接用；占用 → 仅在半径 radius 格内找最近空位（找不到返回 null，禁长距离瞬移） */
  const settleNear = (
    cur: { cards: ControlCard[]; cols: number; rows?: number },
    card: ControlCard,
    nx: number,
    ny: number,
    radius = 2,
  ): { x: number; y: number } | null => {
    const ch = card.h || 1;
    const cols = cur.cols ?? 8;
    const rows = cur.rows || 48;
    const occ = (x: number, y: number) =>
      cur.cards.some(
        (c) =>
          c.id !== card.id &&
          !(x + card.w <= c.x || c.x + c.w <= x || y + ch <= c.y || c.y + (c.h || 1) <= y),
      );
    if (!occ(nx, ny)) return { x: nx, y: ny };
    for (let r = 1; r <= radius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = nx + dx;
          const y = ny + dy;
          if (x < 0 || y < 0 || x + card.w > cols || y + ch > rows) continue;
          if (!occ(x, y)) return { x, y };
        }
      }
    }
    return null;
  };

  const onResizeStart = (e: React.MouseEvent, card: ControlCard) => {
    if (e.button !== 0 || page.locked) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const el = wrap.querySelector<HTMLDivElement>(
      `.ctl-card[data-id="${card.id}"]`,
    );
    if (!el) return;
    e.preventDefault();
    const inner = gridRef.current;
    if (!inner) return;
    resizeRef.current = {
      card,
      el,
      startClientX: e.clientX,
      startClientY: e.clientY,
      innerW0: inner.getBoundingClientRect().width,
    };
  };

  const mountCommand = (
    card: ControlCard,
    cmd: {
      template: string;
      sendMode: SendMode;
      script: string;
      scriptEnabled: boolean;
    },
  ) => {
    const useScript = !!cmd.scriptEnabled && !!cmd.script;
    if (card.type === "switch" && !useScript) {
      const templates = [...card.templates];
      templates[card.state] = cmd.template;
      store.patchCard(page.id, card.id, {
        templates,
        sendMode: cmd.sendMode,
        useScript: false,
        script: "",
      });
    } else {
      store.patchCard(page.id, card.id, {
        template: cmd.template,
        sendMode: cmd.sendMode,
        useScript,
        script: cmd.script,
      });
    }
  };

  const STEP = CELL + GAP;
  const usedRows = page.cards.reduce((m, c) => Math.max(m, c.y + (c.h || 1)), 1);
  const gridRows = Math.max(page.rows || 8, usedRows);
  const menuCard = menu ? page.cards.find((c) => c.id === menu.cardId) : null;
  const editCard = editing ? page.cards.find((c) => c.id === editing) : null;
  const ctxFor = (c: ControlCard): Record<string, number | string> => {
    switch (c.type) {
      case "slider":
        return { value: getVal(c) };
      case "switch":
        return { state: c.state };
      case "joystick":
        return { x: 0, y: 0 };
      default:
        return {};
    }
  };

  const editCmdItem = editingCmd
    ? commandStore.getCommand(editingCmd)
    : null;
  const canSend = (c: ControlCard) =>
    c.type === "slider" ||
    c.type === "button" ||
    c.type === "switch" ||
    c.type === "joystick";

  const renderCard = (c: ControlCard) => {
    const ch = c.h || 1;
    const geo = {
      left: snapPx(c.x * STEP + OFF),
      top: snapPx(c.y * STEP + OFF),
      width: snapPx(c.w * STEP - GAP),
      height: snapPx(ch * STEP - GAP),
    };
    const common = {
      card: c,
      left: geo.left,
      top: geo.top,
      width: geo.width,
      height: geo.height,
      renaming: renamingCard === c.id,
      locked: page.locked,
      onMenu: (card: ControlCard, x: number, y: number) => {
        setMenuPos(null);
        setMountOpen(false);
        setMenu({ cardId: card.id, x, y });
      },
      onDragStart: onCardDragStart,
      onRenameCommit: (name: string) => {
        if (name.trim()) store.patchCard(page.id, c.id, { name: name.trim() });
        setRenamingCard(null);
      },
      onRenameCancel: () => setRenamingCard(null),
      onDropTemplate: (
        card: ControlCard,
        cmd: {
          template: string;
          sendMode: SendMode;
          script: string;
          scriptEnabled: boolean;
        },
      ) => mountCommand(card, cmd),
      resizable: !page.locked,
      onResizeStart,
    };
    switch (c.type) {
      case "slider":
        return (
          <SliderCardView
            key={c.id}
            {...common}
            card={c}
            initial={getVal(c)}
            onValue={onValue}
            onRelease={onRelease}
          />
        );
      case "button":
        return <ButtonCardView key={c.id} {...common} card={c} onSend={sendControl} />;
      case "switch":
        return <SwitchCardView key={c.id} {...common} card={c} onSend={sendControl} />;
      case "led":
        return <LedCardView key={c.id} {...common} card={c} />;
      case "buzzer":
        return <BuzzerCardView key={c.id} {...common} card={c} />;
      case "monitor":
        return <MonitorCardView key={c.id} {...common} card={c} />;
      case "joystick":
        return <JoystickCardView key={c.id} {...common} card={c} onSend={sendControl} />;
      default:
        return null;
    }
  };

  const renderCmdTree = (items: commandStore.CommandNode[], depth: number) => (
    <>
      {items.map((n) => {
        if (isGroup(n)) {
          const collapsed = collapsedGroups.has(n.id);
          return (
            <div key={n.id} className="cmd-group" style={{ marginLeft: depth ? 10 : 0 }}>
              <div
                className={`cmd-group-head${
                  dropTarget && dropTarget.id === n.id
                    ? dropTarget.pos === "into"
                      ? " drop-into"
                      : dropTarget.pos === "before"
                        ? " drop-before"
                        : " drop-after"
                    : ""
                }`}
                draggable={renamingNode !== n.id}
                onDragStart={(e) => {
                  dragNodeRef.current = { id: n.id, kind: "group" };
                  e.dataTransfer.setData("application/x-vs-node", n.id);
                  e.dataTransfer.effectAllowed = "copyMove";
                }}
                onDragEnd={() => {
                  dragNodeRef.current = null;
                  setDropTarget(null);
                }}
                onDragOver={(e) => {
                  const d = dragNodeRef.current;
                  if (!d || d.id === n.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  const r = e.currentTarget.getBoundingClientRect();
                  const t = (e.clientY - r.top) / Math.max(1, r.height);
                  const pos = t < 0.33 ? "before" : t > 0.67 ? "after" : "into";
                  dropPosRef.current = { id: n.id, pos };
                  setDropTarget((p) =>
                    p && p.id === n.id && p.pos === pos
                      ? p
                      : { id: n.id, pos },
                  );
                }}
                onDragLeave={() => {
                  if (dropPosRef.current?.id === n.id) dropPosRef.current = null;
                  setDropTarget((p) => (p && p.id === n.id ? null : p));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const d = dragNodeRef.current;
                  const dt = dropPosRef.current;
                  dropPosRef.current = null;
                  setDropTarget(null);
                  dragNodeRef.current = null;
                  if (!d || d.id === n.id) return;
                  const pos = dt && dt.id === n.id ? dt.pos : "into";
                  doMove(d.id, n.id, pos);
                }}
              >
                <button
                  className="cmd-fold"
                  title={collapsed ? "展开" : "折叠"}
                  onClick={() => {
                    const next = new Set(collapsedGroups);
                    if (collapsed) next.delete(n.id);
                    else next.add(n.id);
                    setCollapsedGroups(next);
                  }}
                >
                  <IconChevron size={13} dir={collapsed ? "right" : "down"} />
                </button>
                <span
                  className="cmd-group-name"
                  onDoubleClick={() => setRenamingNode(n.id)}
                >
                  {renamingNode === n.id ? (
                    <input
                      className="input ctl-tab-rename"
                      autoFocus
                      defaultValue={n.name}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        commandStore.renameNode(n.id, e.target.value.trim() || n.name);
                        setRenamingNode(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commandStore.renameNode(
                            n.id,
                            (e.target as HTMLInputElement).value.trim() || n.name,
                          );
                          setRenamingNode(null);
                        }
                        if (e.key === "Escape") setRenamingNode(null);
                      }}
                    />
                  ) : (
                    n.name
                  )}
                </span>
                <button
                  className="cmd-add-toggle"
                  title="添加命令 / 子分组"
                  onClick={(e) => {
                    e.stopPropagation();
                    setGroupMenuId(groupMenuId === n.id ? null : n.id);
                  }}
                >
                  ＋<IconChevron size={11} dir="down" />
                </button>
                {groupMenuId === n.id && (
                  <div
                    className="cmd-group-menu"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => {
                        commandStore.addCommand(n.id);
                        setGroupMenuId(null);
                      }}
                    >
                      ＋ 添加命令
                    </button>
                    <button
                      onClick={() => {
                        commandStore.addGroup("子分组", n.id);
                        setGroupMenuId(null);
                      }}
                    >
                      ＋ 添加子分组
                    </button>
                  </div>
                )}
                <button title="删除分组" onClick={() => commandStore.removeNode(n.id)}>×</button>
              </div>
              {!collapsed &&
                (renamingNode === n.id ? null : renderCmdTree(n.items, depth + 1))}
            </div>
          );
        }
        const editing = editingCmd === n.id;
        return (
          <div key={n.id} className="cmd-item-wrap" style={{ marginLeft: depth ? 10 : 0 }}>
            <div
              className={`cmd-item ${n.scriptEnabled && n.script ? "script" : ""} ${flashCmd === n.id ? "flash" : ""} ${
                dropTarget && dropTarget.id === n.id
                  ? dropTarget.pos === "before"
                    ? " drop-before"
                    : " drop-after"
                  : ""
              }`}
              draggable
              onDragStart={(e) => {
                dragNodeRef.current = { id: n.id, kind: "cmd" };
                e.dataTransfer.setData(
                  "text/vs-cmd",
                  JSON.stringify({
                    template: n.template,
                    sendMode: n.sendMode,
                    script: n.script,
                    scriptEnabled: n.scriptEnabled,
                    name: n.name,
                  }),
                );
                e.dataTransfer.setData("application/x-vs-node", n.id);
                e.dataTransfer.effectAllowed = "copyMove";
              }}
              onDragEnd={() => {
                dragNodeRef.current = null;
                setDropTarget(null);
              }}
              onDragOver={(e) => {
                const d = dragNodeRef.current;
                if (!d || d.id === n.id) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                const r = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > r.top + r.height / 2;
                const pos = after ? "after" : "before";
                dropPosRef.current = { id: n.id, pos };
                setDropTarget((p) =>
                  p && p.id === n.id && p.pos === pos ? p : { id: n.id, pos },
                );
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const d = dragNodeRef.current;
                const dt = dropPosRef.current;
                dropPosRef.current = null;
                setDropTarget(null);
                dragNodeRef.current = null;
                if (!d || d.id === n.id) return;
                const pos = dt && dt.id === n.id ? dt.pos : "after";
                doMove(d.id, n.id, pos);
              }}
              onClick={() => {
                if (n.scriptEnabled && n.script) {
                  runCardScript(n.script, {})
                    .then(() => setErr(null))
                    .catch((er) => setErr(String(er)));
                } else {
                  sendRaw(
                    n.sendMode,
                    variableStore.resolveVars(n.template),
                  ).catch((er) => setErr(String(er)));
                }
                setFlashCmd(n.id);
                window.setTimeout(() => setFlashCmd(null), 500);
              }}
              onDoubleClick={() => setEditingCmd(editing ? null : n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCmdMenuPos(null);
                setCmdMenu({ id: n.id, x: e.clientX, y: e.clientY });
              }}
              title="单击发送 · 双击编辑 · 右键更多 · 可拖到画布部署"
            >
              <span className="cmd-item-name">{n.name}</span>
              <span className="cmd-item-tpl">
                {n.scriptEnabled && n.script ? "⚡脚本" : n.template}
              </span>
              <button
                className="cmd-edit"
                title="编辑命令"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingCmd(editing ? null : n.id);
                }}
              >
                ✎
              </button>
            </div>
            {editing && <div className="cmd-edit-hint">编辑中…（右侧弹窗）</div>}
          </div>
        );
      })}
    </>
  );

  return (
    <div className="ctl">
      <div className="ctl-tabs">
        {s.pages.map((p) => (
          <div
            key={p.id}
            className={`ctl-tab ${p.id === s.activePageId ? "active" : ""}`}
            onClick={() => store.setActivePage(p.id)}
            onDoubleClick={() => setRenamingPage(p.id)}
            title="双击重命名"
          >
            {renamingPage === p.id ? (
              <input
                className="input ctl-tab-rename"
                autoFocus
                defaultValue={p.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  store.renamePage(p.id, e.target.value.trim() || p.name);
                  setRenamingPage(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    store.renamePage(
                      p.id,
                      (e.target as HTMLInputElement).value.trim() || p.name,
                    );
                    setRenamingPage(null);
                  }
                  if (e.key === "Escape") setRenamingPage(null);
                }}
              />
            ) : (
              <span className="ctl-tab-name">{p.name}</span>
            )}
            {s.pages.length > 1 && (
              <button
                className="ctl-tab-x"
                title="删除控制页"
                onClick={(e) => {
                  e.stopPropagation();
                  store.removePage(p.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          className="ctl-tab-add"
          onClick={() => store.addPage()}
          title="新建控制页"
        >
          ＋
        </button>
        <button
          className="ctl-tab-add"
          title="导出控制画布（JSON）"
          onClick={async () => {
            const { save } = await import("@tauri-apps/plugin-dialog");
            const { invoke } = await import("@tauri-apps/api/core");
            const path = await save({
              title: "导出控制画布",
              defaultPath: `uartix-controls-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
              filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
            });
            if (!path) return;
            await invoke("save_text_file", {
              path,
              content: JSON.stringify(
                { kind: "uartix-controls", version: 1, data: store.exportPages() },
                null,
                2,
              ),
            });
          }}
        >
          ⭳
        </button>
        <button
          className="ctl-tab-add"
          title="导入控制画布为新页"
          onClick={async () => {
            const { open } = await import("@tauri-apps/plugin-dialog");
            const { invoke } = await import("@tauri-apps/api/core");
            const path = await open({
              multiple: false,
              filters: [{ name: "Uartix+ JSON", extensions: ["json"] }],
            });
            if (typeof path !== "string") return;
            try {
              const obj = JSON.parse(await invoke<string>("read_text_file", { path })) as {
                kind?: string;
                data?: unknown;
              };
              if (obj.kind !== "uartix-controls" || !obj.data) {
                alert("不是控制画布文件（kind 不匹配）");
                return;
              }
              const d = obj.data as { name?: string; cols?: number; cards?: Record<string, unknown>[] };
              const arr = Array.isArray(d) ? d[0] : d;
              store.importPage(arr);
            } catch (e) {
              alert(`导入失败: ${e}`);
            }
          }}
        >
          ⭱
        </button>
        <div className="ctl-tabs-spacer" />
        <button
          className="btn icon-btn"
          onClick={() => store.addCard(page.id, "slider")}
          title="添加滑条卡片"
        >
          <IconSlider />
        </button>
        <select
          className="input"
          value={page.cols}
          title="网格列数"
          onChange={(e) => store.setPageCols(page.id, Number(e.target.value))}
        >
          {[4, 6, 8, 10, 12, 16, 20, 24].map((n) => (
            <option key={n} value={n}>
              {n} 列
            </option>
          ))}
        </select>
        <select
          className="input"
          value={page.rows ?? 8}
          title="网格行数"
          onChange={(e) => store.setPageRows(page.id, Number(e.target.value))}
        >
          {[4, 6, 8, 10, 12, 16, 20, 24, 32, 48].map((n) => (
            <option key={n} value={n}>
              {n} 行
            </option>
          ))}
        </select>
        <button
          className="btn icon-btn"
          title="整理：清除重叠并重新排布当前页卡片"
          onClick={() => store.declumpPage(page.id)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        </button>
        <button
          className={`btn icon-btn ${page.locked ? "warn" : ""}`}
          onClick={() => store.setPageLocked(page.id, !page.locked)}
          title={
            page.locked
              ? "已锁定：卡片不可拖动/调整，仅可操作。点击解锁"
              : "未锁定：可拖动卡片位置与右下角调整大小。点击锁定"
          }
        >
          {page.locked ? <IconLock /> : <IconUnlock />}
        </button>
        <button
          className={`btn icon-btn ${sideTab ? "warn" : ""}`}
          onClick={() => setSideTab((t) => (t ? null : "commands"))}
          title="打开/收起控件与命令侧栏"
        >
          <IconSidebar />
        </button>
      </div>

      <div className="ctl-body">
        {sideTab && (
          <div className="ctl-side" style={{ width: sideW }}>
            <div className="ctl-side-tabs">
              <button
                className={sideTab === "widgets" ? "active" : ""}
                onClick={() => setSideTab("widgets")}
              >
                控件
              </button>
              <button
                className={sideTab === "commands" ? "active" : ""}
                onClick={() => setSideTab("commands")}
              >
                命令
              </button>
            </div>
            <div className="ctl-side-content">
              {sideTab === "widgets" && (
                <div className="widget-list">
                  {WIDGET_TYPES.map((w) => (
                    <div
                      key={w.type}
                      className="widget-item"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          "text/vs-widget",
                          JSON.stringify({ type: w.type }),
                        );
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      title="拖到右侧画布创建"
                    >
                      <span className="widget-icon">
                        {WIDGET_ICONS[w.type]}
                      </span>{" "}
                      {w.label}
                    </div>
                  ))}
                  <div className="widget-hint">
                    拖控件到右侧画布创建；右键卡片「设置」可切换模板串 / 脚本，
                    脚本内可用全部解析变量
                  </div>
                </div>
              )}
              {sideTab === "commands" && (
                <div
                  className="cmd-tree"
                  onDragOver={(e) => {
                    if (dragNodeRef.current) e.preventDefault();
                  }}
              onDrop={(e) => {
                const d = dragNodeRef.current;
                if (!d) return;
                e.preventDefault();
                // 若行上的 drop 未触发（拖到行间隙/边缘），使用最后记录的行落点自愈
                const dt = dropPosRef.current;
                dropPosRef.current = null;
                setDropTarget(null);
                dragNodeRef.current = null;
                if (dt && dt.id !== d.id) {
                  doMove(d.id, dt.id, dt.pos);
                  return;
                }
                // 落到空白处：按树末尾移动（命令/分组均可放顶层，自由拖拽）
                if (!commandStore.moveNode(d.id, null)) setErr("无法移动");
              }}
                >
                  <div className="cmd-toolbar">
                    <button
                      className="btn"
                      onClick={() => commandStore.addGroup(`分组${cmds.groups.length + 1}`)}
                    >
                      ＋ 分组
                    </button>
  </div>
                  {renderCmdTree(cmds.groups, 0)}
                  <div className="widget-hint">
                    单击命令立即发送 · 双击编辑 · 拖到画布部署（支持 {"{变量}"}
                    与解析变量）
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {sideTab && (
          <div
            className="ctl-side-resize"
            onMouseDown={(e) => {
              e.preventDefault();
              sideDragRef.current = { startX: e.clientX, w0: sideW };
            }}
          />
        )}
        <div className="ctl-main">
          <div
            className="ctl-grid"
            ref={wrapRef}
            onDragOver={(e) => {
              if (
                e.dataTransfer.types.includes("text/vs-cmd") ||
                e.dataTransfer.types.includes("text/vs-widget")
              ) {
                e.preventDefault();
              }
            }}
            onDrop={(e) => {
              const cmdRaw = e.dataTransfer.getData("text/vs-cmd");
              const widgetRaw = e.dataTransfer.getData("text/vs-widget");
              if (!widgetRaw && !cmdRaw) return;
              e.preventDefault();
              let type: ControlType = "slider";
              if (widgetRaw) {
                try {
                  type = (JSON.parse(widgetRaw) as { type: ControlType }).type;
                } catch {
                  return;
                }
              }
              const id = store.addCard(page.id, type);
              if (cmdRaw) {
                try {
                  const cmd = JSON.parse(cmdRaw) as {
                    template: string;
                    sendMode: SendMode;
                    script: string;
                    scriptEnabled: boolean;
                    name: string;
                  };
                  const card = store
                    .activePage()
?.cards.find((c) => c.id === id);
                  if (card) mountCommand(card, cmd);
                  else {
                    store.patchCard(page.id, id, {
                      template: cmd.template,
                      sendMode: cmd.sendMode,
                      useScript: !!cmd.scriptEnabled && !!cmd.script,
                      script: cmd.script,
                      ...(cmd.name ? { name: cmd.name } : {}),
                    });
                  }
                } catch {
                  return;
                }
              }
            }}
          >
            <div
              ref={gridRef}
              className="ctl-grid-inner"
              style={{
                width: page.cols * STEP + GAP,
                height: gridRows * STEP + GAP,
                backgroundImage:
                  "linear-gradient(to right, rgba(128,140,160,0.22) 1px, transparent 1px), linear-gradient(to bottom, rgba(128,140,160,0.22) 1px, transparent 1px)",
                backgroundSize: `${STEP}px ${STEP}px`,
                backgroundPosition: "0 0",
              }}
            >
              {page.cards.map((c) => renderCard(c))}
              <div ref={ghostRef} className="ctl-ghost" />
              {page.cards.length === 0 && (
                <EmptyState
                  title="画布为空"
                  hint={[
                    "从左侧控件库拖入控件，或点击右上「＋滑条」",
                    "右键卡片可切换模板串 / 脚本，脚本内可用全部解析变量",
                  ]}
                />
              )}
            </div>
          </div>
          {err && <div className="ctl-err">{err}</div>}
        </div>
      </div>

      {menu && menuCard &&
        createPortal(
          <div
            ref={menuRef}
            className="ctx-menu"
            style={{
              left: menuPos?.left ?? -9999,
              top: menuPos?.top ?? -9999,
              visibility: menuPos ? "visible" : "hidden",
            }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={disarmMountClose}
            onMouseLeave={armMountClose}
          >
            <div className="ctx-title">{menuCard.name}</div>
            <button className="ctx-item" onClick={() => { setEditing(menuCard.id); setMenu(null); }}>
              设置…
            </button>
            <button className="ctx-item" onClick={() => { setRenamingCard(menuCard.id); setMenu(null); }}>
              重命名
            </button>
            {canSend(menuCard) && (
              <button
                className="ctx-item"
                onClick={() => { void sendControl(menuCard, ctxFor(menuCard), true); setMenu(null); }}
              >
                立即发送
              </button>
            )}
            <div
              ref={mountAnchorRef}
              className="ctx-item ctx-has-sub"
              onClick={(e) => { e.stopPropagation(); setMountOpen((v) => !v); }}
              onMouseEnter={() => { disarmMountClose(); setMountOpen(true); }}
            >
              挂载命令 <span className="ctx-arrow"><IconChevron size={12} /></span>
            </div>
            {mountOpen && (
              <MountCascade
                anchorEl={mountAnchorRef.current}
                zf={zfactor}
                onArm={armMountClose}
                onDisarm={disarmMountClose}
                onPick={(item) => {
                  mountCommand(menuCard, item);
                  setMenu(null);
                  setMountOpen(false);
                }}
              />
            )}
            <div className="ctx-group">操作</div>
            <button
              className="ctx-item danger"
              onClick={() => { store.removeCard(page.id, menuCard.id); setMenu(null); }}
            >
              删除
            </button>
          </div>,
          document.body,
        )}

      {cmdMenu &&
        createPortal(
          <div
            ref={cmdMenuRef}
            className="ctx-menu"
            style={{
              left: cmdMenuPos?.left ?? -9999,
              top: cmdMenuPos?.top ?? -9999,
              visibility: cmdMenuPos ? "visible" : "hidden",
            }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const node = commandStore.getCommand(cmdMenu.id);
              if (!node) return null;
              return (
                <>
                  <div className="ctx-title">{node.name}</div>
                  <button
                    className="ctx-item"
                    onClick={() => {
                      setEditingCmd(cmdMenu.id);
                      setCmdMenu(null);
                    }}
                  >
                    编辑…
                  </button>
                  <button
                    className="ctx-item danger"
                    onClick={() => {
                      commandStore.removeNode(cmdMenu.id);
                      setCmdMenu(null);
                    }}
                  >
                    删除命令
                  </button>
                </>
              );
            })()}
          </div>,
          document.body,
        )}

      {editCard && (
        <CardModal
          key={editCard.id}
          card={editCard}
          pageId={page.id}
          onClose={() => setEditing(null)}
          onDelete={() => {
            store.removeCard(page.id, editCard.id);
            setEditing(null);
          }}
        />
      )}

      {editCmdItem && (
        <CommandModal
          key={editCmdItem.id}
          item={editCmdItem}
          onClose={() => setEditingCmd(null)}
          onDelete={() => {
            commandStore.removeNode(editCmdItem.id);
            setEditingCmd(null);
          }}
        />
      )}
    </div>
  );
}

function CommandModal(props: {
  item: CommandItem;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { item } = props;
  const scriptOn = item.scriptEnabled;
  return (
    <div className="modal-mask" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">命令设置 · {item.name}</div>
        <div className="form-row">
          <label>名称</label>
          <TextInput
            value={item.name}
            onCommit={(v) => commandStore.patchCommand(item.id, { name: v })}
          />
          <label>模式</label>
          <select
            className="input"
            value={item.sendMode}
            onChange={(e) =>
              commandStore.patchCommand(item.id, {
                sendMode: e.target.value as SendMode,
              })
            }
          >
            <option value="ascii">ASCII</option>
            <option value="hex">Hex</option>
          </select>
        </div>
        <div className="form-row">
          <label>脚本指令</label>
          <label className="chk">
            <input
              type="checkbox"
              className="chk-box"
              checked={scriptOn}
              onChange={(e) =>
                commandStore.patchCommand(item.id, {
                  scriptEnabled: e.target.checked,
                })
              }
            />
            优先执行脚本（隐藏指令模板）
          </label>
        </div>
        {!scriptOn && (
          <>
            <div className="form-row">
              <label>指令模板</label>
              <textarea
                className="input ctl-tpl-input cmd-ta"
                rows={5}
                value={item.template}
                placeholder={"VRp=%.2f!"}
                onChange={(e) =>
                  commandStore.patchCommand(item.id, { template: e.target.value })
                }
              />
            </div>
            <div className="cmd-hint">
              语法：%f %.2f %d，支持 {"{变量}"} 引用解析数据
            </div>
          </>
        )}
        {scriptOn && (
          <>
            <div className="form-row">
              <label>脚本</label>
              <textarea
                className="input ctl-tpl-input ctl-script-input cmd-ta"
                rows={5}
                spellCheck={false}
                value={item.script}
                placeholder={
                  'if (Roll > 45) {\n  await send("ALARM:high!");\n  beep(880, 200);\n}'
                }
                onChange={(e) =>
                  commandStore.patchCommand(item.id, { script: e.target.value })
                }
              />
            </div>
            <div className="cmd-hint">
              API：await send(text, mode?) · beep(freq, ms) · await delay_ms(ms)
              · get("变量") · await waitParse(字段, ms) · set(变量, 值) ·
              setControl(控件, 值) · await repeat(n, i=&gt;…) · log(文本)；完整 JS
              语法可用（for/while/if）；解析字段名可直接当变量使用
            </div>
          </>
        )}
        <div className="form-row">
          <label>备注</label>
          <TextInput
            value={item.note}
            onCommit={(v) => commandStore.patchCommand(item.id, { note: v })}
          />
        </div>
        <div className="modal-foot">
          <button
            className="btn danger-btn"
            onClick={() => {
              commandStore.removeNode(item.id);
              props.onClose();
            }}
          >
            删除命令
          </button>
          <button className="btn primary" onClick={props.onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
