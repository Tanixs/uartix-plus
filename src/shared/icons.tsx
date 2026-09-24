import type { ControlType } from "../features/controls/controlsStore";

/**
 * P103 批 1：图标基准（全套共用两个数，只有一处出处）。
 *
 * 为什么从 2 收到 1.75：14px 图标配 2.0 描边，墨色偏重——一屏十几颗时整块工具栏会"发黑"，
 * 而 1.75 是这一档尺寸的常用重量，也是大厂桌面端工具栏观感的来源。
 */
export const ICON_STROKE = 1.75;
/** 折角类（chevron）笔画短，与 1.75 同档会显虚 ⇒ 单独留重一档 */
export const ICON_STROKE_BOLD = 2.4;
export const ICON_SIZE = 14;

/** 装饰性 SVG 一律 aria-hidden：可读名字由承载它的按钮给（check:aria 钉的正是那一边） */
const svg = (children: React.ReactNode, size: number = ICON_SIZE) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={ICON_STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** 四向箭头（轮播/折叠都用它）。SVG 而不是 ‹ › 字符：§8-25 禁字符图标。 */
const CHEVRON_ROT = { right: 0, down: 90, left: 180, up: 270 } as const;
export const IconChevron = (props: { dir?: keyof typeof CHEVRON_ROT; size?: number }) => (
  <svg
    width={props.size ?? ICON_SIZE}
    height={props.size ?? ICON_SIZE}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={ICON_STROKE_BOLD}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{
      transform: props.dir && props.dir !== "right" ? `rotate(${CHEVRON_ROT[props.dir]}deg)` : undefined,
      transition: "transform 0.15s",
      flex: "none",
    }}
  >
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

export const IconSlider = () =>
  svg(
    <>
      <path d="M4 12h16" />
      <circle cx="10" cy="12" r="3" fill="currentColor" />
    </>,
  );

export const IconButton = () =>
  svg(<rect x="4" y="8" width="16" height="8" rx="3" />);

export const IconSwitch = () =>
  svg(
    <>
      <rect x="3" y="8" width="18" height="8" rx="4" />
      <circle cx="8" cy="12" r="2.4" fill="currentColor" />
    </>,
  );

export const IconLed = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="5" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
    </>,
  );

export const IconBuzzer = () =>
  svg(
    <>
      <path d="M12 4a5 5 0 0 0-5 5v3.6L5.4 16h13.2L17 12.6V9a5 5 0 0 0-5-5z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
      <path d="M20 7c1.2 1.4 1.2 3.6 0 5M4 7c-1.2 1.4-1.2 3.6 0 5" />
    </>,
  );

export const IconMonitor = () =>
  svg(<polyline points="3 16 9 10 13 14 21 6" />);

export const IconJoystick = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </>,
  );

export const IconKeypad = () =>
  svg(
    <>
      <circle cx="12" cy="6" r="2.6" />
      <circle cx="12" cy="18" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="12" r="2.6" />
    </>,
  );

export const IconKeymon = () =>
  svg(
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="M8 10h8M8 14h5" />
    </>,
  );

export const IconFlipH = () =>
  svg(
    <>
      <path d="M12 3v18" strokeDasharray="3 3" />
      <path d="M8 7L4 12l4 5M16 7l4 5-4 5" />
    </>,
  );

export const IconFlipV = () =>
  svg(
    <>
      <path d="M3 12h18" strokeDasharray="3 3" />
      <path d="M7 8L12 4l5 4M7 16l5 4 5-4" />
    </>,
  );

export const IconGear = () =>
  svg(
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>,
  );

export const IconPause = () =>
  svg(
    <>
      <rect x="6" y="5" width="4" height="14" />
      <rect x="14" y="5" width="4" height="14" />
    </>,
  );

export const IconPlay = () => svg(<polygon points="6 4 20 12 6 20" />);

export const IconCamera = () =>
  svg(
    <>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </>,
  );

export const IconTrash = () =>
  svg(
    <>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </>,
  );

export const IconColumns = () =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </>,
  );

export const IconDownload = () =>
  svg(
    <>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 21h16" />
    </>,
  );

export const IconLock = () =>
  svg(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>,
  );

export const IconUnlock = () =>
  svg(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.9-.8" />
    </>,
  );

export const IconSidebar = () =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>,
  );

export const IconSearch = () =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>,
  );

export const IconTune = () =>
  svg(
    <>
      <path d="M4 7h9M19.5 7H20M4 17h1M11 17h9" />
      <circle cx="16" cy="7" r="2.4" />
      <circle cx="8" cy="17" r="2.4" />
    </>,
  );

