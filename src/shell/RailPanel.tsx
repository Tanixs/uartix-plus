import { useEffect, useRef, useSyncExternalStore } from "react";
import { PANEL_GROUPS, panelGroupLabel, panelGroupsAddable } from "../panels/panelMenu";
import { panelTitleOf } from "../panels/panels";
import * as panelActivity from "../panels/panelActivity";
import { getExt, useExtensions } from "../features/ai/extensionStore";
import { requestClosePanel, requestOpenPanel } from "../features/ai/appBus";
import { removeLayout, useLayouts } from "../features/settings/layoutsStore";
import { tx, useLocale } from "../i18n/strings";
import { IconLayoutEdit, IconPlus } from "../shared/icons";
import {
  railPanel,
  railProtoTab,
  setRailProtoTab,
  railPanelBounds,
  railPanelW,
  resetRailPanelW,
  setRailPanelW,
  subscribeRail,
} from "./railState";
import { zoomFactor } from "../shared/zoom";
import { devRailW } from "../dev/bootOverrides";
import { LinkPanel } from "../features/serial/LinkPanel";
import { TemplatesPanel } from "../features/protocol/TemplatesPanel";
import { SendSpecLibrary } from "../features/send/SendSpecLibrary";
import { WidgetGallery } from "../features/controls/WidgetGallery";
import { CommandLibrary } from "../features/controls/CommandLibrary";

/**
 * 二级面板：导轨当前项的内容。
 *
 * 面板本身不含任何业务状态——它只是把已有的 store 与 appBus 摆出来：
 * 开面板走 `requestOpenPanel`，关走 `requestClosePanel`，布局槽走 `layoutsStore`。
 * 所以这里没有"第二真值"，只有第二个**入口**（入口可以有多个，真值不行）。
 */

export interface RailActions {
  editLayout: boolean;
  onToggleEditLayout: () => void;
  onApplyLayoutSlot: (id: string) => void;
  onSaveLayout: (name: string) => boolean;
}

/** 版本串：面板开合状态变了就重算，用它驱动 useSyncExternalStore */
function activityVersion() {
  let v = "";
  for (const g of PANEL_GROUPS) for (const id of g.ids) v += (panelActivity.isOpen(id) ? "o" : "-") + (panelActivity.isVisible(id) ? "v" : "-");
  return v;
}

