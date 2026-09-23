import { HelpHint } from "./HelpHint";

/**
 * 「一行设置」的形状只此一份（P98 起）：主标签 + 可选「?」+ 控件列。
 *
 * 它原先住在 `SettingsModal` 里，只有设置页能用；独立小组件想同形就得抄一遍
 * div/label/set-ctl。P102 把市场那两行搬进市场弹窗后，两个界面共用这一个形状——
 * 抄一份就会漂移（一边改了间距，另一边还留着旧的）。
 */
export function SetRow({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <label>
        {label}
        {tip && <HelpHint text={tip} />}
      </label>
      <div className="set-ctl">{children}</div>
    </div>
  );
}
