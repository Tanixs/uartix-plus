/**
 * P174-R2：代码插件的一键发布（旧 UI 的「发布到 GitHub」迁到新引擎）。
 *
 * token 只在设置里；这里不读、不显示、不落日志。发布的是包内文件（含封面与截图）
 * + README，目标是固定的 api.github.com；强制并入 `uartix-plugin` 话题，市场才能检索到。
 *
 * R19c 补的两件事，都是"用过一次之后才发现缺"的：
 * - **记住发到哪**：仓库名以前每次打开都从插件 id 现推，于是"我明明发到 uartix.yolo
 *   了，再点发布又变回 yolo"。现在成功一次就记进元信息，下次直接接着发同一个仓库。
 * - **说清发的是哪一版**：版本号不给填，是刻意的——它只能来自 `plugin.json`，
 *   手填会让「回滚到 1.2.0」变成一句谎话。但表单一直不显示它，用户就只能猜。
 */

import { useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import { publishPluginV3, readPackageFiles } from "./pluginPublish";
import type { InstalledPlugin } from "./pluginEngine";
import { setPluginMeta, type PluginMeta } from "./pluginMeta";

/** `https://github.com/owner/name` → `owner/name`；认不出返回空。 */
function repoFromUrl(url: string): string {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : "";
}

/** 上次发到哪 → 市场装来的仓库 → 从 id 现推。顺序就是"用户说过的话优先"。 */
function initialRepo(entry: InstalledPlugin, meta?: PluginMeta): string {
  const remembered = meta?.publishedRepo?.split("/")[1];
  const fromOrigin = /^github:[^/]+\/(.+)$/.exec(entry.origin ?? "")?.[1];
  return remembered || fromOrigin || entry.id.split(".").pop() || entry.id;
}

export function PluginPublishForm(props: { entry: InstalledPlugin; meta?: PluginMeta; onNotice: (msg: string) => void; onError: (msg: string) => void }) {
  useLocale();
  const { entry, meta } = props;
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(() => initialRepo(entry, meta));
  const [topics, setTopics] = useState("uartix-plugin");
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ files: string[]; skipped: string[] } | null>(null);
  const [result, setResult] = useState<{ ok: true; repoUrl: string; warning: string; skipped: string[] } | { ok: false; msg: string } | null>(null);
  const lastRepo = meta?.publishedRepo ?? "";

  async function publish(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const r = await publishPluginV3(entry, meta, {
        repo,
        isPrivate,
        topics,
        description: meta?.description || entry.manifest.description || "",
      });
      if (r.ok) {
        setResult({ ok: true, repoUrl: r.repoUrl, warning: r.warning, skipped: r.skipped });
        // 记住它：下次打开直接接着发同一个仓库，而不是让用户重新想起自己填过什么
        const full = repoFromUrl(r.repoUrl);
        if (full && full !== meta?.publishedRepo) {
          try {
            setPluginMeta(entry.id, { publishedRepo: full });
          } catch {
            /* 记不住不影响这次发布成功，下次重新填一次而已 */
          }
        }
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

  /** 发布前的"会带哪些文件"。只读盘、不联网——外发动作仍然只有那颗「一键发布」。 */
  async function showPreview(): Promise<void> {
    try {
      const r = await readPackageFiles(entry.id);
      setPreview({
        files: r.files.map((f) => f.path),
        skipped: r.skipped,
      });
    } catch (e) {
      props.onError(String((e as Error)?.message ?? e));
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
            {tx(
              `发布的是 v${entry.version}：本插件包内的文件（含封面与截图）+ README。token 从「设置 → 集成」读取。`,
              `Publishes v${entry.version}: this plugin's package files (cover and screenshots included) plus a README. The token comes from Settings → Integrations.`,
            )}
          </div>
          {lastRepo ? (
            <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)", color: "var(--ok)" }}>
              {tx(`上次发布到 ${lastRepo}，再点会更新那个仓库。`, `Last published to ${lastRepo}; publishing again updates that repository.`)}
            </div>
          ) : null}
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
          <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)" }}>
            {tx(
              "版本号不在这里改：它只认 plugin.json，手填会让「回滚到上一版」变成一句谎话。要发新版本，先改包里的版本号——那会重新过一次批准卡。",
              "The version is not editable here: it comes from plugin.json, and typing one would make “roll back to the previous version” a lie. To publish a new version, change the package's version first — that goes through the approval card again.",
            )}
          </div>
          <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
            <button className="btn" disabled={busy} onClick={() => void showPreview()}>
              {tx("先看要发布什么", "Preview the file list")}
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void publish()}>
              {busy ? tx("发布中…", "Publishing…") : tx("一键发布", "Publish")}
            </button>
          </div>
          {preview ? (
            <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)", overflowWrap: "anywhere" }}>
              <div>
                {tx(`会带上 ${preview.files.length} 个文件：`, `Will ship ${preview.files.length} files:`)} {preview.files.join("、") || tx("（空）", "(none)")}
              </div>
              {preview.skipped.length ? (
                <div style={{ color: "var(--text-faint)", marginTop: 4 }}>
                  {tx("不会带上：", "Skipped: ")}
                  {preview.skipped.join("、")}
                </div>
              ) : null}
            </div>
          ) : null}
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
