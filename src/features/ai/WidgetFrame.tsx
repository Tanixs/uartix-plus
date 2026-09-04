import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getChannelName,
  requestSendViaHub,
  requestAskViaHub,
  requestThemeViaHub,
  buildSnap,
  type WidgetSnap,
} from "./widgetHub";
import { runAppAction } from "./appActions";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import { collectThemeVars } from "./extRuntime";
import { getChatFeed } from "./aiChatFeed";
import { injectBridge } from "./widgetBridge";
import { WidgetMenu, type WidgetMenuItem } from "./widgetShell";

interface Props {
  widget: { id: string; name: string; html: string };
  isDesktop: boolean;
  /** 无边框形态：注入按住即拖 + 右键菜单辅助 */
  bare?: boolean;
  onHeight?: (h: number) => void;
  /** aiw:win 窗口控制请求（move/dragDelta/size/close/get…），可返回 {data} 应答 */
  onWin?: (
    req: { action: string } & Record<string, unknown>,
  ) => Promise<{ data?: unknown } | void> | { data?: unknown } | void;
  /** 系统菜单项（置顶/穿透/弹出桌面/关闭…），由宿主提供；自定义菜单默认拼接在其后 */
  sysMenu?: () => WidgetMenuItem[];
}

export interface WidgetFrameHandle {
  /** 宿主容器右键等入口：按视口坐标呼出菜单 */
  showMenu: (vx: number, vy: number) => void;
}

interface RawMenuItem {
  id?: string;
  label?: string;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  sep?: boolean;
  children?: RawMenuItem[];
}
interface MenuReg {
  items: RawMenuItem[];
  system: boolean;
}
interface MenuState {
  menus: Record<string, MenuReg>;
  off: boolean;
  def: string;
}

const EMPTY_MENUS: MenuState = { menus: {}, off: false, def: "default" };

function toItems(
  raw: RawMenuItem[],
  menuName: string,
  pick: (menu: string, id: string) => void,
): WidgetMenuItem[] {
  return raw
    .filter((r) => r && (r.sep || typeof r.label === "string"))
    .slice(0, 24)
    .map((r) => ({
      label: String(r.label ?? ""),
      danger: !!r.danger,
      checked: typeof r.checked === "boolean" ? r.checked : undefined,
      disabled: !!r.disabled,
      sep: !!r.sep,
      children: r.children ? toItems(r.children, menuName, pick) : undefined,
      onClick: () => pick(menuName, String(r.id ?? r.label ?? "")),
    }));
}

