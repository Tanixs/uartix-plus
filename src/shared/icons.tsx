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

export const IconMonitor = () =>
  svg(<polyline points="3 16 9 10 13 14 21 6" />);

export const IconJoystick = () =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
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

export const WIDGET_ICONS: Record<ControlType, React.ReactNode> = {
  slider: IconSlider(),
  button: IconButton(),
  switch: IconSwitch(),
  led: IconLed(),
  monitor: IconMonitor(),
  joystick: IconJoystick(),
};
