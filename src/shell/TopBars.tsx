import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import type { ReactNode } from "react";
import * as serialStore from "../features/serial/serialStore";
import { linkSummary } from "../features/serial/linkSummary";
import { patch as patchSettings, useSettings } from "../features/settings/settingsStore";
import type { WorkspacePreset } from "../features/settings/settingsStore";
import { t, tx, useLocale } from "../i18n/strings";
import { Dropdown } from "../shared/Dropdown";
import { Glyph, IconCheck, IconChevron, IconPuzzle, IconSettings, IconSparkle } from "../shared/icons";
import { pendingBadge } from "../features/market/marketBrowse";
import { useAwaitingCount } from "../features/market/useMarketPending";
import { WORKSPACE_META } from "./workspaceMeta";
import iconPlain from "../assets/icon-plain.svg";

/**
 * P104-R2 顶部两条横栏：`IdentityBar`（38px 身份栏）+ `ToolBar`（34px 工具栏）。
 *
 * 沿革：标题栏 36 + 工具栏 36 →（B5）合成一条 44px 命令条 →（R2）拆回两条 38/34。
 * 拆回不是认错，是 B5 只测对了一半：它实测出旧工具栏 1319px 里有 702px 是空 spacer，
 * 于是把两条并成一条；但并完之后"标题栏里躺着接口下拉、发送输入框、+面板选择框"，
 * 用户读到的信号是"这一行很乱"——省下的 28px 买回来的是"哪件是身份、哪件是操作"糊在一起。
 * 现在两条各管一件事，且身份栏零表单控件。
 *
 * 命名债已在 B13④ 还清（原名 `CommandBar.tsx`：B5 那批它是唯一那条命令条，
 * R2 之后它装的是"两条横栏 + 共用的窗口拖拽 / 胶囊 / 下拉原语"）。
 * 改名时要一起动的两处守卫值得留档：`marketUi.test.ts` 与 `tourSteps.test.ts` 都
 * **按文件路径**读这个模块来钉「插件管理」锚点 —— 路径改了没同步，测试不会报"锚点丢了"，
 * 只会读不到文件。这条正是当年拖着不改名的原因，现在连它一起收掉。
 */

/**
 * 接口名与切换器都在 `features/serial/linkSummary.ts` / `LinkPanel.tsx`：
 * R4 起接口切换住在导轨「接入」，工具栏只留一枚只读胶囊，这里不再需要那张表。
 */

function tbSvg(children: ReactNode) {
  return (
    <Glyph>
      {children}
    </Glyph>
  );
}

const IconHelp = () =>
  tbSvg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.4-3 4" />
      <line x1="12" y1="17.5" x2="12.01" y2="17.5" />
    </>,
  );

const IconPin = () =>
  tbSvg(
    <>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-.89 1.55l-1.72.9A2 2 0 0 0 5.34 15z" />
    </>,
  );

/**
 * 纯浏览器（npm run dev 直开）没有 Tauri 内核，getCurrentWindow() 构造即抛；降级为 no-op 桩以便浏览器验证 UI。
 * tauri 环境行为不变。
 * 桩里**列全被调到的方法**：少一个就是整页被错误边界接管（`innerSize` 漏掉时就是这样，
 * 于是"纯浏览器验证通道"这条我们自己依赖的路直接废掉——见 §8-46：兜底要兜得住实际调用面）。
 */
function getWinSafe(): ReturnType<typeof getCurrentWindow> {
  try {
    return getCurrentWindow();
  } catch {
    const p = <T,>(v: T): Promise<T> => Promise.resolve(v);
    const size = () => p({ width: 0, height: 0 });
    const pos = () => p({ x: 0, y: 0 });
    return {
      onResized: () => p(() => {}),
      onMoved: () => p(() => {}),
      isMaximized: () => p(false),
      isFocused: () => p(true),
      innerSize: size,
      outerSize: size,
      innerPosition: pos,
      outerPosition: pos,
      scaleFactor: () => p(1),
      startDragging: () => p(undefined),
      toggleMaximize: () => p(undefined),
      maximize: () => p(undefined),
      unmaximize: () => p(undefined),
      setAlwaysOnTop: () => p(undefined),
      minimize: () => p(undefined),
      close: () => p(undefined),
    } as unknown as ReturnType<typeof getCurrentWindow>;
  }
}

/**
 * 只读链路胶囊：`串口 · COM7 · 115200 · 8N1`。
 * R4 起它是工具栏上关于链路的**唯一**一行字：接口切换器与参数编辑都搬进导轨「接入」，
 * 顶栏只回答"连着什么"。点击派发 `ux:focus-link`，由 LinkPanel 接收（展开接入面板、
 * 滚动并聚焦第一个参数）。事件名沿用 `ux:` 前缀——与 `ux:open-ext-panel` 同族。
 */
