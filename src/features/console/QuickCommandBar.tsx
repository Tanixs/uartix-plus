import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as cmdStore from "../controls/commandStore";
import type { CommandItem } from "../controls/commandStore";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "../controls/variableStore";
import { beep, runScript } from "../controls/scriptRunner";
import { useSettings } from "../settings/settingsStore";
import { CODECS, userCodecToCodec, type Codec, type FactoryField } from "./commandFactory";
import * as userCodecStore from "./userCodecStore";
import { CodecEditorModal, MyCodecsModal } from "./CodecEditorModal";
import type { UserCodecDef } from "./commandFactory";

const b2 = (v: number) => (v & 0xff).toString(16).padStart(2, "0").toUpperCase();

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
}

/** HEX 文本预览：统一两位大写空格分组 */
function fmtHexPreview(t: string): string {
  const tokens = t.trim().split(/[\s,]+/).filter(Boolean);
  return tokens
    .map((tok) => b2(parseInt(tok.replace(/^0x/i, ""), 16)))
    .join(" ");
}

interface TipState {
  item: CommandItem;
  x: number;
  y: number;
  above: boolean;
}

function ChipTooltip({ tip }: { tip: TipState }) {
  const { item } = tip;
  const isScript = Boolean(item.scriptEnabled && item.script.trim());
  const badge = isScript ? "脚本" : item.sendMode === "hex" ? "HEX" : "ASCII";
  let body: React.ReactNode;
  if (isScript) {
    body = <pre className="qk-tip-pre">{item.script}</pre>;
  } else if (item.sendMode === "hex") {
    const shown = fmtHexPreview(item.template);
    const count = shown ? shown.split(" ").length : 0;
    body = (
      <>
        <div className="qk-tip-mono">{shown || "（空）"}</div>
        <div className="qk-tip-sub">{count} 字节</div>
      </>
    );
  } else {
    body = (
      <>
        <div className="qk-tip-mono">{item.template || "（空）"}</div>
        <div className="qk-tip-sub">{new TextEncoder().encode(item.template).length} 字节</div>
      </>
    );
  }
  return (
    <div
      className={`qk-tip ${tip.above ? "above" : "below"}`}
      style={{ left: tip.x, top: tip.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="qk-tip-head">
        <span className="qk-tip-name">{item.name}</span>
        <span className={`qk-tip-badge ${isScript ? "script" : item.sendMode}`}>{badge}</span>
      </div>
      {body}
      {item.note && <div className="qk-tip-note">{item.note}</div>}
      <div className="qk-tip-foot">点击立即发送</div>
    </div>
  );
}

export function QuickCommandBar() {
  const cmds = useSyncExternalStore(cmdStore.subscribe, cmdStore.getSnapshot);
  const settings = useSettings();
  const [open, setOpen] = useState(() => localStorage.getItem("vs.qkbar.open") !== "0");
  const [factoryOpen, setFactoryOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const tipTimer = useRef<number | null>(null);

  // ---- 指令工厂状态 ----
  const uc = useSyncExternalStore(userCodecStore.subscribe, userCodecStore.getSnapshot);
  const allCodecs: Codec[] = useMemo(
    () => [...CODECS, ...uc.codecs.map(userCodecToCodec)],
    [uc.codecs],
  );
  const [codecId, setCodecId] = useState<string>(CODECS[0].id);
  const [editorOpen, setEditorOpen] = useState<{ def: UserCodecDef | null } | null>(null);
  const [myOpen, setMyOpen] = useState(false);
  const codec: Codec = allCodecs.find((c) => c.id === codecId) ?? allCodecs[0];
  const codecById = (id: string): Codec | undefined => {
    const builtIn = CODECS.find((c) => c.id === id);
    if (builtIn) return builtIn;
    const def = userCodecStore.getById(id.startsWith("user:") ? id.slice(5) : id);
    return def ? userCodecToCodec(def) : undefined;
  };
  const initVals = (c: Codec): Record<string, string> => {
    const fields = typeof c.fields === "function" ? c.fields({}) : c.fields;
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = f.def ?? "";
    return out;
  };
  const [vals, setVals] = useState<Record<string, string>>(() => initVals(CODECS[0]));
  const switchCodec = (id: string) => {
    setCodecId(id);
    const c = codecById(id);
    setVals(c ? initVals(c) : {});
  };
  const setVal = (key: string, v: string) => setVals((s) => ({ ...s, [key]: v }));

  const flat = cmdStore.flatCommands();
  const hasWitGroup = cmds.groups.some((g) => g.name === "WIT");

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem("vs.qkbar.open", next ? "1" : "0");
  };

  const showMsg = (t: string) => {
    setMsg(t);
    setErr(null);
    setTimeout(() => setMsg((m) => (m === t ? null : m)), 2000);
  };

  // ---- 芯片悬浮预览 ----
  const tipEnter = (item: CommandItem, el: HTMLElement) => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const above = r.top > 150;
      // rect 是视觉像素；position:fixed 的 top/left 是逻辑像素（CSS zoom 缩放），需除回 zoom
      const zf = (settings.zoom || 100) / 100;
      setTip({
        item,
        x: Math.min(Math.max((r.left + r.width / 2) / zf, 130), window.innerWidth / zf - 130),
        y: (above ? r.top - 8 : r.bottom + 8) / zf,
        above,
      });
    }, 300);
  };
  const tipLeave = () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    setTip(null);
  };

  const runItem = async (item: CommandItem) => {
    try {
      if (item.scriptEnabled && item.script.trim()) {
        const vars = variableStore
          .listVars()
          .map((vd) => ({
            name: vd.name,
            value: variableStore.getVar(vd.name) ?? (vd.kind === "str" ? "" : 0),
          }));
        await runScript(item.script, {
          send: async (text, mode) => {
            await serialStore.sendData(mode ?? "ascii", String(text));
          },
          beep,
          delay_ms: delay,
          get: (name: string) => variableStore.getVar(name),
        }, vars);
      } else {
        if (!item.template.trim()) throw new Error("指令内容为空，请先在「管理」中填写");
        await serialStore.sendData(item.sendMode, item.template);
      }
      setErr(null);
      setFlash(item.id);
      setTimeout(() => setFlash((f) => (f === item.id ? null : f)), 400);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // ---- 指令工厂 ----
  const factoryFields: FactoryField[] =
    typeof codec.fields === "function" ? codec.fields(vals) : codec.fields;

  let preview: { frames: string[]; parts: import("./commandFactory").FramePart[]; note?: string } | null = null;
  let previewErr: string | null = null;
  try {
    preview = codec.build(vals);
  } catch (e) {
    previewErr = String(e).replace(/^Error:\s*/, "");
  }

  const sendFactory = async () => {
    try {
      const r = codec.build(vals);
      for (let i = 0; i < r.frames.length; i++) {
        if (i > 0) await delay(60);
        await serialStore.sendData("hex", r.frames[i]);
      }
      setErr(null);
      showMsg(`已发送 ${r.frames.length} 帧`);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const ensureGroup = (name: string): string => {
    const g = cmdStore.getSnapshot().groups.find((x) => x.name === name);
    if (g) return g.id;
    cmdStore.addGroup(name);
    return cmdStore.getSnapshot().groups.find((x) => x.name === name)!.id;
  };

  const saveFactory = () => {
    try {
      const r = codec.build(vals);
      const gid = ensureGroup(codec.group);
      cmdStore.addCommand(gid);
      const g = cmdStore.getSnapshot().groups.find((x) => x.id === gid)!;
      const item = g.items[g.items.length - 1] as CommandItem;
      const base = {
        name: `${codec.name} ${codec.summary?.(vals) ?? ""}`.trim(),
        sendMode: "hex" as const,
        note: r.note ?? "",
      };
      if (r.frames.length === 1) {
        cmdStore.patchCommand(item.id, { ...base, template: r.frames[0], script: "", scriptEnabled: false });
      } else {
        // 多帧序列存为脚本，逐帧发送
        const script = r.frames
          .map((f, i) => `await send("${f}","hex");${i < r.frames.length - 1 ? "\nawait delay_ms(60);" : ""}`)
          .join("\n");
        cmdStore.patchCommand(item.id, { ...base, template: "", script, scriptEnabled: true });
      }
      showMsg("已存入命令库，可在控制画布拖挂到卡片");
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const addPresetGroup = () => {
    const gid = ensureGroup("WIT");
    const calib = (addr: number, v: number, pre = 200) =>
      [
        `await send("FF AA 69 88 B5","hex");`,
        `await delay_ms(${pre});`,
        `await send("FF AA ${b2(addr)} ${b2(v)} 00","hex");`,
        `await delay_ms(100);`,
        `await send("FF AA 00 00 00","hex");`,
      ].join("\n");
    const presets: { name: string; template?: string; script?: string; note: string }[] = [
      { name: "解锁", template: "FF AA 69 88 B5", note: "解锁寄存器，10s 内有效" },
      { name: "保存配置", template: "FF AA 00 00 00", note: "保存当前配置" },
      { name: "重启模块", template: "FF AA 00 FF 00", note: "软重启" },
      { name: "航向角置零", script: calib(0x01, 0x04), note: "解锁→CALSW=4→保存" },
      { name: "加计校准", script: calib(0x01, 0x01), note: "解锁→CALSW=1→保存，需静止放置" },
      { name: "高度清零", script: calib(0x01, 0x03), note: "解锁→CALSW=3→保存" },
      { name: "磁场校准", script: calib(0x01, 0x07), note: "解锁→CALSW=7→保存，缓慢画8字" },
      { name: "输出100Hz", script: calib(0x03, 0x09), note: "RRATE=0x09" },
      { name: "输出200Hz", script: calib(0x03, 0x0b), note: "RRATE=0x0B" },
      { name: "波特率115200", script: calib(0x04, 0x06), note: "改后需用新波特率重连" },
      { name: "六轴算法", script: calib(0x24, 0x01), note: "AXIS6=1（无磁力计融合）" },
      { name: "九轴算法", script: calib(0x24, 0x00), note: "AXIS6=0" },
    ];
    for (const p of presets) {
      cmdStore.addCommand(gid);
      const g = cmdStore.getSnapshot().groups.find((x) => x.id === gid)!;
      const item = g.items[g.items.length - 1] as CommandItem;
      cmdStore.patchCommand(item.id, {
        name: p.name,
        template: p.template ?? "",
        sendMode: "hex",
        note: p.note,
        script: p.script ?? "",
        scriptEnabled: Boolean(p.script),
      });
    }
    showMsg("已预置 WIT 常用指令");
  };

  const renderFactoryField = (f: FactoryField) => {
    let control: React.ReactNode;
    if (f.kind === "select") {
      control = (
        <select
          className="input"
          value={vals[f.key] ?? ""}
          onChange={(e) => setVal(f.key, e.target.value)}
          title={f.hint}
        >
          {f.options?.map((o) => (
            <option key={o.v} value={String(o.v)}>
              {o.label}
            </option>
          ))}
        </select>
      );
    } else if (f.kind === "hex") {
      control = (
        <input
          className="input qk-hexin"
          value={vals[f.key] ?? ""}
          onChange={(e) => setVal(f.key, e.target.value)}
          placeholder={f.hint}
          title={f.hint}
          spellCheck={false}
        />
      );
    } else if (f.kind === "text") {
      control = (
        <input
          className="input"
          style={{ width: 160 }}
          value={vals[f.key] ?? f.def ?? ""}
          onChange={(e) => setVal(f.key, e.target.value)}
          placeholder={f.label}
          title={f.hint}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendFactory();
          }}
        />
      );
    } else {
      control = (
        <span className="qk-field">
          <input
            className="input qk-val"
            value={vals[f.key] ?? f.def ?? ""}
            onChange={(e) => setVal(f.key, e.target.value)}
            placeholder={f.label}
            title={`${f.label}${f.hint ? `：${f.hint}` : ""}`}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendFactory();
            }}
          />
          {f.options && (
            <select
              className="input"
              value=""
              onChange={(e) => {
                if (e.target.value !== "") setVal(f.key, e.target.value);
              }}
              title="常用值"
            >
              <option value="">常用值…</option>
              {f.options.map((o) => (
                <option key={o.v} value={String(o.v)}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </span>
      );
    }
    return (
      <div key={f.key} className="qk-fgroup">
        <label className="qk-flabel" title={f.hint}>
          {f.label}
        </label>
        {control}
        {f.hint && <span className="qk-fhint">{f.hint}</span>}
      </div>
    );
  };

  return (
    <div className="qk-bar">
      <div className="qk-head">
        <button className="qk-fold" onClick={toggleOpen} title={open ? "收起快捷指令栏" : "展开快捷指令栏"}>
          {open ? "▾" : "▸"} 快捷指令
        </button>
        {open && (
          <>
            <div className="qk-chips">
              {flat.map(({ item }) => (
                <button
                  key={item.id}
                  className={`qk-chip ${flash === item.id ? "flash" : ""}`}
                  onClick={() => void runItem(item)}
                  onMouseEnter={(e) => tipEnter(item, e.currentTarget)}
                  onMouseLeave={tipLeave}
                >
                  {item.scriptEnabled && item.script.trim() ? "⚡ " : ""}
                  {item.name}
                </button>
              ))}
              {!flat.length && (
                <span className="qk-empty">暂无指令，点右侧「管理」添加，或用「指令工厂」构造</span>
              )}
            </div>
            <button
              className={`btn ${factoryOpen ? "primary" : ""}`}
              style={{ flex: "0 0 auto" }}
              onClick={() => setFactoryOpen((v) => !v)}
              title="多协议指令构造器：WIT / 匿名V7 / Modbus / 校验工具"
            >
              指令工厂
            </button>
          </>
        )}
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={() => setManageOpen(true)}>
          管理
        </button>
      </div>
      {open && factoryOpen && (
        <div className="qk-factory">
          <div className="qk-factory-row">
            <div className="qk-fgroup">
              <label className="qk-flabel">协议</label>
              <select
                className="input"
                value={codec.id}
                onChange={(e) => switchCodec(e.target.value)}
                title="选择协议编解码器"
              >
                <optgroup label="内置协议">
                  {CODECS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
                {uc.codecs.length > 0 && (
                  <optgroup label="我的协议">
                    {allCodecs
                      .filter((c) => c.id.startsWith("user:"))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </div>
            <button
              className="btn"
              onClick={() => setEditorOpen({ def: null })}
              title="可视化编辑自己的帧模板：固定字节 + 变量字段 + 长度段 + 校验段"
            >
              ＋新建自定义协议
            </button>
            {uc.codecs.length > 0 && (
              <button className="btn" onClick={() => setMyOpen(true)} title="编辑/删除/导入/导出我的协议">
                管理我的协议
              </button>
            )}
          </div>
          {codec.guide && <div className="qk-guide">💡 {codec.guide}</div>}
          <div className="qk-factory-form">{factoryFields.map(renderFactoryField)}</div>
          <div className="qk-factory-actions">
            <button className="btn primary" onClick={() => void sendFactory()}>
              发送
            </button>
            <button className="btn" onClick={saveFactory} title={`存入命令库「${codec.group}」分组，可拖挂到控制画布卡片`}>
              存为指令
            </button>
            {codec.group === "WIT" && !hasWitGroup && (
              <button className="btn" onClick={addPresetGroup} title="一键添加解锁/保存/校准等常用指令">
                预置常用指令
              </button>
            )}
          </div>
          <div className="qk-factory-preview">
            {preview ? (
              <>
                <div className="qk-frames">
                  {preview.frames.map((f, i) => (
                    <span key={i} className="qk-frame-line">
                      {preview!.frames.length > 1 ? `${i + 1}. ` : ""}
                      {f}
                    </span>
                  ))}
                </div>
                <div className="qk-parts">
                  {preview.parts.map((p, i) => (
                    <span key={i} className="fp-col">
                      <span className={`fp ${p.cls}`} title={p.label}>
                        {p.text}
                      </span>
                      <span className="fp-label">{p.label}</span>
                    </span>
                  ))}
                </div>
                {preview.note && <div className="qk-note">{preview.note}</div>}
              </>
            ) : (
              <div className="qk-note">{previewErr ?? "—"}</div>
            )}
          </div>
        </div>
      )}
      {open && err && <div className="qk-err">{err}</div>}
      {open && msg && <div className="qk-msg">{msg}</div>}
      {tip && <ChipTooltip tip={tip} />}
      {editorOpen && (
        <CodecEditorModal
          initial={editorOpen.def}
          onClose={() => setEditorOpen(null)}
          onSaved={(id) => {
            setEditorOpen(null);
            switchCodec(`user:${id}`);
            showMsg("已保存，可在协议下拉中选用");
          }}
        />
      )}
      {myOpen && (
        <MyCodecsModal
          onClose={() => setMyOpen(false)}
          onEdit={(def) => {
            setMyOpen(false);
            setEditorOpen({ def });
          }}
          onDeleted={(id) => {
            if (codecId === `user:${id}`) switchCodec(CODECS[0].id);
          }}
        />
      )}
      {manageOpen && <ManageModal onClose={() => setManageOpen(false)} />}
    </div>
  );
}

function ManageModal(props: { onClose: () => void }) {
  const cmds = useSyncExternalStore(cmdStore.subscribe, cmdStore.getSnapshot);
  const [grpId, setGrpId] = useState(cmds.groups[0]?.id ?? "");
  const grp = cmds.groups.find((g) => g.id === grpId) ?? cmds.groups[0];

  return (
    <div className="modal-mask" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">快捷指令管理</div>
        <div className="form-row">
          <label>分组</label>
          <select
            className="input"
            value={grp?.id ?? ""}
            onChange={(e) => setGrpId(e.target.value)}
          >
            {cmds.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{g.items.length}）
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => cmdStore.addGroup(`分组${cmds.groups.length + 1}`)}
          >
            新增分组
          </button>
          {grp && cmds.groups.length > 1 && (
            <button
              className="btn"
              onClick={() => {
                cmdStore.removeNode(grp.id);
                setGrpId(cmdStore.getSnapshot().groups[0]?.id ?? "");
              }}
            >
              删除该组
            </button>
          )}
        </div>
        <div className="qk-manage-list">
          {grp?.items.map((n) =>
            "items" in n ? null : (
              <div key={n.id} className="qk-manage-row">
                <input
                  className="input"
                  style={{ width: 110 }}
                  value={n.name}
                  onChange={(e) => cmdStore.patchCommand(n.id, { name: e.target.value })}
                  placeholder="名称"
                />
                <select
                  className="input"
                  style={{ width: 72 }}
                  value={n.sendMode}
                  onChange={(e) =>
                    cmdStore.patchCommand(n.id, { sendMode: e.target.value as "ascii" | "hex" })
                  }
                >
                  <option value="ascii">ASCII</option>
                  <option value="hex">Hex</option>
                </select>
                <input
                  className="input"
                  style={{ flex: 1, fontFamily: "var(--font-mono)" }}
                  value={n.template}
                  onChange={(e) => cmdStore.patchCommand(n.id, { template: e.target.value })}
                  placeholder={n.scriptEnabled ? "（脚本命令）" : "发送内容，如 FF AA 69 88 B5 或 RST!"}
                  disabled={Boolean(n.scriptEnabled && n.script)}
                  title={n.scriptEnabled ? "脚本命令，请在控制画布的命令树中编辑" : n.note}
                />
                <button className="btn" onClick={() => cmdStore.removeNode(n.id)} title="删除">
                  ✕
                </button>
              </div>
            ),
          )}
          {!grp?.items.length && <div className="qk-empty">该分组暂无指令</div>}
        </div>
        <div className="form-row" style={{ marginTop: 8 }}>
          <button
            className="btn primary"
            disabled={!grp}
            onClick={() => grp && cmdStore.addCommand(grp.id)}
          >
            新增命令
          </button>
          <span className="form-hint">
            ⚡脚本命令与分组重命名请在控制画布右侧「命令」面板中编辑；此处改动与控制画布实时互通
          </span>
        </div>
      </div>
    </div>
  );
}