export const WidgetFrame = forwardRef<WidgetFrameHandle, Props>(function WidgetFrame(
  { widget, isDesktop, bare, onHeight, onWin, sysMenu },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const chanRef = useRef<BroadcastChannel | null>(null);
  const lastSnap = useRef<WidgetSnap | null>(null);
  const cursorWatch = useRef(false);
  const cursorCleanup = useRef<(() => void) | null>(null);
  const menusRef = useRef<MenuState>(EMPTY_MENUS);
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const srcDoc = useMemo(() => injectBridge(widget.html, !!bare), [widget.html, bare]);

  useImperativeHandle(ref, () => ({
    showMenu: (vx: number, vy: number) =>
      setMenu({ name: menusRef.current.def, x: vx, y: vy }),
  }));

  const pickMenu = (menuName: string, id: string) => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "aiw:menu-pick", menu: menuName, id },
      "*",
    );
  };

  useEffect(() => {
    const sendAllowed = getSettings().aiWidgetSend;
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data as { type?: string } & Record<string, unknown>;
      if (!d || typeof d.type !== "string" || !d.type.startsWith("aiw:")) return;
      const target = frame.contentWindow;
      switch (d.type) {
        case "aiw:ready": {
          const th = isDesktop ? null : collectThemeVars();
          target?.postMessage(
            {
              type: "aiw:init",
              perms: { send: sendAllowed },
              screen: isDesktop ? null : { w: window.innerWidth, h: window.innerHeight },
              vars: th?.vars ?? null,
              theme: th?.theme ?? null,
            },
            "*",
          );
          const snap = lastSnap.current ?? buildSnap();
          target?.postMessage({ type: "aiw:snap", snap }, "*");
          target?.postMessage({ type: "aiw:chat", feed: getChatFeed() }, "*");
          if (isDesktop) {
            // 桌面窗：向主窗口索取主题变量 + 上报显示器逻辑尺寸（边界感知）
            requestThemeViaHub();
            void import("@tauri-apps/api/window")
              .then(async (m) => {
                const mon = (await m.currentMonitor()) ?? (await m.primaryMonitor());
                if (!mon) return;
                const s = mon.scaleFactor || 1;
                target?.postMessage(
                  {
                    type: "aiw:screen",
                    screen: { w: Math.round(mon.size.width / s), h: Math.round(mon.size.height / s) },
                  },
                  "*",
                );
              })
              .catch(() => undefined);
          }
          break;
        }
        case "aiw:resize": {
          const h = Number(d.height);
          if (Number.isFinite(h) && h > 0 && h <= 2000) onHeight?.(Math.round(h));
          break;
        }
        case "aiw:getSnap": {
          target?.postMessage({ type: "aiw:snap", snap: lastSnap.current ?? buildSnap() }, "*");
          break;
        }
        case "aiw:menu-def": {
          const menus = (d.menus ?? {}) as Record<string, MenuReg>;
          menusRef.current = {
            menus,
            off: !!d.off,
            def: String(d.def || "default"),
          };
          break;
        }
        case "aiw:send": {
          const mode = d.mode === "hex" ? "hex" : "ascii";
          const text = String(d.text ?? "");
          if (!sendAllowed) {
            target?.postMessage({ type: "aiw:send-res", reqId: d.reqId, ok: false, err: "小部件发送权限未开启" }, "*");
            break;
          }
          const run = isDesktop
            ? requestSendViaHub(mode, text)
            : import("../serial/serialStore").then((m) => m.sendData(mode, text));
          void run
            .then(() => target?.postMessage({ type: "aiw:send-res", reqId: d.reqId, ok: true }, "*"))
            .catch((err) =>
              target?.postMessage(
                { type: "aiw:send-res", reqId: d.reqId, ok: false, err: String(err).slice(0, 120) },
                "*",
              ),
            );
          break;
        }
        case "aiw:ask": {
          // 向 AI 助手提问（回答经 aiw:chat 流式回来）；与发送共用外部动作权限
          const text = String(d.text ?? "").slice(0, 4000);
          const reqId = d.reqId;
          const res = (ok: boolean, err?: string) =>
            target?.postMessage({ type: "aiw:ask-res", reqId, ok, err }, "*");
          if (!sendAllowed) {
            res(false, "小部件发送权限未开启（uartix.ask 需要该权限）");
            break;
          }
          if (!text.trim()) {
            res(false, "提问内容为空");
            break;
          }
          if (isDesktop) {
            void requestAskViaHub(text)
              .then(() => res(true))
              .catch((err) => res(false, String(err).slice(0, 120)));
          } else {
            void import("./chatStore").then((m) => {
              const r = m.requestAsk(text);
              res(r.ok, r.err);
            });
          }
          break;
        }
        case "aiw:app": {
          // App Action：低权限档（破坏性动作由 runAppAction 内部拒绝）
          // 兼容两种参数：uartix.app 桥的 {kind,args:{…}} 嵌套式 与 旧协议的 {kind,…平铺}
          const reqId = String(d.reqId ?? "");
          const action = (d.action ?? {}) as { kind?: string; args?: Record<string, unknown> } & Record<string, unknown>;
          const kind = String(action.kind ?? "");
          const args =
            action.args && typeof action.args === "object"
              ? (action.args as Record<string, unknown>)
              : action;
          void runAppAction(kind, args, { highPriv: false })
            .then((r) =>
              target?.postMessage({ type: "aiw:app-res", reqId, ...r }, "*"),
            )
            .catch((err) =>
              target?.postMessage(
                { type: "aiw:app-res", reqId, ok: false, err: String(err).slice(0, 120) },
                "*",
              ),
            );
          break;
        }
        case "aiw:win": {
          const action = String(d.action ?? "");
          // menu：由本组件直接渲染（自定义菜单注册表在这里）
          if (action === "menu") {
            const rect = frame.getBoundingClientRect();
            const x = Number(d.x);
            const y = Number(d.y);
            setMenu({
              name: String(d.menu || menusRef.current.def),
              x: rect.left + (Number.isFinite(x) ? x : rect.width / 2),
              y: rect.top + (Number.isFinite(y) ? y : 30),
            });
            break;
          }
          const reqId = String(d.reqId ?? "");
          if (!action || !onWin) {
            if (reqId)
              target?.postMessage(
                { type: "aiw:win-res", reqId, ok: false, err: "当前形态不支持窗口控制" },
                "*",
              );
            break;
          }
          void Promise.resolve(onWin({ ...d, action }))
            .then((r) =>
              reqId
                ? target?.postMessage({ type: "aiw:win-res", reqId, ok: true, data: r?.data }, "*")
                : undefined,
            )
            .catch((err) =>
              target?.postMessage(
                { type: "aiw:win-res", reqId, ok: false, err: String(err).slice(0, 120) },
                "*",
              ),
            );
          break;
        }
        case "aiw:x2w": {
          // 挂件互感：经 BroadcastChannel 中继给其他沙箱组件（跨窗口可达）
          try {
            chanRef.current?.postMessage({
              type: "aiw:x2w",
              from: widget.id,
              topic: String(d.topic ?? ""),
              data: d.data ?? null,
            });
          } catch {
            /* 通道不可用时静默 */
          }
          break;
        }
        case "aiw:cursor": {
          // 光标追踪（眼睛跟随鼠标等）：桌面窗轮询全局光标；浮窗用窗口级 mousemove
          if (!d.on || cursorWatch.current) break;
          cursorWatch.current = true;
          if (isDesktop) {
            void (async () => {
              const { getCurrentWindow, cursorPosition } = await import("@tauri-apps/api/window");
              const win = getCurrentWindow();
              const scale = (await win.scaleFactor().catch(() => 1)) || 1;
              while (cursorWatch.current) {
                try {
                  const [cur, pos] = await Promise.all([cursorPosition(), win.outerPosition()]);
                  target?.postMessage(
                    { type: "aiw:cursor", x: (cur.x - pos.x) / scale, y: (cur.y - pos.y) / scale },
                    "*",
                  );
                } catch {
                  break;
                }
                await new Promise((r) => setTimeout(r, 120));
              }
            })();
          } else {
            const onMove = (ev: MouseEvent) => {
              if (!cursorWatch.current) return;
              const r = frameRef.current?.getBoundingClientRect();
              if (!r) return;
              target?.postMessage(
                { type: "aiw:cursor", x: ev.clientX - r.left, y: ev.clientY - r.top },
                "*",
              );
            };
            window.addEventListener("mousemove", onMove);
            cursorCleanup.current = () => window.removeEventListener("mousemove", onMove);
          }
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      cursorWatch.current = false;
      cursorCleanup.current?.();
      cursorCleanup.current = null;
    };
  }, [isDesktop, bare, onHeight, onWin, widget.id]);

  // 按键转发：桌面窗聚焦即全收；应用内浮窗仅指针悬停在组件上时转发，
  // 且主窗口焦点在输入控件时不转发（保护聊天输入框）
  useEffect(() => {
    const typing = () => {
      const ae = document.activeElement as HTMLElement | null;
      return (
        !!ae &&
        (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)
      );
    };
    let hover = true;
    const over = () => {
      hover = true;
    };
    const out = () => {
      hover = false;
    };
    const fire = (e: KeyboardEvent) => {
      if (!isDesktop && (!hover || typing())) return;
      frameRef.current?.contentWindow?.postMessage(
        {
          type: "aiw:key",
          kind: e.type,
          key: e.key,
          code: e.code,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        },
        "*",
      );
    };
    const el = frameRef.current;
    if (!isDesktop && el) {
      hover = false;
      el.addEventListener("mouseover", over);
      el.addEventListener("mouseout", out);
    }
    window.addEventListener("keydown", fire);
    window.addEventListener("keyup", fire);
    return () => {
      window.removeEventListener("keydown", fire);
      window.removeEventListener("keyup", fire);
      if (el) {
        el.removeEventListener("mouseover", over);
        el.removeEventListener("mouseout", out);
      }
    };
  }, [isDesktop, widget.id]);

  // 统一数据链路：hub（主窗口内启动）每 ≤500ms 广播一次快照，
  // 应用内浮窗与桌面独立窗口走同一条 BroadcastChannel 通道。
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(getChannelName());
    } catch {
      return;
    }
    const chan = ch;
    chanRef.current = chan;
    chan.onmessage = (e: MessageEvent) => {
      const d = e.data as {
        type?: string;
        snap?: WidgetSnap;
        from?: string;
        topic?: string;
        data?: unknown;
      };
      if (!d || typeof d.type !== "string") return;
      if (d.type === "aiw:snap" && d.snap) {
        lastSnap.current = d.snap;
        frameRef.current?.contentWindow?.postMessage({ type: "aiw:snap", snap: d.snap }, "*");
      } else if (d.type === "aiw:chat") {
        // AI 对话状态（思考中/输出中/完成 + 思维链/正文尾部）→ 小部件感知 AI
        frameRef.current?.contentWindow?.postMessage(d, "*");
      } else if (d.type === "aiw:theme") {
        // 主题桥：换肤实时跟随（hub 在主窗口广播）
        frameRef.current?.contentWindow?.postMessage(d, "*");
      } else if (d.type === "aiw:x2w" && d.from !== widget.id) {
        // 其他挂件广播 → 本组件
        frameRef.current?.contentWindow?.postMessage(
          { type: "aiw:x2w-in", topic: d.topic, data: (d as { data?: unknown }).data, from: d.from },
          "*",
        );
      }
    };
    return () => {
      chan.onmessage = null;
      chan.close();
      if (chanRef.current === chan) chanRef.current = null;
    };
  }, [widget.id]);

  // 组装菜单：自定义项（注册表）+ 系统项（宿主提供，system:false 可隐藏）
  let menuItems: WidgetMenuItem[] = [];
  if (menu) {
    const reg = menusRef.current.menus[menu.name];
    const custom = reg ? toItems(reg.items ?? [], menu.name, pickMenu) : [];
    const sys = sysMenu?.() ?? [];
    menuItems = custom.length
      ? reg?.system === false
        ? custom
        : [...custom, { label: "", sep: true }, ...sys]
      : sys;
  }

  return (
    <>
      <iframe
        ref={frameRef}
        className="aiw-frame"
        style={{ height: "100%" }}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        title={widget.name}
      />
      {menu && menuItems.length > 0 && (
        <WidgetMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </>
  );
});