export function LinkCapsule() {
  const s = useSyncExternalStore(serialStore.subscribe, serialStore.getSnapshot);
  useSettings();
  return (
    <button
      type="button"
      className="cb-capsule"
      title={tx("接口与连接参数在左侧「接入」里改；点此跳过去", "Interface and link parameters live in the Link rail on the left; click to jump there")}
      onClick={() => window.dispatchEvent(new Event("ux:focus-link"))}
    >
      {linkSummary(s)}
    </button>
  );
}

/** 工作区药丸：九套预设就地切换（此前只能进设置页翻到「工作区」那一栏才能改）。
 *  P115-F21：弹出层从 inline absolute（§20 裁剪风险、Esc 不关、焦点散养、mousedown）
 *  改挂 shared/Dropdown 原语——portal 到 body、÷zoom 定位、点外/Esc 关闭并归还焦点
 *  都是原语的约定；`.cb-ws-menu/.tb-menu-item` 样式钩子原样保留。 */
export function WorkspacePill({ onApplyPreset }: { onApplyPreset: (p: WorkspacePreset) => void }) {
  const { workspace } = useSettings();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const meta = WORKSPACE_META();
  const cur = meta.find((m) => m.key === workspace);
  return (
    <div className="cb-ws">
      <button
        ref={btnRef}
        className="cb-ws-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={tx("工作区预设：一键切换面板组合（当前布局会先自动备份）", "Workspace preset: switch the panel set (current layout is backed up first)")}
        onClick={() => setOpen((v) => !v)}
      >
        {/* P115-F23：标签包一层 span，窄窗时随 media 查询收起，药丸塌成图标档 */}
        <span className="cb-ws-label">{cur?.label ?? workspace}</span>
        <IconChevron size={12} dir="down" />
      </button>
      <Dropdown anchor={btnRef.current} open={open} onClose={() => setOpen(false)} className="cb-ws-menu">
        <span className="tb-menu-title">{t("set.preset")}</span>
        {meta.map((m) => (
          <button
            key={m.key}
            role="menuitem"
            className={`tb-menu-item cb-ws-item${m.key === workspace ? " on" : ""}`}
            title={m.desc}
            onClick={() => {
              patchSettings({ workspace: m.key });
              onApplyPreset(m.key);
              setOpen(false);
              // P115-F21：选中关层后焦点回到药丸——不让键盘流掉进 body（与 Listbox 同一口径）
              btnRef.current?.focus();
            }}
          >
            <span className="cb-ws-name">{m.label}</span>
            <span className="cb-ws-desc">{m.desc}</span>
            {m.key === workspace ? <em className="tb-menu-check"><IconCheck /></em> : null}
          </button>
        ))}
      </Dropdown>
    </div>
  );
}

/** 系统段（AI / 插件管理 / 设置 / 帮助）。
 *  R2 起它**不再参与 chromeStore 的排序与显隐**：这四颗是应用级身份件，
 *  住在身份栏，和"工具栏有哪几段"不是一个问题。B5 把它们塞进同一份名单，
 *  换来的是 chrome_set 能把它们排到工具栏中间去——而那里根本没有它们的位置。
 *
 *  `fullPage`（P114-B，用户："ZCode 的标题栏隐藏了几个组件，只有左边的图标和右边的
 *  关闭、置顶、最小化"）：整页铺满工作区时，这四颗收起来——它们每一颗都只会
 *  "从这个全屏页跳到另一个全屏页"，留在原地只让那条 38px 看起来像工具栏。
 *  这里是**不渲染**而不是 `display:none`：隐藏的话 Tab 键仍会经过四颗点不到的按钮。 */
