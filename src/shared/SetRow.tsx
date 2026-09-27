import { Children, Fragment, type ReactNode } from "react";
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

/** 一张组卡：组标题（可无）+ 若干行 */
interface SetGroup {
  title: ReactNode;
  body: ReactNode[];
}

/**
 * 「一页设置 = 每组一张卡」的分区器（P112-A）。
 *
 * 为什么不是给十个页签各套一层 `<div className="set-card">`：页签的 children 本来就是扁平的
 * （`row()` 产出 `.set-row`，组标题是 `.set-group-title`），分区器一次改动覆盖全页；
 * 抄十遍就是十处会漂的缩进，而且下一次加分组时人会只改一半。
 *
 * 判据只有一个：遇到 `.set-group-title` 就开一张新卡，之前的行归"无标题的第一组"。
 * 只有标题、没有行的那种（条件渲染把整组掏空）不输出空卡。
 *
 * **要先穿过 Fragment / 数组**：包在外面时 children 是 `{tab === "x" && (<>…</>)}`，
 * 一共只有一个元素 —— 不摊平的话整页只得到一张卡（P112-A 首跑实拍正是这样，
 * 「界面」与「动效与联动」两组被关在同一张白面里，看不出分层）。
 */
export function SetGroups({ children }: { children: ReactNode }) {
  const leaves: ReactNode[] = [];
  const flatten = (nodes: ReactNode[]) => {
    for (const n of nodes) {
      if (n == null) continue;
      if (Array.isArray(n)) {
        flatten(n);
        continue;
      }
      if (typeof n !== "object") {
        leaves.push(n);
        continue;
      }
      const el = n as { type?: unknown; props?: { children?: ReactNode } };
      if (el.type === Fragment) flatten(Children.toArray(el.props?.children ?? null));
      else leaves.push(n);
    }
  };
  flatten(Children.toArray(children));

  const groups: SetGroup[] = [];
  let cur: SetGroup | null = null;
  for (const child of leaves) {
    const cls = (child as { props?: { className?: unknown } })?.props?.className;
    if (cls === "set-group-title") {
      cur = { title: child, body: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: null, body: [] };
      groups.push(cur);
    }
    cur.body.push(child);
  }
  return (
    <>
      {groups.filter((g) => g.body.length > 0).map((g, i) => (
        <section className="set-card" key={i}>
          {g.title}
          {g.body}
        </section>
      ))}
    </>
  );
}
