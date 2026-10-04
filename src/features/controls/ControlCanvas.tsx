import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as store from "./controlsStore";
import { DebugPresetDialog } from "./DebugPresetDialog";
import { ParameterSetDialog } from "./ParameterSetDialog";
import { executeManagedControl, managedActionReady, routeSliderValue } from "./controlExecution";
import { requireCurrentParameterPage } from "./parameterPageValidation";
import * as sessionStore from "../session/sessionStore";
import { guardLocked } from "../operator/lock";
import type {
  ControlCard,
  ControlType,
  GroupCard,
  GroupChild,
  SendMode,
  SliderCard,
} from "./controlsStore";
import * as variableStore from "./variableStore";
import * as commandStore from "./commandStore";
import { isGroup } from "./commandStore";
import { useSettings } from "../settings/settingsStore";
import { runSpecCard, sendCmd, runCmdScript, type RunnableCommand } from "./cmdExec";
import { IconLock, IconMore, IconUnlock, IconSlider, IconChevron } from "../../shared/icons";
import { EmptyState } from "../../shared/EmptyState";
import { Flyout } from "../../shared/Flyout";
import { tx, useLocale } from "../../i18n/strings";
import { alertDialog } from "../../shared/Dialog";
import { toast } from "../ai/extRuntime";
import { attachPdragZone, type PdragDetail } from "../../shared/pointerDrag";
import type { CommandItem, CommandNode } from "./commandStore";
import {
  BuzzerCardView,
  ButtonCardView,
  CardFrame,
  CardModal,
  GroupCardView,
  JoystickCardView,
  KeypadCardView,
  KeymonCardView,
  LedCardView,
  MonitorCardView,
  CustomCardView,
  SliderCardView,
  SwitchCardView,
} from "./CardViews";

const GAP = 8;
const OFF = GAP / 2;