/* 2D 曲线工具栏图标 */

/* 十字准星游标 */
export const IconCrosshair = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </>,
  );

/* 堆叠（三层斜叠，Material "layers" 造型） */
export const IconStack = () =>
  svg(
    <>
      <path d="M12 2 2.5 7 12 12l9.5-5L12 2z" />
      <path d="M2.5 12 12 17l9.5-5" />
      <path d="M2.5 17 12 22l9.5-5" />
    </>,
  );

/* Y 轴自动缩放（上下箭头 + 中线） */
export const IconAutoY = () =>
  svg(
    <>
      <path d="M12 3v18" />
      <path d="M8 7l4-4 4 4M8 17l4 4 4-4" />
    </>,
  );

/* 一次性自适应（四角外扩箭头，Material "fit" 造型） */
export const IconFitView = () =>
  svg(
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </>,
  );

/* 时间游标（垂直标尺线 + 上下旗标） */
export const IconCursorX = () =>
  svg(
    <>
      <path d="M12 3v18" />
      <path d="M8 3h8l-4 4-4-4z" fill="currentColor" stroke="none" />
      <path d="M8 21h8l-4-4-4 4z" fill="currentColor" stroke="none" />
    </>,
  );

/* 幅值游标（水平标尺线 + 左右旗标） */
export const IconCursorY = () =>
  svg(
    <>
      <path d="M3 12h18" />
      <path d="M3 8v8l4-4-4-4z" fill="currentColor" stroke="none" />
      <path d="M21 8v8l-4-4 4-4z" fill="currentColor" stroke="none" />
    </>,
  );

export const IconSend = () =>
  svg(<path d="M4 12h13M13 6l6 6-6 6" />);

export const IconStop = () =>
  svg(<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />);

export const IconSparkle = () =>
  svg(
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z" />
    </>,
  );

export const IconDock = () =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>,
  );

export const IconUpload = () =>
  svg(
    <>
      <path d="M12 15V4M7 9l5-5 5 5" />
      <path d="M4 21h16" />
    </>,
  );

export const IconPop = () =>
  svg(
    <>
      <path d="M15 4h5v5" />
      <path d="M20 4l-7 7" />
      <path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    </>,
  );

export const IconEye = () =>
  svg(
    <>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </>,
  );

export const IconEyeOff = () =>
  svg(
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.4 17.4 0 0 1-3.1 3.9M6.1 6.1A16.6 16.6 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 4.4-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>,
  );

/**
 * 拼图（插件）。两件事都是量出来的，不是估的：
 * ① 未加变换时墨盒中心在 **(12,9)**（标题栏那颗实测偏上 1px、偏左 1px）；
 * ② 墨盒只占 viewBox 的六成，跟旁边几颗比就"看着小"。
 * 这一串变换＝把墨盒中心搬回 (12,12) 并整体放大（1.3 是量出来的：占比 0.58→0.76，与旁边齿轮的 0.92 同档）；改它要在浏览器里重测
 * `path.getBoundingClientRect()` 与 svg 中心的差（本批实测 dx/dy 从 0.67/-0.67 → 0/0）。
 *
 * **描边要跟着反向补偿**：`scale(1.3)` 把 `strokeWidth="2"` 一起放大了（2.6），
 * 叠上这颗用 16px 而邻居用 14px，屏上就是 1.73px vs 1.17px——用户看到的"边缘太粗"是这 48%。
 * 除以同一个系数，墨盒尺寸不动、重量回到同一档。
 */
export const IconPuzzle = (props?: { size?: number }) =>
  svg(
    <>
      <path
        transform="translate(12 12) scale(1.3) translate(-12 -9)"
        strokeWidth={ICON_STROKE / 1.3}
        d="M9 4a2 2 0 1 1 4 0h4v4a2 2 0 1 1 0 4v4h-4a2 2 0 1 0-4 0H5v-4a2 2 0 1 0 0-4V4h4z"
      />
    </>,
    props?.size,
  );

/** 齿轮（设置）。P102 从 TitleBar 的本地 const 上收：市场页那颗「货架来源」也要同一颗，抄一份就会漂。 */
export const IconSettings = (props?: { size?: number }) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    props?.size,
  );

export const IconCode = () =>
  svg(
    <>
      <path d="M8 6l-5 6 5 6" />
      <path d="M16 6l5 6-5 6" />
    </>,
  );

