/**
 * P174-R2：代码插件的一键发布（旧 UI 的「发布到 GitHub」迁到新引擎）。
 *
 * token 只在设置里；这里不读、不显示、不落日志。发布的是包内文本文件 + README + 封面，
 * 目标是固定的 api.github.com；强制并入 `uartix-plugin` 话题，市场才能检索到。
 */

import { useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import type { InstalledPlugin } from "./pluginEngine";
import type { PluginMeta } from "./pluginMeta";
import { publishPluginV3 } from "./pluginPublish";

export function PluginPublishForm(props: { entry: InstalledPlugin; meta?: PluginMeta; onNotice: (msg: string) => void; onError: (msg: string) => void }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(props.entry.id.split(".").pop() || props.entry.id);
  const [topics, setTopics] = useState("uartix-plugin");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; repoUrl: string; warning: string; skipped: string[] } | { ok: false; msg: string } | null>(null);

  async function publish(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const r = await publishPluginV3(props.entry, props.meta, {
        repo,
        isPrivate,
        topics,
        description: props.meta?.description || props.entry.manifest.description || "",
      });
      if (r.ok) {
        setResult({ ok: true, repoUrl: r.repoUrl, warning: r.warning, skipped: r.skipped });
        props.onNotice(tx("已发布到 GitHub", "Published to GitHub"));
      } else {
        setResult({ ok: false, msg: r.msg });
        props.onError(r.msg);
      }
    } catch (e) {
      setResult({ ok: false, msg: String((e as Error)?.message ?? e) });
      props.onError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <h4 className="plg-sec">
        <button className="btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? tx("收起发布", "Hide publish") : tx("发布到 GitHub", "Publish to GitHub")}
        </button>
      </h4>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)" }}>
            {tx("token 从「设置 → 集成」读取；发布内容是本插件包内的文本文件 + README + 封面。", "The token comes from Settings → Integrations. Publishes the plugin's text files, README and cover.")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--sp-2)" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
              {tx("仓库名", "Repository")}
              <input className="input" value={repo} maxLength={100} onChange={(e) => setRepo(e.target.value)} placeholder="my-plugin" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
              {tx("话题", "Topics")}
              <input className="input" value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="uartix-plugin, yolo" />
            </label>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            {tx("私有仓库（市场检索不到）", "Private repo (not discoverable in the market)")}
          </label>
          <div>
            <button className="btn primary" disabled={busy} onClick={() => void publish()}>
              {busy ? tx("发布中…", "Publishing…") : tx("一键发布", "Publish")}
            </button>
          </div>
          {result ? (
            result.ok ? (
              <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)", overflowWrap: "anywhere" }}>
                <div>{result.repoUrl}</div>
                {result.warning ? <div style={{ color: "var(--warn)" }}>{result.warning}</div> : null}
                {result.skipped.length ? <div style={{ color: "var(--warn)" }}>{tx("未发布：", "Skipped: ")}{result.skipped.join("、")}</div> : null}
              </div>
            ) : (
              <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)", color: "var(--danger)" }}>{result.msg}</div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
