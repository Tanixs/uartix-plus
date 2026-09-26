import { useEffect, useState } from "react";
import { tx, useLocale } from "../../i18n/strings";
import { FULL_KIND, importDispatch } from "./transfer";

/** 全窗口拖拽导入：把 Uartix+ 导出的 JSON 文件拖进窗口即按 kind 自动导入 */
export function JsonDropImport() {
  useLocale(); // 遮罩与回执条都是 tx() 出来的话术，切语言要有人重渲染
  const [hover, setHover] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let depth = 0;
    let hideTimer: number | null = null;
    const flash = (ok: boolean, text: string) => {
      setMsg({ ok, text });
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => setMsg(null), 3200);
    };
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setHover(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDragLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setHover(false);
    };
    const onDrop = async (e: DragEvent) => {
      depth = 0;
      setHover(false);
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      if (!f.name.toLowerCase().endsWith(".json")) {
        flash(false, tx("仅支持 Uartix+ 导出的 JSON 文件", "Only JSON files exported by Uartix+ are accepted"));
        return;
      }
      try {
        const text = await f.text();
        const obj = JSON.parse(text) as { kind?: string; data?: unknown };
        if (!obj.kind || obj.data === undefined) {
          flash(false, tx("文件格式不正确：缺少 kind/data（是否为 Uartix+ 导出的文件？）", "Malformed file: kind/data is missing (is this a file exported by Uartix+?)"));
          return;
        }
        const message = await importDispatch(obj.kind, obj.data);
        flash(true, message);
      } catch (err) {
        flash(false, tx(`导入失败：${String(err).replace(/^Error:\s*/, "")}`, `Import failed: ${String(err).replace(/^Error:\s*/, "")}`));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        depth = 0;
        setHover(false);
      }
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKey);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  return (
    <>
      {hover && (
        <div className="drop-mask">
          <div className="drop-mask-box">
            <div className="drop-mask-title">{tx("松开导入配置文件", "Release to import the configuration file")}</div>
            <div className="drop-mask-hint">
              {tx(`支持协议模板 / 控制画布 / 命令库 / 全量备份（${FULL_KIND}）/ Operator 部署包（.uopk）`,
                `Protocol templates / control canvases / command library / full backup (${FULL_KIND}) / operator packages (.uopk)`)}`
            </div>
          </div>
        </div>
      )}
      {msg && <div className={`drop-toast ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
    </>
  );
}
