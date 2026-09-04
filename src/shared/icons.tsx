import type { ControlType } from "../features/controls/controlsStore";

const svg = (children: React.ReactNode) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

export const IconChevron = (props: { dir?: "right" | "down"; size?: number }) => (
  <svg
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: props.dir === "down" ? "rotate(90deg)" : undefined,
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
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
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

export const IconPuzzle = () =>
  svg(
    <>
      <path d="M9 4a2 2 0 1 1 4 0h4v4a2 2 0 1 1 0 4v4h-4a2 2 0 1 0-4 0H5v-4a2 2 0 1 0 0-4V4h4z" />
    </>,
  );

export const IconCode = () =>
  svg(
    <>
      <path d="M8 6l-5 6 5 6" />
      <path d="M16 6l5 6-5 6" />
    </>,
  );

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