export function SystemButtons({
  onOpenSettings,
  onOpenHelp,
  onOpenAi,
  onOpenLibrary,
  pinned,
  onTogglePin,
  fullPage = false,
}: {
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenAi: () => void;
  /** 打开设置页的「插件管理」那一栏：开的是现成页，不再造第三个插件库窗口 */
  onOpenLibrary: () => void;
  /** P105-A：置顶原住在 `.tb-win` 里和最小化/关闭并排 —— 它改变的是这个窗口的**行为**，
   *  不是窗口本身，与那三颗不是一类。挪回应用动作组，`.tb-win` 只留 Windows 那三件。 */
  pinned: boolean;
  onTogglePin: () => void;
  /** 有整页（目前就是设置页）正铺在工作区上 */
  fullPage?: boolean;
}) {
  useLocale(); // 这一组按钮的 title/aria 都是 tx() 出来的，切语言要有人重渲染
  /** 装包请求里"等你点"的那几条：正在跑的不算（催你做不了的事比不催更坏） */
  const awaitingBadge = pendingBadge(useAwaitingCount());
  return (
    <div className="toolbar-group cb-sys">
      {!fullPage && (
        <>
      <button className="tb-btn" title={tx("AI 助手 (Ctrl+K)", "AI Assistant (Ctrl+K)")} data-tour="ai" onClick={onOpenAi}>
        <IconSparkle />
      </button>
      {/* data-tour="plugins" 是入门引导第 9 步的高亮锚点（tourSteps.test.ts 按文件路径钉它挂在
          「插件管理」这颗上）。锚点写错不会报错，只会让引导悄悄退化成漂浮卡片。 */}
      <button
        className={`tb-btn${awaitingBadge ? " tb-attn" : ""}`}
        title={tx("插件管理", "Plugin library")}
        aria-label={awaitingBadge ? tx(`插件管理，${awaitingBadge} 条装包请求等你确认`, `Plugin library - ${awaitingBadge} install requests await your call`) : tx("插件管理", "Plugin library")}
        data-tour="plugins"
        onClick={onOpenLibrary}
      >
        <IconPuzzle size={16} />
        {awaitingBadge ? <span className="tb-badge">{awaitingBadge}</span> : null}
      </button>
      <button className="tb-btn" title={t("title.settings")} onClick={onOpenSettings}>
        <IconSettings />
      </button>
      <button className="tb-btn" title={t("title.help")} onClick={onOpenHelp}>
        <IconHelp />
      </button>
      {/* 置顶前一道小竖线（P105 反馈③"像以前一样"）：它标的是"左边四颗是去哪，
          右边这颗是窗口的状态"，不是给分组画框。整页开着时四颗不在，这道线也不在。 */}
      <span className="tb-sep" aria-hidden="true" />
        </>
      )}
      <button
        className={`tb-btn${pinned ? " on" : ""}`}
        title={pinned ? t("title.unpin") : t("title.pin")}
        aria-pressed={pinned}
        onClick={onTogglePin}
      >
        <IconPin />
      </button>
    </div>
  );
}

/**
 * 身份栏（38px）：品牌 + 版本 + 应用级入口 + 窗口控件。
 *
 * **一条表单控件都不许放**——这是 R2 拆回两条的全部理由（用户原话：
 * "一般标题栏没人会放选择框或输入框，不然很奇怪"）。B5 把 44px 合成一条时
 * 顺手把接口下拉、链路胶囊、录制、+面板 全塞进了同一行，结果是标题栏读起来
 * 像一条工具栏，而它该只回答"这是哪个应用、在不在最前"。
 */