function MountCascade(props: {
  anchorEl: HTMLElement | null;
  zf: number;
  onArm: () => void;
  onDisarm: () => void;
  onPick: (item: CommandItem) => void;
}) {
  useLocale();
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
              {i === 0
                ? tx("命令库为空（左侧「命令」导轨里添加）", "Command library is empty (add it in the Commands rail on the left)")
                : tx("空分组", "Empty group")}
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
                title={n.scriptEnabled && n.script ? tx("脚本命令", "Script command") : n.template}
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
  useLocale(); // 面板根组件的口径（strings.ts 头注）：这一面的话术是 tx() 出来的，切语言要有人重渲染
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const settings = useSettings();
  const CELL = [48, 60, 72, 90, 110].includes(settings.cellSize) ? settings.cellSize : 60;
  // 全局 CSS zoom 会让卡片边框与背景网格线落在不同取整结果上（视觉间隙随机），
  // 这里把几何值预先取整到 zoom 缩放后的整数设备像素，保证间隙恒定。
  const zfactor = (settings.zoom || 100) / 100;
  const snapPx = (v: number) => (zfactor === 1 ? v : Math.round(v * zfactor) / zfactor);
  // 网格步长/边距/间隙先量化到整数设备像素，卡片坐标 = 格号 × 量化步长，
  // 与背景线（周期 = 量化步长）严格同格，杜绝逐格累积的取整漂移（不对齐根因）
  const STEPq = snapPx(CELL + GAP);
  const OFFq = snapPx(OFF);
  const GAPq = snapPx(GAP);
  const showGhost = (
    gx: number,
    gy: number,
    gw: number,
    gh: number,
    ok: boolean,
  ) => {
    const g = ghostRef.current;
    if (!g) return;
    g.style.display = "block";
    g.style.left = `${gx * STEPq + OFFq}px`;
    g.style.top = `${gy * STEPq + OFFq}px`;
    g.style.width = `${gw * STEPq - GAPq}px`;
    g.style.height = `${gh * STEPq - GAPq}px`;
    g.className = `ctl-ghost ${ok ? "ok" : "bad"}`;
  };
  const hideGhost = () => {
    const g = ghostRef.current;
    if (g) g.style.display = "none";
  };
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
  const [gridMenu, setGridMenu] = useState<{ x: number; y: number; gx: number; gy: number } | null>(null);
  const [gridMenuPos, setGridMenuPos] = useState<{ left: number; top: number } | null>(null);
  const gridMenuRef = useRef<HTMLDivElement | null>(null);
  const mountAnchorRef = useRef<HTMLDivElement | null>(null);
  const mountCloseRef = useRef<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [renamingCard, setRenamingCard] = useState<string | null>(null);
  const [renamingPage, setRenamingPage] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [debugDialog, setDebugDialog] = useState<"preset" | "sets" | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const managedBusy = useRef(false);
  const [managedPending, setManagedPending] = useState(false);
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot);
  const [managedReceipt, setManagedReceipt] = useState<{
    pageId: string; cardId: string; name: string; result: Awaited<ReturnType<typeof executeManagedControl>>;
  } | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);
  useLayoutEffect(() => {
    if (!moreOpen) return;
    const el = moreMenuRef.current;
    const a = moreBtnRef.current;
    if (!el || !a || !a.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const ar = a.getBoundingClientRect();
    const zf = Number(getComputedStyle(document.documentElement).zoom) || 1;
    let left = ar.right - r.width;
    let top = ar.bottom + 6;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - 8 - r.width;
    if (top + r.height > window.innerHeight - 8) top = ar.top - r.height - 6;
    left = Math.max(8, left);
    top = Math.max(8, top);
    el.style.left = `${left / zf}px`;
    el.style.top = `${top / zf}px`;
    el.style.visibility = "visible";
  });

  const doExportCanvas = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await save({
      title: tx("导出控制画布", "Export control canvas"),
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
  };

  const doImportCanvas = async () => {
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
        await alertDialog(tx("不是控制画布文件（kind 不匹配）", "This is not a control-canvas file (kind does not match)"));
        return;
      }
      const d = obj.data as { name?: string; cols?: number; cards?: Record<string, unknown>[] };
      const arr = Array.isArray(d) ? d[0] : d;
      store.importPage(arr);
    } catch (e) {
      await alertDialog(tx(`导入失败: ${e}`, `Import failed: ${e}`));
    }
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 33 : e.deltaX;
      if (!dy && !dx) return;
      e.preventDefault();
      el.scrollTop += dy;
      el.scrollLeft += dx;
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      // 释放保护：在窗口外松手时 mouseup 可能丢失（buttons=0 说明已松开）。
      // 必须放在 resize 分支之前——否则 resizeRef 卡住，鼠标悬停滑过就会持续缩放卡片（压成竖条根因）
      if (e.buttons === 0) {
        if (resizeRef.current || dragRef.current) finish();
        return;
      }
      const rz = resizeRef.current;
      if (rz) {
        const cur = store.activePage();
        const maxW = Math.max(1, (cur?.cols ?? 8) - rz.card.x);
        const maxH = Math.max(1, (cur?.rows || 48) - rz.card.y);
        const scale = liveScale(rz.innerW0);
        const nw0 = Math.max(
          1,
          Math.min(maxW, rz.card.w + Math.round((e.clientX - rz.startClientX) / (STEPq * scale))),
        );
        const nh0 = Math.max(
          1,
          Math.min(maxH, (rz.card.h || 1) + Math.round((e.clientY - rz.startClientY) / (STEPq * scale))),
        );
        // 摇杆与键盘遥控锁定正方形（n×n），杜绝拖成 1×N 长条
        const isSquare = rz.card.type === "joystick" || rz.card.type === "keypad";
        const nw = isSquare ? Math.min(nw0, nh0) : nw0;
        const nh = isSquare ? Math.min(nw0, nh0) : nh0;
        rz.w = nw;
        rz.h = nh;
        rz.el.style.width = `${nw * STEPq - GAPq}px`;
        rz.el.style.height = `${nh * STEPq - GAPq}px`;
        rz.el.style.zIndex = "60";
        return;
      }
      const d = dragRef.current;
      if (!d) return;
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
      const tx = Math.max(0, Math.min(cols - d.card.w, Math.round((leftPx - OFFq) / STEPq)));
      const ty = Math.max(0, Math.min(rows - ch, Math.round((topPx - OFFq) / STEPq)));
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
        const isSq = rz.card.type === "joystick" || rz.card.type === "keypad";
        if (isSq) {
          let n = Math.min(fw, fh);
          while (n > 1 && hit(n, n)) n--;
          fw = n;
          fh = n;
        } else {
          // 碰撞缩减不越过本次缩放前的原尺寸：放大撞到邻居时最多退回原尺寸，
          // 绝不会把宽度挤成 1×N 竖条（缩小方向本来就不会产生碰撞）
          const minW = Math.min(nw, rz.card.w);
          const minH = Math.min(nh, rz.card.h || 1);
          while (fh > minH && hit(fw, fh)) fh--;
          while (fw > minW && hit(fw, fh)) fw--;
        }
        if (fw === rz.card.w && fh === (rz.card.h || 1)) {
          rz.el.style.width = `${fw * STEPq - GAPq}px`;
          rz.el.style.height = `${fh * STEPq - GAPq}px`;
          return;
        }
        rz.el.style.width = "";
        rz.el.style.height = "";
        store.patchCard(cur.id, rz.card.id, { w: fw, h: fh });
        // 缩到原尺寸仍与邻居重叠（历史遗留）→ 就近挪开，而不是继续压扁自己
        store.resolveOverlaps(cur.id);
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

  useEffect(() => {
    if (!gridMenu) return;
    const close = () => setGridMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [gridMenu]);

  useLayoutEffect(() => {
    if (!gridMenu || !gridMenuRef.current) return;
    const r = gridMenuRef.current.getBoundingClientRect();
    const zf = zfactor || 1;
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    const left = Math.max(8, Math.min(gridMenu.x / zf, vw - w - 8));
    let top = gridMenu.y / zf;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    setGridMenuPos({ left, top });
  }, [gridMenu, zfactor]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const r = menuRef.current.getBoundingClientRect();
    const zf = zfactor || 1;
    const w = r.width / zf;
    const h = r.height / zf;
    const vw = window.innerWidth / zf;
    const vh = window.innerHeight / zf;
    const left = Math.max(8, Math.min(menu.x / zf, vw - w - 8));
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

  // 脚本 setControl 联动桥：接收 vs-control-trigger 事件，按控件类型真正触发发送
  useEffect(() => {
    const onCtl = (e: Event) => {
      const d = (e as CustomEvent<{ cardId: string; value: number }>).detail;
      if (!d?.cardId) return;
      const found = store.findCardById(d.cardId);
      if (!found) return;
      const { pageId, card } = found;
      switch (card.type) {
        case "button":
          void sendControl(card, {});
          break;
        case "switch": {
          const st = Math.max(
            0,
            Math.min(card.positions - 1, Math.round(Number(d.value))),
          );
          store.patchCard(pageId, card.id, { state: st });
          void sendControl(card, { state: st });
          break;
        }
        case "slider": {
          const v = Number(d.value);
          valuesRef.current.set(card.id, v);
          store.patchCard(pageId, card.id, { defaultValue: v });
          void sendControl(card, { value: v }, true);
          break;
        }
        case "keypad": {
          const dir = Math.max(0, Math.min(3, Math.round(Number(d.value))));
          void sendControl(card, { dir, phase: "press" });
          break;
        }
        case "keymon":
          void sendControl(card, { phase: "press" });
          break;
        default:
          break;
      }
    };
    window.addEventListener("vs-control-trigger", onCtl);
    return () => window.removeEventListener("vs-control-trigger", onCtl);
  });

  /**
   * P122-C：TX组帧台点了一块 → 这块参数在画布上那张卡亮一下（只定位，不改值、不发送）。
   *
   * 只在卡真的渲染出来的时候动：卡片属于当前页才在 DOM 里，别的页上它不存在，
   * 这里就安静地什么都不做 —— 那句"在别的页上"由组帧台自己说，还带一颗要不要跳过去的键。
   * 自动替人切页会把对方正在看的东西换掉，所以不这么干。
   */
  useEffect(() => {
    let last: number | null = null;
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent<{ cardId?: string }>).detail;
      if (!d?.cardId) return;
      const el = gridRef.current?.querySelector<HTMLElement>(
        `.ctl-card[data-id="${CSS.escape(d.cardId)}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      el.classList.remove("ctl-reveal");
      void el.offsetWidth; // 同一张卡连着闪两次：不重启动画就只亮一次
      el.classList.add("ctl-reveal");
      if (last !== null) window.clearTimeout(last);
      last = window.setTimeout(() => el.classList.remove("ctl-reveal"), 950);
    };
    window.addEventListener("vs-control-reveal", onReveal);
    return () => {
      window.removeEventListener("vs-control-reveal", onReveal);
      if (last !== null) window.clearTimeout(last);
    };
  }, [page?.id]);

  const gridDropRef = useRef<(d: PdragDetail) => void>(() => {});
  const gridOverRef = useRef<(d: PdragDetail) => void>(() => {});
  const [dropPrev, setDropPrev] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    return attachPdragZone(el, {
      kinds: "vs-widget vs-cmd vs-field",
      onOver: (dd) => gridOverRef.current(dd),
      onLeave: () => setDropPrev(null),
      onDrop: (dd) => {
        setDropPrev(null);
        gridDropRef.current(dd);
      },
    });
  }, [page?.id]);

  if (!page) {
    return <div className="ctl"><div className="ctl-empty">{tx("无控制页", "No control pages")}</div></div>;
  }

  const getVal = (c: SliderCard): number =>
    valuesRef.current.get(c.id) ?? c.defaultValue;

  /**
   * 加卡唯一入口。只读锁下 `store.addCard` 返回空串（P121-F），那就把这句话到界面上，
   * 别让人以为按钮点动了却什么都没发生。
   */
  const addCardOrSay = (type: ControlType) => {
    const id = store.addCard(page.id, type);
    if (!id)
      setErr(tx("Operator 只读：不能往控制画布加卡片", "Operator read-only: cards cannot be added to this canvas"));
    return id;
  };

  /* P104-R3：发送与脚本执行的实现搬进 `cmdExec`——命令库现在住在左侧导轨，
     和这里的卡片是两个调用方，同一份发送逻辑不该再有两份。
     错误面仍留在本地：画布报的错不该往导轨那边喊。 */
  const sendRaw = async (mode: SendMode, text: string) => {
    try {
      await sendCmd(mode, text);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  const runCardScript = (
    script: string,
    ctx: Record<string, number | string>,
  ): Promise<void> => runCmdScript(script, ctx);

  const sendControl = async (
    card: ControlCard,
    ctx: Record<string, number | string>,
    force = false,
  ) => {
    if (card.managed !== undefined) {
      if (managedBusy.current) return;
      if (card.type === "slider") valuesRef.current.set(card.id, Number(ctx.value ?? getVal(card)));
      managedBusy.current = true;
      setManagedPending(true);
      const request = { pageId: page.id, cardId: card.id, name: card.name };
      setManagedReceipt(null);
      try {
        const result = await executeManagedControl(card, {
          phase: () => sessionStore.getSnapshot().state,
          start: sessionStore.startRecord,
          stop: sessionStore.stopRecord,
          annotate: sessionStore.annotate,
        });
        setManagedReceipt({ ...request, result });
      } finally { managedBusy.current = false; setManagedPending(false); }
      return;
    }
    if (
      card.type !== "led" &&
      card.type !== "buzzer" &&
      card.type !== "monitor" &&
      card.type !== "group" &&
      card.type !== "custom" &&
      card.useScript
    ) {
      if (!card.script.trim()) {
        setErr(tx(`「${card.name}」已选择脚本模式但脚本为空，请在卡片设置中填写脚本或切回模板串`,
          `"${card.name}" is in script mode but the script is empty — fill it in under card Settings, or switch back to template`));
        return;
      }
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
        if (card.sendTemplateId) {
          try {
            await runSpecCard(card);
            setErr(null);
          } catch (e) {
            setErr(String(e));
          }
        } else {
          await sendRaw(card.sendMode, variableStore.resolveVars(card.template));
        }
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
      case "keypad": {
        const dir = Math.max(0, Math.min(3, Math.round(Number(ctx.dir ?? 0))));
        const phase = String(ctx.phase ?? "press");
        const tpl =
          (phase === "release" ? card.releaseTemplates[dir] : card.templates[dir]) ?? "";
        if (tpl) {
          await sendRaw(card.sendMode, variableStore.resolveVars(tpl));
        }
        break;
      }
      case "keymon": {
        const phase = String(ctx.phase ?? "press");
        const tpl = phase === "release" ? card.releaseTemplate : card.template;
        if (tpl) {
          await sendRaw(card.sendMode, variableStore.resolveVars(tpl));
        }
        break;
      }
      default:
        break;
    }
  };

  /** 组合控件子项发送：滑条松手/按钮点击/开关切换 */
  const sendChild = async (
    card: GroupCard,
    child: GroupChild,
    ctx: Record<string, number | string>,
  ) => {
    if (card.managed !== undefined) return;
    const mode = card.sendMode;
    try {
      switch (child.kind) {
        case "slider": {
          const value = Number(ctx.value ?? child.min);
          await sendRaw(
            mode,
            store.formatTemplate(variableStore.resolveVars(child.template), value, mode),
          );
          break;
        }
        case "button":
          await sendRaw(mode, variableStore.resolveVars(child.template));
          break;
        case "switch": {
          const i = Number(ctx.state ?? 0) ? 1 : 0;
          const tpl = child.templates[i] ?? "";
          if (tpl) await sendRaw(mode, variableStore.resolveVars(tpl));
          break;
        }
        default:
          break;
      }
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  const doSend = async (card: SliderCard, value: number) => {
    if (card.managed !== undefined) return;
    try {
      if (card.sendTemplateId) {
        await runSpecCard(card, value);
      } else {
        await sendCmd(
          card.sendMode,
          store.formatTemplate(
            variableStore.resolveVars(card.template),
            value,
            card.sendMode,
          ),
        );
      }
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
    routeSliderValue(card, v, value => valuesRef.current.set(card.id, value), () => {
      if (card.sendTrigger === "continuous") {
        if (card.useScript) void sendControl(card, { value: v });
        else throttledSend(card, v);
      }
    });
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
      cardLeft0: card.x * STEPq + OFFq,
      cardTop0: card.y * STEPq + OFFq,
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
    cmd: RunnableCommand & { name?: string },
  ) => {
    const useScript = !!cmd.scriptEnabled && !!cmd.script;
    // 引用式命令**没有字节可拷**（它的 template 是空的）。
    // 支持引用的卡片类型把引用接过来；不支持的（开关带两档各自的模板）就地说明——
    // 原先这里会把空 template 写进卡片，症状是"拖了一下，卡片原来那条指令没了"。
    if (cmd.sendTemplateId && !useScript) {
      if (card.type === "slider" || card.type === "button") {
        store.patchCard(page.id, card.id, {
          sendTemplateId: cmd.sendTemplateId,
          template: "",
          sendMode: "hex",
          useScript: false,
          script: "",
        });
      } else {
        setErr(
          tx(
            `「${card.name}」挂不了引用式命令：它自己带模板，不认发送谱。要引用就拖成滑条或按钮卡`,
            `"${card.name}" cannot mount a referenced send template: it carries its own. Use a slider or button card`,
          ),
        );
      }
      return;
    }
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

  const usedRows = page.cards.reduce((m, c) => Math.max(m, c.y + (c.h || 1)), 1);
  const gridRows = Math.max(page.rows || 8, usedRows);

  gridDropRef.current = (d) => {
    const placeAt = (id: string, x: number, y: number) => {
      const g = gridRef.current;
      const card = store.activePage()?.cards.find((c) => c.id === id);
      if (!g || !card) return;
      const r = g.getBoundingClientRect();
      const zf = zfactor || 1;
      const w = card.w || 1;
      const h = card.h || 1;
      const tx = Math.max(0, Math.min(page.cols - w, Math.round(((x - r.left) / zf - OFFq) / STEPq)));
      const ty = Math.max(0, Math.min(gridRows - h, Math.round(((y - r.top) / zf - OFFq) / STEPq)));
      const busy = page.cards.some(
        (c) =>
          c.id !== id &&
          !(tx + w <= c.x || c.x + c.w <= tx || ty + h <= c.y || c.y + (c.h || 1) <= ty),
      );
      if (!busy) store.patchCard(page.id, id, { x: tx, y: ty });
    };
    if (d.kind === "vs-field") {
      try {
        const p = JSON.parse(d.data) as { tplId: string; fieldId: string };
        const vd = variableStore
          .listVars()
          .find((v) => v.tplId === p.tplId && v.fieldId === p.fieldId);
        if (!vd) {
          toast(
            tx(
              "该字段暂无对应变量（模板未启用或为帧头），先在协议模板面板启用",
              "No variable for this field yet (template disabled or header role) — enable it first",
            ),
          );
          return;
        }
        const id = addCardOrSay("monitor");
        if (!id) return;
        store.patchCard(page.id, id, { varName: vd.name, name: vd.name });
        placeAt(id, d.x, d.y);
      } catch {
        return;
      }
      return;
    }
    let type: ControlType = "slider";
    let cmd: {
      template: string;
      sendMode: SendMode;
      script: string;
      scriptEnabled: boolean;
      name: string;
    } | null = null;
    if (d.kind === "vs-widget") {
      try {
        type = (JSON.parse(d.data) as { type: ControlType }).type;
      } catch {
        return;
      }
    } else if (d.kind === "vs-cmd") {
      try {
        cmd = JSON.parse(d.data) as RunnableCommand & { name: string };
      } catch {
        return;
      }
    } else {
      return;
    }
    const id = addCardOrSay(type);
    if (!id) return;
    if (cmd) {
      const card = store.activePage()?.cards.find((c) => c.id === id);
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
    }
    placeAt(id, d.x, d.y);
  };
  gridOverRef.current = (d) => {
    const g = gridRef.current;
    if (!g) return;
    let type: ControlType = "slider";
    if (d.kind === "vs-widget") {
      try {
        type = (JSON.parse(d.data) as { type: ControlType }).type;
      } catch {
        setDropPrev(null);
        return;
      }
    } else if (d.kind === "vs-field") {
      type = "monitor";
    }
    const { w, h } = store.defaultCardSize(type);
    const r = g.getBoundingClientRect();
    const zf = zfactor || 1;
    const tx = Math.max(0, Math.min(page.cols - w, Math.round(((d.x - r.left) / zf - OFFq) / STEPq)));
    const ty = Math.max(0, Math.min(gridRows - h, Math.round(((d.y - r.top) / zf - OFFq) / STEPq)));
    const busy = page.cards.some(
      (c) => !(tx + w <= c.x || c.x + c.w <= tx || ty + h <= c.y || c.y + (c.h || 1) <= ty),
    );
    setDropPrev(busy ? null : { x: tx, y: ty, w, h });
  };

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

  const canSend = (c: ControlCard) =>
    c.type === "slider" ||
    c.type === "button" ||
    c.type === "switch" ||
    c.type === "joystick";

  const renderCard = (c: ControlCard) => {
    // 渲染兜底：w/h/x/y 非有限值时按最小 1×1 格渲染，绝不产生 sub-cell 扁条
    const qw = Number.isFinite(c.w) && c.w >= 1 ? Math.round(c.w) : 1;
    const qh = Number.isFinite(c.h) && c.h >= 1 ? Math.round(c.h) : 1;
    const qx = Number.isFinite(c.x) ? Math.round(c.x) : 0;
    const qy = Number.isFinite(c.y) ? Math.round(c.y) : 0;
    const ch = qh;
    // 与背景网格线共用量化步长，保证卡片边缘严格贴网格
    const geo = {
      left: qx * STEPq + OFFq,
      top: qy * STEPq + OFFq,
      width: qw * STEPq - GAPq,
      height: ch * STEPq - GAPq,
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
        setGridMenu(null);
        setMenu({ cardId: card.id, x, y });
      },
      onDragStart: onCardDragStart,
      onRenameCommit: (name: string) => {
        if (name.trim()) store.patchCard(page.id, c.id, { name: name.trim() });
        setRenamingCard(null);
      },
      onRenameCancel: () => setRenamingCard(null),
      onDropTemplate: (card: ControlCard, cmd: RunnableCommand & { name?: string }) =>
        mountCommand(card, cmd),
      resizable: !page.locked,
      onResizeStart,
    };
    if (c.managed !== undefined && c.type !== "slider" && c.type !== "button" && c.type !== "monitor") {
      return <CardFrame key={c.id} {...common}>
        <p className="ctl-managed-hint">{tx("受管设备动作未配置；未启用发送、脚本或键盘监听。", "Managed device action unconfigured; sending, scripts and keyboard listeners are disabled.")}</p>
      </CardFrame>;
    }
    switch (c.type) {
      case "slider":
        return (
          <SliderCardView
            key={c.managed !== undefined ? `${c.id}:${draftRevision}` : c.id}
            {...common}
            card={c}
            initial={getVal(c)}
            onValue={onValue}
            onRelease={onRelease}
          />
        );
      case "button":
        return <ButtonCardView key={c.id} {...common} card={c} onSend={sendControl}
          disabled={c.managed !== undefined && (managedPending || !managedActionReady(c, session.state))}
          disabledReason={c.managed !== undefined ? managedPending
            ? tx("应用动作处理中…", "Application action in progress…")
            : !managedActionReady(c, session.state)
              ? tx("未配置或当前会话状态不允许", "Unconfigured or unavailable in the current session state")
              : undefined : undefined} />;
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
      case "keypad":
        return <KeypadCardView key={c.id} {...common} card={c} onSend={sendControl} />;
      case "keymon":
        return <KeymonCardView key={c.id} {...common} card={c} onSend={sendControl} />;
      case "group":
        return (
          <GroupCardView
            key={c.id}
            {...common}
            card={c}
            onChildSend={sendChild}
          />
        );
      case "custom":
        return <CustomCardView key={c.id} {...common} card={c} />;
      default:
        return null;
    }
  };

  return (
    <div className="ctl">
      <div className="ctl-tabs">
        {s.pages.map((p) => (
          <div
            key={p.id}
            className={`ctl-tab ${p.id === s.activePageId ? "active" : ""}`}
            data-ctl="tab"
            onClick={() => store.setActivePage(p.id)}
            onDoubleClick={() => setRenamingPage(p.id)}
            title={tx("双击重命名", "Double-click to rename")}
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
                title={tx("删除控制页", "Delete control page")}
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
          title={tx("新建控制页", "New control page")}
        >
          ＋
        </button>
        <div className="ctl-tabs-spacer" />
        <button
          className="btn icon-btn"
          onClick={() => addCardOrSay("slider")}
          title={tx("添加滑条卡片", "Add slider card")}
        >
          <IconSlider />
        </button>
        <button
          className={`btn icon-btn ${page.locked ? "on" : ""}`}
          onClick={() => store.setPageLocked(page.id, !page.locked)}
          title={
            page.locked
              ? tx("已锁定：卡片不可拖动/调整，仅可操作。点击解锁", "Locked: cards can only be operated. Click to unlock")
              : tx("未锁定：可拖动卡片位置与右下角调整大小。点击锁定", "Unlocked: drag cards to move, resize from the corner. Click to lock")
          }
        >
          {page.locked ? <IconLock /> : <IconUnlock />}
        </button>
        <button
          ref={moreBtnRef}
          className={`btn icon-btn ${moreOpen ? "on" : ""}`}
          onClick={() => setMoreOpen((v) => !v)}
          title={tx("更多：调试、布局与导入导出", "More: debug, layout, import/export")}
        >
          <IconMore />
        </button>
        {moreOpen &&
          createPortal(
            <>
              <div
                className="ctl-more-mask"
                onClick={() => setMoreOpen(false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMoreOpen(false);
                }}
              />
              <div
                className="ctl-more-menu"
                ref={moreMenuRef}
                style={{ left: -9999, top: -9999, visibility: "hidden" }}
              >
              <div className="ctl-more-title">{tx("调试", "Debug")}</div>
              <button className="ctl-more-item" onClick={() => {
                if (guardLocked()) return;
                setMoreOpen(false); setDebugDialog("preset");
              }}>{tx("从预设生成惯导调试页…", "Create inertial debug preset…")}</button>
              {page.debugProfile && <button className="ctl-more-item" onClick={() => {
                setMoreOpen(false); setDebugDialog("sets");
              }}>{tx("参数集…", "Parameter sets…")}</button>}
              <div className="ctl-more-sep" />
              <div className="ctl-more-title">{tx("布局", "Layout")}</div>
              <div className="ctl-more-row">
                <select
                  className="input"
                  value={page.cols}
                  title={tx("网格列数", "Grid columns")}
                  onChange={(e) => store.setPageCols(page.id, Number(e.target.value))}
                >
                  {[4, 6, 8, 10, 12, 16, 20, 24].map((n) => (
                    <option key={n} value={n}>
                      {tx(`${n} 列`, `${n} col`)}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  value={page.rows ?? 8}
                  title={tx("网格行数", "Grid rows")}
                  onChange={(e) => store.setPageRows(page.id, Number(e.target.value))}
                >
                  {[4, 6, 8, 10, 12, 16, 20, 24, 32, 48].map((n) => (
                    <option key={n} value={n}>
                      {tx(`${n} 行`, `${n} row`)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm"
                  title={tx("整理：清除重叠并重新排布当前页卡片", "Tidy: clear overlaps and re-layout cards on this page")}
                  onClick={() => store.declumpPage(page.id)}
                >
                  {tx("整理", "Tidy")}
                </button>
              </div>
              <div className="ctl-more-sep" />
              <div className="ctl-more-title">{tx("文件", "File")}</div>
              <button
                className="ctl-more-item"
                onClick={() => {
                  setMoreOpen(false);
                  void doExportCanvas();
                }}
              >
                {tx("导出控制画布…", "Export control canvas…")}
              </button>
              <button
                className="ctl-more-item"
                onClick={() => {
                  setMoreOpen(false);
                  void doImportCanvas();
                }}
              >
                {tx("导入控制画布…", "Import control canvas…")}
              </button>
            </div>
          </>,
            document.body,
          )}
      </div>

      <div className="ctl-body">
        <div className="ctl-main">
          <div
            className="ctl-grid"
            ref={wrapRef}
          >
            <div
              ref={gridRef}
              className="ctl-grid-inner"
              style={{
                width: page.cols * STEPq + GAPq,
                height: gridRows * STEPq + GAPq,
                backgroundImage:
                  "linear-gradient(to right, rgba(128,140,160,0.22) 1px, transparent 1px), linear-gradient(to bottom, rgba(128,140,160,0.22) 1px, transparent 1px)",
                backgroundSize: `${STEPq}px ${STEPq}px`,
                backgroundPosition: "0 0",
              }}
              onContextMenu={(e) => {
                const g = gridRef.current;
                if (!g) return;
                e.preventDefault();
                const r = g.getBoundingClientRect();
                const zf = zfactor || 1;
                const lx = (e.clientX - r.left) / zf;
                const ly = (e.clientY - r.top) / zf;
                const gx = Math.max(0, Math.min(page.cols - 1, Math.floor(lx / STEPq)));
                const gy = Math.max(0, Math.min(gridRows - 1, Math.floor(ly / STEPq)));
                setMenu(null);
                setMenuPos(null);
                setGridMenuPos(null);
                setGridMenu({ x: e.clientX, y: e.clientY, gx, gy });
              }}
            >
              {page.cards.map((c) => renderCard(c))}
              {dropPrev && (
                <div
                  className="ctl-drop-prev"
                  style={{
                    left: dropPrev.x * STEPq + OFFq,
                    top: dropPrev.y * STEPq + OFFq,
                    width: dropPrev.w * STEPq - GAPq,
                    height: dropPrev.h * STEPq - GAPq,
                  }}
                />
              )}
              <div ref={ghostRef} className="ctl-ghost" />
            </div>
          </div>
          {/* 空态挪出滚动内容：.ctl-grid-inner 的行内宽度是整张画布（cols×STEP，约 800px）且
              它自己 position:relative，空态铺满它 ⇒ 居中文字落在看不见的右半边。
              改挂到 .ctl-main（面板视口，非滚动）上，才真的居中在眼前。 */}
          {page.cards.length === 0 && (
            <EmptyState
              title={tx("画布为空", "Canvas is empty")}
              hint={[tx("从左侧「控件」把控件拖进来", "Drag a widget in from Widgets on the left")]}
              actions={[
                {
                  label: tx("＋ 滑条", "＋ Slider"),
                  primary: true,
                  onClick: () => addCardOrSay("slider"),
                },
              ]}
            />
          )}
          {managedReceipt?.pageId === page.id && <div className="ctl-err" role={managedReceipt.result.status === "failed" ? "alert" : "status"}>
            {managedReceipt.name}: {managedReceipt.result.status === "completed"
              ? tx("应用动作完成（非设备回执）", "Application action completed (not device feedback)")
              : managedReceipt.result.status === "failed" ? tx("应用动作失败", "Application action failed")
                : tx("未配置或会话状态不允许；未发送", "Unconfigured or session state disallows action; not sent")}
          </div>}
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
              {tx("设置…", "Settings…")}
            </button>
            <button className="ctx-item" onClick={() => { setRenamingCard(menuCard.id); setMenu(null); }}>
              {tx("重命名", "Rename")}
            </button>
            <button
              className="ctx-item"
              onClick={() => { store.copyCard(page.id, menuCard.id); setMenu(null); }}
              title={tx("复制控件全部属性（模板指令 / 脚本 / 键位等），在画布空白处右键粘贴", "Copy all card properties (template / script / keys), then right-click empty canvas to paste")}
            >
              {tx("复制", "Copy")}
            </button>
            {canSend(menuCard) && (
              <button
                className="ctx-item"
                onClick={() => { void sendControl(menuCard, ctxFor(menuCard), true); setMenu(null); }}
              >
                {tx("立即发送", "Send now")}
              </button>
            )}
            <div
              ref={mountAnchorRef}
              className="ctx-item ctx-has-sub"
              onClick={(e) => { e.stopPropagation(); setMountOpen((v) => !v); }}
              onMouseEnter={() => { disarmMountClose(); setMountOpen(true); }}
            >
              {tx("挂载命令", "Mount command")} <span className="ctx-arrow"><IconChevron size={12} /></span>
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
            <div className="ctx-group">{tx("操作", "Actions")}</div>
            <button
              className="ctx-item danger"
              onClick={() => { store.removeCard(page.id, menuCard.id); setMenu(null); }}
            >
              {tx("删除", "Delete")}
            </button>
          </div>,
          document.body,
        )}

      {gridMenu &&
        createPortal(
          <div
            ref={gridMenuRef}
            className="ctx-menu"
            style={{
              left: gridMenuPos?.left ?? -9999,
              top: gridMenuPos?.top ?? -9999,
              visibility: gridMenuPos ? "visible" : "hidden",
            }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">{tx("控制画布", "Control canvas")}</div>
            <button
              className="ctx-item"
              disabled={!store.hasClipboard()}
              onClick={() => {
                store.pasteCard(page.id, gridMenu.gx, gridMenu.gy);
                setGridMenu(null);
              }}
              title={store.hasClipboard() ? tx("粘贴已复制的控件到此处", "Paste the copied control here") : tx("先右键控件选「复制」", "Right-click a control and choose Copy first")}
            >
              {tx("粘贴", "Paste")}
            </button>
            <button
              className="ctx-item"
              onClick={() => { store.declumpPage(page.id); setGridMenu(null); }}
            >
              {tx("整理布局", "Tidy layout")}
            </button>
          </div>,
          document.body,
        )}

      {debugDialog === "preset" && <DebugPresetDialog onClose={() => setDebugDialog(null)} />}
      {debugDialog === "sets" && page.debugProfile && (
        <ParameterSetDialog
          key={page.id}
          page={page}
          drafts={Object.fromEntries(page.cards.flatMap(c =>
            c.type === "slider" && c.managed?.role === "parameter"
              ? [[c.managed.paramId, getVal(c)]] : []))}
          onLoad={(values, captured) => {
            if (guardLocked()) throw new Error(tx("Operator 配置已锁定", "Operator configuration is locked"));
            // 以发起时捕获的定义签名为准：切页/定义变化在此拒绝，不部分回填。
            const currentPage = requireCurrentParameterPage(store.getSnapshot(), captured);
            const updates = Object.entries(values).map(([paramId, value]) => {
              const cards = currentPage.cards.filter((c): c is SliderCard =>
                c.type === "slider" && c.managed?.role === "parameter" && c.managed.paramId === paramId);
              if (cards.length !== 1 || !Number.isFinite(value)) throw new Error(tx("参数无效", "Invalid parameter"));
              return [cards[0].id, value] as const;
            });
            for (const [id, value] of updates) valuesRef.current.set(id, value);
            setDraftRevision(v => v + 1);
          }}
          onClose={() => setDebugDialog(null)}
        />
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
    </div>
  );
}