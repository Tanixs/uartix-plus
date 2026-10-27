/**
 * P174-R2：代码插件的展示信息编辑器。
 *
 * 改的是**展示层**（名称/描述/作者/主页/封面/截图），不是安装包，也不改信任指纹。
 * 版本号不在这里：它只能来自包。
 */

import { useEffect, useRef, useState } from "react";
import { tx, useLocale } from "../../../i18n/strings";
import { Glyph, IconClose } from "../../../shared/icons";
import type { InstalledPlugin } from "./pluginEngine";
import {
  metaAuthor,
  metaDescription,
  metaHomepage,
  metaName,
  readMetaImage,
  setPluginMeta,
  type PluginMeta,
} from "./pluginMeta";

export function PluginMetaEditor(props: {
  entry: InstalledPlugin;
  meta?: PluginMeta;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  useLocale();
  const { entry, meta } = props;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [homepage, setHomepage] = useState("");
  const [busy, setBusy] = useState("");
  const coverRef = useRef<HTMLInputElement>(null);
  const shotsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(meta?.name ?? "");
    setDescription(meta?.description ?? "");
    setAuthor(meta?.author ?? "");
    setHomepage(meta?.homepage ?? "");
    // 只在切换插件或保存后（meta.updatedAt）重置，不在每行日志时覆盖正在输入的草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, meta?.updatedAt]);

  function save(): void {
    try {
      setPluginMeta(entry.id, {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        author: author.trim() || undefined,
        homepage: homepage.trim() || undefined,
      });
      props.onNotice(tx("展示信息已更新（不影响安装包与权限）", "Display info updated (package and permissions unchanged)"));
    } catch (e) {
      props.onError(String((e as Error)?.message ?? e));
    }
  }

  async function upload(files: FileList | null, kind: "cover" | "shot"): Promise<void> {
    if (!files?.length) return;
    setBusy(kind);
    try {
      const list = Array.from(files).slice(0, kind === "shot" ? 4 : 1);
      const urls: string[] = [];
      for (const f of list) {
        const r = await readMetaImage(f, kind === "cover" ? tx("封面", "Cover") : tx("截图", "Screenshot"));
        if (!r.ok) {
          props.onError(r.msg);
          continue;
        }
        urls.push(r.dataUrl);
      }
      if (kind === "cover" && urls[0]) setPluginMeta(entry.id, { cover: urls[0] });
      if (kind === "shot" && urls.length) setPluginMeta(entry.id, { screenshots: [...(meta?.screenshots ?? []), ...urls].slice(0, 4) });
      if (urls.length) props.onNotice(tx("图片已保存", "Image saved"));
    } finally {
      setBusy("");
      if (coverRef.current) coverRef.current.value = "";
      if (shotsRef.current) shotsRef.current.value = "";
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <div className="plg-detail-desc">{tx("只改展示信息；权限与版本仍以安装包为准。", "Display-only. Permissions and version still come from the package.")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--sp-2)" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
          {tx("名称", "Name")}
          <input className="input" value={name} maxLength={60} placeholder={entry.manifest.name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
          {tx("作者", "Author")}
          <input className="input" value={author} maxLength={40} placeholder={entry.manifest.author ?? ""} onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
          {tx("主页", "Homepage")}
          <input className="input" value={homepage} maxLength={500} placeholder="https://…" onChange={(e) => setHomepage(e.target.value)} />
        </label>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-xs)", color: "var(--text-dim)" }}>
        {tx("描述", "Description")}
        <textarea className="input" rows={2} value={description} maxLength={300} placeholder={entry.manifest.description ?? ""} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <span className="plg-cover" style={{ width: 64, height: 64, flex: "0 0 auto" }}>
          {meta?.cover ? <img src={meta.cover} alt="" /> : <span className="plg-item-ico">{tx("无封面", "No cover")}</span>}
        </span>
        <label className="btn" style={{ cursor: "pointer" }}>
          {busy === "cover" ? tx("处理中…", "Working…") : tx("选择封面", "Pick cover")}
          <input ref={coverRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void upload(e.target.files, "cover")} />
        </label>
        {meta?.cover ? (
          <button className="btn" onClick={() => setPluginMeta(entry.id, { cover: undefined })}>
            {tx("移除封面", "Remove cover")}
          </button>
        ) : null}
        <label className="btn" style={{ cursor: "pointer" }}>
          {busy === "shot" ? tx("处理中…", "Working…") : tx("添加截图", "Add screenshot")}
          <input ref={shotsRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => void upload(e.target.files, "shot")} />
        </label>
        <button className="btn primary" disabled={!!busy} onClick={save}>
          {tx("保存信息", "Save info")}
        </button>
      </div>

      {meta?.screenshots?.length ? (
        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          {meta.screenshots.map((s, i) => (
            <span key={i} style={{ position: "relative", display: "inline-flex" }}>
              <img src={s} alt="" style={{ width: 96, height: 64, objectFit: "cover", borderRadius: "var(--radius-m)", border: "1px solid var(--border)" }} />
              <button
                className="btn"
                style={{ position: "absolute", top: -6, right: -6, padding: "0 6px", lineHeight: "18px" }}
                onClick={() => setPluginMeta(entry.id, { screenshots: meta.screenshots!.filter((_, j) => j !== i) })}
                aria-label={tx("移除截图", "Remove screenshot")}
              >
                <Glyph><IconClose /></Glyph>
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="plg-detail-desc" style={{ fontSize: "var(--fs-xs)" }}>
        {metaName(entry.manifest.name, meta)} · {metaAuthor(entry.manifest.author ?? "—", meta)} · {metaHomepage(entry.manifest.homepage ?? "—", meta)}
        {metaDescription(entry.manifest.description ?? "", meta) ? ` · ${metaDescription(entry.manifest.description ?? "", meta)}` : ""}
      </div>
    </div>
  );
}