function ViewPanel({ actions }: { actions: RailActions }) {
  useSyncExternalStore(panelActivity.subscribe, activityVersion);
  const layouts = useLayouts().slots;
  const exts = useExtensions();
  const extList = exts.exts.filter((e) => e.type === "panel" && e.enabled);

  return (
    <div className="rp-body">
      <div className="rp-sec">
        <div className="rp-sec-head">
          {tx("显示区布局", "Area layout")}
          <button
            type="button"
            className={`rp-mini${actions.editLayout ? " on" : ""}`}
            aria-pressed={actions.editLayout}
            title={tx("编辑显示区布局：沿显示区边缘的 + 号向对应方向新建空显示区", "Edit layout: use the + on area edges to add areas")}
            onClick={actions.onToggleEditLayout}
          >
            <IconLayoutEdit />
            {tx("编辑布局", "Edit layout")}
          </button>
        </div>
        <div className="rp-slots">
          {layouts.length === 0 && (
            <div className="rp-hint">{tx("还没有命名布局。摆好窗口后在这里存一个。", "No named layouts yet. Arrange the windows, then save one here.")}</div>
          )}
          {layouts.map((s) => (
            <div key={s.id} className="rp-slot">
              <button
                type="button"
                className="rp-slot-name"
                title={s.auto ? tx("自动备份：切换预设前的现场快照", "Auto backup: snapshot before a preset switch") : tx("应用此布局", "Apply this layout")}
                onClick={() => actions.onApplyLayoutSlot(s.id)}
              >
                {s.name}
              </button>
              {!s.auto && (
                <button
                  type="button"
                  className="rp-slot-del"
                  title={tx("删除该布局", "Delete this layout")}
                  onClick={() => removeLayout(s.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="rp-slot rp-slot-add"
            title={tx("把当前布局存为一个命名槽", "Save the current layout as a named slot")}
            onClick={() => actions.onSaveLayout(tx(`布局 ${layouts.filter((l) => !l.auto).length + 1}`, `Layout ${layouts.filter((l) => !l.auto).length + 1}`))}
          >
            <IconPlus /> {tx("存为布局", "Save layout")}
          </button>
        </div>
      </div>

      {panelGroupsAddable().map((g) => (
        <div key={g.key} className="rp-sec">
          <div className="rp-sec-title">{panelGroupLabel(g)}</div>
          {g.ids.map((id) => {
            const open = panelActivity.isOpen(id);
            const vis = panelActivity.isVisible(id);
            return (
              <div key={id} className={`rp-item${vis ? " vis" : ""}${open ? " open" : ""}`}>
                <button
                  type="button"
                  className="rp-item-name"
                  title={open ? tx("已打开：点击聚焦", "Open: click to focus") : tx("打开此面板", "Open this panel")}
                  onClick={() => requestOpenPanel(id)}
                >
                  {panelTitleOf(id)}
                </button>
                {open && (
                  <button
                    type="button"
                    className="rp-item-close"
                    title={tx("关闭面板（关闭后其数据管道随之停止）", "Close the panel (its data pipeline stops with it)")}
                    onClick={() => requestClosePanel(id)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {extList.length > 0 && (
        <div className="rp-sec">
          <div className="rp-sec-title">{tx("AI 扩展面板", "AI extension panels")}</div>
          {extList.map((e) => (
            <div key={e.id} className="rp-item">
              <button
                type="button"
                className="rp-item-name"
                title={tx("打开扩展面板", "Open the extension panel")}
                onClick={() => requestOpenPanel(`ext-panel-${e.id}`)}
              >
                {e.name || getExt(e.id)?.name || e.id}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 二级面板：只在有内容时占宽（收起 = 0，不渲染）。 */
export function RailPanel({ actions }: { actions: RailActions }) {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const open = useSyncExternalStore(subscribeRail, railPanel);
  const protoTab = useSyncExternalStore(subscribeRail, railProtoTab);
  const w = useSyncExternalStore(subscribeRail, railPanelW);
  const asideRef = useRef<HTMLElement | null>(null);

  /** P105-D 取证入口：`?railw=420`。走 setRailPanelW 的钳制，所以拍出来的一定是拖得出来的状态。 */
  useEffect(() => {
    const w = devRailW();
    if (w) setRailPanelW(w);
  }, []);

  /**
   * P105-D：拖右边缘改宽。
   *
   * 拖动过程中**只写 CSS 变量**，不碰 store —— 每帧 `setRailPanelW()` 会通知订阅者，
   * 而 App 的订阅回调是 `api.layout(gridSize(...))`，那是拿 pointermove 的帧率去重排
   * 二十个面板。松手时提交一次，重排也只在松手后发生一次。
   * 位移要**除以缩放**：`getBoundingClientRect` 给的是缩放后的视觉 px，
   * 而 dockview 的宽度与 `gridSize()` 都是逻辑 px（B1/B2 撞过的同一个坑）。
   */
  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = asideRef.current;
    if (!el) return;
    e.preventDefault();
    const startW = el.getBoundingClientRect().width / zoomFactor();
    const sx = e.clientX;
    const bounds = () => railPanelBounds();
    const live = (ev: PointerEvent) => {
      const b = bounds();
      const next = Math.min(b.max, Math.max(b.min, Math.round(startW + (ev.clientX - sx) / zoomFactor())));
      el.style.setProperty("--rail-w", `${next}px`);
      return next;
    };
    const onMove = (ev: PointerEvent) => void live(ev);
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setRailPanelW(live(ev));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** 键盘也能调：只用鼠标的调整控件对键盘用户等于不存在。±16px 一步，Home 复位。 */
  const onResizeKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowRight") setRailPanelW(railPanelW() + step);
    else if (e.key === "ArrowLeft") setRailPanelW(railPanelW() - step);
    else if (e.key === "Home") resetRailPanelW();
    else return;
    e.preventDefault();
  };

  if (!open) return null;
  return (
    <aside
      ref={asideRef}
      className="rail-panel"
      style={{ "--rail-w": `${w}px` } as React.CSSProperties}
      aria-label={tx("工作区内容", "Workspace content")}
    >
      {open === "views" && <ViewPanel actions={actions} />}
      {/* R4：接入面板是新写的（接口选择 + 参数一处看完）；
          协议面板是把 TemplatesPanel **原样换个家**——组件本来就自包含，
          搬它等于搬一个 React 元素，零行为改动，比拆 500 行安全得多。 */}
      {open === "link" && (
        <div className="rp-body">
          <LinkPanel />
        </div>
      )}
      {open === "templates" && (
        /* P124-B：「协议」这一项里两条二级页 —— 解析协议 / 发送谱。
           发送谱也是协议（一条线怎么收、怎么发），所以它不配第 6 格导轨，
           配的是同一格里的一页；两边本来就互派生，并排放这座桥才看得见。 */
        <div className="rp-proto">
          <div className="rp-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={protoTab === "parse"}
              className={protoTab === "parse" ? "on" : ""}
              onClick={() => setRailProtoTab("parse")}
            >
              {tx("解析协议", "Parsing")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={protoTab === "send"}
              className={protoTab === "send" ? "on" : ""}
              onClick={() => setRailProtoTab("send")}
            >
              {tx("发送谱", "Send specs")}
            </button>
          </div>
          <div className="rp-proto-body">{protoTab === "parse" ? <TemplatesPanel /> : <SendSpecLibrary />}</div>
        </div>
      )}
      {/* R3：控件库 / 命令库从控制画布的抽屉搬进来。两者都要滚动，
          而「视图」自己带 .rp-body、字段图例自己带 .legend-root 的滚动列，
          所以只有这两项需要外层补一个滚动壳。 */}
      {open === "widgets" && (
        <div className="rp-body rp-body-lib">
          <WidgetGallery />
        </div>
      )}
      {open === "commands" && (
        <div className="rp-body rp-body-lib">
          <CommandLibrary />
        </div>
      )}
      {/* P105-D：右边缘的拖拽条。放在 aside **里面**而不是当兄弟节点，
          是为了让它天然继承面板高度（含 dockview 之外的整条左栏），
          也省掉"面板收起时还要记得把 sash 一起摘掉"这条要记得做才对的事。
          可见 4px、命中区靠 ::before 扩到 16px —— 与 B13 给 dockview sash 的手法同一条。 */}
      <div
        className="rail-sash"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        aria-label={tx("调整二级面板宽度", "Resize the side panel")}
        title={tx("拖动调整宽度（双击复位）", "Drag to resize (double-click to reset)")}
        onPointerDown={startResize}
        onDoubleClick={resetRailPanelW}
        onKeyDown={onResizeKey}
      />
    </aside>
  );
}
