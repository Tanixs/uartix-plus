/**
 * P174-R7①：目录绑定（`$WS` 与 `$EXT:<key>`）。
 *
 * 这一块原来只在插件管理那个 dock 面板里，而管理功能正在整体并入设置页——它不该跟着面板一起消失，
 * 因为"哪个插件被允许读写哪个目录"是**判据的落点**，不是运行时细节：
 * 宿主进程的 `--allow-fs-write` 是启动那一刻按这份表定死的，改这里等于改笼子。
 *
 * 两条形状是原来就有的，这里只是搬：
 *  1. **只列被清单声明过的键**。让用户凭空输一个键名没意义（插件拿不到就用不上），
 *     而"绑了但没有任何插件要"的键只会变成一张对不上账的表。
 *  2. **写声明必须绑、读声明可留空**。只要有一个插件要往这个目录写，它就必须绑：
 *     写不进去的插件一启动就该被拒，而不是跑一半才发现路径是空的。
 *
 * 改动**只影响下一次启动**（笼子是内核参数，没有热改这一说），所以这一面把这句话写在旁边，
 * 而不是让用户点完以为已经生效了。
 */

import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tx, useLocale } from "../../../i18n/strings";
import { declaredRootKeys } from "./manifest";
import { setExternalRoot, setWorkspaceRoot, type InstalledPlugin } from "./pluginEngine";
import { pendingRootBinds, subscribeRootBinds, takeRootBind, type RootBindRequest } from "./rootRequests";

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--sp-2)",
  flexWrap: "wrap",
  fontSize: "var(--fs-xs)",
  color: "var(--text-dim)",
};

const pathStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "46%",
};

export function WorkspaceRootRow(props: { workspaceRoot: string; disabled?: boolean; onError: (msg: string) => void }) {
  useLocale();
  const [busy, setBusy] = useState(false);

  async function pick(): Promise<void> {
    setBusy(true);
    try {
      const dir = await open({ directory: true, multiple: false, title: tx("选择工作区根（插件的 $WS）", "Pick the workspace root (plugin $WS)") });
      if (!dir || Array.isArray(dir)) return;
      await setWorkspaceRoot(dir);
    } catch (e) {
      props.onError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const off = props.workspaceRoot ? "" : tx("未设置", "not set");
  return (
    <div style={rowStyle}>
      <span style={{ fontWeight: 600 }}>{tx("工作区根", "Workspace root")}</span>
      <span style={{ ...pathStyle, color: props.workspaceRoot ? "var(--text)" : "var(--warn)" }} title={props.workspaceRoot || undefined}>
        {props.workspaceRoot || off}
      </span>
      <button className="btn" disabled={busy || props.disabled} onClick={() => void pick()}>
        {tx("选择…", "Choose…")}
      </button>
      {props.workspaceRoot ? (
        <button
          className="btn"
          disabled={busy || props.disabled}
          onClick={() => void setWorkspaceRoot("").catch((e) => props.onError(String((e as Error)?.message ?? e)))}
        >
          {tx("清除", "Clear")}
        </button>
      ) : null}
      <span style={{ color: "var(--text-faint)" }}>
        {tx("声明了 $WS 的插件要用它；改动在下一次启动生效", "Used by plugins declaring $WS; applies on next start")}
      </span>
    </div>
  );
}

/**
 * 目录绑定那一栏。**待确认的绑定显示在这里，按钮也在这里**：
 * 插件面板里的「选工作区」(R7③) 只是把请求送到这里来，点头这一下不在 iframe 里发生——
 * 被授权的一方不该有办法自己弹"您同意授权吗"。
 */
export function PluginRootsFold(props: { entry: InstalledPlugin; roots: Record<string, string>; onError: (msg: string) => void }) {
  useLocale();
  const [busy, setBusy] = useState("");
  const binds = useSyncExternalStore(subscribeRootBinds, pendingRootBinds, pendingRootBinds).filter(
    (b) => b.pluginId === props.entry.id,
  );
  const declared = declaredRootKeys(props.entry.manifest);

  async function pick(key: string): Promise<void> {
    setBusy(key);
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        title: tx(`选择外部目录（$EXT:${key}）`, `Pick the external folder ($EXT:${key})`),
      });
      if (!dir || Array.isArray(dir)) return;
      await setExternalRoot(key, dir);
    } catch (e) {
      props.onError(String((e as Error)?.message ?? e));
    } finally {
      setBusy("");
    }
  }

  /** 用户在宿主这边点头/摇头。批准时按**当初请求的那条**落盘，不是按面板现在的状态。 */
  async function decide(req: RootBindRequest, ok: boolean): Promise<void> {
    takeRootBind(req.pluginId, req.spec);
    if (!ok) return;
    try {
      const by = { pluginId: req.pluginId, forWrite: req.forWrite };
      if (req.spec === "$WS") await setWorkspaceRoot(req.path, by);
      else await setExternalRoot(req.spec.slice("$EXT:".length), req.path, by);
    } catch (e) {
      props.onError(String((e as Error)?.message ?? e));
    }
  }

  if (!declared.length && !binds.length) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {binds.map((b) => (
        <div
          key={`${b.spec}-${b.at}`}
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            flexWrap: "wrap",
            padding: "var(--sp-1) var(--sp-2)",
            border: "1px solid var(--warn)",
            borderRadius: "var(--radius-m)",
            fontSize: "var(--fs-xs)",
          }}
        >
          <span style={{ color: "var(--text)" }}>
            {tx(`它的面板里刚请求把 ${b.spec} 绑到`, `its panel just asked to bind ${b.spec} to `)}
            <span style={{ fontFamily: "var(--font-mono)" }}>{b.path}</span>
          </span>
          <span style={{ color: b.forWrite ? "var(--warn)" : "var(--text-dim)" }}>
            {b.forWrite
              ? tx("写权限；下一次启动生效", "WRITE access; applies on next start")
              : tx("只读；下一次启动生效", "read-only; applies on next start")}
          </span>
          <div style={{ flex: "1 1 auto" }} />
          <button className="btn primary" onClick={() => void decide(b, true)}>
            {tx("批准绑定", "Approve")}
          </button>
          <button className="btn" onClick={() => void decide(b, false)}>
            {tx("取消", "Cancel")}
          </button>
        </div>
      ))}
      {declared.map(({ key, must }) => {
        const bound = props.roots[key] ?? "";
        return (
          <div key={key} style={rowStyle}>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{key}</span>
            <span style={{ ...pathStyle, color: bound ? "var(--text)" : must ? "var(--warn)" : "var(--text-dim)" }} title={bound || undefined}>
              {bound || (must ? tx("必须绑定", "required") : tx("未绑定（只读声明，可留空）", "not bound (read-only, optional)"))}
            </span>
            <button className="btn" disabled={!!busy} onClick={() => void pick(key)}>
              {bound ? tx("更改…", "Change…") : tx("选择…", "Choose…")}
            </button>
            {bound ? (
              <button
                className="btn"
                disabled={!!busy}
                onClick={() => void setExternalRoot(key, "").catch((e) => props.onError(String((e as Error)?.message ?? e)))}
              >
                {tx("解绑", "Unbind")}
              </button>
            ) : null}
            <span style={{ color: "var(--text-faint)" }}>
              {must
                ? tx("这个插件要往里写；改动在下一次启动生效", "this plugin writes here; applies on next start")
                : tx("只读；不绑也能启动", "read-only; works without binding")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