/** 哨兵：盾牌（P62） */
export const IconShield = () =>
  svg(
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      <path d="M9.5 12l2 2 3.5-4" />
    </>,
  );

/** 哨兵：铃铛（报警/浮球，P62） */
export const IconBell = () =>
  svg(
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>,
  );

/** 哨兵：脉冲波形（通道监测，P62） */
export const IconPulse = () =>
  svg(<path d="M3 12h4l2.5-6 4 12 2.5-6h5" />);

/* ================= P74c：通用小图标（统一 lucide 风格，替代字符图标） ================= */

/** 拖拽把手：六点网格 */
export const IconGrip = () =>
  svg(
    <>
      <circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none" />
    </>,
  );

/** 复制 */
export const IconCopy = () =>
  svg(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
  );

/** 关闭 / 删除 */
export const IconClose = () =>
  svg(<path d="M6 6l12 12M18 6L6 18" />);

/** 新增 */
export const IconPlus = () =>
  svg(<path d="M12 5v14M5 12h14" />);

export const IconArrowUp = () =>
  svg(
    <>
      <path d="M12 20V4" />
      <path d="M6 10l6-6 6 6" />
    </>,
  );

export const IconArrowDown = () =>
  svg(
    <>
      <path d="M12 4v16" />
      <path d="M18 14l-6 6-6-6" />
    </>,
  );

/** 计时器 / 时钟（组静默期、时间条用） */
export const IconClock = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>,
  );

/** 列表 / 运行日志 */
export const IconLogs = () =>
  svg(
    <>
      <path d="M4 5h10M4 10h16M4 15h16M4 20h10" />
    </>,
  );

/** 队列（运行中实例徽标） */
export const IconQueue = () =>
  svg(
    <>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="19" cy="18" r="2" fill="currentColor" stroke="none" />
    </>,
  );

/** 单选：选中实心点 */
export const IconDot = () =>
  svg(<circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />);

/** 单选：未选中空圈（与 IconDot 同尺寸，避免行宽跳动） */
export const IconCircle = () =>
  svg(<circle cx="12" cy="12" r="4.5" />);

/** 椭球校准模式标记 */
export const IconTarget = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>,
  );

/** 重拟合 / 刷新 */
/** 3D 视角预设四图标（P82②：HUD 文字钮「俯/侧/正/等」SVG 化，红线 24/25） */
export const IconViewTop = () =>
  svg(
    <>
      <path d="M12 3v5m0 0L9.8 5.8M12 8l2.2-2.2" />
      <rect x="4" y="11" width="16" height="9" rx="2" />
    </>,
  );

export const IconViewSide = () =>
  svg(
    <>
      <path d="M3 12h5m0 0L6.2 9.8M8 12l-1.8 2.2" />
      <rect x="11" y="4" width="9" height="16" rx="2" />
    </>,
  );

export const IconViewFront = () =>
  svg(
    <>
      <path d="M21 12h-5m0 0l1.8-2.2M16 12l1.8 2.2" />
      <rect x="4" y="4" width="9" height="16" rx="2" />
    </>,
  );

export const IconViewIso = () =>
  svg(
    <>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.3 7l8.7 5 8.7-5M12 22V12" />
    </>,
  );

/** 自动旋转（环绕箭头 + 中心点，区别于 IconRotate 的单箭头复位） */
export const IconAutoSpin = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 4.5a7.5 7.5 0 0 1 7.4 6.3M19.5 12A7.5 7.5 0 0 1 12 19.5M4.5 12A7.5 7.5 0 0 1 12 4.5" />
      <path d="M17.2 7.6l2.4.9-.5 2.5" />
    </>,
  );

export const IconRotate = () =>
  svg(
    <>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.5h-4.5" />
    </>,
  );

/** 重命名 / 编辑（feather edit-2 造型，lucide pencil 同源） */
export const IconEdit = () =>
  svg(<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />);

/** 完成 / 已采集 */
export const IconCheck = () =>
  svg(<path d="M4.5 12.5l5 5 10-11" />);

export const WIDGET_ICONS: Record<ControlType, React.ReactNode> = {
  slider: IconSlider(),
  button: IconButton(),
  switch: IconSwitch(),
  led: IconLed(),
  buzzer: IconBuzzer(),
  monitor: IconMonitor(),
  joystick: IconJoystick(),
  keypad: IconKeypad(),
  keymon: IconKeymon(),
  group: IconPuzzle(),
  custom: IconCode(),
};
