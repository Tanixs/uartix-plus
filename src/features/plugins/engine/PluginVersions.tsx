/**
 * P174-R2：从旧 UI 迁过来的"版本历史/回滚"。
 *
 * 归档在 `<pluginsRoot>/.versions/<id>/`，升级前自动留最近 3 份；回滚走与安装同一条
 * `planFolder/commitInstall`，权限面变了照样弹批准卡——回滚不是信任旁路。
 */

import { useEffect, useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import { listVersions, rollbackToVersion, type InstalledPlugin, type PluginVersionEntry } from "./pluginEngine";
import type { InstallPlan } from "./install";

export function PluginVersions(props: {
  entry: InstalledPlugin;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onPending: (plan: InstallPlan) => void;
}) {
  useLocale();
  const [versions, setVersions] = useState<PluginVersionEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    listVersions(props.entry.id)
      .then((v) => {
        if (alive) setVersions(v);
      })
      .catch((e) => {
        if (alive) props.onError(String((e as Error)?.message ?? e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entry.id, props.entry.version, tick]);

  async function rollback(v: PluginVersionEntry): Promise<void> {
    if (confirm !== v.dir) {
      setConfirm(v.dir);
      return;
    }
    setBusy(v.dir);
    try {
      const got = await rollbackToVersion(props.entry.id, v.dir);
      setConfirm("");
      if (got.installed) {
        props.onNotice(tx(`已回滚到 v${got.plan.version}`, `Rolled back to v${got.plan.version}`));
        setTick((n) => n + 1);
      } else {
        props.onPending(got.plan);
      }
    } catch (e) {
      props.onError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      {versions.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {versions.map((v) => (
            <div key={v.dir} style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", fontSize: "var(--fs-sm)" }}>
              <span style={{ fontWeight: 600 }}>v{v.version}</span>
              <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-xs)" }}>
                {v.archivedAt ? new Date(v.archivedAt).toLocaleString() : ""}
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn" disabled={!!busy} onClick={() => void rollback(v)}>
                {busy === v.dir
                  ? tx("回滚中…", "Rolling back…")
                  : confirm === v.dir
                    ? tx("再点一次确认回滚", "Click again to roll back")
                    : tx("回滚到此版本", "Roll back")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)" }}>
          {tx("还没有历史版本；升级时会自动保留最近 3 份。", "No archived versions yet; the last 3 upgrades are kept automatically.")}
        </div>
      )}
    </div>
  );
}
