/**
 * Operator 部署包生成/导入块（P67-O1/O2，设置 → 数据 页）：
 * 生成 = 勾选部件 + 包名描述 → 当前工作区导出为 .uopk 单文件发行物；
 * 导入 = 选择 .uopk → operatorStore.activate（只读模式运行时）。
 */
import { useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { tx, useLocale } from "../../i18n/strings";
import * as templateStore from "../protocol/templateStore";
import * as controlsStore from "../controls/controlsStore";
import * as commandStore from "../controls/commandStore";
import * as operatorStore from "./operatorStore";
import {
  buildPkgFile,
  OPERATOR_KIND,
  type OperatorPayload,
  type OperatorPkg,
} from "./operatorPkg";

async function saveUopk(pkg: OperatorPkg, fallbackName: string): Promise<void> {
  const path = await save({
    title: tx("导出 Operator 部署包", "Export operator package"),
    defaultPath: `${fallbackName || "operator"}.uopk`,
    filters: [{ name: "Uartix Operator 包", extensions: ["uopk"] }],
  });
  if (!path) return;
  await invoke("save_text_file", {
    path,
    content: JSON.stringify(buildPkgFile(pkg), null, 2),
  });
}

async function loadUopk(): Promise<unknown | null> {
  const path = await open({
    title: tx("导入 Operator 部署包", "Import operator package"),
    multiple: false,
    filters: [{ name: "Uartix 包", extensions: ["json", "uopk"] }],
  });
  if (typeof path !== "string") return null;
  let content: string;
  try {
    content = await invoke<string>("read_text_file", { path });
  } catch (e) {
    alert(tx(`读取失败: ${e}`, `Failed to read: ${e}`));
    return null;
  }
  try {
    const obj = JSON.parse(content) as { kind?: string; data?: unknown };
    if (obj.kind !== OPERATOR_KIND || obj.data === undefined) {
      alert(tx("不是 Operator 部署包（kind 不匹配）", "Not an operator package (kind mismatch)"));
      return null;
    }
    return obj.data;
  } catch (e) {
    alert(tx(`JSON 解析失败: ${e}`, `JSON parse failed: ${e}`));
    return null;
  }
}

const PARTS: { key: keyof OperatorPayload & string; zh: string; en: string }[] = [
  { key: "templates", zh: "协议模板", en: "Protocols" },
  { key: "controls", zh: "控制页", en: "Control pages" },
  { key: "commands", zh: "命令库", en: "Commands" },
  { key: "layout", zh: "面板布局", en: "Panel layout" },
];

export function OperatorGenBlock({ notify }: { notify: (s: string) => void }) {
  useLocale(); // 语言切换重渲染
  const [name, setName] = useState(tx("Operator 部署包", "Operator package"));
  const [desc, setDesc] = useState("");
  const [inc, setInc] = useState<Record<string, boolean>>({
    templates: true,
    controls: true,
    commands: true,
    layout: true,
  });

  const generate = async () => {
    try {
      const payload: OperatorPayload = {};
      if (inc.templates) payload.templates = templateStore.exportTemplatesWithMeta();
      if (inc.controls) payload.controls = controlsStore.exportPages();
      if (inc.commands) payload.commands = commandStore.exportGroups();
      if (inc.layout) {
        const raw = localStorage.getItem("vs.layout.v2");
        payload.layout = raw ? JSON.parse(raw) : undefined;
      }
      let ver = "";
      try {
        ver = (await getVersion()) ?? "";
      } catch {
        /* 非 Tauri 环境（预览）留空 */
      }
      const pkg: OperatorPkg = {
        meta: {
          name: name.trim() || tx("Operator 部署包", "Operator package"),
          description: desc.trim(),
          createdAt: Date.now(),
          appVersion: ver,
        },
        payload,
      };
      await saveUopk(pkg, pkg.meta.name);
      notify(tx("Operator 部署包已导出", "Operator package exported"));
    } catch (e) {
      notify(tx(`导出失败：${String(e).slice(0, 80)}`, `Export failed: ${String(e).slice(0, 80)}`));
    }
  };

  const importPkg = async () => {
    const data = await loadUopk();
    if (!data) return;
    try {
      notify(operatorStore.activate(data));
    } catch (e) {
      notify(tx(`导入失败：${String(e).slice(0, 80)}`, `Import failed: ${String(e).slice(0, 80)}`));
    }
  };

  return (
    <div className="set-io-block">
      <div
        className="set-io-head"
        title={tx(
          "把当前工作区（协议/控制页/命令库/布局/外观设置）打包为 .uopk 发行物；操作员端导入后配置只读，可连接设备、发命令、看数据",
          "Bundle the current workspace (protocols / control pages / commands / layout / appearance settings) into a distributable .uopk; operator side runs read-only: connect, send commands, view data",
        )}
      >
        <div className="set-io-label">{tx("Operator 部署包（.uopk）", "Operator package (.uopk)")}</div>
        <div className="set-io-actions">
          <button className="btn" onClick={() => void generate()}>
            {tx("生成部署包", "Generate")}
          </button>
          <button className="btn" onClick={() => void importPkg()}>
            {tx("导入并运行", "Import & run")}
          </button>
        </div>
      </div>
      <div className="set-io-ops">
        <input
          className="input"
          style={{ width: 170 }}
          value={name}
          maxLength={60}
          placeholder={tx("包名", "Package name")}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          style={{ width: 200, flex: 1 }}
          value={desc}
          maxLength={200}
          placeholder={tx("说明（可选）", "Description (optional)")}
          onChange={(e) => setDesc(e.target.value)}
        />
        {PARTS.map((p) => (
          <label key={p.key} className="set-switch-inline" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={inc[p.key]}
              onChange={(e) => setInc((s) => ({ ...s, [p.key]: e.target.checked }))}
            />
            {tx(p.zh, p.en)}
          </label>
        ))}
      </div>
    </div>
  );
}