export function IdentityBar({
  onOpenSettings,
  onOpenHelp,
  onOpenAi,
  onOpenLibrary,
  fullPage = false,
}: {
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenAi: () => void;
  onOpenLibrary: () => void;
  /** 有整页铺在工作区上（现只有设置页）：应用级入口收起，见 `SystemButtons` 那段 */
  fullPage?: boolean;
}) {
  const win = getWinSafe();
  const [maxed, setMaxed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [ver, setVer] = useState<string | null>(null);
  useEffect(() => {
    // 版本号动态读取（tauri.conf.json 单一来源），硬编码会随发版遗忘
    void getVersion().then((v) => setVer(v)).catch(() => setVer(null));
  }, []);
  useEffect(() => {
    let un1: () => void = () => {};
    /**
     * P96-K3：窗口几何自诊断。无边框（decorations:false）窗口的最大化矩形是最容易出事的
     * 一处（真机反馈：双击标题栏后"中间放大、四边被裁"），而它出错时前端完全无感。
     * 读数常驻 `window.__tbLast`（与 `window.__p3d()` 同族，CDP/控制台可直接取），
     * 只有"内容比工作区还大"这种异常才打日志——那正是边缘被裁的形状。
     */
    const probe = () => {
      void Promise.all([
        win.innerSize(), win.outerSize(), win.innerPosition(), win.outerPosition(), win.isMaximized(),
        currentMonitor(),
      ]).then(([iw, ow, ip, op, mx, mon]) => {
        const info = {
          t: Date.now(),
          inner: [iw.width, iw.height],
          outer: [ow.width, ow.height],
          innerPos: [ip.x, ip.y],
          outerPos: [op.x, op.y],
          maximized: mx,
          monitor: mon ? [mon.position.x, mon.position.y, mon.size.width, mon.size.height] : null,
          workArea: mon
            ? [mon.workArea.position.x, mon.workArea.position.y, mon.workArea.size.width, mon.workArea.size.height]
            : null,
          scale: mon?.scaleFactor ?? null,
          css: [window.innerWidth, window.innerHeight],
          dpr: window.devicePixelRatio,
        };
        (window as unknown as { __tbLast?: unknown }).__tbLast = info;
        if (mon && (iw.width > mon.workArea.size.width || iw.height > mon.workArea.size.height)) {
          console.warn("[chrome diag] window content exceeds the work area; edges get clipped:", JSON.stringify(info));
        }
      }).catch(() => undefined);
    };
    const unP = win.onResized(() => {
      void win.isMaximized().then((v) => setMaxed(v));
      probe();
    }).then((u) => {
      un1 = u;
    });
    void win.isMaximized().then((v) => setMaxed(v));
    probe();
    return () => {
      un1();
      void unP;
    };
  }, [win]);

  /**
   * 拖拽区改成「白名单制 → 指名制」。
   * 旧版整个根节点都是拖拽区，靠 `closest(".tb-btn, .tb-iface, .tb-menu")` 把按钮排除掉——
   * 那是一份**要记得写才对**的清单：命令条里段变多、控件搬家，漏写一个选择器就会得到
   * "双击连接钮把窗口最大化了"这种事故。现在只有 `.cb-drag` 一处能拖能双击，
   * 新加控件默认就是安全的，不需要谁记得去改排除表。
   */
  const dragProps = {
    "data-tauri-drag-region": true,
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      void win.startDragging();
    },
    onDoubleClick: () => {
      void win.toggleMaximize();
    },
  };

  return (
    <header className="ibar">
      <div className="tb-brand" title="Uartix+" {...dragProps}>
        <img
          src={iconPlain}
          alt=""
          width={16}
          height={16}
          style={{ filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.35))" }}
          draggable={false}
        />
        Uartix+
        <span className="tb-ver">{ver ?? ""}</span>
      </div>
      <span className="cb-drag" {...dragProps} />
      <SystemButtons
        fullPage={fullPage}
        onOpenSettings={onOpenSettings}
        onOpenHelp={onOpenHelp}
        onOpenAi={onOpenAi}
        onOpenLibrary={onOpenLibrary}
        pinned={pinned}
        onTogglePin={() => {
          const next = !pinned;
          setPinned(next);
          void win.setAlwaysOnTop(next);
        }}
      />
      {/* P105-A：这里只剩 Windows 那三件（最小化/最大化/关闭）。
          `margin-left:auto` 把它们推到右边缘 —— 无边框窗口的关闭钮不在右上角，
          比"不好看"更糟：它是肌肉记忆层面的错位（改前实测内容止于 x=486，右边 63% 是死的）。 */}
      <div className="tb-win">
        <button className="tb-btn" title={t("title.minimize")} onClick={() => void win.minimize()}>
          <Glyph><line x1="5" y1="12" x2="19" y2="12" /></Glyph>
        </button>
        <button className="tb-btn" title={maxed ? t("title.restore") : t("title.maximize")} onClick={() => void win.toggleMaximize()}>
          {maxed ? (
            <Glyph><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M5 16V5a1 1 0 0 1 1-1h11" /></Glyph>
          ) : (
            <Glyph><rect x="5.5" y="5.5" width="13" height="13" rx="1.5" /></Glyph>
          )}
        </button>
        <button className="tb-btn tb-close" title={t("title.close")} onClick={() => void win.close()}>
          <Glyph><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></Glyph>
        </button>
      </div>
    </header>
  );
}

/**
 * 工具栏（34px）：工作区预设 + chromeStore 装配好的三段（connect / session / layout）。
 *
 * 与身份栏的分工就一句话：**这里每一件都点得动，身份栏那几件是"这是哪个应用"。**
 * 段的内容与顺序仍由 `chromeStore` 决定（App 装配后从 `segs` 传进来），
 * 工作区预设是这条最左边的第一颗——它决定的是"这条工具栏和这块画布是干什么的"，
 * 所以它属于工具栏，不属于身份栏。
 */
export function ToolBar({
  segs,
  onApplyPreset,
}: {
  /** App 按 chromeStore 顺序装配好的各段（connect / session / layout） */
  segs: ReactNode[];
  onApplyPreset: (p: WorkspacePreset) => void;
}) {
  return (
    <header className="tbar">
      <WorkspacePill onApplyPreset={onApplyPreset} />
      <span className="tb-sep" />
      {segs}
    </header>
  );
}
