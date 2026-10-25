/**
 * P174-R5：插件详情里「工作区预设」与「任务模板」那一排动作按钮。
 *
 * 单独一个组件是为了可测（`PluginContribActions.test.tsx` 钉接线：点了确实调宿主出口、
 * 未启用/未批准时按钮是死的），也让 `PluginEngineSection` 不再为一排按钮加一堆局部 state。
 *
 * 两条判据与面板/小部件同一条：**启用了且批准了**才让点（否则会出现"面板进不去但预设能换"
 * 那种后门）；应用预设/载入模板都会先把结果说给用户听（`onNotice`），失败上红条（`onError`）。
 */
import { useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import type { InstalledPlugin } from "./pluginEngine";
import { applyPluginPreset, loadPluginTask } from "./pluginHostActions";

interface Props {
  entry: InstalledPlugin;
  /** 当前能不能操作（= 已启用且已批准）。 */
  usable: boolean;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}

export function PluginContribActions({ entry, usable, onNotice, onError }: Props) {
  useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const presets = entry.manifest.contributes.presets ?? [];
  const tasks = entry.manifest.contributes.tasks ?? [];
  if (!presets.length && !tasks.length) return null;

  async function run(key: string, fn: () => Promise<{ ok: boolean; msg: string }>) {
    setBusy(key);
    onError("");
    try {
      const r = await fn();
      if (r.ok) onNotice(r.msg);
      else onError(r.msg);
    } catch (e) {
      onError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {presets.length ? (
        <>
          <h4 className="plg-sec">{tx("工作区预设", "Workspace presets")}</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
            {presets.map((pr) => (
              <button
                key={pr.id}
                className="btn"
                disabled={!usable || busy !== null}
                onClick={() => void run(`preset:${pr.id}`, () => applyPluginPreset(entry, pr))}
              >
                {tx(`应用「${pr.title}」`, `Apply “${pr.title}”`)}
              </button>
            ))}
          </div>
          <div className="plg-detail-dim" style={{ fontSize: "var(--fs-xs)" }}>
            {tx("点一下整屏面板排布就换成这套；换之前当前布局会自动存进 设置 → 工作区 的备份槽，随时回得去。", "One click swaps the whole panel layout; your current layout is backed up to Settings → Workspace first, so you can go back.")}
          </div>
        </>
      ) : null}

      {tasks.length ? (
        <>
          <h4 className="plg-sec">{tx("任务模板", "Task templates")}</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-2)" }}>
            {tasks.map((t) => (
              <button
                key={t.id}
                className="btn"
                disabled={!usable || busy !== null}
                onClick={() => void run(`task:${t.id}`, () => loadPluginTask(entry, t))}
              >
                {tx(`载入「${t.title}」`, `Load “${t.title}”`)}
              </button>
            ))}
          </div>
          <div className="plg-detail-dim" style={{ fontSize: "var(--fs-xs)" }}>
            {tx("只把「目标 + 建议步骤」填进 AI 助手输入框，不替你发送；发不发、用哪个授权档仍由你决定。", "Only fills the goal + suggested steps into the AI box — it never sends for you; sending and the authorization tier stay your call.")}
          </div>
        </>
      ) : null}
    </>
  );
}
