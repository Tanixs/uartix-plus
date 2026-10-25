/**
 * P174-R2：`contributes.settings` 的编辑面。
 *
 * 值存在 `settings.json.pluginConfig`（B2），键级 patch、默认值回落；宿主在 **hello** 里把
 * 生效值递给插件（`ctx.config`），所以保存后要重启宿主才生效——面板上把这句话写出来，
 * 不让用户以为"点了保存插件就立刻变了"。
 */

import { useEffect, useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import { setPluginConfig, type InstalledPlugin } from "./pluginEngine";
import type { PluginSettingField } from "./manifest";

export function PluginConfigEditor(props: {
  entry: InstalledPlugin;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  useLocale();
  const fields = props.entry.manifest.contributes.settings ?? [];
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [busy, setBusy] = useState("");

  useEffect(() => {
    const next: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      const v = props.entry.config[f.key];
      next[f.key] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : f.default;
    }
    setValues(next);
    // 切换插件/版本时重置；保存后 entry.config 变化不覆盖正在编辑的值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.entry.id, props.entry.version]);

  if (!fields.length) return null;

  function set(key: string, v: string | number | boolean): void {
    setValues((cur) => ({ ...cur, [key]: v }));
  }

  async function save(): Promise<void> {
    setBusy("save");
    try {
      await setPluginConfig(props.entry.id, values);
      props.onNotice(tx("配置已保存；宿主下次启动时生效", "Settings saved; they take effect the next time the host starts"));
    } catch (e) {
      props.onError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)" }}>
        {tx("保存后写入本机配置；宿主进程下次启动时读取（已运行的面板不会热更新）。", "Saved locally; the host reads it on next start (a running panel is not hot-reloaded).")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--sp-2)" }}>
        {fields.map((f: PluginSettingField) => {
          const v = values[f.key] ?? f.default;
          return (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
              <span>{f.label || f.key} <span style={{ color: "var(--text-faint)" }}>({f.key})</span></span>
              {f.type === "boolean" ? (
                <input type="checkbox" checked={Boolean(v)} onChange={(e) => set(f.key, e.target.checked)} />
              ) : f.type === "enum" ? (
                <select className="input" value={String(v)} onChange={(e) => set(f.key, e.target.value)}>
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  className="input"
                  type={f.type === "number" ? "number" : "text"}
                  value={String(v)}
                  min={f.min}
                  max={f.max}
                  onChange={(e) => set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)}
                />
              )}
            </label>
          );
        })}
      </div>
      <div>
        <button className="btn primary" disabled={!!busy} onClick={() => void save()}>
          {tx("保存配置", "Save settings")}
        </button>
      </div>
    </div>
  );
}
